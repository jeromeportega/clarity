'use server';

import { createDb, type FinanceDb } from '../../../../modules/finance/db/client';
import { gatewayFor } from '../../../../modules/finance/core/reconciliation/gateway';
import { applyCorrection } from '../../../../modules/finance/core/corrections/apply';
import type { QueueItemType } from '../../../../modules/finance/core/queue/types';
import { reconcileAfterWrite } from '../../lib/reconcile';
import { isValidItemType, validateCorrection, MAX_FIELD_LEN } from '../api/queue/[id]/_lib/validation';
import { requireWriterFromAction } from '../lib/auth/writer';

// Server Actions are public endpoints: every export here is callable by any
// client that can reach the page, with whatever arguments it likes. They
// validate their input exactly as the API routes do (`_lib/validation.ts`)
// and resolve their writer exactly as the routes do (`lib/auth/writer.ts`):
// a signed-in person acts on their own household; a token-holding
// server-side caller on the demo household. A missing writer throws.

let _db: FinanceDb | undefined;
function getDb(): FinanceDb {
  _db ??= createDb();
  return _db;
}

function getGateway(db: FinanceDb) {
  return gatewayFor({
    PUBLIC_DEMO_MODE: process.env.PUBLIC_DEMO_MODE,
    RECON_BACKEND: process.env.RECON_BACKEND as 'stub' | 'live' | undefined,
  }, db);
}

function requireItem(itemId: unknown, itemType: unknown): { id: string; type: QueueItemType } {
  if (typeof itemId !== 'string' || itemId.length === 0 || itemId.length > MAX_FIELD_LEN) {
    throw new Error('Bad Request: invalid item id');
  }
  if (typeof itemType !== 'string' || !isValidItemType(itemType)) {
    throw new Error('Bad Request: invalid itemType');
  }
  return { id: itemId, type: itemType };
}

async function decide(
  itemId: unknown,
  itemType: unknown,
  action: Parameters<typeof applyCorrection>[2],
): Promise<{ removedItemId: string }> {
  const item = requireItem(itemId, itemType);
  const writer = await requireWriterFromAction();
  const scope = { householdId: writer.householdId };
  const db = getDb();
  const result = await applyCorrection(scope, { ...item, reason: '' }, action, getGateway(db), db);
  // A decision about a match changes what the engine must honour; item-level
  // decisions (SKU, flagged receipt) change no match.
  if (item.type === 'ambiguous_match') await reconcileAfterWrite(db, scope.householdId);
  return result;
}

export async function confirmItem(itemId: string, itemType: QueueItemType): Promise<{ removedItemId: string }> {
  return decide(itemId, itemType, { type: 'confirm' });
}

export async function dismissItem(itemId: string, itemType: QueueItemType): Promise<{ removedItemId: string }> {
  return decide(itemId, itemType, { type: 'dismiss' });
}

export async function correctItem(
  itemId: string,
  itemType: QueueItemType,
  correction: unknown,
): Promise<{ removedItemId: string }> {
  const validated = validateCorrection(correction);
  if (!validated.ok) throw new Error(`Bad Request: ${validated.error}`);
  return decide(itemId, itemType, { type: 'correct', correction: validated.correction });
}
