import { describe, expect, it } from 'vitest';
import type { BankLine, LedgerEvent, MatchRecord, ReconcileInputs, ReceiptView, StoreCreditAccrual } from './model';
import { reconcileRefunds } from './refunds';

// ── Fixture builders ──────────────────────────────────────────────────────────

const makeDebit = (overrides: Partial<BankLine> & Pick<BankLine, 'id' | 'amountCents' | 'normalizedMerchant'>): BankLine => ({
  accountId: 'acc-1',
  postedDate: '2024-03-01',
  direction: 'debit' as const,
  ...overrides,
});

const makeCredit = (overrides: Partial<BankLine> & Pick<BankLine, 'id' | 'amountCents' | 'normalizedMerchant'>): BankLine => ({
  accountId: 'acc-1',
  postedDate: '2024-03-05',
  direction: 'credit' as const,
  ...overrides,
});

const makeReceipt = (overrides: Partial<ReceiptView> & Pick<ReceiptView, 'id' | 'totalCents' | 'merchant'>): ReceiptView => ({
  capturedAt: '2024-03-01',
  items: [],
  ...overrides,
});

const makeAccrual = (
  overrides: Partial<StoreCreditAccrual> & Pick<StoreCreditAccrual, 'id' | 'kind' | 'amountCents'>,
): StoreCreditAccrual => ({
  occurredAt: '2024-02-14',
  ...overrides,
});

const emptyInputs = (): ReconcileInputs => ({
  householdId: 'test-hh',
  bankLines: [],
  orders: [],
  receipts: [],
  storeCreditAccruals: [],
});

// ── AC1 / FR-6: Card refund → bank CREDIT, signed negative ───────────────────

describe('card refund — bank CREDIT line', () => {
  it('creates a refund_card match and a signed-negative LedgerEvent', () => {
    const inputs: ReconcileInputs = {
      ...emptyInputs(),
      bankLines: [
        makeDebit({ id: 'bl-purchase', amountCents: -3200, normalizedMerchant: 'COSTCO' }),
        makeCredit({ id: 'bl-refund', amountCents: 1600, normalizedMerchant: 'COSTCO' }),
      ],
    };

    const { events, matches, drawdowns } = reconcileRefunds(inputs, []);

    // One refund_card match for the CREDIT line.
    const refundMatch = matches.find((m) => m.type === 'refund_card');
    expect(refundMatch).toBeDefined();
    expect(refundMatch?.transactionId).toBe('bl-refund');
    expect(refundMatch?.status).toBe('auto_linked');

    // Signed-negative event (value returning).
    const refundEvent = events.find((e) => e.id === `refund-card-bl-refund`);
    expect(refundEvent).toBeDefined();
    expect(refundEvent?.signedSpendCents).toBe(-1600); // < 0
    expect(refundEvent?.fundedBy).toBe('bank');

    // No drawdowns for a plain card refund.
    expect(drawdowns).toHaveLength(0);
  });

  it('net spend drops by refund amount when combined with purchase event', () => {
    // Simulate: purchase event (+3200) produced by dedup/engine, refund event (-1600) from here.
    const purchaseEvent: LedgerEvent = {
      id: 'purchase-event',
      signedSpendCents: 3200,
      occurredOn: '2024-03-01',
      fundedBy: 'bank',
      sources: { transactionId: 'bl-purchase' },
      mergedItems: [],
    };

    const inputs: ReconcileInputs = {
      ...emptyInputs(),
      bankLines: [makeCredit({ id: 'bl-refund', amountCents: 1600, normalizedMerchant: 'COSTCO' })],
    };

    const { events } = reconcileRefunds(inputs, []);

    const allEvents = [purchaseEvent, ...events];
    const netSpend = allEvents.reduce((sum, e) => sum + e.signedSpendCents, 0);
    expect(netSpend).toBe(1600); // 3200 (purchase) − 1600 (refund)
  });
});

// ── AC2 / AC3 / FR-7: Store-credit refund — no bank line, never unmatched ────

