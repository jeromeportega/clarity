import { normalizeMerchant } from '../normalize/merchant';
import { normalizeStore } from '../receipts/dictionary/normalize';

// =============================================================================
// Which bank charges are worth asking a receipt for.
//
// Most of a household's bank lines — rent, utilities, restaurants, fuel — have
// no item-level story to recover, and asking about them is noise. A charge at
// a store whose receipt breaks down into items (warehouse clubs, big-box,
// home improvement, grocery, pharmacy) is different: upload the receipt and
// the charge becomes items with categories. The queue asks about those only.
//
// Two sources of "receipt-capable":
//   1. a built-in list of chains, matched as whole words against the bank
//      line's normalized merchant (UPPERCASE, punctuation flattened to
//      spaces, so "SAM'S CLUB" arrives as "SAM S CLUB");
//   2. every store this household has already uploaded a receipt from. Both
//      sides go through `normalizeStore` — the one key per retailer the SKU
//      dictionary uses — so "Harris Teeter #123" on a receipt header and
//      "HARRIS TEETER 0456" on a bank line meet at "HARRIS TEETER".
//
// Fuel is never asked about, whoever sells it: "COSTCO GAS" is one line on a
// receipt, not a breakdown. And only recent debits: a first import brings
// years of history and nobody has the receipt for a charge from two years ago.
// =============================================================================

export interface ReceiptCapableMerchant {
  /** Display name for the queue row. */
  name: string;
  /** Whole-word patterns over a `normalizeMerchant` string. First entry to match wins. */
  patterns: readonly RegExp[];
  /** A pattern that vetoes the match (a namesake that is not a store). */
  exclude?: RegExp;
}

export const RECEIPT_CAPABLE_MERCHANTS: readonly ReceiptCapableMerchant[] = [
  // Warehouse clubs
  { name: 'Costco', patterns: [/\bCOSTCO\b/] },
  { name: "Sam's Club", patterns: [/\bSAM S CLUB\b/, /\bSAMS CLUB\b/, /\bSAMSCLUB\b/] },
  // BJ's Wholesale, not BJ's Restaurant & Brewhouse.
  { name: "BJ's", patterns: [/\bBJ ?S (WHOLESALE|WHSE|CLUB)\b/] },
  // Big-box
  { name: 'Walmart', patterns: [/\bWAL ?MART\b/, /\bWM SUPERCENTER\b/, /\bWM SUPERC\b/] },
  { name: 'Target', patterns: [/\bTARGET\b/] },
  { name: 'Fred Meyer', patterns: [/\bFRED MEYER\b/] },
  { name: 'Meijer', patterns: [/\bMEIJER\b/] },
  // Home improvement — Lowes Foods (a grocer) before Lowe's, since first match wins.
  { name: 'Lowes Foods', patterns: [/\bLOWE ?S FOODS\b/] },
  { name: 'Home Depot', patterns: [/\bHOME ?DEPOT\b/] },
  { name: "Lowe's", patterns: [/\bLOWE ?S\b/] },
  { name: 'Menards', patterns: [/\bMENARDS\b/] },
  { name: 'IKEA', patterns: [/\bIKEA\b/] },
  // Electronics
  { name: 'Best Buy', patterns: [/\bBEST ?BUY\b/] },
  // Grocery
  { name: 'Kroger', patterns: [/\bKROGER\b/] },
  { name: 'Safeway', patterns: [/\bSAFEWAY\b/] },
  { name: 'Albertsons', patterns: [/\bALBERTSONS?\b/] },
  { name: "Trader Joe's", patterns: [/\bTRADER JOE S\b/, /\bTRADER JOES\b/] },
  { name: 'Whole Foods', patterns: [/\bWHOLE ?FOODS\b/, /\bWHOLEFDS\b/, /\bWFM\b/] },
  { name: 'Aldi', patterns: [/\bALDI\b/] },
  { name: 'H-E-B', patterns: [/\bH ?E ?B\b/] },
  { name: 'Publix', patterns: [/\bPUBLIX\b/] },
  { name: 'Wegmans', patterns: [/\bWEGMANS\b/] },
  { name: 'WinCo', patterns: [/\bWINCO\b/] },
  { name: 'Sprouts', patterns: [/\bSPROUTS\b/] },
  // Pharmacy — the store, not the mail-order benefit manager.
  { name: 'Walgreens', patterns: [/\bWALGREENS\b/] },
  { name: 'CVS', patterns: [/\bCVS\b/], exclude: /\bCAREMARK\b/ },
  { name: 'Rite Aid', patterns: [/\bRITE ?AID\b/] },
];

/** A pump is a pump: one line, no breakdown, whoever's sign is over it. */
const FUEL = /\b(GAS|FUEL|GASOLINE|PETROL)\b/;

/** How far back the queue asks for a receipt; older charges are just charges. */
export const RECEIPT_ASK_WINDOW_DAYS = 60;

