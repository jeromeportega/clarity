'use server';

import { createDb, type FinanceDb } from '../../../../modules/finance/db/client';
import { reextractReceipt } from '../../lib/reextract';
import { MAX_FIELD_LEN } from '../api/queue/[id]/_lib/validation';
import { requireWriterFromAction } from '../lib/auth/writer';

// A public endpoint like every Server Action: validates its one argument and
// resolves its writer exactly as the route does (`lib/auth/writer.ts`).

let _db: FinanceDb | undefined;
function getDb(): FinanceDb {
  _db ??= createDb();
  return _db;
}

export type ReadAgainResult =
  | { ok: true; status: 'ok' | 'needs_review'; itemCount: number }
  | { ok: false; code: 'not_found' | 'has_items' | 'image_mismatch' | 'no_image' | 'unsupported_image' };

/** Read the photo behind an unreadable receipt again (see `lib/reextract.ts`). */
export async function readReceiptAgain(receiptId: unknown): Promise<ReadAgainResult> {
  if (typeof receiptId !== 'string' || receiptId.length === 0 || receiptId.length > MAX_FIELD_LEN) {
    throw new Error('Bad Request: invalid receipt id');
  }
  const writer = await requireWriterFromAction();
  const outcome = await reextractReceipt(getDb(), writer.householdId, receiptId);
  if (!outcome.ok) return { ok: false, code: outcome.code };
  return { ok: true, status: outcome.result.status, itemCount: outcome.result.items.length };
}