describe('store-credit refund — canonical test: bank shows nothing → net spend still correct', () => {
  const storeRefundInputs = (kind: StoreCreditAccrual['kind']): ReconcileInputs => ({
    ...emptyInputs(),
    orders: [
      {
        id: 'order-1',
        externalOrderId: 'AMZN-001',
        orderDate: '2024-02-01',
        orderTotalCents: 4500,
        items: [
          {
            id: 'item-1a',
            shipmentId: 'SHIP-1',
            description: 'Wireless Headphones',
            amountCents: 4500,
            isReturn: false,
          },
          {
            id: 'item-1b',
            shipmentId: 'SHIP-1',
            description: 'Wireless Headphones Return',
            amountCents: -2400,
            isReturn: true,
            refundDestination: kind,
          },
        ],
      },
    ],
    storeCreditAccruals: [
      makeAccrual({
        id: `accrual-${kind}`,
        kind,
        amountCents: 2400,
        orderId: 'order-1',
        orderItemId: 'item-1b',
      }),
    ],
  });

  for (const kind of ['store_credit', 'gift_card', 'account_balance'] as const) {
    it(`${kind} refund: signed-negative event, linked accrual, absent from unmatched`, () => {
      const inputs = storeRefundInputs(kind);
      const { events, matches, drawdowns } = reconcileRefunds(inputs, []);

      // The refund match should be store_credit_refund type.
      const refundMatch = matches.find((m) => m.type === 'store_credit_refund');
      expect(refundMatch).toBeDefined();
      expect(refundMatch?.orderId).toBe('order-1');
      expect(refundMatch?.orderItemId).toBe('item-1b');

      // Must link to the originating accrual (FR-7).
      expect(refundMatch?.storeCreditBalanceId).toBe(`accrual-${kind}`);
      expect(refundMatch?.status).toBe('auto_linked');

      // Signed-negative event (value returning, no bank line).
      const refundEvent = events.find((e) => e.signedSpendCents < 0);
      expect(refundEvent).toBeDefined();
      expect(refundEvent?.signedSpendCents).toBe(-2400);
      expect(refundEvent?.fundedBy).toBe('store_credit');

      // No bank lines involved → no drawdowns.
      expect(drawdowns).toHaveLength(0);

      // Verify net spend is correct: if we had a purchase of +4500 earlier,
      // adding -2400 refund → net = 2100.
      const purchaseEvent: LedgerEvent = {
        id: 'purchase-event',
        signedSpendCents: 4500,
        occurredOn: '2024-02-01',
        fundedBy: 'bank',
        sources: { transactionId: 'some-bank-line' },
        mergedItems: [],
      };
      const netSpend = [purchaseEvent, ...events].reduce((sum, e) => sum + e.signedSpendCents, 0);
      expect(netSpend).toBe(2100); // 4500 − 2400
    });
  }

  it('store_credit refund without a matching accrual: still auto_linked, never unmatched', () => {
    const inputs: ReconcileInputs = {
      ...emptyInputs(),
      orders: [
        {
          id: 'order-2',
          externalOrderId: 'AMZN-002',
          orderDate: '2024-03-01',
          orderTotalCents: 1999,
          items: [
            {
              id: 'item-2a',
              shipmentId: 'SHIP-2',
              description: 'Phone Case Return',
              amountCents: -1999,
              isReturn: true,
              refundDestination: 'store_credit',
            },
          ],
        },
      ],
      storeCreditAccruals: [], // no matching accrual in the database
    };

    const { events, matches } = reconcileRefunds(inputs, []);

    // Still emits a match (lower confidence, but present).
    const refundMatch = matches.find((m) => m.type === 'store_credit_refund');
    expect(refundMatch).toBeDefined();
    expect(refundMatch?.status).toBe('auto_linked');
    // storeCreditBalanceId is undefined when there is no accrual.
    expect(refundMatch?.storeCreditBalanceId).toBeUndefined();

    // Still emits a negative event.
    const refundEvent = events.find((e) => e.signedSpendCents < 0);
    expect(refundEvent).toBeDefined();
    expect(refundEvent?.signedSpendCents).toBe(-1999);
  });
});

// ── AC4 / FR-8: Partial store-credit payment ──────────────────────────────────

