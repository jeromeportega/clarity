'use server';

import { headers } from 'next/headers';
import { createDb, type FinanceDb } from '../../../../modules/finance/db/client';
import { gatewayFor } from '../../../../modules/finance/core/reconciliation/gateway';
import {
  applyCorrection,
  type CorrectionVariant,
} from '../../../../modules/finance/core/corrections/apply';
import { DEMO_HOUSEHOLD_ID } from '../../../../modules/finance/core/scope';
import type { QueueItemType } from '../../../../modules/finance/core/queue/types';
import { isValidMutationToken, mutationTokenFromHeaders } from '../lib/auth/token';

const SCOPE = { householdId: DEMO_HOUSEHOLD_ID };

// Server Actions are mutations and use the same shared-secret gate as the API
// routes (lib/auth/token.ts) — one implementation, fail-closed. Note that a
// browser cannot attach custom headers to a Server Action POST, so today these
// are reachable only by token-holding server-side callers. They are kept for
// the session-based auth that replaces the shared secret (roadmap Phase 1),
// when the gate becomes the session and the queue buttons are mounted.
async function requireMutationToken(): Promise<void> {
  const h = await headers();
  if (!isValidMutationToken(mutationTokenFromHeaders((name) => h.get(name)))) {
    throw new Error('Unauthorized');
  }
}

function getDb() {
  return createDb();
}

function getGateway(db: FinanceDb) {
  return gatewayFor({
    PUBLIC_DEMO_MODE: process.env.PUBLIC_DEMO_MODE,
    RECON_BACKEND: process.env.RECON_BACKEND as 'stub' | 'live' | undefined,
  }, db);
}

export async function confirmItem(
  itemId: string,
  itemType: QueueItemType,
): Promise<{ removedItemId: string }> {
  await requireMutationToken();
  const db = getDb();
  return applyCorrection(
    SCOPE,
    { id: itemId, type: itemType, reason: '' },
    { type: 'confirm' },
    getGateway(db),
    db,
  );
}

export async function dismissItem(
  itemId: string,
  itemType: QueueItemType,
): Promise<{ removedItemId: string }> {
  await requireMutationToken();
  const db = getDb();
  return applyCorrection(
    SCOPE,
    { id: itemId, type: itemType, reason: '' },
    { type: 'dismiss' },
    getGateway(db),
    db,
  );
}

export async function correctItem(
  itemId: string,
  itemType: QueueItemType,
  correction: CorrectionVariant,
): Promise<{ removedItemId: string }> {
  await requireMutationToken();
  const db = getDb();
  return applyCorrection(
    SCOPE,
    { id: itemId, type: itemType, reason: '' },
    { type: 'correct', correction },
    getGateway(db),
    db,
  );
}
