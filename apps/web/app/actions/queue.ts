'use server';

import { createDb } from '../../../modules/finance/db/client';
import { gatewayFor } from '../../../modules/finance/core/reconciliation/gateway';
import {
  applyCorrection,
  type CorrectionVariant,
} from '../../../modules/finance/core/corrections/apply';
import { DEMO_HOUSEHOLD_ID } from '../../../modules/finance/core/scope';
import type { QueueItemType } from '../../../modules/finance/core/queue/types';

const SCOPE = { householdId: DEMO_HOUSEHOLD_ID };

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
  return applyCorrection(
    SCOPE,
    { id: itemId, type: itemType, reason: '' },
    { type: 'correct', correction },
    getGateway(),
    getDb(),
  );
}
