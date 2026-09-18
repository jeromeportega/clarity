import { LibSqlSkuDictionary } from '../../../modules/finance/core/receipts/dictionary/libsql-sku-dictionary';
import type { SkuDictionary } from '../../../modules/finance/core/receipts/dictionary/sku-dictionary';
import type { ReceiptPipelineDeps } from '../../../modules/finance/core/receipts/process-receipt';
import { liveModelsAvailable, resolverModelId, visionModelId } from '../../../modules/finance/core/receipts/model-ids';
import { LlmSkuResolver, ModelSkuResolver } from '../../../modules/finance/core/receipts/resolver/llm-resolver';
import { RecordedSkuResolver } from '../../../modules/finance/core/receipts/resolver/recorded-resolver';
import type { SkuResolver } from '../../../modules/finance/core/receipts/resolver/sku-resolver';
import { LibSqlReceiptStore } from '../../../modules/finance/core/receipts/store/libsql-receipt-store';
import type { ReceiptStore } from '../../../modules/finance/core/receipts/store/receipt-store';
import { LiveVisionProvider } from '../../../modules/finance/core/receipts/vision/live-vision-provider';
import { RecordedVisionProvider } from '../../../modules/finance/core/receipts/vision/recorded-vision-provider';
import type { VisionProvider } from '../../../modules/finance/core/receipts/vision/vision-provider';
import type { FinanceDb } from '../../../modules/finance/db/client';

export interface ReceiptPipelineOverrides {
  /** Vision seam; defaults to a live model through the AI Gateway when it can authenticate, else recorded fixtures. */
  vision?: VisionProvider;
  /** The generic LLM resolver the dictionary-first resolver falls back to; same default rule. */
  llm?: SkuResolver;
  store?: ReceiptStore;
  dictionary?: SkuDictionary;
  env?: Record<string, string | undefined>;
}

/**
 * The composition root for the receipt pipeline: real, durable persistence
 * (`LibSqlReceiptStore` scoped to the household, `LibSqlSkuDictionary`) plus
 * the vision / resolver seams chosen by environment. Everything an uploaded
 * receipt produces — the receipt, its line items, and every confident SKU
 * resolution — survives the request, so idempotency works across uploads and
 * the dictionary actually learns.
 *
 * The core never chooses a model or builds a provider; this file (app layer) does.
 */
export function buildReceiptPipelineDeps(
  db: FinanceDb,
  householdId: string,
  overrides: ReceiptPipelineOverrides = {},
): ReceiptPipelineDeps {
  const env = overrides.env ?? process.env;
  // Live models go through the Vercel AI Gateway: an API key locally, the
  // deployment's OIDC token on Vercel. Without either, recorded fixtures.
  const live = liveModelsAvailable(env);

  const vision = overrides.vision ?? (live ? new LiveVisionProvider({ model: visionModelId(env) }) : new RecordedVisionProvider());
  const llm = overrides.llm ?? (live ? new ModelSkuResolver({ model: resolverModelId(env) }) : new RecordedSkuResolver());
  const dictionary = overrides.dictionary ?? new LibSqlSkuDictionary(db, { householdId });
  const store = overrides.store ?? new LibSqlReceiptStore(db, { householdId });
  // Invariant: the store's idempotency scope, the dictionary's scope and the
  // household stamped on every row must agree, or one household's photo could
  // be filed under — or resolved from — another's. Only injected ones can
  // violate it.
  for (const [what, dep] of [['receipt store', store], ['SKU dictionary', dictionary]] as const) {
    const scoped = (dep as { scopedHouseholdId?: string }).scopedHouseholdId;
    if (scoped !== undefined && scoped !== householdId) {
      throw new Error(`${what} is scoped to household ${scoped} but the pipeline is for ${householdId}`);
    }
  }
  const resolver = new LlmSkuResolver({ dictionary, llm });

  return { vision, resolver, dictionary, store, householdId, source: 'photo' };
}
