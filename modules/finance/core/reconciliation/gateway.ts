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
 * Returns the stub when PUBLIC_DEMO_MODE=1 or RECON_BACKEND is not 'live'
 * (the default). Returns the live backend only when explicitly opted in via
 * RECON_BACKEND=live without public-mode override.
 */
export function gatewayFor(env: GatewayEnv): ReconciliationGateway {
  if (env.PUBLIC_DEMO_MODE === '1' || env.RECON_BACKEND !== 'live') {
    return new StubReconciliationGateway();
  }
  return new LiveReconciliationGateway();
}
