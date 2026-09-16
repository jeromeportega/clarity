import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';

import { receiptItems, receipts } from '../../../db/schema';
import { categoryIdFor } from '../../../db/taxonomy';
import { HeuristicClassifier } from '../../classify/classifier';
import { H1_TAXONOMY } from '../../classify/taxonomy';
import { normalizeSkuOrAbbrev, normalizeStore } from './normalize';
import { skuDictionary } from './schema';

// =============================================================================
// Teach the SKU dictionary from digital receipts.
//
// A retailer's own export names every line ("Kirkland Signature Organic Extra
// Virgin Olive Oil, 2 L") next to the item number it prints on paper. A
// photographed receipt from the same retailer shows that item number — so
// every digital line the household has ever received is a free, authoritative
// answer for the photo path, under the key the resolver looks up first
// (`sku`, store-canonicalised).
//
// The item NUMBER is the only key written. The printed abbreviation is not:
// one abbreviation ("KS ORG EVOO") covers several sizes and variants, and a
// wrong name at confidence 1.0 is exactly the silent guess the review queue
// exists to prevent. A photo whose item number vision missed goes to the
// resolver's model path as before.
//
// What is written:
//   - the retailer's canonical name at name confidence 1.0 (it is the name);
//   - the CATEGORY the household has already given the line when a human set
//     one on the item (category_confidence 1.0) — at 1.0; otherwise a
//     heuristic-classifier guess from the name alone at a deliberately low
//     confidence, so the first photographed hit asks the human for the
//     category once and their answer becomes a `human` row that never asks
//     again;
//   - source `auto`, under one rule beyond the dictionary's usual law: a
//     retailer-supplied name overwrites an earlier `auto` row (an LLM's guess
//     at the same line) but never a `human` one. Re-running is idempotent.
// =============================================================================

/** Below the resolver's 0.8 gate on purpose — see the note above. */
export const BOOTSTRAP_CATEGORY_CONFIDENCE = 0.5;

/** Sources whose canonical names are the retailer's own. Photos are never here. */
export const DIGITAL_RECEIPT_SOURCES: readonly string[] = ['costco_digital'];

/** In-memory dedupe separator; never appears in a normalised key. */
const KEY_SEP = '\u001f';

const CHUNK = 100;

export interface LearnFromDigitalReceiptsOptions {
  householdId: string;
  /** Stamp for `updated_at`; injected for deterministic tests. */
  clock?: () => number;
  categoryConfidence?: number;
}

export interface LearnFromDigitalReceiptsSummary {
  householdId: string;
  /** Digital line items with a canonical name AND an item number that were considered. */
  itemsSeen: number;
  /** Distinct (store, item number) rows offered to the dictionary. */
  keys: number;
  /** Rows re-keyed under the current normalization before learning. */
  rekeyed: number;
}

type DictionaryRow = typeof skuDictionary.$inferInsert;
type Db = LibSQLDatabase<Record<string, unknown>>;

/**
 * Upsert retailer-named lines from the household's digital receipts into
 * `sku_dictionary`, after re-keying any row written under a superseded
 * normalization (so nothing already learned becomes unreachable). Idempotent;
 * never overwrites a `human` row.
 */
