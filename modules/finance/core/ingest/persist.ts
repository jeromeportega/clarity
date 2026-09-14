import { randomUUID } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import type { FinanceDb } from '../../db/client';
import {
  orderItems,
  orders,
  receiptItems,
  receipts,
  storeCreditBalances,
  transactions,
} from '../../db/schema';
import type { ImportError, NormalizedBatch } from '../adapters/source-adapter';
import { transactionDedupKey } from '../idempotency/keys';

export interface PersistOutcome {
  inserted: {
    transactions: number;
    orders: number;
    orderItems: number;
    storeCreditRows: number;
    receipts: number;
    receiptItems: number;
  };
  skippedDuplicates: number;
  errors: ImportError[];
}

interface InsertLike {
  rowsAffected?: number;
}

function inserted(result: InsertLike): boolean {
  return (result.rowsAffected ?? 0) > 0;
}

/**
 * The single home for ALL writes. Importers never touch the DB; they return a
 * {@link NormalizedBatch} and this function owns the cross-source rules so they
 * live in exactly one place:
 *
 *   - Idempotency: every transaction / order row is inserted with
 *     insert-or-ignore semantics against the schema's load-bearing unique
 *     indexes; a receipt is skipped when a row with its `sourceHash` already
 *     exists in `receipts.image_hash` (the same key the vision pipeline uses
 *     for photographed receipts). Skipped rows are counted.
 *   - Store-credit ledger: a return line whose `refundDestination` is a
 *     non-card destination accrues ONE positive `store_credit_balances` row; a
 *     `card` refund writes none.
 */
export async function persistBatch(
  db: FinanceDb,
  batch: NormalizedBatch,
  ctx: { householdId: string; accountId?: string },
): Promise<PersistOutcome> {
  const out: PersistOutcome = {
    inserted: { transactions: 0, orders: 0, orderItems: 0, storeCreditRows: 0, receipts: 0, receiptItems: 0 },
    skippedDuplicates: 0,
    errors: [],
  };

  for (const t of batch.transactions) {
    const accountId = ctx.accountId;
    if (!accountId) {
      out.errors.push({
        rowRef: t.sourceRowHash,
        reason: 'transaction requires an accountId in ImportContext',
      });
      continue;
    }
    const dedupKey = transactionDedupKey({
      accountId,
      postedDate: t.postedDate,
      amountCents: t.amountCents,
      normalizedMerchant: t.normalizedMerchant,
      sourceRowHash: t.sourceRowHash,
    });
    const res = await db
      .insert(transactions)
      .values({
        id: randomUUID(),
        accountId,
        postedDate: t.postedDate,
        amountCents: t.amountCents,
        direction: t.direction,
        rawMerchant: t.rawMerchant,
        normalizedMerchant: t.normalizedMerchant,
        sourceRowHash: t.sourceRowHash,
        dedupKey,
      })
      .onConflictDoNothing();
    if (inserted(res)) out.inserted.transactions += 1;
    else out.skippedDuplicates += 1;
  }

  for (const order of batch.orders) {
    const orderId = randomUUID();
    const res = await db
      .insert(orders)
      .values({
        id: orderId,
        householdId: ctx.householdId,
        source: order.source,
        externalOrderId: order.externalOrderId,
        orderDate: order.orderDate,
        currency: order.currency || 'USD',
        orderTotalCents: order.orderTotalCents,
      })
      .onConflictDoNothing();

    let effectiveOrderId: string = orderId;
    if (inserted(res)) {
      out.inserted.orders += 1;
    } else {
      // Order already exists (ux_orders_external): find its id so we can still
      // insert-or-ignore any new line items against it.
      const existing = await db
        .select({ id: orders.id })
        .from(orders)
        .where(
          and(
            eq(orders.householdId, ctx.householdId),
            eq(orders.source, order.source),
            eq(orders.externalOrderId, order.externalOrderId),
          ),
        );
      const found = existing[0];
      if (!found) {
        out.errors.push({
          rowRef: order.externalOrderId,
          reason: 'order conflicted on insert but could not be located',
        });
        continue;
      }
      effectiveOrderId = found.id;
    }

    for (const item of order.items) {
      const itemId = randomUUID();
      const itemRes = await db
        .insert(orderItems)
        .values({
          id: itemId,
          orderId: effectiveOrderId,
          shipmentId: item.shipmentId,
          itemSeq: item.itemSeq,
          description: item.description,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents,
          amountCents: item.amountCents,
          isReturn: item.isReturn,
          refundDestination: item.refundDestination,
          sourceRowHash: item.sourceRowHash,
        })
        .onConflictDoNothing();

      if (!inserted(itemRes)) {
        out.skippedDuplicates += 1;
        continue;
      }
      out.inserted.orderItems += 1;

      // A non-card refund destination accrues one positive ledger row.
      if (item.isReturn && item.refundDestination && item.refundDestination !== 'card') {
        await db.insert(storeCreditBalances).values({
          id: randomUUID(),
          householdId: ctx.householdId,
          orderItemId: itemId,
          kind: item.refundDestination,
          amountCents: Math.abs(item.amountCents),
        });
        out.inserted.storeCreditRows += 1;
      }
    }
  }

  for (const receipt of batch.receipts) {
    // Idempotency on the source's own transaction id (hashed), scoped to the
    // household. `receipts.image_hash` has no unique index, so check first.
    const existing = await db
      .select({ id: receipts.id })
      .from(receipts)
      .where(and(eq(receipts.householdId, ctx.householdId), eq(receipts.imageHash, receipt.sourceHash)))
      .limit(1);
    if (existing[0]) {
      out.skippedDuplicates += 1;
      continue;
    }

    const receiptId = randomUUID();
    await db.insert(receipts).values({
      id: receiptId,
      householdId: ctx.householdId,
      source: receipt.source,
      store: receipt.store,
      purchasedAt: receipt.purchasedAt,
      subtotalCents: receipt.subtotalCents,
      taxCents: receipt.taxCents,
      totalCents: receipt.totalCents,
      paymentLast4: receipt.paymentLast4,
      imageHash: receipt.sourceHash,
      needsReview: receipt.needsReview,
    });
    out.inserted.receipts += 1;

    if (receipt.items.length > 0) {
      await db.insert(receiptItems).values(
        receipt.items.map((item) => ({
          id: randomUUID(),
          receiptId,
          lineNo: item.lineNo,
          sku: item.sku,
          rawDescription: item.rawDescription,
          canonicalName: item.canonicalName,
          categoryId: null,
          quantity: item.quantity,
          unitPriceCents: item.unitPriceCents ?? null,
          linePriceCents: item.linePriceCents,
          discountCents: item.discountCents,
          // A source-supplied canonical name is ground truth; the category is
          // assigned downstream (classifier / dictionary / human), so it has no
          // confidence yet.
          nameConfidence: item.canonicalName === null ? null : 1,
          categoryConfidence: null,
          refundDestination: item.refundDestination ?? null,
          needsReview: item.needsReview,
        })),
      );
      out.inserted.receiptItems += receipt.items.length;
    }
  }

  return out;
}
