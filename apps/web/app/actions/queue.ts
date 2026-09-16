'use server';

import { createDb, type FinanceDb } from '../../../../modules/finance/db/client';
import { gatewayFor } from '../../../../modules/finance/core/reconciliation/gateway';
import {
  applyCorrection,
  type CorrectionVariant,
} from '../../../../modules/finance/core/corrections/apply';
import type { QueueItemType } from '../../../../modules/finance/core/queue/types';
import { reconcileAfterWrite } from '../../lib/reconcile';
import { requireWriterFromAction } from '../lib/auth/writer';

// Server Actions are mutations and resolve their writer exactly as the API
// routes do (lib/auth/writer.ts): a signed-in person acts on their own
// household; a token-holding server-side caller on the demo household. A
// missing writer throws — actions have no Response to return.

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

async function decide(
  itemId: string,
  itemType: QueueItemType,
  action: Parameters<typeof applyCorrection>[2],
): Promise<{ removedItemId: string }> {
  const writer = await requireWriterFromAction();
  const scope = { householdId: writer.householdId };
  const db = getDb();
  const result = await applyCorrection(scope, { id: itemId, type: itemType, reason: '' }, action, getGateway(db), db);
  // A decision about a match changes what the engine must honour; item-level
  // decisions (SKU, flagged receipt) change no match.
  if (itemType === 'ambiguous_match') await reconcileAfterWrite(db, scope.householdId);
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
  correction: CorrectionVariant,
): Promise<{ removedItemId: string }> {
  return decide(itemId, itemType, { type: 'correct', correction });
}
