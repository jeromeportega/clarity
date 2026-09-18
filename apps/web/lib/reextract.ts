import { and, eq } from 'drizzle-orm';

import { reprocessReceipt, type ReprocessOutcome } from '../../../modules/finance/core/receipts/reprocess-receipt';
import { receiptImageKey } from '../../../modules/finance/core/receipts/store/image-store';
import { LibSqlReceiptStore } from '../../../modules/finance/core/receipts/store/libsql-receipt-store';
import { isSupportedMimeType } from '../../../modules/finance/core/receipts/vision/vision-provider';
import type { FinanceDb } from '../../../modules/finance/db/client';
import { reviewDecisions } from '../../../modules/finance/db/schema';
import { getImageStore } from './image-store';
import { buildReceiptPipelineDeps, type ReceiptPipelineOverrides } from './receipt-pipeline';
import { reconcileAfterWrite } from './reconcile';

export type ReextractOutcome =
  | ReprocessOutcome
  | { ok: false; code: 'no_image' | 'unsupported_image' };

/**
 * Read a stored receipt photo again, for one household. The image comes from
 * the image store under the receipt's own hash (never from the request), the
 * pipeline is the same one uploads use, and a successful read re-runs
 * reconciliation because the receipt's total and date may have changed.
 *
 * A successful read also forgets any earlier queue decision about the
 * receipt itself (`flagged_receipt`): that decision was about the placeholder,
 * and the row now says something else — if it needs review again, it must
 * surface again. Decisions about line items are untouched (there were none).
 */
export async function reextractReceipt(
  db: FinanceDb,
  householdId: string,
  receiptId: string,
  overrides: ReceiptPipelineOverrides = {},
): Promise<ReextractOutcome> {
  const store = new LibSqlReceiptStore(db, { householdId });
  const receipt = await store.getReceiptById(receiptId);
  if (!receipt) return { ok: false, code: 'not_found' };

  const image = await getImageStore().get(receiptImageKey(householdId, receipt.imageHash));
  if (!image) return { ok: false, code: 'no_image' };
  if (!isSupportedMimeType(image.mimeType)) return { ok: false, code: 'unsupported_image' };

  const deps = buildReceiptPipelineDeps(db, householdId, { store, ...overrides });
  const outcome = await reprocessReceipt(receiptId, { bytes: image.bytes, mimeType: image.mimeType }, deps);
  if (outcome.ok) {
    await db
      .delete(reviewDecisions)
      .where(and(eq(reviewDecisions.householdId, householdId), eq(reviewDecisions.itemType, 'flagged_receipt'), eq(reviewDecisions.itemId, receiptId)));
    await reconcileAfterWrite(db, householdId);
  }
  return outcome;
}
