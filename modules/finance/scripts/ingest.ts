import { readFileSync, statSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import { argv, cwd, env } from 'node:process';
import { pathToFileURL } from 'node:url';

import { eq } from 'drizzle-orm';

import { amazonAdapter } from '../core/adapters/amazon/amazon.adapter';
import { bankAdapter } from '../core/adapters/bank/bank.adapter';
import { costcoAdapter } from '../core/adapters/costco/costco.adapter';
import { emlAdapter } from '../core/adapters/eml.adapter';
import { retailerApiAdapter } from '../core/adapters/retailer-api.adapter';
import type { RawInput, SourceAdapter, SourceKind } from '../core/adapters/source-adapter';
import { importSource, type ImportContext, type ImportResult } from '../core/ingest/pipeline';
import { reconcileHousehold, type ReconcileRunSummary } from '../core/reconcile/run';
import { learnFromDigitalReceipts, type LearnFromDigitalReceiptsSummary } from '../core/receipts/dictionary/bootstrap';
import { createDb, type FinanceDb } from '../db/client';
import { accounts } from '../db/schema';

/**
 * CLI entry point that ingests a bank export (Excel/CSV), an Amazon order CSV,
 * or a Costco digital-receipt JSON export by reading the file BYTES and handing
 * them to the same `importSource` the HTTP routes use. This is one of the
 * composition roots that import every adapter (the contract's entry-point seam).
 *
 *   tsx modules/finance/scripts/ingest.ts bank   <path.xlsx|.csv> --account <accountId>
 *   tsx modules/finance/scripts/ingest.ts orders <path.csv>
 *   tsx modules/finance/scripts/ingest.ts costco <path.json>
 *
 * Security: the path is resolved and confined to a base directory (cwd by default,
 * overridable via CLARITY_INGEST_BASE_DIR) and must be a regular file. The file is
 * only ever READ — never executed — closing path-traversal as a vector.
 */

export const allAdapters: SourceAdapter[] = [
  bankAdapter,
  amazonAdapter,
  costcoAdapter,
  retailerApiAdapter,
  emlAdapter,
];

export type IngestCommand = 'bank' | 'orders' | 'costco';

/** Maps a CLI command to the source kind the adapters dispatch on. */
const COMMAND_KIND: Record<IngestCommand, SourceKind> = {
  bank: 'bank',
  orders: 'amazon',
  costco: 'costco',
};

/**
 * Resolve a user-supplied path to an absolute path that is provably inside
 * `baseDir`, exists, and is a regular file. Throws (before any read) on a null
 * byte, an escaping `../` path, or a non-file target.
 */
export function resolveInputPath(rawPath: string, baseDir: string = cwd()): string {
  if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
    throw new Error('a file path is required');
  }
  if (rawPath.includes('\0')) {
    throw new Error('invalid path: contains a null byte');
  }

  const base = resolve(baseDir);
  const resolved = resolve(base, rawPath);
  if (resolved !== base && !resolved.startsWith(base + sep)) {
    throw new Error(`path escapes the allowed base directory: ${rawPath}`);
  }

  const stat = statSync(resolved, { throwIfNoEntry: false });
  if (!stat) {
    throw new Error(`file not found: ${resolved}`);
  }
  if (!stat.isFile()) {
    throw new Error(`not a regular file: ${resolved}`);
  }
  return resolved;
}

function mimeForPath(path: string): string | undefined {
  if (/\.csv$/i.test(path)) return 'text/csv';
  if (/\.json$/i.test(path)) return 'application/json';
  if (/\.xlsx$/i.test(path)) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (/\.xls$/i.test(path)) return 'application/vnd.ms-excel';
  return undefined;
}

/** Read the resolved file's bytes and build a {@link RawInput}. Never executes the file. */
export function buildRawInput(kind: SourceKind, resolvedPath: string): RawInput {
  const bytes = new Uint8Array(readFileSync(resolvedPath));
  const input: RawInput = { kind, filename: basename(resolvedPath), bytes };
  const mimeType = mimeForPath(resolvedPath);
  if (mimeType) input.mimeType = mimeType;
  return input;
}

