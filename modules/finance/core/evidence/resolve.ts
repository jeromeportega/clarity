import { and, eq } from 'drizzle-orm';
import type { FinanceDb } from '../../db/client';
import { accounts, orderItems, orders, receiptItems, receipts, transactions } from '../../db/schema';
import type { HouseholdScope } from '../scope';
import type { BoundingBox, EvidenceResult } from './types';

/**
 * Resolve the evidence source for a given item ID, within one household.
 *
 * Runs all three lookups in parallel, then returns the first match. Every
 * lookup is scoped through the household — receipt items via their receipt,
 * order items via their order, transactions via their account — so an id
 * from another household is simply not found.
 * Returns a discriminated EvidenceRef, or { kind: 'not_found' } for unknown IDs.
 *
 * receipt_region evidence degrades gracefully: when receipt_items.bbox is NULL,
 * bbox is omitted from the result and the UI links the whole image (ADR-007).
 */
export async function resolveEvidence(
  itemId: string,
  db: FinanceDb,
  scope: HouseholdScope,
): Promise<EvidenceResult> {
  const [riRows, oiRows, txRows] = await Promise.all([
    db
      .select({ receiptId: receiptItems.receiptId, bbox: receiptItems.bbox })
      .from(receiptItems)
      .innerJoin(receipts, eq(receiptItems.receiptId, receipts.id))
      .where(and(eq(receiptItems.id, itemId), eq(receipts.householdId, scope.householdId))),
    db
      .select({ orderId: orderItems.orderId })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .where(and(eq(orderItems.id, itemId), eq(orders.householdId, scope.householdId))),
    db
      .select({ id: transactions.id })
      .from(transactions)
      .innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .where(and(eq(transactions.id, itemId), eq(accounts.householdId, scope.householdId))),
  ]);

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

  if (oiRows.length > 0) {
    return { kind: 'amazon_order_row', orderId: oiRows[0]!.orderId, orderItemId: itemId };
  }

  if (txRows.length > 0) {
    return { kind: 'bank_line', transactionId: itemId };
  }

  return { kind: 'not_found', itemId };
}
