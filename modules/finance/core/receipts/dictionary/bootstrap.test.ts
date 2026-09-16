/**
 * learnFromDigitalReceipts — digital receipts teach the dictionary what the
 * photo path will look up.
 */
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type FinanceDb } from '../../../db/client';
import { TAXONOMY_IDS } from '../../../db/taxonomy';
import { households, receiptItems, receipts } from '../../../db/schema';
import type { Resolution, ResolutionQuery, SkuResolver } from '../resolver/sku-resolver';
import { LlmSkuResolver } from '../resolver/llm-resolver';
import { BOOTSTRAP_CATEGORY_CONFIDENCE, learnFromDigitalReceipts, renormalizeDictionaryKeys } from './bootstrap';
import { LibSqlSkuDictionary } from './libsql-sku-dictionary';
import { skuDictionary } from './schema';

const HH = 'hh-dict';
const OTHER = 'hh-dict-other';
const CLOCK = () => 1_700_000_000_000;

let db: FinanceDb;
let cleanup: () => void;

async function seedReceipt(
  id: string,
  opts: { householdId?: string; source?: string; store?: string; purchasedAt: string },
  items: Array<{ sku: string | null; raw: string; canonical: string | null; cents?: number; categoryId?: string; categoryConfidence?: number }>,
): Promise<void> {
  await db.insert(receipts).values({
    id,
    householdId: opts.householdId ?? HH,
    source: opts.source ?? 'costco_digital',
    store: opts.store ?? 'COSTCO WHSE',
    purchasedAt: opts.purchasedAt,
    totalCents: items.reduce((s, i) => s + (i.cents ?? 1000), 0),
  });
  await db.insert(receiptItems).values(
    items.map((i, idx) => ({
      id: `${id}-ri-${idx + 1}`,
      receiptId: id,
      lineNo: idx + 1,
      sku: i.sku,
      rawDescription: i.raw,
      canonicalName: i.canonical,
      categoryId: i.categoryId ?? null,
      categoryConfidence: i.categoryConfidence ?? null,
      quantity: 1,
      linePriceCents: i.cents ?? 1000,
      nameConfidence: i.canonical === null ? null : 1,
      needsReview: i.canonical === null,
    })),
  );
}

async function rowFor(store: string, key: string) {
  const rows = await db.select().from(skuDictionary).where(eq(skuDictionary.skuOrAbbrev, key));
  return rows.find((r) => r.store === store) ?? null;
}

async function allRows() {
  return db.select().from(skuDictionary);
}

