import type { NormalizedBatch, RawInput, SourceAdapter } from '../source-adapter';
import { parseCostcoReceipts } from './parse';

/**
 * Costco digital in-warehouse receipt importer. File-based only — it reads the
 * bytes of a saved `WarehouseReceiptDetail` JSON export and never opens a live
 * connection or handles credentials.
 *
 * It fills only the `receipts` array of the {@link NormalizedBatch}; all DB
 * writes and idempotency live in `persist.ts`. Digital receipts land in the
 * same `receipts` / `receipt_items` tables as photographed ones, so whatever
 * reads those tables (the review queue today; rollups and bank matching once
 * runtime reconciliation is wired) sees them without knowing the source — and
 * because every line carries Costco's own canonical product name, they are
 * also the ground truth the SKU resolver learns from.
 */
export const costcoAdapter: SourceAdapter = {
  kind: 'costco',

  supports(input: RawInput): boolean {
    return input.kind === 'costco';
  },

  normalize(input: RawInput): NormalizedBatch {
    const text = new TextDecoder('utf-8').decode(input.bytes);
    const { receipts, errors } = parseCostcoReceipts(text);
    return { transactions: [], orders: [], receipts, errors };
  },
};
