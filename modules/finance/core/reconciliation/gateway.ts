export type {
  HouseholdScope,
  MatchStatus,
  Match,
  AmbiguousMatchGroup,
  Transaction,
  RollupKey,
  SpendRollup,
  ReconciliationGateway,
} from './types';

import type { FinanceDb } from '../../db/client';
import type { ReconciliationGateway } from './types';
import { StubReconciliationGateway } from './stub';
import { LiveReconciliationGateway } from './live';

export type GatewayEnv = {
  PUBLIC_DEMO_MODE?: string;
  /** `stub` opts out of the database-backed gateway; anything else is live. */
  RECON_BACKEND?: 'stub' | 'live';
};

/**
 * Selects the reconciliation backend.
 *
 * The database-backed `LiveReconciliationGateway` is the default: it reads the
 * `matches` and `receipt_items` rows that ingestion, uploads and corrections
 * write. `RECON_BACKEND=stub` is the explicit opt-out for the hard-coded demo
 * rows. `PUBLIC_DEMO_MODE` controls SCOPE/household only — it does NOT choose
 * the backend, so a public demo can be (and is) live-backed.
 *
 * The caller hands in the database: core never opens one.
 */
export function gatewayFor(env: GatewayEnv, db: FinanceDb): ReconciliationGateway {
  if (env.RECON_BACKEND === 'stub') {
    return new StubReconciliationGateway();
  }
  return new LiveReconciliationGateway(db);
}