describe('learnFromDigitalReceipts', () => {
  beforeEach(async () => {
    ({ db, cleanup } = createTestDb());
    await db.insert(households).values([{ id: HH, name: 'A' }, { id: OTHER, name: 'B' }]);
  });
  afterEach(() => cleanup());

  it('writes the retailer’s name under the item number, store-canonicalised — and under nothing else', async () => {
    await seedReceipt('r1', { purchasedAt: '2025-01-10' }, [
      { sku: '1919326', raw: '***BOUNTY*** 669SF TALL PACK', canonical: 'Bounty Advanced Paper Towels, 12-pack', cents: 2849 },
    ]);

    const summary = await learnFromDigitalReceipts(db, { householdId: HH, clock: CLOCK });

    expect(summary).toEqual({ householdId: HH, itemsSeen: 1, keys: 1, rekeyed: 0 });
    const rows = await allRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.store).toBe('COSTCO');
    expect(row.skuOrAbbrev).toBe('1919326');
    expect(row.canonicalName).toBe('Bounty Advanced Paper Towels, 12-pack');
    expect(row.nameConfidence).toBe(1);
    expect(row.categoryConfidence).toBe(BOOTSTRAP_CATEGORY_CONFIDENCE);
    expect(row.source).toBe('auto');
    expect(row.updatedAt).toBe(CLOCK());
    expect(TAXONOMY_IDS).toContain(row.category);
    // The printed abbreviation is NOT a key: one abbreviation covers many items.
    expect(await rowFor('COSTCO', 'BOUNTY 669SF TALL PACK')).toBeNull();
  });

  it('the category is an honest guess: below the resolver’s gate, so the first photo hit asks the human once', () => {
    expect(BOOTSTRAP_CATEGORY_CONFIDENCE).toBeLessThan(0.8);
  });

  it('the guess comes from the name alone, never a merchant catch-all', async () => {
    await seedReceipt('r', { purchasedAt: '2025-01-10' }, [
      { sku: '1', raw: 'WIDGET', canonical: 'Widget Deluxe' },
      { sku: '2', raw: 'KS PT', canonical: 'Kirkland Signature Paper Towels, 12-count' },
    ]);
    await learnFromDigitalReceipts(db, { householdId: HH, clock: CLOCK });

    expect((await rowFor('COSTCO', '1'))!.category).toBe('other');
    expect((await rowFor('COSTCO', '2'))!.category).toBe('household');
  });

  it('a category the household already settled on the line is written as theirs, at 1.0', async () => {
    await seedReceipt('r', { purchasedAt: '2025-01-10' }, [
      { sku: '3', raw: 'PT', canonical: 'Bounty Paper Towels', categoryId: 'household', categoryConfidence: 1 },
      { sku: '4', raw: 'PT2', canonical: 'Brawny Paper Towels', categoryId: 'shopping', categoryConfidence: 0.6 },
    ]);
    await learnFromDigitalReceipts(db, { householdId: HH, clock: CLOCK });

    const human = (await rowFor('COSTCO', '3'))!;
    expect(human.category).toBe('household');
    expect(human.categoryConfidence).toBe(1);
    // Anything below a human's certainty is re-guessed from the name and priced as a guess.
    expect((await rowFor('COSTCO', '4'))!.categoryConfidence).toBe(BOOTSTRAP_CATEGORY_CONFIDENCE);
  });

  it('skips lines without a canonical name or item number, empty names, non-digital sources, and other households', async () => {
    await seedReceipt('r-unnamed', { purchasedAt: '2025-01-10' }, [
      { sku: '111', raw: 'MYSTERY', canonical: null },
      { sku: null, raw: 'NO NUMBER', canonical: 'Named But Numberless' },
      { sku: '112', raw: 'BLANK', canonical: '   ' },
    ]);
    await seedReceipt('r-photo', { purchasedAt: '2025-01-11', source: 'photo', store: 'COSTCO WHOLESALE' }, [
      { sku: '222', raw: 'LLM NAMED', canonical: 'An LLM Guess' },
    ]);
    await seedReceipt('r-future-source', { purchasedAt: '2025-01-11', source: 'some_new_source' }, [
      { sku: '223', raw: 'X', canonical: 'Not Allowlisted' },
    ]);
    await seedReceipt('r-other', { purchasedAt: '2025-01-12', householdId: OTHER }, [
      { sku: '333', raw: 'THEIRS', canonical: 'Their Item' },
    ]);

    const summary = await learnFromDigitalReceipts(db, { householdId: HH, clock: CLOCK });

    expect(summary.itemsSeen).toBe(1); // the blank-name line is seen, then found empty
    expect(summary.keys).toBe(0);
    expect(await allRows()).toEqual([]);
  });

  it('the most recent purchase names an item bought more than once; a refund line is a purchase of the same item', async () => {
    await seedReceipt('r-old', { purchasedAt: '2024-06-01' }, [
      { sku: '4444', raw: 'KS EVOO', canonical: 'Kirkland Olive Oil 2L (old label)' },
    ]);
    await seedReceipt('r-new', { purchasedAt: '2025-02-01' }, [
      { sku: '4444', raw: 'KS EVOO', canonical: 'Kirkland Signature Organic Extra Virgin Olive Oil, 2 L' },
    ]);
    await seedReceipt('r-refund', { purchasedAt: '2025-03-01' }, [
      { sku: '4444', raw: 'KS EVOO', canonical: 'Kirkland Signature Organic Extra Virgin Olive Oil, 2 L', cents: -1899 },
    ]);

    const summary = await learnFromDigitalReceipts(db, { householdId: HH, clock: CLOCK });

    expect(summary).toMatchObject({ itemsSeen: 3, keys: 1 });
    expect((await rowFor('COSTCO', '4444'))!.canonicalName).toBe('Kirkland Signature Organic Extra Virgin Olive Oil, 2 L');
  });

  it('a retailer’s name replaces an earlier LLM guess but never a human’s answer', async () => {
    await db.insert(skuDictionary).values([
      { store: 'COSTCO', skuOrAbbrev: '5555', canonicalName: 'Some LLM Guess', category: 'other', nameConfidence: 0.85, categoryConfidence: 0.85, source: 'auto', updatedAt: 1 },
      { store: 'COSTCO', skuOrAbbrev: '6666', canonicalName: 'What The Human Said', category: 'household', nameConfidence: 1, categoryConfidence: 1, source: 'human', updatedAt: 1 },
    ]);
    await seedReceipt('r', { purchasedAt: '2025-01-10' }, [
      { sku: '5555', raw: 'A', canonical: 'Retailer Name A' },
      { sku: '6666', raw: 'B', canonical: 'Retailer Name B' },
    ]);

    await learnFromDigitalReceipts(db, { householdId: HH, clock: CLOCK });

    expect((await rowFor('COSTCO', '5555'))!.canonicalName).toBe('Retailer Name A');
    const human = (await rowFor('COSTCO', '6666'))!;
    expect(human.canonicalName).toBe('What The Human Said');
    expect(human.category).toBe('household');
    expect(human.source).toBe('human');
    expect(human.updatedAt).toBe(1);
  });

  it('is idempotent, and writes every row of a large import (chunked)', async () => {
    const many = Array.from({ length: 230 }, (_, i) => ({ sku: String(100000 + i), raw: `ITEM ${i}`, canonical: `Item Number ${i}` }));
    await seedReceipt('r-big', { purchasedAt: '2025-01-10' }, many);

    const first = await learnFromDigitalReceipts(db, { householdId: HH, clock: CLOCK });
    const again = await learnFromDigitalReceipts(db, { householdId: HH, clock: CLOCK });

    expect(first).toEqual({ householdId: HH, itemsSeen: 230, keys: 230, rekeyed: 0 });
    expect(again).toEqual(first);
    const rows = await allRows();
    expect(rows).toHaveLength(230);
    // Per-row binding of the upsert: the last chunk's rows carry their own names.
    expect((await rowFor('COSTCO', '100229'))!.canonicalName).toBe('Item Number 229');
  });

  it('re-keys rows written under a superseded normalization before learning', async () => {
    await db.insert(skuDictionary).values({
      store: 'COSTCO WHSE', skuOrAbbrev: '7777', canonicalName: 'Human Said', category: 'groceries', nameConfidence: 1, categoryConfidence: 1, source: 'human', updatedAt: 5,
    });
    await seedReceipt('r', { purchasedAt: '2025-01-10' }, [{ sku: '7777', raw: 'X', canonical: 'Retailer Name' }]);

    const summary = await learnFromDigitalReceipts(db, { householdId: HH, clock: CLOCK });

    expect(summary.rekeyed).toBe(1);
    const rows = await allRows();
    expect(rows).toHaveLength(1);
    // The human's row moved to the canonical key and the retailer did not overwrite it.
    expect(rows[0]).toMatchObject({ store: 'COSTCO', skuOrAbbrev: '7777', canonicalName: 'Human Said', source: 'human' });
  });

  it('closes the loop: a photographed line from the same retailer resolves from the dictionary with no model call', async () => {
    await seedReceipt('r', { purchasedAt: '2025-01-10' }, [
      { sku: '1919326', raw: '***BOUNTY***', canonical: 'Bounty Advanced Paper Towels, 12-pack', cents: 2849 },
    ]);
    await learnFromDigitalReceipts(db, { householdId: HH, clock: CLOCK });

    let llmCalls = 0;
    const llm: SkuResolver = {
      async resolve(_q: ResolutionQuery): Promise<Resolution> {
        llmCalls += 1;
        return { canonicalName: 'model guess', category: 'other', nameConfidence: 0.9, categoryConfidence: 0.9, source: 'auto' };
      },
    };
    const resolver = new LlmSkuResolver({ dictionary: new LibSqlSkuDictionary(db), llm });
    const categories = TAXONOMY_IDS;

    // Vision read the header as printed and caught the item number.
    const bySku = await resolver.resolve({ store: 'COSTCO WHOLESALE', sku: '1919326', description: 'BOUNTY', categories });
    expect(bySku.source).toBe('dictionary');
    expect(bySku.canonicalName).toBe('Bounty Advanced Paper Towels, 12-pack');
    expect(bySku.nameConfidence).toBe(1);
    // …and the category still goes to the human, once.
    expect(bySku.categoryConfidence).toBeLessThan(0.8);
    expect(llmCalls).toBe(0);

    // Vision missed the item number: the model path, as before — never a
    // retailer name guessed from an ambiguous abbreviation.
    const byAbbrev = await resolver.resolve({ store: 'Costco Wholesale #482', sku: null, description: '***BOUNTY***', categories });
    expect(byAbbrev.source).toBe('auto');
    expect(llmCalls).toBe(1);
  });
});

