import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { categories, receiptItems, receipts } from './h1-schema';
import type {
  NewReceipt,
  NewReceiptItem,
  ReceiptItemRecord,
  ReceiptRecord,
  ReceiptStore,
} from './receipt-store';

type Row<T extends { $inferSelect: unknown }> = T['$inferSelect'];

export interface LibSqlReceiptStoreOptions {
  clock?: () => number;
  id?: () => string;
  /**
   * Scope the idempotency lookup to one household. Two households may hold the
   * same photo (the unique index is on (household_id, image_hash)); without a
   * scope a lookup could return another household's receipt.
   */
  householdId?: string;
}

// Drizzle-ORM-over-libSQL/Turso implementation of ReceiptStore, reading and
// writing the `receipts` / `receipt_items` / `categories` tables. Assumes the
// schema already exists (the migrations, or `applyStubH1Schema` in tests).
//
// Ids are app-generated UUID text PKs and `created_at` is an ISO-8601 text
// timestamp; the store generates both on insert.
export class LibSqlReceiptStore implements ReceiptStore {
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly householdId: string | undefined;

  // Any Drizzle-over-libSQL handle works: only the table-level query builder is
  // used (never `db.query`), so the app's schema-less `FinanceDb` and a
  // schema-typed test handle are both assignable to this parameter.
  constructor(
    private readonly db: LibSQLDatabase<Record<string, unknown>>,
    opts: LibSqlReceiptStoreOptions = {},
  ) {
    this.now = opts.clock ?? Date.now;
    this.newId = opts.id ?? randomUUID;
    this.householdId = opts.householdId;
  }

  /** The household this store is scoped to (undefined = unscoped). */
  get scopedHouseholdId(): string | undefined {
    return this.householdId;
  }

  async findReceiptByImageHash(hash: string): Promise<ReceiptRecord | null> {
    return this.findByHash(this.householdId, hash);
  }

  async insertReceipt(r: NewReceipt): Promise<ReceiptRecord> {
    const createdAt = new Date(this.now()).toISOString();
    // `store`, `purchased_at` and `total_cents` are NOT NULL in the table while
    // the pipeline models them as nullable (the unreadable-receipt path produces
    // nulls). Such a receipt is persisted as a placeholder — '' / '' / 0 — and
    // is always flagged `needs_review` by the pipeline, so it surfaces in the
    // queue rather than being lost.
    const rows = await this.db
      .insert(receipts)
      .values({
        ...r,
        id: this.newId(),
        store: r.store ?? '',
        purchasedAt: r.purchasedAt ?? '',
        totalCents: r.totalCents ?? 0,
        createdAt,
      })
      // ux_receipts_household_hash: a concurrent insert of the same photo for
      // the same household loses the race and gets the existing row back.
      .onConflictDoNothing()
      .returning();
    const inserted = rows[0];
    if (inserted) return toReceiptRecord(inserted);

    const existing = await this.findByHash(r.householdId, r.imageHash);
    if (!existing) {
      throw new Error('receipt insert conflicted but the existing row could not be found');
    }
    return existing;
  }

  async insertReceiptItems(items: NewReceiptItem[]): Promise<ReceiptItemRecord[]> {
    if (items.length === 0) return [];
    const createdAt = new Date(this.now()).toISOString();
    const rows = await this.db
      .insert(receiptItems)
      .values(items.map((item) => ({ ...item, id: this.newId(), createdAt })))
      .returning();
    return rows.map(toReceiptItemRecord);
  }

  async listCategories(): Promise<readonly string[]> {
    const rows = await this.db
      .select({ id: categories.id })
      .from(categories)
      .orderBy(sql`rowid`); // insertion order == seed order
    return rows.map((r) => r.id);
  }

  private async findByHash(householdId: string | undefined, hash: string): Promise<ReceiptRecord | null> {
    const where = householdId
      ? and(eq(receipts.householdId, householdId), eq(receipts.imageHash, hash))
      : eq(receipts.imageHash, hash);
    const rows = await this.db.select().from(receipts).where(where).limit(1);
    const row = rows[0];
    return row ? toReceiptRecord(row) : null;
  }
}

// Explicit row -> record mappers keep the columns-only mapping visible and
// decouple the public records from Drizzle's inferred row types.
function toReceiptRecord(row: Row<typeof receipts>): ReceiptRecord {
  return {
    id: row.id,
    householdId: row.householdId,
    source: row.source,
    store: row.store,
    purchasedAt: row.purchasedAt,
    subtotalCents: row.subtotalCents,
    taxCents: row.taxCents,
    totalCents: row.totalCents,
    paymentLast4: row.paymentLast4,
    // `image_hash` is nullable in the table; the pipeline's idempotency contract
    // treats it as required (every pipeline-written receipt carries a hash), so
    // a stored row always has one. Coerce the nullability away.
    imageHash: row.imageHash ?? '',
    needsReview: row.needsReview,
    createdAt: row.createdAt,
  };
}

function toReceiptItemRecord(row: Row<typeof receiptItems>): ReceiptItemRecord {
  return {
    id: row.id,
    receiptId: row.receiptId,
    lineNo: row.lineNo,
    sku: row.sku,
    rawDescription: row.rawDescription,
    canonicalName: row.canonicalName,
    categoryId: row.categoryId,
    quantity: row.quantity,
    unitPriceCents: row.unitPriceCents,
    linePriceCents: row.linePriceCents,
    discountCents: row.discountCents,
    nameConfidence: row.nameConfidence,
    categoryConfidence: row.categoryConfidence,
    refundDestination: row.refundDestination,
    needsReview: row.needsReview,
    createdAt: row.createdAt,
  };
}
