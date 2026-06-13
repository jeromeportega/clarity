import { randomUUID } from 'node:crypto';
import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';

import { createDb, type FinanceDb } from '../db/client';
import { DEFAULT_CATEGORIES, accounts, categories, households } from '../db/schema';

/**
 * Seed a single synthetic demo household (NFR-5). Real structure, fully fake data:
 * no real names, accounts, or balances. The demo identifiers are exported as stable
 * constants so the HTTP routes and the integration test agree on the household /
 * account without re-seeding.
 *
 * `seed()` is idempotent — every insert is insert-or-ignore, so running it twice
 * still yields exactly one household, one account, and one row per category.
 */

/** Stable, hard-coded demo IDs (valid UUIDv4 shape). */
export const DEMO_HOUSEHOLD_ID = '00000000-0000-4000-8000-000000000001';
export const DEMO_ACCOUNT_ID = '00000000-0000-4000-8000-000000000002';

export interface SeedResult {
  householdId: string;
  accountId: string;
  categories: number;
}

export async function seed(db: FinanceDb): Promise<SeedResult> {
  await db
    .insert(households)
    .values({ id: DEMO_HOUSEHOLD_ID, name: 'Demo Household' })
    .onConflictDoNothing();

  await db
    .insert(accounts)
    .values({
      id: DEMO_ACCOUNT_ID,
      householdId: DEMO_HOUSEHOLD_ID,
      name: 'Demo Credit Card',
      type: 'credit_card',
      institution: 'Demo Bank',
    })
    .onConflictDoNothing();

  for (const name of DEFAULT_CATEGORIES) {
    await db
      .insert(categories)
      .values({ id: randomUUID(), name })
      .onConflictDoNothing();
  }

  return {
    householdId: DEMO_HOUSEHOLD_ID,
    accountId: DEMO_ACCOUNT_ID,
    categories: DEFAULT_CATEGORIES.length,
  };
}

async function main(): Promise<void> {
  const result = await seed(createDb());
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

/** Run `main()` only when executed directly (e.g. `tsx scripts/seed.ts`), never on import. */
if (import.meta.url === pathToFileURL(argv[1] ?? '').href) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  });
}
