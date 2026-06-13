import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyStubH1Schema, CATEGORY_SEED, schema } from './h1-schema';
import { LibSqlReceiptStore } from './libsql-receipt-store';
import type {
  NewReceipt,
  NewReceiptItem,
  ReceiptItemRecord,
  ReceiptRecord,
  ReceiptStore,
} from './receipt-store';
import { StubReceiptStore } from './stub-receipt-store';

const RECEIPT_KEYS = [
  'id',
  'householdId',
  'source',
  'store',
  'purchasedAt',
  'subtotalCents',
  'taxCents',
  'totalCents',
  'paymentLast4',
  'imageHash',
  'needsReview',
  'createdAt',
].sort();

const sampleReceipt = (overrides: Partial<NewReceipt> = {}): NewReceipt => ({
  householdId: 'household-1',
  source: 'photo',
  store: 'COSTCO',
  purchasedAt: '2026-06-13',
  subtotalCents: 23000,
  taxCents: 417,
  totalCents: 23417,
  paymentLast4: '4242',
  imageHash: 'hash-1',
  needsReview: false,
  ...overrides,
});

interface Harness {
  store: ReceiptStore;
  cleanup: () => void;
}

const factories: ReadonlyArray<readonly [string, () => Promise<Harness>]> = [
  [
    'StubReceiptStore',
    async () => ({ store: new StubReceiptStore(), cleanup: () => {} }),
  ],
  [
    'LibSqlReceiptStore',
    async () => {
      const client = createClient({ url: ':memory:' });
      await applyStubH1Schema(client);
      const db = drizzle(client, { schema });
      return { store: new LibSqlReceiptStore(db), cleanup: () => client.close() };
    },
  ],
];

describe.each(factories)('ReceiptStore contract — %s', (_name, make) => {
  let store: ReceiptStore;
  let cleanup: () => void;

  beforeEach(async () => {
    ({ store, cleanup } = await make());
  });
  afterEach(() => cleanup());

  it('findReceiptByImageHash returns null on an empty store (cold path, no throw)', async () => {
    await expect(store.findReceiptByImageHash('nope')).resolves.toBeNull();
  });

  it('insertReceipt assigns an id and echoes back ONLY H1 columns; round-trips via findByImageHash', async () => {
    const input = sampleReceipt();
    const inserted = await store.insertReceipt(input);

    expect(Object.keys(inserted).sort()).toEqual(RECEIPT_KEYS);
    expect(typeof inserted.id).toBe('string');
    expect(typeof inserted.createdAt).toBe('string');
    // Every supplied H1 column echoes back unchanged.
    expect(inserted).toMatchObject(input);

    const found = await store.findReceiptByImageHash('hash-1');
    expect(found).toEqual(inserted);
  });

  it('insertReceiptItems assigns ids, links receipt_id, and preserves signed line prices', async () => {
    const receipt = await store.insertReceipt(sampleReceipt());
    const items: NewReceiptItem[] = [
      {
        receiptId: receipt.id,
        lineNo: 1,
        sku: 'KS-EVOO',
        rawDescription: 'KS ORG EVOO 2CT',
        canonicalName: 'Kirkland Organic Olive Oil',
        categoryId: 'groceries',
        quantity: 1,
        unitPriceCents: 1899,
        linePriceCents: 1899,
        discountCents: 0,
        nameConfidence: 0.95,
        categoryConfidence: 0.9,
        refundDestination: null,
        needsReview: false,
      },
      {
        receiptId: receipt.id,
        lineNo: 2,
        sku: null,
        rawDescription: 'RETURN WHOLE MILK',
        canonicalName: null,
        categoryId: null,
        quantity: 1,
        unitPriceCents: null,
        linePriceCents: -399, // signed: a return
        discountCents: 0,
        nameConfidence: null,
        categoryConfidence: null,
        refundDestination: 'card',
        needsReview: true,
      },
    ];

    const inserted = await store.insertReceiptItems(items);

    expect(inserted).toHaveLength(2);
    expect(new Set(inserted.map((i) => i.id)).size).toBe(2); // unique ids
    for (const item of inserted) {
      expect(typeof item.id).toBe('string');
      expect(item.receiptId).toBe(receipt.id); // linked
      expect(item.discountCents).toBeGreaterThanOrEqual(0);
    }
    expect(inserted[0].linePriceCents).toBe(1899);
    expect(inserted[1].linePriceCents).toBe(-399); // signed return preserved
    expect(inserted[1].refundDestination).toBe('card');
    // Strip store-assigned fields; the H1 columns echo back exactly as supplied.
    expect(inserted.map(({ id, createdAt, ...rest }) => rest)).toEqual(items);
  });

  it('insertReceiptItems on an empty list is a no-op', async () => {
    await expect(store.insertReceiptItems([])).resolves.toEqual([]);
  });

  it('listCategories returns the H1 taxonomy verbatim from seed (single source of truth)', async () => {
    const categories = await store.listCategories();
    expect(categories).toEqual([...CATEGORY_SEED]);
    // No new category beyond the seed, and no duplicates.
    expect(new Set(categories).size).toBe(CATEGORY_SEED.length);
  });
});

describe('ReceiptStore — stub and libSQL are behaviorally interchangeable', () => {
  it('produce identical observable records for the same insert -> find', async () => {
    const stub = new StubReceiptStore();

    const client = createClient({ url: ':memory:' });
    await applyStubH1Schema(client);
    const libsql = new LibSqlReceiptStore(drizzle(client, { schema }));

    const input = sampleReceipt({ imageHash: 'shared-hash' });

    const fromStub = await stub.insertReceipt(input);
    const fromLibsql = await libsql.insertReceipt(input);

    // Ignore store-assigned volatile fields; the observable H1 columns match.
    const strip = ({ id, createdAt, ...rest }: ReceiptRecord) => rest;
    expect(strip(fromStub)).toEqual(strip(fromLibsql));

    const items: NewReceiptItem[] = [
      {
        receiptId: fromStub.id,
        lineNo: 1,
        sku: 'A',
        rawDescription: 'THING',
        canonicalName: 'Thing',
        categoryId: 'household',
        quantity: 2,
        unitPriceCents: 500,
        linePriceCents: 1000,
        discountCents: 150,
        nameConfidence: 0.8,
        categoryConfidence: 0.8,
        refundDestination: null,
        needsReview: false,
      },
    ];
    const stubItems = await stub.insertReceiptItems(
      items.map((i) => ({ ...i, receiptId: fromStub.id })),
    );
    const libsqlItems = await libsql.insertReceiptItems(
      items.map((i) => ({ ...i, receiptId: fromLibsql.id })),
    );
    const stripItem = ({ id, receiptId, createdAt, ...rest }: ReceiptItemRecord) => rest;
    expect(stubItems.map(stripItem)).toEqual(libsqlItems.map(stripItem));

    expect(await stub.listCategories()).toEqual(await libsql.listCategories());

    client.close();
  });
});
