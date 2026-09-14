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
 *     "Showing" dropdown and every page of each period (10 per page), and for
 *     each "View Receipt" / "View Return Receipt" button opens the receipt
 *     dialog and screenshots the receipt paper.
 *   - Warehouse receipts are named <YYYY-MM-DD>_<transactionBarcode>.png so
 *     they pair with `transactionBarcode` in Costco's WarehouseReceiptDetail
 *     JSON. Gas-station receipts print no barcode; they are named
 *     <YYYY-MM-DD>_gas-<invoice>.png and pair with `invoiceNumber`. A
 *     manifest.json in the output dir records what was captured (paths
 *     relative to the manifest so the set can move as a unit).
 *   - Re-runs skip receipts the manifest already lists (same identifier, date
 *     and kind, file still present). Two different receipts that would produce
 *     the same filename are both kept (suffix _2, _3, …) with a warning —
 *     a receipt is never overwritten or silently dropped.
 *
 * Why PNG and not PDF: Chrome only exposes print-to-PDF in headless mode, and
 * Costco's sign-in does not survive headless well. The vision pipeline accepts
 * PNG directly. Pass --headless (without --cdp) to attempt PDF capture as well.
 *
 * Output lives under data/ — real financial data, never committed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { chromium, type BrowserContext, type Locator, type Page } from 'playwright';

interface Args {
  out: string;
  profile: string;
  ranges: number;
  headless: boolean;
  cdp?: string;
}

interface ManifestEntry {
  /** Warehouse receipts: the printed transaction barcode. Gas receipts: null. */
  barcode: string | null;
  /** Gas receipts: the printed Invoice# (pairs with JSON `invoiceNumber`). */
  invoice: string | null;
  kind: 'receipt' | 'return';
  layout: 'warehouse' | 'gas';
  date: string; // YYYY-MM-DD
  time?: string;
  /** Signed: negative for a return receipt. As printed, e.g. "-42.39". */
  total?: string;
  range: string;
  /** Relative to the manifest's directory. */
  file: string;
  pdf?: string;
  capturedAt: string;
}

/** Per-run state threaded through the capture functions. */
interface Run {
  outDir: string;
  manifest: ManifestEntry[];
  /** Filenames written during THIS run, to disambiguate same-run collisions. */
  written: Set<string>;
  /** Attempt page.pdf() — only meaningful for a headless, self-launched browser. */
  pdf: boolean;
}

const ORDERS_URL = 'https://www.costco.com/OrderStatusCmd';
const LOGIN_WAIT_MS = 10 * 60 * 1000;
const STEP_DELAY_MS = 400;
const LIST_SETTLE_MS = 15_000;
const MAX_PAGES_PER_RANGE = 50;

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
    else if (a === '--ranges') {
      const n = Number(next());
      if (!Number.isInteger(n) || n <= 0) throw new Error('--ranges must be a positive integer');
      args.ranges = n;
    } else if (a === '--headless') args.headless = true;
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
const warn = (msg: string) => console.warn(`[costco] WARN ${msg}`);

/**
 * Load the manifest, normalizing entries written by earlier versions of this
 * script (no `invoice` / `layout`; a 'no-barcode' sentinel instead of null) so
 * every consumer can rely on the current shape.
 */
function loadManifest(path: string): ManifestEntry[] {
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Array<Partial<ManifestEntry> & { barcode?: string | null }>;
  return raw.map((e) => {
    const barcode = e.barcode && e.barcode !== 'no-barcode' ? e.barcode : null;
    const invoice = e.invoice ?? null;
    return {
      ...e,
      barcode,
      invoice,
      layout: e.layout ?? (invoice ? 'gas' : 'warehouse'),
      kind: e.kind ?? 'receipt',
      date: e.date ?? 'unknown-date',
      range: e.range ?? '',
      file: e.file ?? '',
      capturedAt: e.capturedAt ?? '',
    };
  });
}