export async function learnFromDigitalReceipts(
  db: Db,
  opts: LearnFromDigitalReceiptsOptions,
): Promise<LearnFromDigitalReceiptsSummary> {
  const { rekeyed } = await renormalizeDictionaryKeys(db);

  const now = (opts.clock ?? Date.now)();
  const categoryConfidence = opts.categoryConfidence ?? BOOTSTRAP_CATEGORY_CONFIDENCE;
  const classifier = new HeuristicClassifier();

  // Oldest first, so when the same item was bought more than once the most
  // recent canonical name is the one that survives the in-memory dedupe.
  const lines = await db
    .select({
      sku: receiptItems.sku,
      canonicalName: receiptItems.canonicalName,
      linePriceCents: receiptItems.linePriceCents,
      categoryId: receiptItems.categoryId,
      categoryConfidence: receiptItems.categoryConfidence,
      store: receipts.store,
    })
    .from(receiptItems)
    .innerJoin(receipts, eq(receiptItems.receiptId, receipts.id))
    .where(
      and(
        eq(receipts.householdId, opts.householdId),
        inArray(receipts.source, [...DIGITAL_RECEIPT_SOURCES]),
        isNotNull(receiptItems.canonicalName),
        isNotNull(receiptItems.sku),
      ),
    )
    .orderBy(asc(receipts.purchasedAt), asc(receipts.id), asc(receiptItems.lineNo));

  const rows = new Map<string, DictionaryRow>();
  for (const line of lines) {
    const canonicalName = line.canonicalName!.trim();
    if (canonicalName === '') continue;
    const store = normalizeStore(line.store);
    const key = normalizeSkuOrAbbrev(line.sku!);
    if (store === '' || key === '') continue;

    // A category the household has already settled on this line is theirs;
    // anything else is a guess from the name, and priced as one.
    const human = line.categoryId !== null && line.categoryConfidence === 1;
    const category = human
      ? line.categoryId!
      : (categoryIdFor(
          classifier.classify({ merchant: '', description: canonicalName, amountCents: line.linePriceCents }, H1_TAXONOMY)
            .category,
        ) ?? 'other');

    rows.set(`${store}${KEY_SEP}${key}`, {
      store,
      skuOrAbbrev: key,
      canonicalName,
      category,
      nameConfidence: 1.0,
      categoryConfidence: human ? 1.0 : categoryConfidence,
      source: 'auto',
      updatedAt: now,
    });
  }

  const values = [...rows.values()];
  for (let i = 0; i < values.length; i += CHUNK) {
    await db
      .insert(skuDictionary)
      .values(values.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: [skuDictionary.store, skuDictionary.skuOrAbbrev],
        set: {
          canonicalName: sql`excluded.canonical_name`,
          category: sql`excluded.category`,
          nameConfidence: sql`excluded.name_confidence`,
          categoryConfidence: sql`excluded.category_confidence`,
          source: sql`excluded.source`,
          updatedAt: sql`excluded.updated_at`,
        },
        // The retailer's name beats an earlier LLM guess; a human's answer
        // beats everything.
        setWhere: sql`${skuDictionary.source} = 'auto'`,
      });
  }

  return { householdId: opts.householdId, itemsSeen: lines.length, keys: values.length, rekeyed };
}

/**
 * Re-key every dictionary row with the current normalization, in one
 * transaction. Needed whenever `normalizeStore` / `normalizeSkuOrAbbrev` learn
 * a new rule: rows written under the old key would otherwise never be found
 * again. A row whose key is already canonical is untouched. When several rows
 * collapse onto one key, ONE survives: a `human` row over an `auto` one, and
 * among equals the most recently updated — so a newer correction is never
 * replaced by an older one. A row whose new key would be empty is left alone.
 */
export async function renormalizeDictionaryKeys(db: Db): Promise<{ examined: number; rekeyed: number }> {
  type Row = typeof skuDictionary.$inferSelect;
  const all = await db.select().from(skuDictionary);

  // Group every row (moving or not) by the key it belongs under.
  const groups = new Map<string, { store: string; skuOrAbbrev: string; rows: Row[] }>();
  let moving = 0;
  for (const row of all) {
    const store = normalizeStore(row.store);
    const skuOrAbbrev = normalizeSkuOrAbbrev(row.skuOrAbbrev);
    if (store === '' || skuOrAbbrev === '') continue;
    if (store !== row.store || skuOrAbbrev !== row.skuOrAbbrev) moving += 1;
    const k = `${store}${KEY_SEP}${skuOrAbbrev}`;
    const g = groups.get(k) ?? { store, skuOrAbbrev, rows: [] };
    g.rows.push(row);
    groups.set(k, g);
  }
  if (moving === 0) return { examined: all.length, rekeyed: 0 };

  const rank = (r: Row): number => (r.source === 'human' ? 1 : 0);
  await db.transaction(async (tx) => {
    for (const g of groups.values()) {
      const movers = g.rows.filter((r) => r.store !== g.store || r.skuOrAbbrev !== g.skuOrAbbrev);
      if (movers.length === 0) continue;
      const winner = [...g.rows].sort((a, b) => rank(b) - rank(a) || b.updatedAt - a.updatedAt)[0]!;
      for (const r of movers) {
        await tx
          .delete(skuDictionary)
          .where(and(eq(skuDictionary.store, r.store), eq(skuDictionary.skuOrAbbrev, r.skuOrAbbrev)));
      }
      const { store: _s, skuOrAbbrev: _k, ...fields } = winner;
      await tx
        .insert(skuDictionary)
        .values({ ...fields, store: g.store, skuOrAbbrev: g.skuOrAbbrev })
        .onConflictDoUpdate({ target: [skuDictionary.store, skuDictionary.skuOrAbbrev], set: fields });
    }
  });

  return { examined: all.length, rekeyed: moving };
}