describe('partial store-credit payment (bank charge < receipt total)', () => {
  const partialPaymentInputs = (): ReconcileInputs => ({
    ...emptyInputs(),
    bankLines: [
      makeDebit({ id: 'bl-partial', amountCents: -6000, normalizedMerchant: 'TARGET', postedDate: '2024-03-01' }),
    ],
    receipts: [
      makeReceipt({
        id: 'receipt-partial',
        totalCents: 10000,
        merchant: 'TARGET',
        capturedAt: '2024-03-01',
      }),
    ],
    storeCreditAccruals: [
      makeAccrual({ id: 'sc-gift', kind: 'gift_card', amountCents: 5000 }),
    ],
  });

  it('emits a negative StoreCreditDrawdown for the gap', () => {
    const { drawdowns } = reconcileRefunds(partialPaymentInputs(), []);

    expect(drawdowns).toHaveLength(1);
    expect(drawdowns[0].amountCents).toBe(-4000); // gap = 10000 - 6000
    expect(drawdowns[0].kind).toBe('gift_card');
    expect(drawdowns[0].reason).toBe('partial_payment');
  });

  it('drawdown amount = receipt total − bank charge', () => {
    const { drawdowns } = reconcileRefunds(partialPaymentInputs(), []);
    const gap = 10000 - 6000;
    expect(drawdowns[0].amountCents).toBe(-gap);
  });

  it('LedgerEvent records full goods value (ADR-005) and fundedBy bank (model constraint)', () => {
    const { events } = reconcileRefunds(partialPaymentInputs(), []);

    const event = events.find((e) => e.id.startsWith('sc-partial-'));
    expect(event).toBeDefined();
    expect(event?.signedSpendCents).toBe(10000); // full receipt total
    // 'bank' is the only valid discriminated-union variant when no orderId is present;
    // 'store_credit' and 'split' both require sources.orderId (see model.ts).
    expect(event?.fundedBy).toBe('bank');
  });

  it('storeCreditBalanceId is set even when gap is covered by multiple smaller accruals', () => {
    // Two 2500¢ accruals — neither individually covers the 4000¢ gap, but together they do.
    const inputs: ReconcileInputs = {
      ...emptyInputs(),
      bankLines: [
        makeDebit({ id: 'bl-multi', amountCents: -6000, normalizedMerchant: 'TARGET', postedDate: '2024-03-01' }),
      ],
      receipts: [
        makeReceipt({ id: 'receipt-multi', totalCents: 10000, merchant: 'TARGET', capturedAt: '2024-03-01' }),
      ],
      storeCreditAccruals: [
        makeAccrual({ id: 'sc-a', kind: 'gift_card', amountCents: 2500 }),
        makeAccrual({ id: 'sc-b', kind: 'gift_card', amountCents: 2500 }),
      ],
    };

    const { drawdowns, matches } = reconcileRefunds(inputs, []);

    // Availability guard: net sum = 5000 >= gap 4000 → proceeds.
    expect(drawdowns).toHaveLength(1);
    expect(drawdowns[0].amountCents).toBe(-4000);

    // storeCreditBalanceId must be set to the largest positive accrual (not undefined).
    const scMatch = matches.find((m) => m.type === 'store_credit_drawdown');
    expect(scMatch).toBeDefined();
    // Either sc-a or sc-b (both are 2500¢ — first in sort order wins, either is valid).
    expect(scMatch?.storeCreditBalanceId).toMatch(/^sc-[ab]$/);
  });

  it('match is auto_linked and receipt not in unmatched', () => {
    const { matches } = reconcileRefunds(partialPaymentInputs(), []);

    const scMatch = matches.find((m) => m.type === 'store_credit_drawdown');
    expect(scMatch).toBeDefined();
    expect(scMatch?.status).toBe('auto_linked');
    expect(scMatch?.receiptId).toBe('receipt-partial');
    expect(scMatch?.transactionId).toBe('bl-partial');
  });

  it('does not produce a drawdown for a receipt already matched by regular matchers', () => {
    // Simulate that the receipt was already matched (receipt_bank type).
    const priorMatch: MatchRecord = {
      id: 'receipt_bank-receipt-partial-bl-partial',
      type: 'receipt_bank',
      transactionId: 'bl-partial',
      receiptId: 'receipt-partial',
      confidence: 0.95,
      rationale: 'already matched',
      status: 'auto_linked',
    };

    const { drawdowns } = reconcileRefunds(partialPaymentInputs(), [priorMatch]);
    expect(drawdowns).toHaveLength(0);
  });
});

