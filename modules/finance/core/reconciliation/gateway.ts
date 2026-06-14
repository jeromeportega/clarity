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

import type { ReconciliationGateway } from './types';
import { StubReconciliationGateway } from './stub';
import { LiveReconciliationGateway } from './live';

export type GatewayEnv = {
  PUBLIC_DEMO_MODE?: string;
  /** Defaults to 'stub' while H3 is unmerged. */
  RECON_BACKEND?: 'stub' | 'live';
};

/**
 * Selects the reconciliation backend.
 *
 * RECON_BACKEND is the sole stub-vs-live switch: 'live' selects the DB-backed
 * LiveReconciliationGateway; anything else (the default) selects the stub.
 * PUBLIC_DEMO_MODE controls SCOPE/household only — it does NOT force the stub, so
 * a public demo can be live-backed (PUBLIC_DEMO_MODE=1, RECON_BACKEND=live).
 */
export function gatewayFor(env: GatewayEnv): ReconciliationGateway {
  if (env.RECON_BACKEND === 'live') {
    return new LiveReconciliationGateway();
  }
  return new StubReconciliationGateway();
}
