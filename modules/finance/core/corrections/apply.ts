import { randomUUID } from 'node:crypto';
import type { FinanceDb } from '../../db/client';
import { reviewDecisions } from '../../db/schema';
import { skuDictionary } from '../receipts/dictionary/schema';
import { normalizeStore, normalizeSkuOrAbbrev } from '../receipts/dictionary/normalize';
import type { ReconciliationGateway } from '../reconciliation/types';
import type { HouseholdScope } from '../scope';
import type { QueueItem } from '../queue/types';

// ---------------------------------------------------------------------------
// Action types
// ---------------------------------------------------------------------------

export type PickCategoryCorrection = {
  variant: 'pickCategoryId';
  categoryId: string;
};

export type PickMatchCandidateCorrection = {
  variant: 'pickMatchCandidateId';
  candidateId: string;
};

export type EditResolutionCorrection = {
  variant: 'editResolution';
  store: string;
  skuOrAbbrev: string;
  canonicalName: string;
  category: string;
};

export type CorrectionVariant =
  | PickCategoryCorrection
  | PickMatchCandidateCorrection
  | EditResolutionCorrection;

export type CorrectionAction =
  | { type: 'confirm' }
  | { type: 'dismiss' }
  | { type: 'correct'; correction: CorrectionVariant };

export interface CorrectionResult {
  removedItemId: string;
}

// ---------------------------------------------------------------------------
// applyCorrection — the core mutation
//
// ONE libSQL transaction: writes review_decisions, upserts sku_dictionary (only
// on editResolution), then calls gw.recomputeRollups before committing.
// If recomputeRollups throws, the transaction rolls back — no partial state.
//
// Affected IDs for recomputeRollups: always [item.id] — a bounded set (the item
// under review), never the whole household.
// ---------------------------------------------------------------------------

export async function applyCorrection(
  scope: HouseholdScope,
  item: QueueItem,
  action: CorrectionAction,
  gw: ReconciliationGateway,
  db: FinanceDb,
): Promise<CorrectionResult> {
  const decisionId = randomUUID();
  const payloadJson = action.type === 'correct'
    ? JSON.stringify(action.correction)
    : null;

  await db.transaction(async (tx) => {
    // 1. Write the terminal decision row.
    await tx.insert(reviewDecisions).values({
      id: decisionId,
      householdId: scope.householdId,
      itemType: item.type,
      itemId: item.id,
      decision: action.type,
      payloadJson,
    });

    // 2. Upsert sku_dictionary — only for editResolution corrections.
    if (action.type === 'correct' && action.correction.variant === 'editResolution') {
      const c = action.correction;
      const now = Date.now();
      await tx
        .insert(skuDictionary)
        .values({
          store: normalizeStore(c.store),
          skuOrAbbrev: normalizeSkuOrAbbrev(c.skuOrAbbrev),
          canonicalName: c.canonicalName,
          category: c.category,
          nameConfidence: 1.0,
          categoryConfidence: 1.0,
          source: 'human' as const,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [skuDictionary.store, skuDictionary.skuOrAbbrev],
          set: {
            canonicalName: c.canonicalName,
            category: c.category,
            nameConfidence: 1.0,
            categoryConfidence: 1.0,
            source: 'human' as const,
            updatedAt: now,
          },
          // human-wins: always overwrite any existing entry (auto or human)
        });
    }

    // 3. Recompute rollups — inside the transaction so a failure rolls back
    //    the decision row and any sku_dictionary write.
    //    Affected set: [item.id] — bounded, never the whole household.
    await gw.recomputeRollups(scope, [item.id]);
  });

  return { removedItemId: item.id };
}
