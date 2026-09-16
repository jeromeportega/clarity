import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The identity provider is mocked so the scope resolver can be exercised in
// every configuration without a Clerk key or a request context.
const clerk = vi.hoisted(() => ({
  auth: vi.fn(),
  currentUser: vi.fn(),
}));
vi.mock('@clerk/nextjs/server', () => ({ auth: clerk.auth, currentUser: clerk.currentUser }));

// The membership lookup is mocked too: this file tests scope resolution, not
// provisioning (core/auth/membership.test.ts does that against a real DB).
const membership = vi.hoisted(() => ({ resolveMembership: vi.fn() }));
vi.mock('../modules/finance/core/auth/membership', () => ({ resolveMembership: membership.resolveMembership }));
vi.mock('../modules/finance/db/client', () => ({ createDb: vi.fn(() => ({})) }));

import { resolveReadScope } from '../apps/web/lib/public-mode';
import { getPrincipal, isClerkConfigured } from '../apps/web/app/lib/auth/session';
import { DEMO_HOUSEHOLD_ID } from '../modules/finance/core/scope';

function configureClerk(): void {
  vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'pk_test_x');
  vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_x');
  vi.stubEnv('CLARITY_OPERATOR_EMAILS', 'Sam@Example.com, other@example.com');
}

describe('resolveReadScope', () => {
  beforeEach(() => {
    clerk.auth.mockReset();
    clerk.currentUser.mockReset();
    membership.resolveMembership.mockReset();
    membership.resolveMembership.mockResolvedValue({ householdId: 'hh-mine', role: 'owner', provisioned: false });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('PUBLIC_DEMO_MODE=1', () => {
    it('returns DEMO_HOUSEHOLD_ID, read-only, without consulting the identity provider — Clerk keys are ignored', async () => {
      vi.stubEnv('PUBLIC_DEMO_MODE', '1');
      configureClerk();
      clerk.auth.mockResolvedValue({ userId: 'user_1' });

      const scope = await resolveReadScope();
      expect(scope).toEqual({ householdId: DEMO_HOUSEHOLD_ID, readonly: true });
      expect(clerk.auth).not.toHaveBeenCalled();
      expect(isClerkConfigured()).toBe(false);
      expect(await getPrincipal()).toBeNull();
    });
  });

  describe('sign-in configured', () => {
    beforeEach(() => {
      vi.stubEnv('PUBLIC_DEMO_MODE', '0');
      configureClerk();
    });

    it('a signed-in person gets their own household, writable', async () => {
      clerk.auth.mockResolvedValue({ userId: 'user_1' });
      clerk.currentUser.mockResolvedValue({
        primaryEmailAddress: { emailAddress: 'sam@example.com' },
        emailAddresses: [],
        fullName: 'Sam',
        firstName: 'Sam',
      });

      const scope = await resolveReadScope();
      expect(scope).toEqual({ householdId: 'hh-mine' });
      // Allowlisted (case-insensitively), so a first sign-in may be provisioned.
      expect(membership.resolveMembership).toHaveBeenCalledWith({}, { userId: 'user_1', email: 'sam@example.com', displayName: 'Sam' }, { provision: true });
    });

    it('a stranger may sign in but is not provisioned: no household, no scope', async () => {
      clerk.auth.mockResolvedValue({ userId: 'user_2' });
      clerk.currentUser.mockResolvedValue({ primaryEmailAddress: { emailAddress: 'stranger@example.com' }, emailAddresses: [], fullName: null, firstName: null });
      membership.resolveMembership.mockResolvedValue(null);

      expect(await resolveReadScope()).toBeNull();
      expect(membership.resolveMembership).toHaveBeenCalledWith({}, expect.objectContaining({ userId: 'user_2' }), { provision: false });
    });

    it('with no operator allowlist at all, nobody is provisioned', async () => {
      vi.stubEnv('CLARITY_OPERATOR_EMAILS', '');
      clerk.auth.mockResolvedValue({ userId: 'user_1' });
      clerk.currentUser.mockResolvedValue({ primaryEmailAddress: { emailAddress: 'sam@example.com' }, emailAddresses: [], fullName: 'Sam', firstName: 'Sam' });
      membership.resolveMembership.mockResolvedValue(null);

      expect(await resolveReadScope()).toBeNull();
      expect(membership.resolveMembership).toHaveBeenCalledWith({}, expect.anything(), { provision: false });
    });

    it('nobody signed in → null (the caller redirects or answers 403)', async () => {
      clerk.auth.mockResolvedValue({ userId: null });
      expect(await resolveReadScope()).toBeNull();
      expect(membership.resolveMembership).not.toHaveBeenCalled();
    });

    it('outside a request context (a build-time render) there is no session, not an error', async () => {
      clerk.auth.mockRejectedValue(new Error('auth() was called outside a request'));
      expect(await resolveReadScope()).toBeNull();
    });
  });

  describe('sign-in not configured', () => {
    it('is never a session, and never touches the identity provider', async () => {
      vi.stubEnv('PUBLIC_DEMO_MODE', '0');
      vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', '');
      vi.stubEnv('CLERK_SECRET_KEY', '');
      expect(isClerkConfigured()).toBe(false);
      expect(await getPrincipal()).toBeNull();
      expect(await resolveReadScope()).toBeNull();
      expect(clerk.auth).not.toHaveBeenCalled();
    });

    it('needs BOTH keys', () => {
      expect(isClerkConfigured({ NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk' })).toBe(false);
      expect(isClerkConfigured({ CLERK_SECRET_KEY: 'sk' })).toBe(false);
      expect(isClerkConfigured({ NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: ' ', CLERK_SECRET_KEY: 'sk' })).toBe(false);
      expect(isClerkConfigured({ NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk', CLERK_SECRET_KEY: 'sk' })).toBe(true);
    });
  });
});
