import { normalizeMerchant } from '../normalize/merchant';

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
//   2. every store this household has already uploaded a receipt from — if
//      they keep receipts from the corner market, ask about the corner market.
//
// And only recent debits: a first import brings years of history and nobody
// has the receipt for a charge from two years ago.
// =============================================================================

export interface ReceiptCapableMerchant {
  /** Display name for the queue row. */
  name: string;
  /** Whole-word patterns over a `normalizeMerchant` string. */
  patterns: readonly RegExp[];
}

export const RECEIPT_CAPABLE_MERCHANTS: readonly ReceiptCapableMerchant[] = [
  // Warehouse clubs
  { name: 'Costco', patterns: [/\bCOSTCO\b/] },
  { name: "Sam's Club", patterns: [/\bSAM S CLUB\b/, /\bSAMS CLUB\b/, /\bSAMSCLUB\b/] },
  { name: "BJ's", patterns: [/\bBJ S\b/, /\bBJS\b/] },
  // Big-box
  { name: 'Walmart', patterns: [/\bWAL ?MART\b/, /\bWM SUPERCENTER\b/, /\bWM SUPERC\b/] },
  { name: 'Target', patterns: [/\bTARGET\b/] },
  { name: 'Fred Meyer', patterns: [/\bFRED MEYER\b/] },
  { name: 'Meijer', patterns: [/\bMEIJER\b/] },
  // Home improvement
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
  // Pharmacy
  { name: 'Walgreens', patterns: [/\bWALGREENS\b/] },
  { name: 'CVS', patterns: [/\bCVS\b/] },
  { name: 'Rite Aid', patterns: [/\bRITE ?AID\b/] },
];

/** How far back the queue asks for a receipt; older charges are just charges. */
export const RECEIPT_ASK_WINDOW_DAYS = 60;

/**
 * The store a bank line is at, if it is one worth asking a receipt for; else
 * null. `learnedStores` are this household's own `receipts.store` values.
 */
export function receiptCapableMerchant(normalizedMerchant: string, learnedStores: Iterable<string> = []): string | null {
  const line = normalizeMerchant(normalizedMerchant);
  if (line.length === 0) return null;
  for (const m of RECEIPT_CAPABLE_MERCHANTS) {
    if (m.patterns.some((p) => p.test(line))) return m.name;
  }
  for (const store of learnedStores) {
    const key = normalizeMerchant(store);
    // Too short to be identity ("A1"), or not a whole-word occurrence: no.
    if (key.length < 3) continue;
    if (new RegExp(`(^|\\s)${escapeRegExp(key)}(\\s|$)`).test(line)) return store.trim();
  }
  return null;
}

/** A debit inside the ask window: recent enough that the receipt may still exist. */
export function isWithinAskWindow(postedDate: string, now: Date, windowDays = RECEIPT_ASK_WINDOW_DAYS): boolean {
  const posted = Date.parse(`${postedDate}T00:00:00Z`);
  if (Number.isNaN(posted)) return false;
  const ageDays = (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - posted) / 86_400_000;
  return ageDays >= 0 && ageDays <= windowDays;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
