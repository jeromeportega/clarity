import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { RefundDestination } from '../../model/normalized';
import type {
  BankLine,
  ClassifiedItem,
  LedgerEvent,
  MatchRecord,
  OrderItemView,
  OrderView,
  ReconcileInputs,
  ReconciledLedger,
  ReceiptItemView,
  ReceiptView,
  StoreCreditAccrual,
  StoreCreditDrawdown,
} from '../model';
import { bankSignToSignedSpend } from '../model';
import type { InsightFlag } from '../../insights/model';
import type { Correction, Rollup, RollupCell } from '../../rollups/model';

describe('compile/type smoke — one literal of every domain type', () => {
  it('constructs BankLine', () => {
    const line: BankLine = {
      id: 'bl-1',
      accountId: 'acct-1',
      postedDate: '2024-01-15',
      amountCents: -4999,
      direction: 'debit',
      normalizedMerchant: 'WHOLE FOODS',
      lastFour: '1234',
    };
    expect(line.amountCents).toBe(-4999);
  });

  it('constructs OrderItemView and OrderView', () => {
    const item: OrderItemView = {
      id: 'oi-1',
      shipmentId: 'ship-1',
      description: 'Kindle',
      amountCents: 2999,
      isReturn: false,
    };
    const order: OrderView = {
      id: 'ord-1',
      externalOrderId: 'AMZN-001',
      orderDate: '2024-01-20',
      orderTotalCents: 2999,
      items: [item],
    };
    expect(order.items).toHaveLength(1);
  });

  it('constructs ReceiptItemView and ReceiptView', () => {
    const rItem: ReceiptItemView = {
      id: 'ri-1',
      description: 'Groceries',
      amountCents: 4999,
    };
    const receipt: ReceiptView = {
      id: 'rec-1',
      merchant: 'WHOLE FOODS',
      capturedAt: '2024-01-15',
      totalCents: 4999,
      lastFour: '1234',
      items: [rItem],
    };
    expect(receipt.items).toHaveLength(1);
  });

  it('constructs StoreCreditAccrual', () => {
    const accrual: StoreCreditAccrual = {
      id: 'sca-1',
      kind: 'gift_card',
      amountCents: 2400,
      occurredAt: '2024-02-14',
      orderId: 'ord-2',
      orderItemId: 'oi-2',
    };
    expect(accrual.kind).toBe('gift_card');
  });

  it('constructs ReconcileInputs', () => {
    const inputs: ReconcileInputs = {
      householdId: 'hh-1',
      bankLines: [],
      orders: [],
      receipts: [],
      storeCreditAccruals: [],
    };
    expect(inputs.householdId).toBe('hh-1');
  });

  it('constructs MatchRecord', () => {
    const match: MatchRecord = {
      id: 'mr-1',
      type: 'receipt_bank',
      transactionId: 'tx-1',
      receiptId: 'rec-1',
      confidence: 0.92,
      rationale: 'merchant + amount + date aligned within 1-day window',
      status: 'auto_linked',
    };
    expect(match.confidence).toBeGreaterThan(0.7);
  });

  it('constructs ClassifiedItem', () => {
    const item: ClassifiedItem = {
      itemRef: { receiptItemId: 'ri-1' },
      category: 'groceries',
      rationale: 'merchant heuristic matched grocery store',
      source: 'item_heuristic',
    };
    expect(item.source).toBe('item_heuristic');
  });

  it('constructs LedgerEvent — all three fundedBy variants', () => {
    const bankFunded: LedgerEvent = {
      id: 'le-1',
      signedSpendCents: 4999,
      occurredOn: '2024-01-15',
      fundedBy: 'bank',
      sources: { transactionId: 'tx-1', receiptId: 'rec-1' },
      mergedItems: [],
      categoryFallback: 'groceries',
    };
    const creditFunded: LedgerEvent = {
      id: 'le-2',
      signedSpendCents: 2400,
      occurredOn: '2024-02-14',
      fundedBy: 'store_credit',
      sources: { orderId: 'ord-1' },
      mergedItems: [],
    };
    const splitFunded: LedgerEvent = {
      id: 'le-3',
      signedSpendCents: 6750,
      occurredOn: '2024-02-03',
      fundedBy: 'split',
      sources: { transactionId: 'tx-2', orderId: 'ord-2' },
      mergedItems: [],
    };
    expect(bankFunded.fundedBy).toBe('bank');
    expect(creditFunded.fundedBy).toBe('store_credit');
    expect(splitFunded.fundedBy).toBe('split');
  });

  it('constructs StoreCreditDrawdown', () => {
    const drawdown: StoreCreditDrawdown = {
      id: 'scd-1',
      kind: 'gift_card',
      amountCents: -2400,
      occurredAt: '2024-02-14',
      reason: 'partial_payment',
      orderId: 'ord-2',
    };
    expect(drawdown.amountCents).toBeLessThan(0);
  });

  it('constructs ReconciledLedger', () => {
    const ledger: ReconciledLedger = {
      events: [],
      matches: [],
      reviewQueue: [],
      storeCreditDrawdowns: [],
      unmatched: { bankLines: [], orderItems: [], receipts: [] },
      netSpendCents: 0,
    };
    expect(ledger.netSpendCents).toBe(0);
  });

  it('constructs RollupCell and Rollup from rollups/model', () => {
    const cell: RollupCell = {
      category: 'groceries',
      month: '2024-01',
      netSpendCents: 4999,
      eventIds: ['le-1'],
    };
    const rollup: Rollup = [cell];
    expect(rollup).toHaveLength(1);
  });

  it('constructs Correction from rollups/model — all three variants', () => {
    const reclassify: Correction = {
      kind: 'reclassify_item',
      itemRef: { receiptItemId: 'ri-1' },
      newCategory: 'dining',
    };
    const relink: Correction = { kind: 'relink_match', matchId: 'mr-1', newTransactionId: 'tx-2' };
    const reject: Correction = { kind: 'reject_match', matchId: 'mr-2' };
    expect(reclassify.kind).toBe('reclassify_item');
    expect(relink.kind).toBe('relink_match');
    expect(reject.kind).toBe('reject_match');
  });

  it('constructs InsightFlag from insights/model', () => {
    const flag: InsightFlag = {
      code: 'merchant_above_avg',
      message: 'Whole Foods spending is 40% above your 3-month average',
      amounts: { observedCents: 14997, comparisonCents: 10713, deltaPct: 40 },
      basis: '3-month rolling average',
    };
    expect(flag.code).toBe('merchant_above_avg');
  });

  it('RefundDestination is the H1 union, not a local redeclaration', () => {
    // If this compiles, the type was imported rather than re-declared locally.
    const dest: RefundDestination = 'gift_card';
    const orderItem: OrderItemView = {
      id: 'oi-ret',
      shipmentId: 'ship-ret',
      description: 'Returned item',
      amountCents: -2400,
      isReturn: true,
      refundDestination: dest,
    };
    const accrual: StoreCreditAccrual = {
      id: 'sca-ret',
      kind: 'gift_card',
      amountCents: 2400,
      occurredAt: '2024-02-14',
    };
    expect(orderItem.refundDestination).toBe('gift_card');
    expect(accrual.kind).toBe('gift_card');
  });
});

describe('bankSignToSignedSpend — sign-flip correctness', () => {
  it('bank purchase debit (-1234) → signedSpendCents +1234', () => {
    expect(bankSignToSignedSpend(-1234)).toBe(1234);
  });

  it('bank refund credit (+1234) → signedSpendCents -1234', () => {
    expect(bankSignToSignedSpend(1234)).toBe(-1234);
  });

  it('zero amount maps to zero', () => {
    expect(bankSignToSignedSpend(0)).toEqual(0);
  });

  it('large purchase rounds correctly', () => {
    expect(bankSignToSignedSpend(-150000)).toBe(150000);
  });
});

describe('no Next.js / React imports in core/reconcile', () => {
  const RECONCILE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

  function collectTs(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...collectTs(full));
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        out.push(full);
      }
    }
    return out;
  }

  it('zero next/react imports in reconcile source files', () => {
    const files = collectTs(RECONCILE_DIR);
    expect(files.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      if (/\bfrom\s*['"](?:next|react|react-dom)(?:\/[^'"]*)?['"]/.test(src)) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });
});
