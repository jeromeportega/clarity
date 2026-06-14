import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveHouseholdScope } from '../apps/web/lib/public-mode';
import { DEMO_HOUSEHOLD_ID } from '../modules/finance/core/scope';

describe('resolveHouseholdScope', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('PUBLIC_DEMO_MODE=1', () => {
    it('returns DEMO_HOUSEHOLD_ID with readonly:true', () => {
      vi.stubEnv('PUBLIC_DEMO_MODE', '1');
      const scope = resolveHouseholdScope();
      expect(scope.householdId).toBe(DEMO_HOUSEHOLD_ID);
      expect(scope.readonly).toBe(true);
    });

    it('ignores any household hint in the request — no opt-out (T2)', () => {
      vi.stubEnv('PUBLIC_DEMO_MODE', '1');
      const req = new Request('http://test/', {
        headers: { 'x-household-id': 'some-other-household' },
      });
      const scope = resolveHouseholdScope(req);
      expect(scope.householdId).toBe(DEMO_HOUSEHOLD_ID);
      expect(scope.readonly).toBe(true);
    });
  });

  describe('non-public mode', () => {
    it('returns a defined scope — no unscoped read path', () => {
      vi.stubEnv('PUBLIC_DEMO_MODE', '0');
      const scope = resolveHouseholdScope();
      expect(scope).toBeDefined();
      expect(scope.householdId).toBeDefined();
    });

    it('does not set readonly when PUBLIC_DEMO_MODE is not "1"', () => {
      vi.stubEnv('PUBLIC_DEMO_MODE', '0');
      expect(resolveHouseholdScope().readonly).toBeUndefined();
    });

    it('does not set readonly when PUBLIC_DEMO_MODE is absent', () => {
      vi.stubEnv('PUBLIC_DEMO_MODE', undefined as unknown as string);
      expect(resolveHouseholdScope().readonly).toBeUndefined();
    });

    it('still scopes to DEMO_HOUSEHOLD_ID (no unscoped read path)', () => {
      vi.stubEnv('PUBLIC_DEMO_MODE', '0');
      expect(resolveHouseholdScope().householdId).toBe(DEMO_HOUSEHOLD_ID);
    });
  });
});