describe('renormalizeDictionaryKeys', () => {
  beforeEach(async () => {
    ({ db, cleanup } = createTestDb());
  });
  afterEach(() => cleanup());

  const row = (store: string, key: string, name: string, source: 'auto' | 'human', updatedAt: number) => ({
    store, skuOrAbbrev: key, canonicalName: name, category: 'other', nameConfidence: 1, categoryConfidence: 1, source, updatedAt,
  });

  it('moves rows written under a superseded key to the canonical one; human beats auto on collision', async () => {
    await db.insert(skuDictionary).values([
      row('COSTCO WHSE', 'KS EVOO', 'Human Said', 'human', 5),
      row('COSTCO WHOLESALE', 'KS EVOO', 'LLM Said', 'auto', 6),
      row('COSTCO', '1234', 'Fine', 'auto', 7), // already canonical: untouched
    ]);

    const result = await renormalizeDictionaryKeys(db);

    expect(result).toEqual({ examined: 3, rekeyed: 2 });
    const all = await allRows();
    expect(all.map((r) => `${r.store}|${r.skuOrAbbrev}`).sort()).toEqual(['COSTCO|1234', 'COSTCO|KS EVOO']);
    const merged = all.find((r) => r.skuOrAbbrev === 'KS EVOO')!;
    expect(merged.canonicalName).toBe('Human Said');
    expect(merged.source).toBe('human');
  });

  it('between two human answers the NEWER one survives, whichever key it sat under', async () => {
    await db.insert(skuDictionary).values([
      row('COSTCO WHSE', '1234', 'OLD HUMAN (stale key)', 'human', 10),
      row('COSTCO', '1234', 'NEW HUMAN (canonical key)', 'human', 20),
    ]);
    await renormalizeDictionaryKeys(db);
    const all = await allRows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ store: 'COSTCO', skuOrAbbrev: '1234', canonicalName: 'NEW HUMAN (canonical key)', updatedAt: 20 });

    // And the other way round: the newer answer was the one under the stale key.
    await db.delete(skuDictionary);
    await db.insert(skuDictionary).values([
      row('COSTCO WHSE', '1234', 'NEW HUMAN (stale key)', 'human', 30),
      row('COSTCO', '1234', 'OLD HUMAN (canonical key)', 'human', 20),
    ]);
    await renormalizeDictionaryKeys(db);
    expect((await allRows())[0]).toMatchObject({ canonicalName: 'NEW HUMAN (stale key)', updatedAt: 30 });
  });

  it('an old-key auto row never displaces a canonical-key human row, even when newer', async () => {
    await db.insert(skuDictionary).values([
      row('COSTCO WHSE', '1234', 'newer auto', 'auto', 99),
      row('COSTCO', '1234', 'older human', 'human', 1),
    ]);
    await renormalizeDictionaryKeys(db);
    const all = await allRows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ canonicalName: 'older human', source: 'human' });
  });

  it('leaves alone a row whose canonical key would be empty', async () => {
    await db.insert(skuDictionary).values([row('COSTCO WHSE', '***', 'Stars', 'auto', 1)]);
    expect(await renormalizeDictionaryKeys(db)).toEqual({ examined: 1, rekeyed: 0 });
    expect((await allRows())[0]).toMatchObject({ store: 'COSTCO WHSE', skuOrAbbrev: '***' });
  });

  it('is a no-op on an already-canonical dictionary, and idempotent', async () => {
    await db.insert(skuDictionary).values([row('COSTCO WHSE', '1', 'X', 'auto', 1), row('COSTCO', '2', 'Y', 'auto', 1)]);
    expect(await renormalizeDictionaryKeys(db)).toEqual({ examined: 2, rekeyed: 1 });
    expect(await renormalizeDictionaryKeys(db)).toEqual({ examined: 2, rekeyed: 0 });
  });
});
