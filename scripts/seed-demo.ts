import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';

import { createDb } from '../modules/finance/db/client';
import { seedDemoHousehold } from '../modules/finance/core/seed/demoHousehold';

async function main(): Promise<void> {
  const db = createDb();
  const result = await seedDemoHousehold(db);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (argv[1] && import.meta.url === pathToFileURL(argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exitCode = 1;
  });
}