// ── Over-drawdown guard ───────────────────────────────────────────────────────

describe('over-drawdown guard', () => {
  it('routes to review and emits no drawdown when gap exceeds available accrual', () => {
    const inputs: ReconcileInputs = {
      ...emptyInputs(),
      bankLines: [
        makeDebit({ id: 'bl-over', amountCents: -6000, normalizedMerchant: 'TARGET', postedDate: '2024-03-01' }),
      ],
      receipts: [
        makeReceipt({
          id: 'receipt-over',
          totalCents: 10000,
          merchant: 'TARGET',
          capturedAt: '2024-03-01',
        }),
      ],
      storeCreditAccruals: [
        // Only 2000¢ available, but gap is 4000¢.
        makeAccrual({ id: 'sc-short', kind: 'gift_card', amountCents: 2000 }),
      ],
    };

    const { drawdowns, matches } = reconcileRefunds(inputs, []);

    // No drawdown written (Security Model: never write a negative balance).
    expect(drawdowns).toHaveLength(0);

    // Match still emitted but routed to review.
    const scMatch = matches.find((m) => m.type === 'store_credit_drawdown');
    expect(scMatch).toBeDefined();
    expect(scMatch?.status).toBe('review');
  });

  it('routes to review when all accruals are already over-drawn (net negative)', () => {
    const inputs: ReconcileInputs = {
      ...emptyInputs(),
      bankLines: [
        makeDebit({ id: 'bl-over2', amountCents: -8000, normalizedMerchant: 'TARGET', postedDate: '2024-03-01' }),
      ],
      receipts: [
        makeReceipt({
          id: 'receipt-over2',
          totalCents: 10000,
          merchant: 'TARGET',
          capturedAt: '2024-03-01',
        }),
      ],
      storeCreditAccruals: [
        makeAccrual({ id: 'sc-prev', kind: 'gift_card', amountCents: 1000 }),
        makeAccrual({ id: 'sc-drawn', kind: 'gift_card', amountCents: -1500 }), // prior drawdown
      ],
    };

    const { drawdowns, matches } = reconcileRefunds(inputs, []);

    // Net available = 1000 - 1500 = -500 < 0 → route to review.
    expect(drawdowns).toHaveLength(0);
    const scMatch = matches.find((m) => m.type === 'store_credit_drawdown');
    expect(scMatch?.status).toBe('review');
  });
});

// ── FR-9: Net spend = purchases − refunds ─────────────────────────────────────

describe('FR-9: net spend = purchases − refunds', () => {
  it('netSpendCents over mixed fixture = Σ signedSpendCents', () => {
    // Fixture: two purchases + one card refund + one store-credit refund.
    const inputs: ReconcileInputs = {
      ...emptyInputs(),
      bankLines: [
        makeDebit({ id: 'bl-buy1', amountCents: -5000, normalizedMerchant: 'WHOLE FOODS MARKET' }),
        makeDebit({ id: 'bl-buy2', amountCents: -3200, normalizedMerchant: 'COSTCO', postedDate: '2024-03-20' }),
        makeCredit({ id: 'bl-refund', amountCents: 1600, normalizedMerchant: 'COSTCO', postedDate: '2024-03-22' }),
      ],
      orders: [
        {
          id: 'order-sc',
          externalOrderId: 'AMZN-SC',
          orderDate: '2024-02-10',
          orderTotalCents: 2000,
          items: [
            {
              id: 'item-sc',
              shipmentId: 'SHIP-SC',
              description: 'Returned Gadget',
              amountCents: -2000,
              isReturn: true,
              refundDestination: 'store_credit',
            },
          ],
        },
      ],
      storeCreditAccruals: [
        makeAccrual({ id: 'sc-1', kind: 'store_credit', amountCents: 2000, orderId: 'order-sc', orderItemId: 'item-sc' }),
      ],
    };

    // Purchase events that would come from mergeCounted / engine (story-003-003).
    const purchaseEvents: LedgerEvent[] = [
      {
        id: 'evt-buy1',
        signedSpendCents: 5000,
        occurredOn: '2024-03-01',
        fundedBy: 'bank',
        sources: { transactionId: 'bl-buy1' },
        mergedItems: [],
      },
      {
        id: 'evt-buy2',
        signedSpendCents: 3200,
        occurredOn: '2024-03-20',
        fundedBy: 'bank',
        sources: { transactionId: 'bl-buy2' },
        mergedItems: [],
      },
    ];

    const { events } = reconcileRefunds(inputs, []);
    const allEvents = [...purchaseEvents, ...events];

    const netSpend = allEvents.reduce((sum, e) => sum + e.signedSpendCents, 0);

    // 5000 + 3200 − 1600 (card refund) − 2000 (sc refund) = 4600
    expect(netSpend).toBe(4600);

    // Verify individual refund events.
    const cardRefundEvent = events.find((e) => e.id === 'refund-card-bl-refund');
    expect(cardRefundEvent?.signedSpendCents).toBe(-1600);

    const scRefundEvent = events.find((e) => e.id === 'refund-sc-order-sc-item-sc');
    expect(scRefundEvent?.signedSpendCents).toBe(-2000);
  });
});

