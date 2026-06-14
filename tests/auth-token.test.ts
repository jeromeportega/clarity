import { afterEach, describe, expect, it, vi } from 'vitest';

import { requireMutationToken } from '../apps/web/app/lib/auth/token';

function makeReq(token?: string): Request {
  const headers: Record<string, string> = {};
  if (token !== undefined) {
    headers['x-reconcile-token'] = token;
  }
  return new Request('http://test/', { method: 'POST', headers });
}

function assertIs401(result: Response | null): void {
  expect(result).toBeInstanceOf(Response);
  expect((result as Response).status).toBe(401);
}

describe('requireMutationToken', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns null for a valid token', () => {
    vi.stubEnv('RECONCILE_MUTATION_TOKEN', 'super-secret-token');
    expect(requireMutationToken(makeReq('super-secret-token'))).toBeNull();
  });

  it('returns 401 when x-reconcile-token header is missing', () => {
    vi.stubEnv('RECONCILE_MUTATION_TOKEN', 'super-secret-token');
    assertIs401(requireMutationToken(makeReq()));
  });

  it('returns 401 for a wrong token', () => {
    vi.stubEnv('RECONCILE_MUTATION_TOKEN', 'super-secret-token');
    assertIs401(requireMutationToken(makeReq('wrong-token')));
  });

  it('returns 401 for an empty-string token', () => {
    vi.stubEnv('RECONCILE_MUTATION_TOKEN', 'super-secret-token');
    assertIs401(requireMutationToken(makeReq('')));
  });

  it('returns 401 for a token shorter than the secret — no crash (Security T6)', () => {
    vi.stubEnv('RECONCILE_MUTATION_TOKEN', 'super-secret-token');
    assertIs401(requireMutationToken(makeReq('short')));
  });

  it('returns 401 for a token longer than the secret — no crash (Security T6)', () => {
    vi.stubEnv('RECONCILE_MUTATION_TOKEN', 'super-secret-token');
    assertIs401(requireMutationToken(makeReq('super-secret-token-extra-chars')));
  });

  it('returns 401 when RECONCILE_MUTATION_TOKEN env var is not set', () => {
    vi.stubEnv('RECONCILE_MUTATION_TOKEN', undefined as unknown as string);
    assertIs401(requireMutationToken(makeReq('any-token')));
  });

  describe('Authorization: Bearer fallback (deprecated)', () => {
    it('accepts a correct token via Authorization: Bearer and returns null', () => {
      vi.stubEnv('RECONCILE_MUTATION_TOKEN', 'super-secret-token');
      const req = new Request('http://test/', {
        method: 'POST',
        headers: { authorization: 'Bearer super-secret-token' },
      });
      expect(requireMutationToken(req)).toBeNull();
    });

    it('returns 401 for a wrong token via Authorization: Bearer', () => {
      vi.stubEnv('RECONCILE_MUTATION_TOKEN', 'super-secret-token');
      const req = new Request('http://test/', {
        method: 'POST',
        headers: { authorization: 'Bearer wrong-token' },
      });
      assertIs401(requireMutationToken(req));
    });

    it('x-reconcile-token takes precedence over Authorization: Bearer', () => {
      vi.stubEnv('RECONCILE_MUTATION_TOKEN', 'super-secret-token');
      const req = new Request('http://test/', {
        method: 'POST',
        headers: {
          'x-reconcile-token': 'super-secret-token',
          authorization: 'Bearer wrong-token',
        },
      });
      expect(requireMutationToken(req)).toBeNull();
    });
  });
});
