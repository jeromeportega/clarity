import type { BankLine, Cents, ClassifiedItem, LedgerEvent } from '../reconcile/model';
import type { ReconcileConfig } from '../reconcile/thresholds';
import { clampToTaxonomy } from './taxonomy';
import { applyKeywordRules } from './rules';
import { detectRecurring } from './recurring';
import { merchantFallback } from './merchant-fallback';

export interface Classifier {
  classify(
    q: { merchant: string; description?: string; amountCents: Cents },
    taxonomy: readonly string[],
  ): ClassifiedItem;
}

export class HeuristicClassifier implements Classifier {
  classify(
    q: { merchant: string; description?: string; amountCents: Cents },
    taxonomy: readonly string[],
  ): ClassifiedItem {
    const searchText = [q.merchant, q.description].filter(Boolean).join(' ');
    const hit = applyKeywordRules(searchText);
    const category = clampToTaxonomy(hit?.category ?? 'Other', taxonomy);
    const keyword = hit?.keyword ?? 'no match';
    const rationale = `merchant: ${q.merchant}; keyword match: "${keyword}" → ${category}`;

    return {
      itemRef: {},
      category,
      rationale,
      source: 'item_heuristic',
    };
  }
}

// LlmClassifier satisfies the Classifier interface but is NEVER imported or
// wired in test files (NFR-5, ADR-007). Defined here to document the seam;
// all gated code paths use HeuristicClassifier.
export class LlmClassifier implements Classifier {
  classify(
    _q: { merchant: string; description?: string; amountCents: Cents },
    _taxonomy: readonly string[],
  ): ClassifiedItem {
    throw new Error(
      'LlmClassifier must not be called in the gated test suite (NFR-5)',
    );
  }
}

export { detectRecurring, merchantFallback };
export type { BankLine, LedgerEvent, ReconcileConfig };