/** A store this household uploads receipts from, prepared once per queue build. */
export interface LearnedStore {
  /** `normalizeStore` of the receipt header, punctuation flattened like a bank line. */
  key: string;
  tokens: readonly string[];
  /** What the row says: the key in title case ("HARRIS TEETER" → "Harris Teeter"). */
  display: string;
}

/** One-word headers that name a kind of shop, not a shop: never a key on their own. */
const GENERIC_SINGLE_WORDS = new Set([
  'STORE', 'STORES', 'MARKET', 'MARKETS', 'SHOP', 'SHOPS', 'MART', 'FOODS', 'FOOD', 'GROCERY', 'GROCER',
  'PHARMACY', 'SUPERMARKET', 'DEPOT', 'CENTER', 'CENTRE', 'OUTLET', 'WAREHOUSE', 'CLUB', 'HARDWARE', 'RECEIPT', 'TOTAL',
]);

/**
 * Prepare the household's receipt headers for matching. A key must be able
 * to stand for a retailer on its own: at least two words, or one word of at
 * least four characters that is not a generic kind of shop, and not just a
 * number — so "Gas", "A1", "THE", "Market" and "Store" never become catch-alls.
 */
export function compileLearnedStores(stores: Iterable<string>): LearnedStore[] {
  const out: LearnedStore[] = [];
  const seen = new Set<string>();
  for (const store of stores) {
    // Match on the flattened form (bank lines lose their apostrophes:
    // "JOE'S HARDWARE" arrives as "JOE S HARDWARE"); display the proper one.
    const proper = normalizeStore(store);
    const key = normalizeStore(normalizeMerchant(proper));
    const tokens = key.split(' ').filter((t) => t.length > 0);
    if (tokens.length === 0 || seen.has(key)) continue;
    if (/^\d+$/.test(key)) continue;
    if (tokens.length < 2 && (key.length < 4 || GENERIC_SINGLE_WORDS.has(key))) continue;
    if (FUEL.test(key)) continue;
    seen.add(key);
    out.push({ key, tokens, display: titleCase(proper) });
  }
  return out;
}

/**
 * The store a bank line is at, if it is one worth asking a receipt for; else
 * null. Chains match anywhere in the line as whole words. A learned store
 * matches when its key and the line's key share a whole-token prefix — bank
 * lines and receipt headers both lead with the name and trail with numbers,
 * cities and noise ("HARRIS TEETER STORE 123 RALEIGH NC" vs "HARRIS TEETER")
 * — or, for a bank that prefixes its payees ("PURCHASE AUTHORIZED ON 09 16
 * CORNER MARKET"), when the whole learned key appears as a run of tokens.
 * The label is capped at the words that matched, so a long header does not
 * become a long row.
 */
export function receiptCapableMerchant(normalizedMerchant: string, learned: readonly LearnedStore[] = []): string | null {
  const line = normalizeMerchant(normalizedMerchant);
  if (line.length === 0 || FUEL.test(line)) return null;
  for (const m of RECEIPT_CAPABLE_MERCHANTS) {
    if (m.exclude?.test(line)) continue;
    if (m.patterns.some((p) => p.test(line))) return m.name;
  }
  if (learned.length === 0) return null;
  const lineTokens = normalizeStore(line).split(' ').filter((t) => t.length > 0);
  for (const store of learned) {
    const n = sharedPrefixLength(lineTokens, store.tokens);
    if (n > 0) {
      // The whole learned key matched: its proper spelling. Only the line's
      // shorter head matched: the line's own words, title-cased.
      return n === store.tokens.length ? store.display : titleCase(lineTokens.slice(0, n).join(' '));
    }
    if (containsRun(lineTokens, store.tokens)) return store.display;
  }
  return null;
}

/** How many leading tokens the two lists share, if one is a whole-token prefix of the other; else 0. */
function sharedPrefixLength(a: readonly string[], b: readonly string[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return 0;
  return n;
}

/** `needle` appears in `hay` as a contiguous run of whole tokens. */
function containsRun(hay: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  outer: for (let i = 0; i + needle.length <= hay.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

function titleCase(key: string): string {
  return key
    .split(' ')
    .map((t) => (t.length <= 1 || /\d/.test(t) ? t : t[0] + t.slice(1).toLowerCase()))
    .join(' ');
}

/**
 * A debit inside the ask window: recent enough that the receipt may still
 * exist. Compared as calendar days in UTC; a bank posting dated one day ahead
 * of the server's UTC day (a household east of UTC, or a bank's local date)
 * still counts as today.
 */
export function isWithinAskWindow(postedDate: string, now: Date, windowDays = RECEIPT_ASK_WINDOW_DAYS): boolean {
  const posted = Date.parse(`${postedDate}T00:00:00Z`);
  if (Number.isNaN(posted)) return false;
  const ageDays = (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - posted) / 86_400_000;
  return ageDays >= -1 && ageDays <= windowDays;
}