function saveManifest(path: string, entries: ManifestEntry[]): void {
  writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`);
}

// Costco prints dates as MM/DD/YYYY on warehouse receipts and MM/DD/YY on gas receipts.
function toIsoDate(printed: string | undefined): string {
  const m = printed?.match(/(\d{2})\/(\d{2})\/(\d{2,4})/);
  if (!m) return 'unknown-date';
  const year = m[3]!.length === 2 ? `20${m[3]}` : m[3];
  return `${year}-${m[1]}-${m[2]}`;
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
      // The sign-in may be completed in ANOTHER tab of the same profile (the
      // --cdp flow); re-request the orders page periodically so this tab
      // picks up the session instead of sitting on a stale sign-in form.
      if (Date.now() - lastNav > 20_000) {
        lastNav = Date.now();
        await page.goto(ORDERS_URL, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
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

// Everything we touch lives inside the Warehouse tab panel; the site header
// (search box = role combobox, promo/chat widgets with "show more" buttons)
// must never be matched.
function panel(page: Page): Locator {
  return page.getByRole('tabpanel').first();
}

function rangeCombo(page: Page): Locator {
  return panel(page).getByRole('combobox').first();
}

function receiptButtons(page: Page): Locator {
  return panel(page).getByRole('button', { name: /view (return )?receipt/i });
}

// The receipt dialog is the MUI dialog that actually contains a receipt paper;
// a hidden Bootstrap modal with dialog semantics also exists on the page.
function receiptDialog(page: Page): Locator {
  return page.getByRole('dialog').filter({ has: page.locator('.MuiDialog-paper') }).last();
}

interface Caption {
  from: number;
  to: number;
  total: number;
  text: string;
}

async function showingCaption(page: Page): Promise<Caption | null> {
  const caption = panel(page).getByText(/showing\s+\d+\s*-\s*\d+\s+of\s+\d+/i).first();
  const text = ((await caption.textContent().catch(() => '')) ?? '').trim();
  const m = text.match(/showing\s+(\d+)\s*-\s*(\d+)\s+of\s+(\d+)/i);
  return m ? { from: Number(m[1]), to: Number(m[2]), total: Number(m[3]), text } : null;
}

// Wait for the list to re-render: the "Showing x - y of z" caption changes, or
// receipt buttons (re)appear. Bounded; no reliance on network idle, which a
// chatty SPA never reaches.
async function waitForListSettled(page: Page, previous: Caption | null): Promise<Caption | null> {
  const deadline = Date.now() + LIST_SETTLE_MS;
  let caption: Caption | null = null;
  while (Date.now() < deadline) {
    caption = await showingCaption(page);
    const count = await receiptButtons(page).count();
    if ((caption && caption.text !== previous?.text) || (!previous && count > 0)) break;
    await sleep(250);
  }
  await sleep(STEP_DELAY_MS);
  return caption ?? (await showingCaption(page));
}

// The period control is a native <select> (MUI NativeSelect) on the live site;
// its <option>s are never "visible" to Playwright and it must be driven with
// selectOption(). Keep the pop-up-menu path in case the markup changes.
async function isNativeSelect(combo: Locator): Promise<boolean> {
  return combo.evaluate((el) => el.tagName === 'SELECT').catch(() => false);
}

async function selectRange(page: Page, label: string): Promise<Caption | null> {
  const before = await showingCaption(page);
  const combo = rangeCombo(page);
  if (await isNativeSelect(combo)) {
    await combo.selectOption({ label });
  } else {
    await combo.click();
    const option = page.getByRole('option', { name: label, exact: true });
    await option.waitFor({ state: 'visible', timeout: 10_000 });
    await option.click();
  }
  return waitForListSettled(page, before);
}

async function listRangeLabels(page: Page): Promise<string[]> {
  const combo = rangeCombo(page);
  if (await isNativeSelect(combo)) {
    const labels = await combo.locator('option').allTextContents();
    return labels.map((t) => t.trim()).filter(Boolean);
  }
  await combo.click();
  const options = page.getByRole('option');
  await options.first().waitFor({ state: 'visible', timeout: 10_000 });
  const labels = (await options.allTextContents()).map((t) => t.trim()).filter(Boolean);
  await page.keyboard.press('Escape');
  await sleep(STEP_DELAY_MS);
  return labels;
}

// --- pagination ---------------------------------------------------------------
// The list shows 10 receipts per page with MUI-style pagination ("Go to page
// N", "Go to previous page", "Go to next page"). Some periods remember the
// last page visited, so always rewind to page 1 before capturing.

function pagerButton(page: Page, name: RegExp): Locator {
  return panel(page).getByRole('button', { name }).first();
}

async function clickPager(page: Page, name: RegExp, current: Caption | null): Promise<Caption | null> {
  const btn = pagerButton(page, name);
  if (!(await btn.isVisible().catch(() => false))) return null;
  if (await btn.isDisabled().catch(() => false)) return null;
  await btn.click();
  return waitForListSettled(page, current);
}

async function goToFirstPage(page: Page, current: Caption | null): Promise<Caption | null> {
  let caption = current;
  for (let i = 0; i < MAX_PAGES_PER_RANGE && caption && caption.from > 1; i++) {
    const next =
      (await clickPager(page, /^go to page 1$|^page 1$|^1$/i, caption)) ??
      (await clickPager(page, /previous page|^previous$|^prev$/i, caption));
    if (!next || next.text === caption.text) {
      warn(`could not rewind to page 1 (at "${caption.text}")`);
      break;
    }
    caption = next;
  }
  return caption;
}

async function goToNextPage(page: Page, current: Caption): Promise<Caption | null> {
  const next = await clickPager(page, /next page|^next$/i, current);
  if (!next || next.text === current.text) return null;
  return next;
}

// --- receipt metadata ---------------------------------------------------------

interface ReceiptMeta {
  layout: 'warehouse' | 'gas';
  barcode: string | null;
  invoice: string | null;
  date: string;
  time?: string;
  total?: string;
}

async function readReceiptMeta(paper: Locator, kind: ManifestEntry['kind']): Promise<ReceiptMeta> {
  const text = (await paper.innerText()).replace(/ /g, ' ');
  const barcode = text.match(/\b(\d{20,})\b/)?.[1] ?? null;

  if (!barcode && /Invoice#/i.test(text)) {
    // Gas-station layout: "Invoice# 38015 / Date: 09/03/26 / Time: 17:00 /
    // Total Sale $51.11". No barcode is printed.
    const invoice = text.match(/Invoice#\s*(\d+)/i)?.[1] ?? null;
    const date = toIsoDate(text.match(/Date:\s*(\d{2}\/\d{2}\/\d{2,4})/i)?.[1]);
    const time = text.match(/Time:\s*(\d{1,2}:\d{2})/i)?.[1];
    const rawTotal = text.match(/(?<!Refunded\s)\bTotal\s+Sale\s*\$?(-?[\d,]+\.\d{2})/i)?.[1];
    const total = rawTotal === undefined ? undefined : kind === 'return' ? `-${rawTotal.replace(/^-/, '')}` : rawTotal;
    return { layout: 'gas', barcode: null, invoice, date, time, total };
  }

  // Warehouse layout. The transaction footer reads "MM/DD/YYYY HH:MM <trn> <op>"
  // (it appears in the tender block and again at the bottom). Take the LAST
  // such match so an unrelated date-like string higher on the page cannot win.
  const footer = [...text.matchAll(/(\d{2}\/\d{2}\/\d{4})\s+(\d{1,2}:\d{2})\s+\d+\s+\d+/g)].at(-1);
  const anyDate = text.match(/(\d{2}\/\d{2}\/\d{4})\s+(\d{1,2}:\d{2})/);
  const dateMatch = footer ?? anyDate;

  // "Total 118.87" — but not the "Refunded Total" summary line, whose sign is
  // printed differently. Sign the value by receipt kind.
  const rawTotal = text.match(/(?<!Refunded\s)\bTotal\s+\$?(-?[\d,]+\.\d{2})/i)?.[1];
  const total = rawTotal === undefined ? undefined : kind === 'return' ? `-${rawTotal.replace(/^-/, '')}` : rawTotal;

  return { layout: 'warehouse', barcode, invoice: null, date: toIsoDate(dateMatch?.[1]), time: dateMatch?.[2], total };
}

/** The stable identifier a receipt pairs on, or null when nothing readable was printed. */
function identifierOf(meta: ReceiptMeta): string | null {
  return meta.barcode ?? (meta.invoice ? `gas-${meta.invoice}` : null);
}

/**
 * Pick a filename base that collides with nothing already written — neither in
 * this run nor on disk from earlier runs. A collision means a DIFFERENT
 * receipt with the same date/identifier text, so it gets a suffix and a warning;
 * nothing is ever overwritten or dropped.
 */
function uniqueBase(run: Run, base: string): string {
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? base : `${base}_${n}`;
    if (!run.written.has(candidate) && !existsSync(join(run.outDir, `${candidate}.png`))) {
      if (n > 1) warn(`filename collision for ${base}; saving as ${candidate}`);
      return candidate;
    }
  }
  throw new Error(`could not find a unique filename for ${base}`);
}

/**
 * "Already captured" is decided by the manifest, not by filename: an entry
 * with the same identifier, date and kind whose file is still on disk. A
 * receipt without a readable identifier can never be recognised, so it is
 * always captured again (with a suffix) rather than risk skipping a different one.
 */
function alreadyCaptured(run: Run, meta: ReceiptMeta, kind: ManifestEntry['kind']): boolean {
  const id = identifierOf(meta);
  if (!id) return false;
  return run.manifest.some(
    (e) =>
      (e.barcode ?? (e.invoice ? `gas-${e.invoice}` : null)) === id &&
      e.date === meta.date &&
      e.kind === kind &&
      existsSync(join(run.outDir, e.file)),
  );
}

async function captureOpenDialog(
  page: Page,
  run: Run,
  kind: ManifestEntry['kind'],
  range: string,
): Promise<'captured' | 'skipped'> {
  const dialog = receiptDialog(page);
  await dialog.waitFor({ state: 'visible', timeout: 20_000 });
  const paper = dialog.locator('.MuiDialog-paper').first();
  await paper.waitFor({ state: 'visible', timeout: 10_000 });
  // Give the barcode image and fonts a moment.
  await sleep(600);

  const meta = await readReceiptMeta(paper, kind);
  const id = identifierOf(meta) ?? 'no-id';
  if (id === 'no-id') warn(`no barcode or invoice found in a ${meta.layout} ${kind} dated ${meta.date}; filename will not pair with the JSON export`);
  const rawBase = `${meta.date}_${id}${kind === 'return' ? '_return' : ''}`;

  if (alreadyCaptured(run, meta, kind)) {
    log(`skip (already captured) ${rawBase}`);
    return 'skipped';
  }
  const base = uniqueBase(run, rawBase);
  const file = join(run.outDir, `${base}.png`);

  // Make the whole paper fit the viewport so the element screenshot is complete.
  const paperHeight = await paper.evaluate((el) => (el as HTMLElement).scrollHeight);
  const vp = page.viewportSize() ?? { width: 1100, height: 1400 };
  if (paperHeight + 160 > vp.height) {
    await page.setViewportSize({ width: vp.width, height: paperHeight + 160 });
    await sleep(300);
  }

  await paper.screenshot({ path: file, type: 'png' });
  run.written.add(base);

  let pdf: string | undefined;
  if (run.pdf) {
    const pdfPath = join(run.outDir, `${base}.pdf`);
    try {
      await page.pdf({ path: pdfPath, printBackground: true, width: '4in', height: `${Math.ceil(paperHeight / 96) + 1}in` });
      pdf = relative(run.outDir, pdfPath);
    } catch (err) {
      warn(`pdf failed for ${base}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  run.manifest.push({
    barcode: meta.barcode,
    invoice: meta.invoice,
    kind,
    layout: meta.layout,
    date: meta.date,
    time: meta.time,
    total: meta.total,
    range,
    file: relative(run.outDir, file),
    pdf,
    capturedAt: new Date().toISOString(),
  });
  log(`captured ${base}${meta.total ? ` ($${meta.total})` : ''}`);
  return 'captured';
}

