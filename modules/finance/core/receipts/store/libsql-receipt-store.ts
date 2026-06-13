import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import { categories, receiptItems, receipts, schema } from './h1-schema';
import type {
  NewReceipt,
  NewReceiptItem,
  ReceiptItemRecord,
  ReceiptRecord,
  ReceiptStore,
} from './receipt-store';

type Row<T extends { $inferSelect: unknown }> = T['$inferSelect'];

// Drizzle-ORM-over-libSQL/Turso implementation of ReceiptStore, reading and
// writing H1's `receipts` / `receipt_items` / `categories` tables. Assumes the
// schema already exists (H1's migrations, or `applyStubH1Schema` in tests).
//
// H1's ids are app-generated UUID text PKs and `created_at` is an ISO-8601 text
// timestamp (ADR-001); the store generates both on insert.
export class LibSqlReceiptStore implements ReceiptStore {
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(
    private readonly db: LibSQLDatabase<typeof schema>,
    opts: { clock?: () => number; id?: () => string } = {},
  ) {
    this.now = opts.clock ?? Date.now;
    this.newId = opts.id ?? randomUUID;
  }

  async findReceiptByImageHash(hash: string): Promise<ReceiptRecord | null> {
    const rows = await this.db
      .select()
      .from(receipts)
      .where(eq(receipts.imageHash, hash))
      .limit(1);
    const row = rows[0];
    return row ? toReceiptRecord(row) : null;
  }

  async insertReceipt(r: NewReceipt): Promise<ReceiptRecord> {
    const createdAt = new Date(this.now()).toISOString();
    // H1/H2 contract reconciliation: H1 made `store`, `purchased_at` and
    // `total_cents` NOT NULL, while the H2 application contract models them as
    // nullable (the FR-6 unreadable-receipt path produces nulls — that path only
    // ever targets the in-memory StubReceiptStore, never this real H1-backed
    // store). A readable receipt always carries these, so we coerce the
    // never-null-in-practice values to H1-acceptable defaults at the boundary.
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
      .returning();
    return toReceiptRecord(rows[0]);
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
}

// Explicit row -> record mappers keep the H1-columns-only mapping visible and
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
    // H1's `image_hash` column is nullable; the H2 idempotency contract treats
    // it as required (every H2-written receipt carries the SHA-256 of its
    // bytes), so a stored row always has a hash. Coerce the H1 nullability away.
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
