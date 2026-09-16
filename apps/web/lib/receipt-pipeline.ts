import Anthropic from '@anthropic-ai/sdk';

import { LibSqlSkuDictionary } from '../../../modules/finance/core/receipts/dictionary/libsql-sku-dictionary';
import type { SkuDictionary } from '../../../modules/finance/core/receipts/dictionary/sku-dictionary';
import type { ReceiptPipelineDeps } from '../../../modules/finance/core/receipts/process-receipt';
import { AnthropicSkuResolver, LlmSkuResolver } from '../../../modules/finance/core/receipts/resolver/llm-resolver';
import { RecordedSkuResolver } from '../../../modules/finance/core/receipts/resolver/recorded-resolver';
import type { SkuResolver } from '../../../modules/finance/core/receipts/resolver/sku-resolver';
import { LibSqlReceiptStore } from '../../../modules/finance/core/receipts/store/libsql-receipt-store';
import type { ReceiptStore } from '../../../modules/finance/core/receipts/store/receipt-store';
import { LiveAnthropicVisionProvider } from '../../../modules/finance/core/receipts/vision/live-anthropic-vision-provider';
import { RecordedVisionProvider } from '../../../modules/finance/core/receipts/vision/recorded-vision-provider';
import type { VisionProvider } from '../../../modules/finance/core/receipts/vision/vision-provider';
import type { FinanceDb } from '../../../modules/finance/db/client';

export interface ReceiptPipelineOverrides {
  /** Vision seam; defaults to live Anthropic when ANTHROPIC_API_KEY is set, else recorded fixtures. */
  vision?: VisionProvider;
  /** The generic LLM resolver the dictionary-first resolver falls back to; same default rule. */
  llm?: SkuResolver;
  store?: ReceiptStore;
  dictionary?: SkuDictionary;
  env?: NodeJS.ProcessEnv;
}

/**
 * The composition root for the receipt pipeline: real, durable persistence
 * (`LibSqlReceiptStore` scoped to the household, `LibSqlSkuDictionary`) plus
 * the vision / resolver seams chosen by environment. Everything an uploaded
 * receipt produces — the receipt, its line items, and every confident SKU
 * resolution — survives the request, so idempotency works across uploads and
 * the dictionary actually learns.
 *
 * The core never builds clients; this file (app layer) does.
 */
export function buildReceiptPipelineDeps(
  db: FinanceDb,
  householdId: string,
  overrides: ReceiptPipelineOverrides = {},
): ReceiptPipelineDeps {
  const env = overrides.env ?? process.env;
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  const client = apiKey ? new Anthropic({ apiKey }) : null;

  const vision = overrides.vision ?? (client ? new LiveAnthropicVisionProvider({ client }) : new RecordedVisionProvider());
  const llm = overrides.llm ?? (client ? new AnthropicSkuResolver({ client }) : new RecordedSkuResolver());
  const dictionary = overrides.dictionary ?? new LibSqlSkuDictionary(db);
  const store = overrides.store ?? new LibSqlReceiptStore(db, { householdId });
  // Invariant: the store's idempotency scope and the household stamped on
  // every row must agree, or one household's photo could be filed under
  // another's. Only an injected store can violate it.
  const scoped = (store as { scopedHouseholdId?: string }).scopedHouseholdId;
  if (scoped !== undefined && scoped !== householdId) {
    throw new Error(`receipt store is scoped to household ${scoped} but the pipeline is for ${householdId}`);
  }
  const resolver = new LlmSkuResolver({ dictionary, llm });

  return { vision, resolver, dictionary, store, householdId, source: 'photo' };
}
