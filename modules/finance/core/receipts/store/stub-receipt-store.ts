import { CATEGORY_SEED } from './h1-schema';
import type {
  NewReceipt,
  NewReceiptItem,
  ReceiptItemRecord,
  ReceiptRecord,
  ReceiptStore,
} from './receipt-store';

// In-memory ReceiptStore mirroring exactly the persisted columns. Used by
// `npm test` so the pipeline is testable offline (no key, no network). Because
// it is typed against the same record types as the libSQL store, any schema
// drift surfaces as a TypeScript error rather than silent data.
export class StubReceiptStore implements ReceiptStore {
  private readonly receipts: ReceiptRecord[] = [];
  private readonly items: ReceiptItemRecord[] = [];
  private nextReceiptId = 1;
  private nextItemId = 1;
  private readonly now: () => number;
  private readonly householdId: string | undefined;

  constructor(opts: { clock?: () => number; householdId?: string } = {}) {
    this.now = opts.clock ?? Date.now;
    this.householdId = opts.householdId;
  }

  /** The household this store is scoped to (undefined = unscoped). */
  get scopedHouseholdId(): string | undefined {
    return this.householdId;
  }

  async findReceiptByImageHash(hash: string): Promise<ReceiptRecord | null> {
    const found = this.receipts.find(
      (r) => r.imageHash === hash && (this.householdId === undefined || r.householdId === this.householdId),
    );
    return found ? { ...found } : null;
  }

  async insertReceipt(r: NewReceipt): Promise<ReceiptRecord> {
    // Same identity rule as the libSQL store: one receipt per (household, hash).
    const existing = this.receipts.find((x) => x.householdId === r.householdId && x.imageHash === r.imageHash);
    if (existing) return { ...existing };
    // Mirror the identity columns: a text id and an ISO-8601 createdAt.
    const record: ReceiptRecord = {
      ...r,
      id: `receipt-${this.nextReceiptId++}`,
      createdAt: new Date(this.now()).toISOString(),
    };
    this.receipts.push(record);
    return { ...record };
  }

  async insertReceiptItems(items: NewReceiptItem[]): Promise<ReceiptItemRecord[]> {
    const createdAt = new Date(this.now()).toISOString();
    const records: ReceiptItemRecord[] = items.map((item) => ({
      ...item,
      id: `item-${this.nextItemId++}`,
      createdAt,
    }));
    this.items.push(...records);
    return records.map((r) => ({ ...r }));
  }

  async listCategories(): Promise<readonly string[]> {
    return [...CATEGORY_SEED];
  }
}
