import { and, asc, eq, inArray } from 'drizzle-orm';

import type { FinanceDb } from '../../db/client';
import {
  accounts,
  matches,
  orderItems,
  orders,
  receiptItems,
  receipts,
  storeCreditBalances,
  transactions,
} from '../../db/schema';
import { FIXTURE_INPUTS } from './__fixtures__/index';
import type {
  BankLine,
  ConfirmedMatch,
  OrderItemView,
  OrderView,
  ReceiptItemView,
  ReceiptView,
  ReconcileInputs,
  StoreCreditAccrual,
} from './model';

export interface ReconcileSource {
  load(householdId: string): Promise<ReconcileInputs>;
}

/**
 * In-memory fixture source used in tests and the gate. Returns the synthetic
 * corpus from `__fixtures__/index.ts`, overriding its householdId with the
 * caller's so fixture data is addressable by any test household.
 */
export class FixtureReconcileSource implements ReconcileSource {
  async load(householdId: string): Promise<ReconcileInputs> {
    return {
      ...FIXTURE_INPUTS,
      householdId,
      bankLines: FIXTURE_INPUTS.bankLines.map((b) => ({ ...b })),
      orders: FIXTURE_INPUTS.orders.map((o) => ({ ...o, items: o.items.map((i) => ({ ...i })) })),
      receipts: FIXTURE_INPUTS.receipts.map((r) => ({ ...r, items: r.items.map((i) => ({ ...i })) })),
      storeCreditAccruals: FIXTURE_INPUTS.storeCreditAccruals.map((a) => ({ ...a })),
    };
  }
}

/** `CURRENT_TIMESTAMP` text (`YYYY-MM-DD HH:MM:SS`) or ISO → the calendar day. */
function dayOf(timestamp: string): string {
  return timestamp.slice(0, 10);
}

/**
 * Loads a household's reconciliation inputs from the database — everything the
 * engine matches over, scoped to the household at every table:
 *
 *   bank lines   ← transactions via accounts.household_id
 *   orders       ← orders.household_id, with their line items
 *   receipts     ← receipts.household_id, with their line items
 *   store credit ← store_credit_balances.household_id, dated by the order the
 *                  refund line belongs to (else the row's own creation day)
 *
 * Amounts keep the schema's sign convention (bank debits negative, order
 * return lines negative); the engine performs the one bank→spend flip itself.
 * A receipt line's amount is what was actually paid for it — its line price
 * net of the discount that applied to it. Rows come back in a stable order
 * (by id) so a re-run over unchanged data produces the same ledger.
 */
export class DrizzleReconcileSource implements ReconcileSource {
  constructor(private readonly db: FinanceDb) {}

  async load(householdId: string): Promise<ReconcileInputs> {
    const [bankLines, orderViews, receiptViews, storeCreditAccruals, confirmedMatches] = await Promise.all([
      this.loadBankLines(householdId),
      this.loadOrders(householdId),
      this.loadReceipts(householdId),
      this.loadStoreCredit(householdId),
      this.loadConfirmedMatches(householdId),
    ]);
    return { householdId, bankLines, orders: orderViews, receipts: receiptViews, storeCreditAccruals, confirmedMatches };
  }

  private householdTransactionIds(householdId: string) {
    return this.db
      .select({ id: transactions.id })
      .from(transactions)
      .innerJoin(accounts, eq(transactions.accountId, accounts.id))
      .where(eq(accounts.householdId, householdId));
  }

  /**
   * The humans' settled matches: every `manual` row that names the receipt or
   * order it stands for, one decision per transaction (a transaction is paid
   * once). A `manual` row with neither anchor — a candidate for a receipt with
   * no line items, say — has nothing the engine could honour and is skipped.
   */
  private async loadConfirmedMatches(householdId: string): Promise<ConfirmedMatch[]> {
    const rows = await this.db
      .select({ transactionId: matches.transactionId, receiptId: matches.receiptId, orderId: matches.orderId })
      .from(matches)
      .where(and(inArray(matches.transactionId, this.householdTransactionIds(householdId)), eq(matches.status, 'manual')))
      .orderBy(asc(matches.id));

    const byTransaction = new Map<string, ConfirmedMatch>();
    for (const r of rows) {
      if (byTransaction.has(r.transactionId)) continue;
      if (r.receiptId) byTransaction.set(r.transactionId, { transactionId: r.transactionId, receiptId: r.receiptId });
      else if (r.orderId) byTransaction.set(r.transactionId, { transactionId: r.transactionId, orderId: r.orderId });
    }
    return [...byTransaction.values()];
  }

  private householdOrderIds(householdId: string) {
    return this.db.select({ id: orders.id }).from(orders).where(eq(orders.householdId, householdId));
  }

  private householdReceiptIds(householdId: string) {
    return this.db.select({ id: receipts.id }).from(receipts).where(eq(receipts.householdId, householdId));
  }

  private async loadBankLines(householdId: string): Promise<BankLine[]> {
    const rows = await this.db
      .select({
        id: transactions.id,
        accountId: transactions.accountId,
        postedDate: transactions.postedDate,
        amountCents: transactions.amountCents,
        direction: transactions.direction,
        normalizedMerchant: transactions.normalizedMerchant,
      })
      .from(transactions)
      .innerJoin(accounts, eq(transactions.accountId, accounts.id))
      // A pending line (a synced authorization) may change amount or vanish
      // when it posts: it is not a bank line until then.
      .where(and(eq(accounts.householdId, householdId), eq(transactions.pending, false)))
      .orderBy(asc(transactions.id));

    return rows.map((r) => ({
      id: r.id,
      accountId: r.accountId,
      postedDate: r.postedDate,
      amountCents: r.amountCents,
      direction: r.direction,
      normalizedMerchant: r.normalizedMerchant,
    }));
  }

