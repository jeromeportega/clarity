import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyStubH1Schema, schema } from './h1-schema';
import { LibSqlReceiptStore } from './libsql-receipt-store';
import type { NewReceipt, NewReceiptItemDraft, ReceiptStore } from './receipt-store';
import { StubReceiptStore } from './stub-receipt-store';

// The read-again half of the ReceiptStore contract, on both implementations:
// getReceiptById (scoped), listReceiptItems, replaceReceiptExtraction.

const HH = 'hh-a';
const OTHER = 'hh-b';

const placeholder = (householdId: string, imageHash: string): NewReceipt => ({
  householdId,
  source: 'photo',
  store: null,
  purchasedAt: null,
  subtotalCents: null,
  taxCents: null,
  totalCents: null,
  paymentLast4: null,
  imageHash,
  needsReview: true,
});

const draft = (lineNo: number, rawDescription: string): NewReceiptItemDraft => ({
  lineNo,
  sku: null,
  rawDescription,
  canonicalName: `Canonical ${rawDescription}`,
  categoryId: 'groceries',
  quantity: 1,
  unitPriceCents: 100,
  linePriceCents: 100,
  discountCents: 0,
  nameConfidence: 0.95,
  categoryConfidence: 0.9,
  refundDestination: null,
  needsReview: false,
});

interface Harness {
  scoped: ReceiptStore; // scoped to HH
  unscoped: ReceiptStore;
  cleanup: () => void;
}

const factories: ReadonlyArray<readonly [string, () => Promise<Harness>]> = [
  [
    'StubReceiptStore',
    async () => {
      // The stub's scope is per instance (it holds only what was inserted
      // through it), so the "unscoped" view is the same instance.
      const scoped = new StubReceiptStore({ householdId: HH });
      return { scoped, unscoped: scoped, cleanup: () => {} };
    },
  ],
  [
    'LibSqlReceiptStore',
    async () => {
      // A file, not ':memory:': replaceReceiptExtraction runs in a transaction,
      // and libSQL's in-memory databases are per connection — the transaction's
      // connection would see an empty database.
      const dir = mkdtempSync(join(tmpdir(), 'clarity-store-reextract-'));
      const client = createClient({ url: `file:${join(dir, 'h1.db')}` });
      await applyStubH1Schema(client);
      // receipts.household_id is a FK and libSQL enforces it: seed both households.
      for (const id of [HH, OTHER]) {
        await client.execute({ sql: 'INSERT OR IGNORE INTO households (id, name) VALUES (?, ?)', args: [id, id] });
      }
      const db = drizzle(client, { schema });
      return {
        scoped: new LibSqlReceiptStore(db, { householdId: HH }),
        unscoped: new LibSqlReceiptStore(db),
        cleanup: () => {
          client.close();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
  ],
];

describe.each(factories)('ReceiptStore read-again contract — %s', (name, make) => {
  let h: Harness;
  beforeEach(async () => {
    h = await make();
  });
  afterEach(() => h.cleanup());

  it('getReceiptById returns null for an unknown id', async () => {
    expect(await h.scoped.getReceiptById('nope')).toBeNull();
  });

  it('replaceReceiptExtraction swaps the fields and the items, keeps id / hash / createdAt / household', async () => {
    const inserted = await h.scoped.insertReceipt(placeholder(HH, 'hash-1'));
    expect(await h.scoped.listReceiptItems(inserted.id)).toEqual([]);

    const replaced = await h.scoped.replaceReceiptExtraction(
      inserted.id,
      { store: 'COSTCO', purchasedAt: '2026-06-13', subtotalCents: 200, taxCents: 16, totalCents: 216, paymentLast4: '4242', needsReview: false },
      [draft(1, 'A'), draft(2, 'B')],
    );
    expect(replaced.receipt).toMatchObject({
      id: inserted.id,
      householdId: HH,
      imageHash: 'hash-1',
      createdAt: inserted.createdAt,
      store: 'COSTCO',
      purchasedAt: '2026-06-13',
      subtotalCents: 200,
      taxCents: 16,
      totalCents: 216,
      paymentLast4: '4242',
      needsReview: false,
    });
    expect(replaced.items.map((i) => [i.receiptId, i.lineNo, i.rawDescription])).toEqual([
      [inserted.id, 1, 'A'],
      [inserted.id, 2, 'B'],
    ]);
    expect(await h.scoped.getReceiptById(inserted.id)).toEqual(replaced.receipt);
    expect((await h.scoped.listReceiptItems(inserted.id)).map((i) => i.lineNo)).toEqual([1, 2]);

    // A second replacement removes the first items rather than adding to them.
    const again = await h.scoped.replaceReceiptExtraction(inserted.id, { ...replaced.receipt, store: 'TARGET' }, [draft(1, 'C')]);
    expect(again.items.map((i) => i.rawDescription)).toEqual(['C']);
    expect((await h.scoped.listReceiptItems(inserted.id)).map((i) => i.rawDescription)).toEqual(['C']);
    expect((await h.scoped.getReceiptById(inserted.id))?.store).toBe('TARGET');
  });

  it('replacing with an unreadable reading stores the placeholder shape, flagged', async () => {
    const inserted = await h.scoped.insertReceipt({ ...placeholder(HH, 'hash-2'), store: 'COSTCO', totalCents: 500, needsReview: false });
    await h.scoped.insertReceiptItems([{ ...draft(1, 'X'), receiptId: inserted.id }]);
    const replaced = await h.scoped.replaceReceiptExtraction(
      inserted.id,
      { store: null, purchasedAt: null, subtotalCents: null, taxCents: null, totalCents: null, paymentLast4: null, needsReview: true },
      [],
    );
    expect(replaced.items).toEqual([]);
    expect(replaced.receipt.needsReview).toBe(true);
    expect(await h.scoped.listReceiptItems(inserted.id)).toEqual([]);
    // The libSQL store coerces the NOT NULL columns to its placeholder values; the stub keeps nulls.
    if (name === 'LibSqlReceiptStore') {
      expect(replaced.receipt).toMatchObject({ store: '', purchasedAt: '', totalCents: 0 });
    } else {
      expect(replaced.receipt).toMatchObject({ store: null, purchasedAt: null, totalCents: null });
    }
  });

  it('getReceiptById and replaceReceiptExtraction respect the household scope', async () => {
    const theirs = await h.unscoped.insertReceipt(placeholder(OTHER, 'hash-3'));
    if (name === 'LibSqlReceiptStore') {
      expect(await h.scoped.getReceiptById(theirs.id)).toBeNull();
      await expect(
        h.scoped.replaceReceiptExtraction(theirs.id, { ...theirs, store: 'MINE' }, []),
      ).rejects.toThrow(/not found in scope/);
      expect((await h.unscoped.getReceiptById(theirs.id))?.store).toBe('');
    } else {
      // The stub's scope is per instance; a scoped stub never holds another household's row.
      expect(await h.scoped.getReceiptById(theirs.id)).toBeNull();
    }
  });
});