export interface RunIngestOptions {
  command: IngestCommand;
  path: string;
  accountId?: string;
  db?: FinanceDb;
  adapters?: SourceAdapter[];
  baseDir?: string;
  /** Reconcile the household after the import lands (default true), as the HTTP routes do. */
  reconcile?: boolean;
}

export type RunIngestResult = ImportResult & {
  reconciliation?: ReconcileRunSummary | { error: string };
  dictionary?: LearnFromDigitalReceiptsSummary | { error: string };
};

/**
 * Resolve the import context (the bank command derives `householdId` from the
 * account named by `accountId`; orders and Costco receipts fall under the single
 * demo household) and drive `importSource`.
 */
async function resolveContext(
  db: FinanceDb,
  command: IngestCommand,
  accountId: string | undefined,
): Promise<ImportContext> {
  if (command === 'orders' || command === 'costco') {
    // Lazy import so the CLI has no static dependency on a script's side effects.
    const { DEMO_HOUSEHOLD_ID } = await import('./seed');
    return { householdId: DEMO_HOUSEHOLD_ID };
  }

  if (!accountId) {
    throw new Error('the bank command requires --account <accountId>');
  }
  const rows = await db
    .select({ householdId: accounts.householdId })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  const account = rows[0];
  if (!account) {
    throw new Error(`unknown accountId '${accountId}' — run the seed script first`);
  }
  return { householdId: account.householdId, accountId };
}

export async function runIngest(opts: RunIngestOptions): Promise<RunIngestResult> {
  const resolvedPath = resolveInputPath(opts.path, opts.baseDir);
  const input = buildRawInput(COMMAND_KIND[opts.command], resolvedPath);
  const db = opts.db ?? createDb();
  const adapters = opts.adapters ?? allAdapters;
  const ctx = await resolveContext(db, opts.command, opts.accountId);
  const result = await importSource(db, input, ctx, adapters);
  let out: RunIngestResult = result;
  if (opts.command === 'costco' && result.inserted.receipts > 0) {
    // Digital receipts name their lines: teach the dictionary, as the route does.
    // The import is committed; a failure here is reported next to it.
    try {
      out = { ...out, dictionary: await learnFromDigitalReceipts(db, { householdId: ctx.householdId }) };
    } catch (err) {
      out = { ...out, dictionary: { error: err instanceof Error ? err.message : String(err) } };
    }
  }
  if (opts.reconcile === false) return out;
  // Imported rows are only useful once matched — same as the HTTP routes. The
  // import is committed by now, so a reconcile failure is reported next to it
  // rather than thrown away with it; `npm run` exits non-zero via main().
  try {
    return { ...out, reconciliation: await reconcileHousehold(db, ctx.householdId) };
  } catch (err) {
    return { ...out, reconciliation: { error: err instanceof Error ? err.message : String(err) } };
  }
}

export interface ParsedArgs {
  command: IngestCommand;
  path: string;
  accountId?: string;
}

export function parseArgs(args: string[]): ParsedArgs {
  const [command, ...rest] = args;
  if (command !== 'bank' && command !== 'orders' && command !== 'costco') {
    throw new Error('usage: ingest <bank|orders|costco> <path> [--account <accountId>]');
  }

  let path: string | undefined;
  let accountId: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--account') {
      accountId = rest[i + 1];
      i += 1;
    } else if (arg !== undefined && path === undefined) {
      path = arg;
    }
  }

  if (!path) {
    throw new Error('a file path is required');
  }
  return accountId === undefined ? { command, path } : { command, path, accountId };
}

async function main(): Promise<void> {
  const parsed = parseArgs(argv.slice(2));
  const result = await runIngest({
    ...parsed,
    baseDir: env.CLARITY_INGEST_BASE_DIR ?? cwd(),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  const failed = (v: unknown): boolean => typeof v === 'object' && v !== null && 'error' in v;
  if (failed(result.reconciliation) || failed(result.dictionary)) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(argv[1] ?? '').href) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
