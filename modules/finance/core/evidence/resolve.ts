import { eq } from 'drizzle-orm';
import type { FinanceDb } from '../../db/client';
import { receiptItems, receipts, orderItems, transactions } from '../../db/schema';
import type { BoundingBox, EvidenceResult } from './types';

/**
 * Resolve the evidence source for a given item ID.
 *
 * Lookup order: receipt_items → order_items → transactions.
 * Returns a discriminated EvidenceRef, or { kind: 'not_found' } for unknown IDs.
 *
 * receipt_region evidence degrades gracefully: when receipt_items.bbox is NULL,
 * bbox is omitted from the result and the UI links the whole image (ADR-007).
 */
export async function resolveEvidence(
  itemId: string,
  db: FinanceDb,
): Promise<EvidenceResult> {
  const riRows = await db
    .select({
      receiptId: receiptItems.receiptId,
      bbox: receiptItems.bbox,
    })
    .from(receiptItems)
    .where(eq(receiptItems.id, itemId));

  if (riRows.length > 0) {
    const ri = riRows[0]!;
    const imageUrl = `/api/receipts/image/${ri.receiptId}`;
    let bbox: BoundingBox | undefined;
    if (ri.bbox) {
      try {
        bbox = JSON.parse(ri.bbox) as BoundingBox;
      } catch {
        // Malformed bbox JSON — degrade to whole-image reference (ADR-007)
      }
    }
    return bbox
      ? { kind: 'receipt_region', receiptId: ri.receiptId, imageUrl, bbox }
      : { kind: 'receipt_region', receiptId: ri.receiptId, imageUrl };
  }

  const oiRows = await db
    .select({ orderId: orderItems.orderId })
    .from(orderItems)
    .where(eq(orderItems.id, itemId));

  if (oiRows.length > 0) {
    return { kind: 'amazon_order_row', orderId: oiRows[0]!.orderId, orderItemId: itemId };
  }

  const txRows = await db
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.id, itemId));

  if (txRows.length > 0) {
    return { kind: 'bank_line', transactionId: itemId };
  }

  return { kind: 'not_found', itemId };
}
