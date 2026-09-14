/**
 * Capture every in-warehouse Costco receipt for the signed-in member as a PNG.
 *
 *   npx tsx scripts/costco/capture-receipts.ts [--cdp http://localhost:9222]
 *       [--out data/costco/receipts] [--profile data/costco/chrome-profile]
 *       [--ranges N] [--headed|--headless]
 *
 * Recommended: attach to a Chrome you start yourself (--cdp). Costco's sign-in
 * does not reliably complete in an automation-launched browser, and this way
 * nothing about the browser is altered — you sign in exactly as usual:
 *
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *       --remote-debugging-port=9222 \
 *       --user-data-dir="$HOME/Library/Application Support/clarity-costco-chrome" &
 *   # sign in at https://www.costco.com in that window, then:
 *   npx tsx scripts/costco/capture-receipts.ts --cdp http://localhost:9222
 *
 * (Chrome refuses a debugging port on its default profile, hence the separate
 * --user-data-dir. The script opens its own tab and closes it when done.)
 *
 * How it works
 *   - Without --cdp, launches real Chrome (Playwright `channel: 'chrome'`)
 *     with a persistent profile under data/ (gitignored) so you sign in once
 *     and stay signed in on later runs. The script never sees or stores your
 *     password; it only waits for the orders page to appear.
 *   - Opens Orders & Purchases → Warehouse tab, iterates every period in the
 *     "Showing" dropdown, and for each "View Receipt" / "View Return Receipt"
 *     button opens the receipt dialog and screenshots the receipt paper.
 *   - Files are named <YYYY-MM-DD>_<transactionBarcode>.png so they pair with
 *     the `transactionBarcode` field of Costco's WarehouseReceiptDetail JSON.
 *     A manifest.json in the output dir records what was captured.
 *   - Re-runs skip receipts whose file already exists.
 *
 * Why PNG and not PDF: Chrome only exposes print-to-PDF in headless mode, and
 * Costco's sign-in does not survive headless well. The vision pipeline accepts
 * PNG directly. Pass --headless to attempt PDF capture as well (best effort).
 *
 * Output lives under data/ — real financial data, never committed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';

interface Args {
  out: string;
  profile: string;
  ranges: number;
  headless: boolean;
  cdp?: string;
}

interface ManifestEntry {
  barcode: string;
  kind: 'receipt' | 'return';
  date: string; // YYYY-MM-DD
  time?: string;
  total?: string;
  range: string;
  file: string;
  pdf?: string;
  capturedAt: string;
}

const ORDERS_URL = 'https://www.costco.com/OrderStatusCmd';
const LOGIN_WAIT_MS = 10 * 60 * 1000;
const STEP_DELAY_MS = 400;

function parseArgs(argv: string[]): Args {
  const args: Args = {
    out: 'data/costco/receipts',
    profile: 'data/costco/chrome-profile',
    ranges: Number.POSITIVE_INFINITY,
    headless: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === '--out') args.out = next();
    else if (a === '--profile') args.profile = next();
    else if (a === '--cdp') args.cdp = next();
    else if (a === '--ranges') args.ranges = Number(next());
    else if (a === '--headless') args.headless = true;
    else if (a === '--headed') args.headless = false;
    else if (a === '-h' || a === '--help') {
      console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) => console.log(`[costco] ${msg}`);

function loadManifest(path: string): ManifestEntry[] {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as ManifestEntry[]) : [];
}

function saveManifest(path: string, entries: ManifestEntry[]): void {
  writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`);
}

// Costco prints dates as MM/DD/YYYY in the receipt footer and list.
function toIsoDate(mmddyyyy: string | undefined): string {
  const m = mmddyyyy?.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : 'unknown-date';
}

// Poll until the Warehouse tab is visible. Tolerates the sign-in redirect
// (signin.costco.com, including the emailed one-time-code step) and, once the
// session is back on costco.com but not on the orders page (the post-login
// landing page varies), navigates to the orders page again.
async function waitForSignedIn(page: Page): Promise<void> {
  const deadline = Date.now() + LOGIN_WAIT_MS;
  let announced = false;
  let lastNav = 0;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error('The browser window was closed before sign-in completed. Re-run and leave the window open.');
    const tab = page.getByRole('tab', { name: /warehouse/i });
    if (await tab.isVisible().catch(() => false)) return;

    const url = page.url();
    if (/signin\.costco\.com|\/logon|login/i.test(url)) {
      if (!announced) {
        log('Not signed in. Sign in to costco.com in the browser window that just opened');
        log(`(waiting up to ${LOGIN_WAIT_MS / 60000} minutes; the script never reads your credentials).`);
        announced = true;
      }
    } else if (!/ordersandpurchases|OrderStatusCmd/i.test(url) && Date.now() - lastNav > 15_000) {
      // Signed in (or never redirected) but somewhere else: go to the orders page.
      lastNav = Date.now();
      await page.goto(ORDERS_URL, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    }
    await sleep(2_000);
  }
  throw new Error(`Timed out after ${LOGIN_WAIT_MS / 60000} minutes waiting for sign-in.`);
}

// The period dropdown lives inside the Warehouse tab panel; the site header's
// search box can also expose role=combobox, so always scope to the panel.
function rangeCombo(page: Page): Locator {
  return page.getByRole('tabpanel').getByRole('combobox').first();
}

async function selectRange(page: Page, label: string): Promise<void> {
  const combo = rangeCombo(page);
  await combo.click();
  const option = page.getByRole('option', { name: label, exact: true });
  await option.waitFor({ state: 'visible', timeout: 10_000 });
  await option.click();
  // The list re-renders; wait for the "Showing x - y of z" caption to settle.
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
  await sleep(STEP_DELAY_MS);
}

async function listRangeLabels(page: Page): Promise<string[]> {
  const combo = rangeCombo(page);
  await combo.click();
  const options = page.getByRole('option');
  await options.first().waitFor({ state: 'visible', timeout: 10_000 });
  const labels = (await options.allTextContents()).map((t) => t.trim()).filter(Boolean);
  await page.keyboard.press('Escape');
  await sleep(STEP_DELAY_MS);
  return labels;
}

// Expand any "load more"-style pagination until the caption says all are shown.
async function expandAll(page: Page): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const more = page.getByRole('button', { name: /(load|show|view) more|next page/i }).first();
    if (!(await more.isVisible().catch(() => false))) return;
    await more.click();
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => undefined);
    await sleep(STEP_DELAY_MS);
  }
}

async function showingCaption(page: Page): Promise<string> {
  const caption = page.getByText(/showing\s+\d+\s*-\s*\d+\s+of\s+\d+/i).first();
  return (await caption.textContent().catch(() => '')) ?? '';
}

interface ReceiptMeta {
  barcode: string;
  date: string;
  time?: string;
  total?: string;
}

async function readReceiptMeta(paper: Locator): Promise<ReceiptMeta> {
  const text = (await paper.innerText()).replace(/ /g, ' ');
  const barcode = text.match(/\b(\d{20,})\b/)?.[1] ?? 'no-barcode';
  // Footer line like "09/08/2026 16:53 489 121" or "P7 09/08/2026 04:53".
  const dateMatch = text.match(/(\d{2}\/\d{2}\/\d{4})\s+(\d{1,2}:\d{2})/);
  const total = text.match(/\bTotal\s+\$?(-?[\d,]+\.\d{2})/i)?.[1];
  return {
    barcode,
    date: toIsoDate(dateMatch?.[1]),
    time: dateMatch?.[2],
    total,
  };
}

async function captureOpenDialog(
  page: Page,
  outDir: string,
  kind: ManifestEntry['kind'],
  range: string,
  manifest: ManifestEntry[],
  headless: boolean,
): Promise<'captured' | 'skipped'> {
  const dialog = page.getByRole('dialog').filter({ hasText: /receipt/i }).last();
  await dialog.waitFor({ state: 'visible', timeout: 20_000 });
  const paper = dialog.locator('.MuiDialog-paper').first();
  await paper.waitFor({ state: 'visible', timeout: 10_000 });
  // Give the barcode image and fonts a moment.
  await sleep(600);

  const meta = await readReceiptMeta(paper);
  const base = `${meta.date}_${meta.barcode}${kind === 'return' ? '_return' : ''}`;
  const file = join(outDir, `${base}.png`);

  if (existsSync(file)) {
    log(`skip (exists) ${base}`);
    return 'skipped';
  }

  // Make the whole paper fit the viewport so the element screenshot is complete.
  const paperHeight = await paper.evaluate((el) => (el as HTMLElement).scrollHeight);
  const vp = page.viewportSize() ?? { width: 1100, height: 1400 };
  if (paperHeight + 160 > vp.height) {
    await page.setViewportSize({ width: vp.width, height: paperHeight + 160 });
    await sleep(300);
  }

  await paper.screenshot({ path: file, type: 'png' });

  let pdf: string | undefined;
  if (headless) {
    try {
      pdf = join(outDir, `${base}.pdf`);
      await page.pdf({ path: pdf, printBackground: true, width: '4in', height: `${Math.ceil(paperHeight / 96) + 1}in` });
    } catch (err) {
      log(`pdf failed for ${base}: ${err instanceof Error ? err.message : String(err)}`);
      pdf = undefined;
    }
  }

  manifest.push({
    barcode: meta.barcode,
    kind,
    date: meta.date,
    time: meta.time,
    total: meta.total,
    range,
    file,
    pdf,
    capturedAt: new Date().toISOString(),
  });
  log(`captured ${base}${meta.total ? ` ($${meta.total})` : ''}`);
  return 'captured';
}

async function closeDialog(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog').filter({ hasText: /receipt/i }).last();
  const close = dialog.getByRole('button', { name: /^close$/i }).first();
  if (await close.isVisible().catch(() => false)) await close.click();
  else await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
  await sleep(STEP_DELAY_MS);
}

async function processRange(
  page: Page,
  range: string,
  outDir: string,
  manifest: ManifestEntry[],
  headless: boolean,
): Promise<{ captured: number; skipped: number; failed: number }> {
  const stats = { captured: 0, skipped: 0, failed: 0 };
  await selectRange(page, range);
  await expandAll(page);
  const caption = await showingCaption(page);
  const buttons = page.getByRole('button', { name: /view (return )?receipt/i });
  const count = await buttons.count();
  log(`range "${range}": ${count} receipt button(s) ${caption ? `(${caption.trim()})` : ''}`);

  for (let i = 0; i < count; i++) {
    const button = buttons.nth(i);
    const name = (await button.textContent().catch(() => '')) ?? '';
    const kind: ManifestEntry['kind'] = /return/i.test(name) ? 'return' : 'receipt';
    try {
      await button.scrollIntoViewIfNeeded();
      await button.click();
      const result = await captureOpenDialog(page, outDir, kind, range, manifest, headless);
      stats[result === 'captured' ? 'captured' : 'skipped']++;
    } catch (err) {
      stats.failed++;
      log(`FAILED receipt #${i + 1} in "${range}": ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await closeDialog(page).catch(() => undefined);
    }
  }
  return stats;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(args.out);
  const profileDir = resolve(args.profile);
  mkdirSync(outDir, { recursive: true });
  mkdirSync(profileDir, { recursive: true });
  const manifestPath = join(outDir, 'manifest.json');
  const manifest = loadManifest(manifestPath);

  log(`output: ${outDir}`);
  log(`profile: ${profileDir} (${args.headless ? 'headless' : 'headed'})`);

  // Two ways to get a browser:
  //   --cdp <url>  attach to a Chrome YOU started (see --help). No automation
  //                switches are involved, so Costco's sign-in behaves exactly
  //                as it does for you normally. Recommended.
  //   default      launch Chrome with a persistent profile under data/. Costco's
  //                sign-in may not complete in an automation-launched browser.
  let context: BrowserContext;
  let disconnect: () => Promise<void>;
  if (args.cdp) {
    const browser = await chromium.connectOverCDP(args.cdp);
    context = browser.contexts()[0] ?? (await browser.newContext());
    disconnect = () => browser.close(); // disconnects only; your Chrome stays open
    log(`attached to Chrome at ${args.cdp}`);
  } else {
    context = await chromium.launchPersistentContext(profileDir, {
      channel: 'chrome',
      headless: args.headless,
      viewport: { width: 1100, height: 1400 },
      // A print dialog would block the page; neutralize it up front.
      args: ['--disable-print-preview', '--no-first-run', '--no-default-browser-check'],
    });
    disconnect = () => context.close();
  }
  await context.addInitScript(() => {
    window.print = () => undefined;
  });

  const page = args.cdp ? await context.newPage() : context.pages()[0] ?? (await context.newPage());
  if (args.cdp) await page.setViewportSize({ width: 1100, height: 1400 });
  const totals = { captured: 0, skipped: 0, failed: 0 };

  try {
    await page.goto(ORDERS_URL, { waitUntil: 'domcontentloaded' });
    await waitForSignedIn(page);
    await page.getByRole('tab', { name: /warehouse/i }).click();
    await rangeCombo(page).waitFor({ state: 'visible', timeout: 20_000 });

    const ranges = (await listRangeLabels(page)).slice(0, args.ranges);
    log(`periods available: ${ranges.join(' | ')}`);

    for (const range of ranges) {
      const s = await processRange(page, range, outDir, manifest, args.headless);
      totals.captured += s.captured;
      totals.skipped += s.skipped;
      totals.failed += s.failed;
      saveManifest(manifestPath, manifest);
    }
  } finally {
    saveManifest(manifestPath, manifest);
    if (args.cdp) await page.close().catch(() => undefined);
    await disconnect();
  }

  log(`done — captured ${totals.captured}, skipped ${totals.skipped} (already on disk), failed ${totals.failed}`);
  log(`manifest: ${manifestPath}`);
  if (totals.failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