  private async loadOrders(householdId: string): Promise<OrderView[]> {
    const orderRows = await this.db
      .select({
        id: orders.id,
        externalOrderId: orders.externalOrderId,
        orderDate: orders.orderDate,
        orderTotalCents: orders.orderTotalCents,
      })
      .from(orders)
      .where(eq(orders.householdId, householdId))
      .orderBy(asc(orders.id));
    if (orderRows.length === 0) return [];

    const itemRows = await this.db
      .select({
        id: orderItems.id,
        orderId: orderItems.orderId,
        shipmentId: orderItems.shipmentId,
        description: orderItems.description,
        amountCents: orderItems.amountCents,
        isReturn: orderItems.isReturn,
        refundDestination: orderItems.refundDestination,
      })
      .from(orderItems)
      .where(inArray(orderItems.orderId, this.householdOrderIds(householdId)))
      .orderBy(asc(orderItems.orderId), asc(orderItems.shipmentId), asc(orderItems.itemSeq));

    const itemsByOrder = new Map<string, OrderItemView[]>();
    for (const r of itemRows) {
      const view: OrderItemView = {
        id: r.id,
        shipmentId: r.shipmentId,
        description: r.description,
        amountCents: r.amountCents,
        isReturn: r.isReturn,
        ...(r.refundDestination ? { refundDestination: r.refundDestination } : {}),
      };
      const list = itemsByOrder.get(r.orderId) ?? [];
      list.push(view);
      itemsByOrder.set(r.orderId, list);
    }

    return orderRows.map((o) => ({
      id: o.id,
      externalOrderId: o.externalOrderId,
      orderDate: o.orderDate,
      ...(o.orderTotalCents != null ? { orderTotalCents: o.orderTotalCents } : {}),
      items: itemsByOrder.get(o.id) ?? [],
    }));
  }

  private async loadReceipts(householdId: string): Promise<ReceiptView[]> {
    const receiptRows = await this.db
      .select({
        id: receipts.id,
        store: receipts.store,
        purchasedAt: receipts.purchasedAt,
        totalCents: receipts.totalCents,
        paymentLast4: receipts.paymentLast4,
      })
      .from(receipts)
      .where(eq(receipts.householdId, householdId))
      .orderBy(asc(receipts.id));
    if (receiptRows.length === 0) return [];

    const itemRows = await this.db
      .select({
        id: receiptItems.id,
        receiptId: receiptItems.receiptId,
        rawDescription: receiptItems.rawDescription,
        canonicalName: receiptItems.canonicalName,
        linePriceCents: receiptItems.linePriceCents,
        discountCents: receiptItems.discountCents,
      })
      .from(receiptItems)
      .where(inArray(receiptItems.receiptId, this.householdReceiptIds(householdId)))
      .orderBy(asc(receiptItems.receiptId), asc(receiptItems.lineNo));

    const itemsByReceipt = new Map<string, ReceiptItemView[]>();
    for (const r of itemRows) {
      const view: ReceiptItemView = {
        id: r.id,
        description: r.canonicalName ?? r.rawDescription,
        amountCents: r.linePriceCents - r.discountCents,
      };
      const list = itemsByReceipt.get(r.receiptId) ?? [];
      list.push(view);
      itemsByReceipt.set(r.receiptId, list);
    }

    return receiptRows.map((r) => ({
      id: r.id,
      // An unreadable photo persists as a '' store / '' date / 0 total
      // placeholder; leave those fields absent so the matcher treats it as
      // unscorable rather than as a real 0¢ purchase on an empty date.
      ...(r.store !== '' ? { merchant: r.store } : {}),
      ...(r.purchasedAt !== '' ? { capturedAt: r.purchasedAt } : {}),
      totalCents: r.totalCents,
      ...(r.paymentLast4 ? { lastFour: r.paymentLast4 } : {}),
      items: itemsByReceipt.get(r.id) ?? [],
    }));
  }

  private async loadStoreCredit(householdId: string): Promise<StoreCreditAccrual[]> {
    const rows = await this.db
      .select({
        id: storeCreditBalances.id,
        kind: storeCreditBalances.kind,
        amountCents: storeCreditBalances.amountCents,
        createdAt: storeCreditBalances.createdAt,
        orderItemId: storeCreditBalances.orderItemId,
        orderId: orderItems.orderId,
        orderDate: orders.orderDate,
      })
      .from(storeCreditBalances)
      .leftJoin(orderItems, eq(storeCreditBalances.orderItemId, orderItems.id))
      // Scoped like every other join here: a foreign order can never date an accrual.
      .leftJoin(orders, and(eq(orderItems.orderId, orders.id), eq(orders.householdId, householdId)))
      .where(eq(storeCreditBalances.householdId, householdId))
      .orderBy(asc(storeCreditBalances.id));

    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      amountCents: r.amountCents,
      occurredAt: r.orderDate ?? dayOf(r.createdAt),
      ...(r.orderId ? { orderId: r.orderId } : {}),
      ...(r.orderItemId ? { orderItemId: r.orderItemId } : {}),
    }));
  }
}
