/**
 * Synthetic fixture corpus for the H3 reconciliation engine.
 *
 * All data is FAKE: merchants, amounts, and IDs are invented. No real PII,
 * account numbers, API keys, or PANs appear here. Dates span four calendar
 * months (2024-01 through 2024-04) so that 003-007's baseline comparisons
 * always have ≥3 months of history.
 *
 * Coverage per input kind (required by gate-safety):
 *   - BankLine debit (purchase)        ✓
 *   - BankLine credit (refund)         ✓
 *   - OrderView with OrderItemViews    ✓
 *   - ReceiptView with ReceiptItemViews ✓
 *   - StoreCreditAccrual               ✓
 */

import type { ReconcileInputs } from '../model';

export const FIXTURE_HOUSEHOLD_ID = 'fixture-household-001';

export const FIXTURE_INPUTS: ReconcileInputs = {
  householdId: FIXTURE_HOUSEHOLD_ID,

  bankLines: [
    {
      id: 'bank-line-001',
      accountId: 'fixture-account-001',
      postedDate: '2024-01-15',
      amountCents: -4999,
      direction: 'debit',
      normalizedMerchant: 'WHOLE FOODS MARKET',
      lastFour: '1234',
    },
    {
      id: 'bank-line-002',
      accountId: 'fixture-account-001',
      postedDate: '2024-01-22',
      amountCents: -1299,
      direction: 'debit',
      normalizedMerchant: 'NETFLIX',
    },
    {
      id: 'bank-line-003',
      accountId: 'fixture-account-001',
      postedDate: '2024-02-03',
      amountCents: -6750,
      direction: 'debit',
      normalizedMerchant: 'AMAZON',
      lastFour: '5678',
    },
    {
      // card refund for a partial Costco return — no store-credit accrual,
      // so there is no double-credit risk here.
      id: 'bank-line-004',
      accountId: 'fixture-account-001',
      postedDate: '2024-03-22',
      amountCents: 1600,
      direction: 'credit',
      normalizedMerchant: 'COSTCO',
    },
    {
      id: 'bank-line-005',
      accountId: 'fixture-account-001',
      postedDate: '2024-03-08',
      amountCents: -8500,
      direction: 'debit',
      normalizedMerchant: 'TARGET',
      lastFour: '9012',
    },
    {
      id: 'bank-line-006',
      accountId: 'fixture-account-001',
      postedDate: '2024-03-20',
      amountCents: -3200,
      direction: 'debit',
      normalizedMerchant: 'COSTCO',
    },
    {
      id: 'bank-line-007',
      accountId: 'fixture-account-001',
      postedDate: '2024-04-05',
      amountCents: -5400,
      direction: 'debit',
      normalizedMerchant: 'WHOLE FOODS MARKET',
      lastFour: '1234',
    },
    // Amazon bank lines required for order-matching AC (FR-2).
    // bank-line-008: direct single-charge match for order-001 (4298¢).
    {
      id: 'bank-line-008',
      accountId: 'fixture-account-001',
      postedDate: '2024-01-23',
      amountCents: -4298,
      direction: 'debit',
      normalizedMerchant: 'AMAZON',
    },
    // bank-line-009 + bank-line-010: split-shipment pair for order-005 (4000+3000=7000¢).
    // Each charge is > tipAdjustmentToleranceCents (1500¢) away from the order total (7000¢)
    // so they cannot direct-match individually, forcing the subset-sum path.
    {
      id: 'bank-line-009',
      accountId: 'fixture-account-001',
      postedDate: '2024-03-11',
      amountCents: -4000,
      direction: 'debit',
      normalizedMerchant: 'AMAZON',
    },
    {
      id: 'bank-line-010',
      accountId: 'fixture-account-001',
      postedDate: '2024-03-13',
      amountCents: -3000,
      direction: 'debit',
      normalizedMerchant: 'AMAZON',
    },
  ],

  orders: [
    {
      id: 'order-001',
      externalOrderId: 'AMZN-FIXTURE-001',
      orderDate: '2024-01-20',
      orderTotalCents: 4298,
      items: [
        {
          id: 'order-item-001a',
          shipmentId: 'SHIP-001',
          description: 'Kindle Case',
          amountCents: 2999,
          isReturn: false,
        },
        {
          id: 'order-item-001b',
          shipmentId: 'SHIP-001',
          description: 'USB-C Cable',
          amountCents: 1299,
          isReturn: false,
        },
      ],
    },
    {
      id: 'order-002',
      externalOrderId: 'AMZN-FIXTURE-002',
      orderDate: '2024-02-01',
      orderTotalCents: 4500,
      items: [
        {
          id: 'order-item-002a',
          shipmentId: 'SHIP-002',
          description: 'Wireless Headphones',
          amountCents: 4500,
          isReturn: false,
        },
        {
          id: 'order-item-002b',
          shipmentId: 'SHIP-002',
          description: 'Wireless Headphones',
          amountCents: -2400,
          isReturn: true,
          refundDestination: 'gift_card',
        },
      ],
    },
    {
      id: 'order-003',
      externalOrderId: 'AMZN-FIXTURE-003',
      orderDate: '2024-03-10',
      orderTotalCents: 1499,
      items: [
        {
          id: 'order-item-003a',
          shipmentId: 'SHIP-003',
          description: 'Paperback Book',
          amountCents: 1499,
          isReturn: false,
        },
      ],
    },
    {
      id: 'order-004',
      externalOrderId: 'AMZN-FIXTURE-004',
      orderDate: '2024-04-02',
      orderTotalCents: 1999,
      items: [
        {
          id: 'order-item-004a',
          shipmentId: 'SHIP-004',
          description: 'Phone Case',
          amountCents: 1999,
          isReturn: false,
        },
      ],
    },
    {
      // Split-shipment order: two separate Amazon charges (bank-line-009 + bank-line-010)
      // sum to 7000¢. Each individual charge is > tipAdjustmentToleranceCents away from
      // the total, so only the subset-sum path resolves this order.
      id: 'order-005',
      externalOrderId: 'AMZN-FIXTURE-005',
      orderDate: '2024-03-12',
      orderTotalCents: 7000,
      items: [
        {
          id: 'order-item-005a',
          shipmentId: 'SHIP-005A',
          description: 'Mechanical Keyboard',
          amountCents: 4000,
          isReturn: false,
        },
        {
          id: 'order-item-005b',
          shipmentId: 'SHIP-005B',
          description: 'Desk Mat',
          amountCents: 3000,
          isReturn: false,
        },
      ],
    },
  ],

  receipts: [
    {
      id: 'receipt-001',
      merchant: 'WHOLE FOODS MARKET',
      capturedAt: '2024-01-15',
      totalCents: 4999,
      lastFour: '1234',
      items: [
        {
          id: 'receipt-item-001a',
          description: 'Organic Groceries',
          amountCents: 4999,
        },
      ],
    },
    {
      // intentionally unmatched — no bank line on 2024-02-20 for $35.00.
      // Exercises the unmatched.receipts code path in reconciliation.
      id: 'receipt-002',
      merchant: 'TARGET',
      capturedAt: '2024-02-20',
      totalCents: 3500,
      items: [
        {
          id: 'receipt-item-002a',
          description: 'Household Supplies',
          amountCents: 3500,
        },
      ],
    },
    {
      id: 'receipt-003',
      merchant: 'TARGET',
      capturedAt: '2024-03-08',
      totalCents: 8500,
      lastFour: '9012',
      items: [
        {
          id: 'receipt-item-003a',
          description: 'Clothing',
          amountCents: 8500,
        },
      ],
    },
    {
      id: 'receipt-004',
      merchant: 'WHOLE FOODS MARKET',
      capturedAt: '2024-04-05',
      totalCents: 5400,
      lastFour: '1234',
      items: [
        {
          id: 'receipt-item-004a',
          description: 'Organic Groceries',
          amountCents: 5400,
        },
      ],
    },
  ],

  storeCreditAccruals: [
    {
      id: 'store-credit-001',
      kind: 'gift_card',
      amountCents: 2400,
      occurredAt: '2024-02-14',
      orderId: 'order-002',
      orderItemId: 'order-item-002b',
    },
  ],
};
