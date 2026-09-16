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
  items: Array<{ sku: string | null; raw: string; canonical: string | null; cents?: number }>,
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

describe('learnFromDigitalReceipts', () => {
  beforeEach(async () => {
    ({ db, cleanup } = createTestDb());
    await db.insert(households).values([{ id: HH, name: 'A' }, { id: OTHER, name: 'B' }]);
  });
  afterEach(() => cleanup());

  it('writes the retailer’s name under the item number AND the printed abbreviation, store-canonicalised', async () => {
    await seedReceipt('r1', { purchasedAt: '2025-01-10' }, [
      { sku: '1919326', raw: '***BOUNTY*** 669SF TALL PACK', canonical: 'Bounty Advanced Paper Towels, 12-pack', cents: 2849 },
    ]);

    const summary = await learnFromDigitalReceipts(db, { householdId: HH, clock: CLOCK });

    expect(summary).toEqual({ householdId: HH, itemsSeen: 1, keys: 2, rowsBefore: 0, rowsAfter: 2 });
    const bySku = await rowFor('COSTCO', '1919326');
    const byAbbrev = await rowFor('COSTCO', 'BOUNTY 669SF TALL PACK');
    for (const row of [bySku, byAbbrev]) {
      expect(row).not.toBeNull();
      expect(row!.canonicalName).toBe('Bounty Advanced Paper Towels, 12-pack');
      expect(row!.nameConfidence).toBe(1);
      expect(row!.categoryConfidence).toBe(BOOTSTRAP_CATEGORY_CONFIDENCE);
      expect(row!.source).toBe('auto');
      expect(row!.updatedAt).toBe(CLOCK());
      expect(TAXONOMY_IDS).toContain(row!.category);
    }
  });

  it('the category is an honest guess: below the resolver’s gate, so the first photo hit asks the human once', () => {
    expect(BOOTSTRAP_CATEGORY_CONFIDENCE).toBeLessThan(0.8);
  });

  it('skips lines without a canonical name, photo receipts, other households, and unkeyable abbreviations', async () => {
    await seedReceipt('r-unnamed', { purchasedAt: '2025-01-10' }, [
      { sku: '111', raw: 'MYSTERY', canonical: null },
    ]);
    await seedReceipt('r-photo', { purchasedAt: '2025-01-11', source: 'photo', store: 'COSTCO WHOLESALE' }, [
      { sku: '222', raw: 'LLM NAMED', canonical: 'An LLM Guess' },
    ]);
    await seedReceipt('r-other', { purchasedAt: '2025-01-12', householdId: OTHER }, [
      { sku: '333', raw: 'THEIRS', canonical: 'Their Item' },
    ]);
    await seedReceipt('r-generic', { purchasedAt: '2025-01-13' }, [
      { sku: null, raw: 'ITEM', canonical: 'Named But Unkeyable' },
      { sku: null, raw: '12345', canonical: 'Digits Only Abbreviation' },
    ]);

    const summary = await learnFromDigitalReceipts(db, { householdId: HH, clock: CLOCK });

    expect(summary.itemsSeen).toBe(2); // the two generic lines are seen, then found unkeyable
    expect(summary.keys).toBe(0);
    expect(await db.select().from(skuDictionary)).toEqual([]);
  });

  it('the most recent purchase names an item bought more than once', async () => {
    await seedReceipt('r-old', { purchasedAt: '2024-06-01' }, [
      { sku: '4444', raw: 'KS EVOO', canonical: 'Kirkland Olive Oil 2L (old label)' },
    ]);
    await seedReceipt('r-new', { purchasedAt: '2025-02-01' }, [
      { sku: '4444', raw: 'KS EVOO', canonical: 'Kirkland Signature Organic Extra Virgin Olive Oil, 2 L' },
    ]);

    const summary = await learnFromDigitalReceipts(db, { householdId: HH, clock: CLOCK });

    expect(summary).toMatchObject({ itemsSeen: 2, keys: 2, rowsAfter: 2 });
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

  it('is idempotent', async () => {
    await seedReceipt('r', { purchasedAt: '2025-01-10' }, [
      { sku: '7777', raw: 'ONE', canonical: 'Item One' },
      { sku: '8888', raw: 'TWO', canonical: 'Item Two' },
    ]);
    const first = await learnFromDigitalReceipts(db, { householdId: HH, clock: CLOCK });
    const again = await learnFromDigitalReceipts(db, { householdId: HH, clock: CLOCK });

    expect(first.rowsAfter).toBe(4);
    expect(again).toEqual({ ...first, rowsBefore: 4, rowsAfter: 4 });
    expect(await db.select().from(skuDictionary)).toHaveLength(4);
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
        return { canonicalName: 'never', category: 'other', nameConfidence: 0, categoryConfidence: 0, source: 'auto' };
      },
    };
    const resolver = new LlmSkuResolver({ dictionary: new LibSqlSkuDictionary(db), llm });
    const categories = TAXONOMY_IDS;

    // Vision read the header as printed and caught the item number.
    const bySku = await resolver.resolve({ store: 'COSTCO WHOLESALE', sku: '1919326', description: 'BOUNTY', categories });
    // Vision missed the item number; only the printed abbreviation survived.
    const byAbbrev = await resolver.resolve({ store: 'Costco Wholesale #482', sku: null, description: '***BOUNTY***', categories });

    for (const r of [bySku, byAbbrev]) {
      expect(r.source).toBe('dictionary');
      expect(r.canonicalName).toBe('Bounty Advanced Paper Towels, 12-pack');
      expect(r.nameConfidence).toBe(1);
      // …and the category still goes to the human, once.
      expect(r.categoryConfidence).toBeLessThan(0.8);
    }
    expect(llmCalls).toBe(0);
  });
});

