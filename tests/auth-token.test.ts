import { afterEach, describe, expect, it, vi } from 'vitest';

import { requireMutationToken } from '../apps/web/app/lib/auth/token';

function makeReq(token?: string): Request {
  const headers: Record<string, string> = {};
  if (token !== undefined) {
    headers['x-reconcile-token'] = token;
  }
  return new Request('http://test/', { method: 'POST', headers });
}

function catchThrown(fn: () => void): unknown {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e;
  }
}

function assertIs401(thrown: unknown): void {
  expect(thrown).toBeInstanceOf(Response);
  expect((thrown as Response).status).toBe(401);
}

describe('requireMutationToken', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not throw for a valid token', () => {
    vi.stubEnv('RECONCILE_MUTATION_TOKEN', 'super-secret-token');
    expect(() => requireMutationToken(makeReq('super-secret-token'))).not.toThrow();
  });

  it('throws 401 when x-reconcile-token header is missing', () => {
    vi.stubEnv('RECONCILE_MUTATION_TOKEN', 'super-secret-token');
    assertIs401(catchThrown(() => requireMutationToken(makeReq())));
  });

  it('throws 401 for a wrong token', () => {
    vi.stubEnv('RECONCILE_MUTATION_TOKEN', 'super-secret-token');
    assertIs401(catchThrown(() => requireMutationToken(makeReq('wrong-token'))));
  });

  it('throws 401 for an empty-string token', () => {
    vi.stubEnv('RECONCILE_MUTATION_TOKEN', 'super-secret-token');
    assertIs401(catchThrown(() => requireMutationToken(makeReq(''))));
  });

  it('throws 401 for a token shorter than the secret — no crash (Security T6)', () => {
    vi.stubEnv('RECONCILE_MUTATION_TOKEN', 'super-secret-token');
    assertIs401(catchThrown(() => requireMutationToken(makeReq('short'))));
  });

  it('throws 401 for a token longer than the secret — no crash (Security T6)', () => {
    vi.stubEnv('RECONCILE_MUTATION_TOKEN', 'super-secret-token');
    assertIs401(catchThrown(() => requireMutationToken(makeReq('super-secret-token-extra-chars'))));
  });

  it('throws 401 when RECONCILE_MUTATION_TOKEN env var is not set', () => {
    const saved = process.env.RECONCILE_MUTATION_TOKEN;
    delete process.env.RECONCILE_MUTATION_TOKEN;
    try {
      assertIs401(catchThrown(() => requireMutationToken(makeReq('any-token'))));
    } finally {
      if (saved !== undefined) process.env.RECONCILE_MUTATION_TOKEN = saved;
    }
  });
});
