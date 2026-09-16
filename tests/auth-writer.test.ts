/**
 * requireWriter — who may write, to which household, on what proof.
 *
 * Clerk and the membership lookup are mocked; the token gate is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const clerk = vi.hoisted(() => ({ auth: vi.fn(), currentUser: vi.fn() }));
vi.mock('@clerk/nextjs/server', () => ({ auth: clerk.auth, currentUser: clerk.currentUser }));
const membership = vi.hoisted(() => ({ resolveMembership: vi.fn() }));
vi.mock('../modules/finance/core/auth/membership', () => ({ resolveMembership: membership.resolveMembership }));
vi.mock('../modules/finance/db/client', () => ({ createDb: vi.fn(() => ({})) }));

import { isSameOrigin, requireWriter } from '../apps/web/app/lib/auth/writer';
import { DEMO_HOUSEHOLD_ID } from '../modules/finance/core/scope';

const TOKEN = 'writer-test-token';

function post(headers: Record<string, string> = {}, url = 'https://app.example.com/api/x'): Request {
  return new Request(url, { method: 'POST', headers });
}

function signedIn(): void {
  vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'pk_test');
  vi.stubEnv('CLERK_SECRET_KEY', 'sk_test');
  vi.stubEnv('CLARITY_OPERATOR_EMAILS', 'sam@example.com');
  clerk.auth.mockResolvedValue({ userId: 'user_sam' });
  clerk.currentUser.mockResolvedValue({ primaryEmailAddress: { emailAddress: 'sam@example.com' }, emailAddresses: [], fullName: 'Sam', firstName: 'Sam' });
  membership.resolveMembership.mockResolvedValue({ householdId: 'hh_user_sam', role: 'owner', provisioned: false });
}

describe('requireWriter', () => {
  beforeEach(() => {
    clerk.auth.mockReset();
    clerk.currentUser.mockReset();
    membership.resolveMembership.mockReset();
    vi.stubEnv('PUBLIC_DEMO_MODE', '0');
    vi.stubEnv('RECONCILE_MUTATION_TOKEN', TOKEN);
    vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', '');
    vi.stubEnv('CLERK_SECRET_KEY', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('neither a session nor the token → 401', async () => {
    const w = await requireWriter(post());
    expect(w).toBeInstanceOf(Response);
    expect((w as Response).status).toBe(401);
  });

  it('the token → the operator, on the demo household', async () => {
    expect(await requireWriter(post({ 'x-reconcile-token': TOKEN }))).toEqual({ via: 'token', householdId: DEMO_HOUSEHOLD_ID });
  });

  it('a session from our own page → that person, on their own household — never the demo one', async () => {
    signedIn();
    const w = await requireWriter(post({ 'sec-fetch-site': 'same-origin' }));
    expect(w).toMatchObject({ via: 'session', householdId: 'hh_user_sam', principal: { userId: 'user_sam', email: 'sam@example.com' } });
    expect(membership.resolveMembership).toHaveBeenCalledWith({}, { userId: 'user_sam', email: 'sam@example.com', displayName: 'Sam' }, { provision: true });
  });

  it('a session request that cannot prove it is same-site → 403, even with a valid token alongside', async () => {
    signedIn();
    const cases: Record<string, string>[] = [
      { 'sec-fetch-site': 'cross-site' },
      { 'sec-fetch-site': 'same-site' },
      { origin: 'https://evil.example.net', host: 'app.example.com' },
      { origin: 'http://app.example.com', host: 'app.example.com', 'x-forwarded-proto': 'https' },
      {},
    ];
    for (const headers of cases) {
      const w = await requireWriter(post({ ...headers, 'x-reconcile-token': TOKEN }));
      expect(w, JSON.stringify(headers)).toBeInstanceOf(Response);
      expect((w as Response).status, JSON.stringify(headers)).toBe(403);
    }
  });

  it('behind a proxy, Origin is checked against the forwarded host, not the internal request URL', async () => {
    signedIn();
    const w = await requireWriter(
      post({ origin: 'https://clarity.example.com', host: 'clarity.example.com', 'x-forwarded-proto': 'https' }, 'http://localhost:3000/api/x'),
    );
    expect(w).toMatchObject({ via: 'session', householdId: 'hh_user_sam' });
    const forwarded = await requireWriter(
      post({ origin: 'https://clarity.example.com', host: 'localhost:3000', 'x-forwarded-host': 'clarity.example.com', 'x-forwarded-proto': 'https' }, 'http://localhost:3000/api/x'),
    );
    expect(forwarded).toMatchObject({ via: 'session' });
  });

  it('a signed-in person with no household here is not a writer (falls back to the token, else 401)', async () => {
    signedIn();
    membership.resolveMembership.mockResolvedValue(null);
    expect((await requireWriter(post({ 'sec-fetch-site': 'same-origin' })) as Response).status).toBe(401);
  });

  it('a stranger’s first sign-in is not provisioned unless their email is allowlisted', async () => {
    signedIn();
    vi.stubEnv('CLARITY_OPERATOR_EMAILS', 'someone-else@example.com');
    membership.resolveMembership.mockResolvedValue(null);
    expect((await requireWriter(post({ 'sec-fetch-site': 'same-origin' })) as Response).status).toBe(401);
    expect(membership.resolveMembership).toHaveBeenCalledWith(expect.anything(), expect.anything(), { provision: false });
  });

  it('in the public demo, Clerk is ignored: a session is not a writer', async () => {
    signedIn();
    vi.stubEnv('PUBLIC_DEMO_MODE', '1');
    expect((await requireWriter(post({ 'sec-fetch-site': 'same-origin' })) as Response).status).toBe(401);
    expect(clerk.auth).not.toHaveBeenCalled();
    expect(await requireWriter(post({ 'x-reconcile-token': TOKEN }))).toEqual({ via: 'token', householdId: DEMO_HOUSEHOLD_ID });
  });
});

describe('isSameOrigin', () => {
  it('trusts the browser’s own verdict first', () => {
    expect(isSameOrigin(post({ 'sec-fetch-site': 'same-origin', origin: 'https://evil.example.net' }))).toBe(true);
    expect(isSameOrigin(post({ 'sec-fetch-site': 'none' }))).toBe(true);
    expect(isSameOrigin(post({ 'sec-fetch-site': 'cross-site', origin: 'https://app.example.com', host: 'app.example.com' }))).toBe(false);
  });

  it('otherwise requires Origin to match the public scheme and host', () => {
    expect(isSameOrigin(post({ origin: 'https://app.example.com', host: 'app.example.com' }))).toBe(true);
    expect(isSameOrigin(post({ origin: 'https://app.example.com', host: 'app.example.com:443' }))).toBe(false);
    expect(isSameOrigin(post({ origin: 'not a url', host: 'app.example.com' }))).toBe(false);
    expect(isSameOrigin(post({ origin: 'https://app.example.com' }))).toBe(false); // no host to compare against
  });
});