describe('renormalizeDictionaryKeys', () => {
  beforeEach(async () => {
    ({ db, cleanup } = createTestDb());
  });
  afterEach(() => cleanup());

  it('moves rows written under a superseded key to the canonical one, human beating auto on collision', async () => {
    await db.insert(skuDictionary).values([
      // Written before store canonicalisation existed.
      { store: 'COSTCO WHSE', skuOrAbbrev: 'KS EVOO', canonicalName: 'Human Said', category: 'groceries', nameConfidence: 1, categoryConfidence: 1, source: 'human', updatedAt: 5 },
      { store: 'COSTCO WHOLESALE', skuOrAbbrev: 'KS EVOO', canonicalName: 'LLM Said', category: 'other', nameConfidence: 0.9, categoryConfidence: 0.9, source: 'auto', updatedAt: 6 },
      // Already canonical: untouched.
      { store: 'COSTCO', skuOrAbbrev: '1234', canonicalName: 'Fine', category: 'other', nameConfidence: 1, categoryConfidence: 1, source: 'auto', updatedAt: 7 },
    ]);

    const result = await renormalizeDictionaryKeys(db);

    expect(result).toEqual({ examined: 3, rekeyed: 2 });
    const all = await db.select().from(skuDictionary);
    expect(all.map((r) => `${r.store}|${r.skuOrAbbrev}`).sort()).toEqual(['COSTCO|1234', 'COSTCO|KS EVOO']);
    const merged = all.find((r) => r.skuOrAbbrev === 'KS EVOO')!;
    expect(merged.canonicalName).toBe('Human Said');
    expect(merged.source).toBe('human');
  });

  it('is a no-op on an already-canonical dictionary', async () => {
    await db.insert(skuDictionary).values({ store: 'COSTCO', skuOrAbbrev: '1', canonicalName: 'X', category: 'other', nameConfidence: 1, categoryConfidence: 1, source: 'auto', updatedAt: 1 });
    expect(await renormalizeDictionaryKeys(db)).toEqual({ examined: 1, rekeyed: 0 });
  });
});
