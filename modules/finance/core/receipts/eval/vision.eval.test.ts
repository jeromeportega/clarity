import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { StubSkuDictionary } from '../dictionary/stub-sku-dictionary';
import { processReceipt, type ReceiptPipelineDeps } from '../process-receipt';
import { AnthropicSkuResolver, LlmSkuResolver } from '../resolver/llm-resolver';
import { StubReceiptStore } from '../store/stub-receipt-store';
import { LiveAnthropicVisionProvider } from '../vision/live-anthropic-vision-provider';
import type { ReceiptImageInput } from '../vision/vision-provider';
import {
  EVAL_PASS_FRACTION,
  MIN_EVAL_RECEIPTS,
  discoverReceipts,
  evalKeyPresent,
  evalTimeoutMs,
  expectedPathFor,
  gradeReceipt,
  meetsThreshold,
  mimeTypeForFile,
  resolveEvalDir,
  resolveEvalLimit,
  resolveEvalRatio,
  sampleEvenly,
  type ExpectedReceipt,
  type GradedItem,
} from './harness';

// =============================================================================
// FR-18 — the key-gated accuracy harness. Runs ONLY under `npm run vision:eval`
// (the separate `eval` Vitest project), and only when ANTHROPIC_API_KEY is set.
// With no key it SKIPS, never fails (ADR-006), so it never touches the default
// `npm test` / E2E offline gate.
//
// It drives ≥5 sanitized real receipts end-to-end through the live pipeline
// (LiveAnthropicVisionProvider + the live LLM resolver) and asserts, as a SINGLE
// threshold over the whole sample, that ≥80% of expected line items resolved
// correctly — Sørensen–Dice canonical-name similarity ≥ ratio AND exact category
// equality. Never a per-item exact-string match (NFR-5).
//
// Trade-off (accepted, per the architect): an accuracy regression is only caught
// when someone runs `vision:eval` with a key, not on every push — the price of
// keeping the default gate fully offline.
//
// Point RECEIPT_EVAL_DIR at the real (sanitized) receipt kit to grade it; the
// committed synthetic Costco-style sample is the default.
// =============================================================================

const RUN = evalKeyPresent();

describe.skipIf(!RUN)('vision:eval — live accuracy over sanitized receipts (FR-18)', () => {
  let deps: ReceiptPipelineDeps;
  const dir = resolveEvalDir();
  const ratio = resolveEvalRatio();
  const limit = resolveEvalLimit();
  // An evenly spaced sample when capped, so a smoke run spans the whole period.
  const receiptFiles = RUN ? sampleEvenly(discoverReceipts(dir), limit) : [];
  const expectedLineItems = receiptFiles.reduce((n, file) => {
    const expected = JSON.parse(readFileSync(expectedPathFor(file), 'utf8')) as ExpectedReceipt;
    return n + expected.items.length;
  }, 0);
  const timeoutMs = evalTimeoutMs(receiptFiles.length, expectedLineItems);

  beforeAll(() => {
    const client = new Anthropic(); // reads ANTHROPIC_API_KEY; guarded by RUN
    const dictionary = new StubSkuDictionary();
    deps = {
      vision: new LiveAnthropicVisionProvider({ client }),
      resolver: new LlmSkuResolver({ dictionary, llm: new AnthropicSkuResolver({ client }) }),
      dictionary,
      store: new StubReceiptStore(),
    };
  });

  it(
    `resolves ≥${Math.round(EVAL_PASS_FRACTION * 100)}% of line items across ≥${MIN_EVAL_RECEIPTS} receipts`,
    async () => {
      expect(receiptFiles.length).toBeGreaterThanOrEqual(MIN_EVAL_RECEIPTS);

      let correct = 0;
      let total = 0;
      const perReceipt: string[] = [];
      for (const file of receiptFiles) {
        const input: ReceiptImageInput = {
          bytes: new Uint8Array(readFileSync(file)),
          mimeType: mimeTypeForFile(file)!,
        };
        const expected = JSON.parse(readFileSync(expectedPathFor(file), 'utf8')) as ExpectedReceipt;

        const out = await processReceipt(input, deps);
        const graded: GradedItem[] = out.items.map((item) => ({
          sku: item.sku,
          canonicalName: item.canonicalName,
          category: item.categoryId,
        }));

        const score = gradeReceipt(graded, expected.items, ratio);
        correct += score.correct;
        total += score.total;
        const totalOk = out.receipt.totalCents === expected.totalCents ? 'total ok' : `total ${out.receipt.totalCents} vs ${expected.totalCents}`;
        // Filenames embed the full transaction id; print only its tail.
        const label = (file.split('/').pop() ?? file).replace(/(\d{6})\d{8,}/, '…$1');
        perReceipt.push(`${label}: ${score.correct}/${score.total} items, ${totalOk}${out.status === 'ok' ? '' : ` [${out.status}]`}`);
      }
      // Per-receipt diagnostics for the operator; the assertion stays a single threshold.
      console.log(`vision:eval — ${correct}/${total} line items resolved (${((100 * correct) / Math.max(total, 1)).toFixed(1)}%)\n${perReceipt.join('\n')}`);

      // A single threshold assertion over the whole sample — never per-item.
      expect(total).toBeGreaterThan(0);
      expect(
        meetsThreshold(correct, total),
        `correctly resolved ${correct}/${total} line items (need ≥${EVAL_PASS_FRACTION})`,
      ).toBe(true);
    },
    timeoutMs,
  );
});
