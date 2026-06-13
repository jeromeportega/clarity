import type { NormalizedBatch, RawInput, SourceAdapter } from '../source-adapter';
import { parseAmazonOrders } from './parse';

/**
 * Amazon order-history importer (FR-9). File-based only — it reads the bytes of a
 * "Request My Data" → Order History CSV and never opens a live connection (NFR-3).
 *
 * It fills only the `orders` array of the {@link NormalizedBatch}; all DB writes,
 * idempotency, and the store-credit ledger accrual live in `persist.ts`. The
 * importer's whole job is to produce signed, per-shipment line items with
 * `refundDestination` set where the source states it — the sign convention then
 * carries returns correctly end to end.
 */
export const amazonAdapter: SourceAdapter = {
  kind: 'amazon',

  supports(input: RawInput): boolean {
    return input.kind === 'amazon';
  },

  normalize(input: RawInput): NormalizedBatch {
    const text = new TextDecoder('utf-8').decode(input.bytes);
    const { orders, errors } = parseAmazonOrders(text);
    return { transactions: [], orders, receipts: [], errors };
  },
};
