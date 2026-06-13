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
export class LibSqlReceiptStore implements ReceiptStore {
  private readonly now: () => number;

  constructor(
    private readonly db: LibSQLDatabase<typeof schema>,
    opts: { clock?: () => number } = {},
  ) {
    this.now = opts.clock ?? Date.now;
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
    const rows = await this.db
      .insert(receipts)
      .values({ ...r, createdAt: this.now() })
      .returning();
    return toReceiptRecord(rows[0]);
  }

  async insertReceiptItems(items: NewReceiptItem[]): Promise<ReceiptItemRecord[]> {
    if (items.length === 0) return [];
    const createdAt = this.now();
    const rows = await this.db
      .insert(receiptItems)
      .values(items.map((item) => ({ ...item, createdAt })))
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
    imageHash: row.imageHash,
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
