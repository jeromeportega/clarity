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
  env: NodeJS.ProcessEnv = process.env,
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

function openClient(url: string, authToken?: string): Client {
  return createClient(authToken ? { url, authToken } : { url });
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
    void client.executeMultiple(sqlText).catch(() => {});
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