async function closeDialog(page: Page): Promise<void> {
  const dialog = receiptDialog(page);
  const close = dialog.getByRole('button', { name: /^close$/i }).first();
  if (await close.isVisible().catch(() => false)) await close.click();
  else await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);
  await sleep(STEP_DELAY_MS);
}

interface Stats {
  captured: number;
  skipped: number;
  failed: number;
}

async function processPage(page: Page, run: Run, range: string, stats: Stats): Promise<void> {
  const buttons = receiptButtons(page);
  const count = await buttons.count();
  for (let i = 0; i < count; i++) {
    // Locators re-query live. Guard against the list re-rendering with a
    // different length mid-loop (a virtualized list would do this), which
    // would make index i point at a different receipt.
    const nowCount = await buttons.count();
    if (nowCount !== count) {
      warn(`receipt list changed length mid-page (${count} → ${nowCount}); stopping this page — re-run to pick up the rest`);
      break;
    }
    const button = buttons.nth(i);
    const name = (await button.textContent().catch(() => '')) ?? '';
    const kind: ManifestEntry['kind'] = /return/i.test(name) ? 'return' : 'receipt';
    try {
      await button.scrollIntoViewIfNeeded();
      await button.click();
      const result = await captureOpenDialog(page, run, kind, range);
      stats[result === 'captured' ? 'captured' : 'skipped']++;
    } catch (err) {
      stats.failed++;
      log(`FAILED receipt #${i + 1} in "${range}": ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await closeDialog(page).catch(() => undefined);
    }
  }
}

async function processRange(page: Page, run: Run, range: string): Promise<Stats> {
  const stats: Stats = { captured: 0, skipped: 0, failed: 0 };
  let caption = await selectRange(page, range);
  caption = await goToFirstPage(page, caption);
  log(`range "${range}": ${caption ? `${caption.total} receipt(s), ${caption.text}` : `${await receiptButtons(page).count()} receipt button(s), no caption`}`);

  let seen = 0;
  for (let pageNo = 1; pageNo <= MAX_PAGES_PER_RANGE; pageNo++) {
    const onPage = await receiptButtons(page).count();
    await processPage(page, run, range, stats);
    seen += onPage;
    if (!caption || caption.to >= caption.total) break;
    const next = await goToNextPage(page, caption);
    if (!next) {
      warn(`range "${range}": expected more pages after "${caption.text}" but found no next-page control`);
      break;
    }
    caption = next;
    log(`  page ${pageNo + 1}: ${caption.text}`);
  }
  if (caption && seen < caption.total) warn(`range "${range}": saw ${seen} of ${caption.total} listed receipts`);
  return stats;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outDir = resolve(args.out);
  const profileDir = resolve(args.profile);
  mkdirSync(outDir, { recursive: true });
  mkdirSync(profileDir, { recursive: true });
  const manifestPath = join(outDir, 'manifest.json');
  const run: Run = {
    outDir,
    manifest: loadManifest(manifestPath),
    written: new Set(),
    // page.pdf() only works in a headless browser we launched ourselves.
    pdf: args.headless && !args.cdp,
  };
  if (args.headless && args.cdp) warn('--headless is ignored with --cdp (the attached browser is whatever you launched); no PDFs will be attempted');

  log(`output: ${outDir}`);
  log(args.cdp ? `attaching to ${args.cdp}` : `profile: ${profileDir} (${args.headless ? 'headless' : 'headed'})`);

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
  const totals: Stats = { captured: 0, skipped: 0, failed: 0 };

  try {
    await page.goto(ORDERS_URL, { waitUntil: 'domcontentloaded' });
    await waitForSignedIn(page);
    await page.getByRole('tab', { name: /warehouse/i }).click();
    await rangeCombo(page).waitFor({ state: 'visible', timeout: 20_000 });

    const ranges = (await listRangeLabels(page)).slice(0, args.ranges);
    log(`periods available: ${ranges.join(' | ')}`);

    for (const range of ranges) {
      const s = await processRange(page, run, range);
      totals.captured += s.captured;
      totals.skipped += s.skipped;
      totals.failed += s.failed;
      saveManifest(manifestPath, run.manifest);
    }
  } finally {
    saveManifest(manifestPath, run.manifest);
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
