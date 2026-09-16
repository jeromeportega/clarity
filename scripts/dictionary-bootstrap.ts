import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';

import { createDb } from '../modules/finance/db/client';
import { DEMO_HOUSEHOLD_ID } from '../modules/finance/core/scope';
import {
  learnFromDigitalReceipts,
  renormalizeDictionaryKeys,
} from '../modules/finance/core/receipts/dictionary/bootstrap';

/**
 * Bootstrap the SKU dictionary from the digital receipts already in the
 * database (`npm run dictionary:bootstrap`). Two steps, both idempotent:
 *
 *   1. re-key any dictionary row written under a superseded normalization, so
 *      nothing learned earlier becomes unreachable when the key rules improve;
 *   2. teach the dictionary every retailer-named line of the household's
 *      digital receipts (see `core/receipts/dictionary/bootstrap.ts`).
 *
 * The ingest route and CLI run step 2 after every Costco import; this script
 * is for existing data and for after a normalization change. Env selects the
 * database exactly as for the app (`TURSO_*`, else the local file DB).
 */
async function main(): Promise<void> {
  const db = createDb();
  const rekey = await renormalizeDictionaryKeys(db);
  const learned = await learnFromDigitalReceipts(db, { householdId: DEMO_HOUSEHOLD_ID });
  process.stdout.write(`${JSON.stringify({ rekey, learned }, null, 2)}\n`);
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  });
}
