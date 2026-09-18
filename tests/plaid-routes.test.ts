/**
 * POST /api/plaid/sync and POST /api/plaid/sandbox/connect — the HTTP
 * contracts. The sync itself is exercised in core (sync.test.ts, real DB,
 * fixture-driven fake client); here the lib is mocked so every status is
 * checked in isolation, including the sandbox-only guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lib = vi.hoisted(() => ({
  syncHouseholdBanks: vi.fn(),
  connectSandboxBank: vi.fn(),
  isPlaidConfigured: vi.fn(() => true),
  plaidEnv: vi.fn((): 'sandbox' | 'production' | null => 'sandbox'),
}));
vi.mock('../apps/web/lib/plaid/sync', () => lib);
vi.mock('../modules/finance/db/client', () => ({ createDb: vi.fn(() => ({})) }));

import { POST as SYNC } from '../apps/web/app/api/plaid/sync/route';
import { POST as CONNECT } from '../apps/web/app/api/plaid/sandbox/connect/route';
import { DEMO_HOUSEHOLD_ID } from '../modules/finance/core/scope';

const TOKEN = 'plaid-route-test-token';
const post = (path: string, withToken = true) =>
  new Request(`http://localhost${path}`, { method: 'POST', headers: withToken ? { 'x-reconcile-token': TOKEN } : {} });

describe('Plaid routes', () => {
  beforeEach(() => {
    lib.syncHouseholdBanks.mockReset();
    lib.connectSandboxBank.mockReset();
    lib.isPlaidConfigured.mockReturnValue(true);
    lib.plaidEnv.mockReturnValue('sandbox');
    vi.stubEnv('RECONCILE_MUTATION_TOKEN', TOKEN);
    vi.stubEnv('PUBLIC_DEMO_MODE', '0');
    vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', '');
    vi.stubEnv('CLERK_SECRET_KEY', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('both routes refuse without a writer, before touching Plaid', async () => {
    expect((await SYNC(post('/api/plaid/sync', false))).status).toBe(401);
    expect((await CONNECT(post('/api/plaid/sandbox/connect', false))).status).toBe(401);
    expect(lib.syncHouseholdBanks).not.toHaveBeenCalled();
    expect(lib.connectSandboxBank).not.toHaveBeenCalled();
  });

  it('503 when Plaid is not configured on the deployment', async () => {
    lib.isPlaidConfigured.mockReturnValue(false);
    expect((await SYNC(post('/api/plaid/sync'))).status).toBe(503);
    expect((await CONNECT(post('/api/plaid/sandbox/connect'))).status).toBe(503);
  });

  it('sync runs for the writer’s household and returns the per-bank result', async () => {
    lib.syncHouseholdBanks.mockResolvedValue({ items: [{ plaidItemId: 'pi', institutionName: 'Test Bank', ok: true, summary: { added: 3 } }], reconciled: true });
    const res = await SYNC(post('/api/plaid/sync'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ reconciled: true, items: [{ ok: true }] });
    expect(lib.syncHouseholdBanks).toHaveBeenCalledWith({}, DEMO_HOUSEHOLD_ID);
  });

  it('sandbox connect is 404 outside the sandbox — production Items come only from Link', async () => {
    lib.plaidEnv.mockReturnValue('production');
    expect((await CONNECT(post('/api/plaid/sandbox/connect'))).status).toBe(404);
    expect(lib.connectSandboxBank).not.toHaveBeenCalled();
  });

  it('sandbox connect returns the new Item and its first sync', async () => {
    lib.connectSandboxBank.mockResolvedValue({ plaidItemId: 'pi-new', summary: { added: 48, accountsCreated: 14 } });
    const res = await CONNECT(post('/api/plaid/sandbox/connect'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ plaidItemId: 'pi-new', summary: { added: 48, accountsCreated: 14 } });
    expect(lib.connectSandboxBank).toHaveBeenCalledWith({}, DEMO_HOUSEHOLD_ID);
  });

  it('a Plaid failure is a logged 500, never a half answer', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    lib.syncHouseholdBanks.mockRejectedValue(new Error('INVALID_ACCESS_TOKEN'));
    const res = await SYNC(post('/api/plaid/sync'));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Sync failed' });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
