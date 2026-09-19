import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';

export type FinanceDb = ReturnType<typeof drizzle>;

export interface CreateDbOptions {
  url?: string;
  authToken?: string;
}

const TEMP_DB_PREFIX = 'clarity-finance-';
const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

function tempDbFile(): string {
  return join(tmpdir(), `${TEMP_DB_PREFIX}${randomUUID()}.db`);
}

/**
 * Resolve the libSQL connection in priority order:
 *   1. explicit `opts.url`
 *   2. Turso via env (`TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`)
 *   3. a durable local `file:` DB for dev (so `seed` and the dev server agree)
 *   4. a per-run temp `file:` DB when no durable disk is available
 * Exported so the resolution itself is unit-testable without opening a client.
 */
export function resolveDbConfig(
  opts?: CreateDbOptions,
  env: Record<string, string | undefined> = process.env,
): { url: string; authToken?: string } {
  if (opts?.url) {
    return { url: opts.url, authToken: opts.authToken };
  }
  if (env.TURSO_DATABASE_URL) {
    return {
      url: env.TURSO_DATABASE_URL,
      authToken: opts?.authToken ?? env.TURSO_AUTH_TOKEN,
    };
  }
  try {
    const dir = env.CLARITY_DATA_DIR ?? join(process.cwd(), 'data');
    mkdirSync(dir, { recursive: true });
    return { url: `file:${join(dir, 'finance.db')}` };
  } catch {
    return { url: `file:${tempDbFile()}` };
  }
}

/**
 * The `fetch` a remote (Turso) client must use. The libSQL HTTP transport
 * POSTs each statement through the global `fetch`; inside a Next.js server
 * that global is patched, and on Vercel a fetch it deems cacheable lands in
 * the persistent Data Cache — keyed by URL and body, shared across
 * deployments. A query whose text and parameters never change (the queue's
 * "unmatched transactions" read) was being answered from a response recorded
 * weeks earlier, so new rows never appeared in production while the same
 * build against the same database was right locally. Database traffic is
 * never cacheable: every request goes out with `cache: 'no-store'`.
 */
export function uncachedFetch(base: typeof fetch = fetch): typeof fetch {
  return (input, init) => base(input, { ...init, cache: 'no-store' });
}

/** A URL the libSQL client will reach over the network (HTTP/WebSocket), as opposed to a local file or `:memory:`. */
export function isRemoteDbUrl(url: string): boolean {
  return /^(libsql|https?|wss?):\/\//i.test(url);
}

/**
 * The libSQL client config for a URL: the token when there is one, and — for
 * a remote URL only — the uncached `fetch`. Exported, like `resolveDbConfig`,
 * so the wiring is unit-testable without opening a client.
 */
export function clientConfig(url: string, authToken?: string, base: typeof fetch = fetch): { url: string; authToken?: string; fetch?: typeof fetch } {
  return {
    url,
    ...(authToken ? { authToken } : {}),
    ...(isRemoteDbUrl(url) ? { fetch: uncachedFetch(base) } : {}),
  };
}

function openClient(url: string, authToken?: string): Client {
  const client = createClient(clientConfig(url, authToken));
  // A second writer on the same file waits (up to 5 s) for the write lock
  // instead of failing at once with SQLITE_BUSY. A file client runs its
  // statements FIFO, so this lands before anything issued after it. Remote
  // (Turso) clients manage locking server-side; the pragma is not sent there.
  if (url.startsWith('file:')) {
    void client.execute('PRAGMA busy_timeout = 5000').catch(() => undefined);
  }
  return client;
}

export function createDb(opts?: CreateDbOptions): FinanceDb {
  const { url, authToken } = resolveDbConfig(opts);
  return drizzle(openClient(url, authToken));
}

/**
 * Apply every migration in `modules/finance/db/migrations` to a fresh client.
 *
 * `createTestDb()` is synchronous by contract, and @libsql/client exposes no
 * synchronous execute. A single `file:` client serializes its operations FIFO,
 * so issuing the DDL here (un-awaited) is guaranteed to run before whatever the
 * test awaits next; a broken migration surfaces as a "no such table" failure on
 * that next query rather than silently passing. The folder is empty until
 * story-001-002 lands, in which case this is a no-op.
 */
function applyMigrations(client: Client): void {
  if (!existsSync(MIGRATIONS_DIR)) return;
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const name of files) {
    const sqlText = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
    if (sqlText.trim().length === 0) continue;
    // Never swallow: a failing migration (DDL or, since 0005, data) must be
    // loud, or every test DB silently runs against a half-migrated schema.
    void client.executeMultiple(sqlText).catch((err: unknown) => {
      console.error(`[db] test migration ${name} failed:`, err instanceof Error ? err.message : err);
    });
  }
}

/**
 * The ONLY way tests obtain a DB: a throwaway `file:` libSQL DB with every
 * migration applied. Each call is isolated (unique temp file), and `cleanup()`
 * closes the client and removes the file with no leak.
 */
export function createTestDb(): { db: FinanceDb; cleanup: () => void; file: string } {
  const file = tempDbFile();
  const client = openClient(`file:${file}`);
  const db = drizzle(client);
  applyMigrations(client);

  const cleanup = (): void => {
    try {
      client.close();
    } catch {
      /* already closed — nothing to do */
    }
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      rmSync(`${file}${suffix}`, { force: true });
    }
  };

  return { db, cleanup, file };
}
