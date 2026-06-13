import type { BankLine, ClassifiedItem } from '../reconcile/model';
import { clampToTaxonomy } from './taxonomy';
import { applyKeywordRules } from './rules';

export function merchantFallback(line: BankLine, taxonomy: readonly string[]): ClassifiedItem {
  const hit = applyKeywordRules(line.normalizedMerchant);
  const category = clampToTaxonomy(hit?.category ?? 'Other', taxonomy);
  const matched = hit?.keyword ?? 'no keyword match';
  const rationale = `merchant: ${line.normalizedMerchant}; no item data, merchant keyword fallback: "${matched}" → ${category}`;

  return {
    itemRef: {},
    category,
    rationale,
    source: 'merchant_fallback',
  };
}
