import { and, eq, sql } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { normalizeSkuOrAbbrev, normalizeStore } from './normalize';
import { schema, skuDictionary } from './schema';
import type { DictionaryEntry, SkuDictionary } from './sku-dictionary';

// Drizzle-ORM-over-libSQL/Turso implementation of SkuDictionary, reading and
// writing H2's own `sku_dictionary` table. Assumes the table already exists
// (`applySkuDictionarySchema` in tests).
export class LibSqlSkuDictionary implements SkuDictionary {
  constructor(private readonly db: LibSQLDatabase<typeof schema>) {}

  async lookup(store: string, skuOrAbbrev: string): Promise<DictionaryEntry | null> {
    const rows = await this.db
      .select()
      .from(skuDictionary)
      .where(
        and(
          eq(skuDictionary.store, normalizeStore(store)),
          eq(skuDictionary.skuOrAbbrev, normalizeSkuOrAbbrev(skuOrAbbrev)),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? toEntry(row) : null;
  }

  async upsert(entry: DictionaryEntry): Promise<void> {
    const row = {
      store: normalizeStore(entry.store),
      skuOrAbbrev: normalizeSkuOrAbbrev(entry.skuOrAbbrev),
      canonicalName: entry.canonicalName,
      category: entry.category,
      nameConfidence: entry.nameConfidence,
      categoryConfidence: entry.categoryConfidence,
      source: entry.source,
      updatedAt: entry.updatedAt,
    };
    // Human-wins precedence enforced in one statement: on key conflict, update
    // ONLY when the incoming row is human. An incoming auto row therefore never
    // overwrites an existing row (auto or human); a fresh key always inserts.
    await this.db
      .insert(skuDictionary)
      .values(row)
      .onConflictDoUpdate({
        target: [skuDictionary.store, skuDictionary.skuOrAbbrev],
        set: {
          canonicalName: row.canonicalName,
          category: row.category,
          nameConfidence: row.nameConfidence,
          categoryConfidence: row.categoryConfidence,
          source: row.source,
          updatedAt: row.updatedAt,
        },
        setWhere: sql`excluded.source = 'human'`,
      });
  }
}

type Row = typeof skuDictionary.$inferSelect;

function toEntry(row: Row): DictionaryEntry {
  return {
    store: row.store,
    skuOrAbbrev: row.skuOrAbbrev,
    canonicalName: row.canonicalName,
    category: row.category,
    nameConfidence: row.nameConfidence,
    categoryConfidence: row.categoryConfidence,
    source: row.source,
    updatedAt: row.updatedAt,
  };
}