// ── ADR-005: Refund-then-respend nets to zero new outflow ──────────────────────

describe('ADR-005: refund → store credit → respend nets to zero new outflow', () => {
  it('store-credit refund (−X) + respend via partial payment (+X) = 0 net new outflow', () => {
    // Step 1: return a $2400 item → refunded to gift card (−2400 refund event)
    const refundInputs: ReconcileInputs = {
      ...emptyInputs(),
      orders: [
        {
          id: 'order-return',
          externalOrderId: 'AMZN-RET',
          orderDate: '2024-02-10',
          orderTotalCents: 2400,
          items: [
            {
              id: 'item-return',
              shipmentId: 'SHIP-RET',
              description: 'Returned Item',
              amountCents: -2400,
              isReturn: true,
              refundDestination: 'gift_card',
            },
          ],
        },
      ],
      storeCreditAccruals: [
        makeAccrual({
          id: 'sc-return',
          kind: 'gift_card',
          amountCents: 2400,
          orderId: 'order-return',
          orderItemId: 'item-return',
        }),
      ],
    };
    const refundResult = reconcileRefunds(refundInputs, []);
    const refundNetDelta = refundResult.events.reduce((s, e) => s + e.signedSpendCents, 0);
    expect(refundNetDelta).toBe(-2400); // refund = −2400

    // Step 2: use that gift card for a $2400 purchase (fully store-credit funded).
    // Modelled as a partial payment where bank = $0 → not this code path since
    // bankAbs=0 < receipt=2400. In practice a fully-SC purchase may have no bank
    // line; here we verify the partial-payment path where bank = 0¢ debit.
    // Instead, use a realistic partial: bank=$0 scenario is edge-case; use bank=$0
    // debit + receipt=$2400 to test the zero-debit edge.
    const respendInputs: ReconcileInputs = {
      ...emptyInputs(),
      bankLines: [
        // $0 bank debit — fully store-credit funded; bank amount = 0 → bankAbs = 0 < 2400
        makeDebit({ id: 'bl-respend', amountCents: 0, normalizedMerchant: 'AMAZON', postedDate: '2024-03-15' }),
      ],
      receipts: [
        makeReceipt({ id: 'receipt-respend', totalCents: 2400, merchant: 'AMAZON', capturedAt: '2024-03-15' }),
      ],
      storeCreditAccruals: [
        makeAccrual({ id: 'sc-respend', kind: 'gift_card', amountCents: 2400 }),
      ],
    };
    const respendResult = reconcileRefunds(respendInputs, []);
    const respendNetDelta = respendResult.events.reduce((s, e) => s + e.signedSpendCents, 0);
    // Full receipt value ($2400) counts as spend per ADR-005 (funding-source-agnostic).
    expect(respendNetDelta).toBe(2400);

    // Combined: −2400 (refund) + 2400 (respend) = 0 new net outflow.
    expect(refundNetDelta + respendNetDelta).toBe(0);
  });
});
