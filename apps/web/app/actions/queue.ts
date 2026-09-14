'use server';

import { timingSafeEqual } from 'node:crypto';

import { headers } from 'next/headers';
import { createDb } from '../../../../modules/finance/db/client';
import { gatewayFor } from '../../../../modules/finance/core/reconciliation/gateway';
import {
  applyCorrection,
  type CorrectionVariant,
} from '../../../../modules/finance/core/corrections/apply';
import { DEMO_HOUSEHOLD_ID } from '../../../../modules/finance/core/scope';
import type { QueueItemType } from '../../../../modules/finance/core/queue/types';

const SCOPE = { householdId: DEMO_HOUSEHOLD_ID };

// Server Actions are mutations and use the same shared-secret gate as the API
// routes. Fail closed: with no RECONCILE_MUTATION_TOKEN configured, no mutation
// is possible from any caller. (Real sign-in replaces this gate.)
async function requireMutationToken(): Promise<void> {
  const token = process.env.RECONCILE_MUTATION_TOKEN;
  if (!token) {
    throw new Error('Unauthorized');
  }
  const h = await headers();
  const provided = h.get('x-reconcile-token') ?? h.get('authorization')?.replace(/^Bearer /, '') ?? '';
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(token, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new Error('Unauthorized');
  }
}

function getDb() {
  return createDb();
}

function getGateway() {
  return gatewayFor({
    PUBLIC_DEMO_MODE: process.env.PUBLIC_DEMO_MODE,
    RECON_BACKEND: process.env.RECON_BACKEND as 'stub' | 'live' | undefined,
  });
}

export async function confirmItem(
  itemId: string,
  itemType: QueueItemType,
): Promise<{ removedItemId: string }> {
  await requireMutationToken();
  return applyCorrection(
    SCOPE,
    { id: itemId, type: itemType, reason: '' },
    { type: 'confirm' },
    getGateway(),
    getDb(),
  );
}

export async function dismissItem(
  itemId: string,
  itemType: QueueItemType,
): Promise<{ removedItemId: string }> {
  await requireMutationToken();
  return applyCorrection(
    SCOPE,
    { id: itemId, type: itemType, reason: '' },
    { type: 'dismiss' },
    getGateway(),
    getDb(),
  );
}

export async function correctItem(
  itemId: string,
  itemType: QueueItemType,
  correction: CorrectionVariant,
): Promise<{ removedItemId: string }> {
  await requireMutationToken();
  return applyCorrection(
    SCOPE,
    { id: itemId, type: itemType, reason: '' },
    { type: 'correct', correction },
    getGateway(),
    getDb(),
  );
}
