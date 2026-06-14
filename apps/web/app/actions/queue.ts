'use server';

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

// When RECONCILE_MUTATION_TOKEN is configured (production), Server Actions require
// the same Bearer token. Without the token set (dev / demo), they are open — Next.js
// CSRF protection applies in all cases.
async function requireMutationToken(): Promise<void> {
  const token = process.env.RECONCILE_MUTATION_TOKEN;
  if (!token) return;
  const h = await headers();
  if (h.get('authorization') !== `Bearer ${token}`) {
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
