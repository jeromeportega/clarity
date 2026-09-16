import { sha256Hex } from '../../idempotency/keys';
import type {
  NormalizedReceipt,
  NormalizedReceiptItem,
  RefundDestination,
} from '../../model/normalized';
import type { ImportError } from '../source-adapter';

/**
 * Parser for Costco's digital in-warehouse receipts — the `WarehouseReceiptDetail`
 * records behind costco.com → Orders & Purchases → Warehouse, saved as JSON
 * (a bare array, or the GraphQL envelope around it).
 *
 * What we take, per receipt: barcode (idempotency), local purchase date,
 * receipt/transaction type (gas vs. warehouse, sale vs. refund), subtotal / tax
 * / total, and — for card tenders only — the LAST FOUR digits. Per line: item
 * number, printed descriptions, Costco's canonical product name, department,
 * unit price, quantity, amount.
 *
 * What we never copy: membership number, tender account numbers beyond the
 * last four, approval codes, operator / register / transaction numbers,
 * warehouse street address, coupon UPCs, product image URLs.
 *
 * Signs are taken FROM THE SOURCE and validated, never rewritten: Costco prints
 * refund receipts with negative amounts. A "Refund" receipt whose total is not
 * negative (or a sale whose total is) is flagged for review rather than
 * "corrected" — a uniform sign flip would reconcile perfectly and be invisible.
 *
 * Line semantics (how Costco prints them):
 *   - An instant-savings line has a description starting with "/" (e.g.
 *     "/BOUNTY" or "/ 1671445") and a negative amount, printed IMMEDIATELY
 *     after the item it discounts. It is folded into that item: on a sale as
 *     `discountCents` (line price stays gross); on a refund into the (negative)
 *     line price, since the refund reverses the net amount. A savings line with
 *     no immediately-preceding emitted item is an import error and flags the
 *     receipt — it is never attached to the wrong product or emitted as a
 *     phantom item.
 *   - A CRV / bottle-deposit / bag-fee line (department 0, "CA REDEMP VAL …")
 *     keeps a fixed canonical name. Costco's own name on department-0 lines is
 *     unreliable, so an unrecognized fee line is left unnamed and flagged.
 *   - A fuel line carries `fuelUnitQuantity` (gallons) and a per-gallon unit
 *     price.
 *   - `itemActualName` is Costco's catalog name. When it is just the receipt
 *     text shouted back in ALL CAPS (no catalog entry), it is not a canonical
 *     name: the line is left unnamed and flagged for review.
 */

export const COSTCO_DIGITAL_SOURCE = 'costco_digital';

/** Record types Costco's receipt export carries; both share one shape. */
export const SUPPORTED_DOCUMENT_TYPES: ReadonlySet<string> = new Set(['WarehouseReceiptDetail', 'FuelReceipts']);

/** ±2¢ tolerance for `Σ line − Σ discount + tax ≈ total`. */
const ARITHMETIC_TOLERANCE_CENTS = 2;

/** Field separator for hashing; a NUL byte cannot occur inside any field. */
const SEP = String.fromCharCode(0);

type Unknown = Record<string, unknown>;

export interface ParsedCostcoReceipts {
  receipts: NormalizedReceipt[];
  errors: ImportError[];
}

export function parseCostcoReceipts(text: string): ParsedCostcoReceipts {
  const errors: ImportError[] = [];
  let json: unknown;
  try {
    json = JSON.parse(text.replace(/^﻿/, ''));
  } catch (err) {
    return {
      receipts: [],
      errors: [{ rowRef: 'file', reason: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` }],
    };
  }

  const entries = locateReceiptArray(json);
  if (!entries) {
    return {
      receipts: [],
      errors: [{ rowRef: 'file', reason: 'expected an array of WarehouseReceiptDetail records' }],
    };
  }

  const receipts: NormalizedReceipt[] = [];
  entries.forEach((entry, index) => {
    const result = parseReceipt(entry, index, errors);
    if (result) receipts.push(result);
  });
  return { receipts, errors };
}

function locateReceiptArray(json: unknown): unknown[] | null {
  if (Array.isArray(json)) return json;
  if (!isObject(json)) return null;
  if (Array.isArray(json.receipts)) return json.receipts;
  const data = json.data;
  if (isObject(data)) {
    const rwc = data.receiptsWithCounts;
    if (isObject(rwc) && Array.isArray(rwc.receipts)) return rwc.receipts;
  }
  return null;
}

/** Returns the receipt, or null when the record was rejected (an error was pushed). */
function parseReceipt(entry: unknown, index: number, errors: ImportError[]): NormalizedReceipt | null {
  const rowRef = `receipt[${index}]`;
  if (!isObject(entry)) {
    errors.push({ rowRef, reason: 'not an object' });
    return null;
  }

  // Warehouse receipts are `WarehouseReceiptDetail`; gas-station receipts in
  // the same export are `FuelReceipts` (same shape, one fuel line).
  const documentType = str(entry.documentType);
  if (documentType && !SUPPORTED_DOCUMENT_TYPES.has(documentType)) {
    errors.push({ rowRef, reason: `unsupported documentType '${documentType}'` });
    return null;
  }

  const barcode = str(entry.transactionBarcode);
  if (!barcode) {
    errors.push({ rowRef, reason: 'missing transactionBarcode' });
    return null;
  }

  // Prefer the retailer's local calendar date; the ISO timestamp is UTC and
  // can land on the next day for an evening purchase.
  const purchasedAt =
    isoDate(entry.transactionDate) ?? isoDate(entry.transactionDateTime) ?? isoDate(entry.transactionDateISO);
  if (!purchasedAt) {
    errors.push({ rowRef: barcode, reason: 'missing or invalid transactionDate' });
    return null;
  }

  const totalCents = cents(entry.total);
  if (totalCents === null) {
    errors.push({ rowRef: barcode, reason: 'missing total' });
    return null;
  }

  const isRefund = /refund/i.test(str(entry.transactionType) ?? '');
  const isGas = /gas/i.test(str(entry.receiptType) ?? '');

  const tender = firstObject(entry.tenderArray);
  const paymentLast4 = isCardTender(tender) ? last4(tender?.displayAccountNumber) : null;
  const refundDestination = isRefund ? refundDestinationFor(tender) : undefined;

  let flagged = false;
  const rawItems = Array.isArray(entry.itemArray) ? entry.itemArray : [];
  const items: NormalizedReceiptItem[] = [];
  let lineNo = 0;
  // Whether the immediately-preceding RAW row produced an item (savings lines
  // may only fold onto that row).
  let prevRowEmitted = false;

  for (const raw of rawItems) {
    if (!isObject(raw)) {
      prevRowEmitted = false;
      continue;
    }
    const amount = cents(raw.amount);
    if (amount === null) {
      errors.push({ rowRef: barcode, reason: `line without a numeric amount (item ${str(raw.itemNumber) ?? '?'})` });
      flagged = true;
      prevRowEmitted = false;
      continue;
    }

    const desc01 = (str(raw.itemDescription01) ?? '').trim();
    const desc02 = (str(raw.itemDescription02) ?? '').trim();

    // Instant savings: fold into the item printed immediately before it.
    if (desc01.startsWith('/')) {
      if (!prevRowEmitted || items.length === 0) {
        errors.push({ rowRef: barcode, reason: `instant-savings line "${desc01}" has no preceding item` });
        flagged = true;
        prevRowEmitted = false;
        continue;
      }
      const target = items[items.length - 1]!;
      if (target.linePriceCents < 0) {
        // A refunded line is printed negative and its savings row positive:
        // the reversal shrinks the (negative) refunded amount. Decided by the
        // line's own sign, not the receipt type, so nothing is ever rewritten.
        target.linePriceCents += Math.abs(amount);
      } else {
        target.discountCents += Math.abs(amount);
      }
      target.sourceRowHash = sha256Hex(`${target.sourceRowHash}${SEP}savings${SEP}${amount}`);
      // A second consecutive savings row still belongs to the same item.
      continue;
    }

    lineNo += 1;
    const sku = str(raw.itemNumber);
    const department = num(raw.itemDepartmentNumber);
    const isFee = department === 0 || FEE_PATTERN.test(desc01);
    const isFuel = raw.fuelUomCode != null || raw.fuelGradeCode != null;

    const canonicalName = isFee
      ? feeName(desc01)
      : isFuel
        ? (catalogName(raw.itemActualName) ?? fuelName(raw.fuelGradeDescription, desc01))
        : catalogName(raw.itemActualName);

    const rawQuantity = isFuel ? num(raw.fuelUnitQuantity) : num(raw.unit);
    const quantity = rawQuantity === null ? 1 : Math.abs(rawQuantity) || 1;
    const unitPriceCents = cents(raw.itemUnitPriceAmount);

    const item: NormalizedReceiptItem = {
      lineNo,
      sku,
      rawDescription: [desc01, desc02].filter(Boolean).join(' ') || 'ITEM',
      canonicalName,
      quantity,
      unitPriceCents,
      linePriceCents: amount,
      discountCents: 0,
      needsReview: canonicalName === null,
      sourceRowHash: sha256Hex(`${barcode}${SEP}${lineNo}${SEP}${sku ?? ''}${SEP}${amount}`),
    };
    if (refundDestination) item.refundDestination = refundDestination;
    items.push(item);
    prevRowEmitted = true;
  }

  const taxCents = cents(entry.taxes);
  const subtotalCents = cents(entry.subTotal);

  // Validate — never coerce — the arithmetic and the sign.
  const expected = items.reduce((sum, i) => sum + i.linePriceCents - i.discountCents, 0) + (taxCents ?? 0);
  const arithmeticOk = items.length > 0 && Math.abs(expected - totalCents) <= ARITHMETIC_TOLERANCE_CENTS;
  const signOk = totalCents === 0 || isRefund === totalCents < 0;
  if (!arithmeticOk || !signOk) flagged = true;

  return {
    source: COSTCO_DIGITAL_SOURCE,
    // As a bank line prints it after merchant cleanup (store numbers are
    // stripped there), so the receipt↔bank matcher sees an exact merchant.
    store: isGas ? 'COSTCO GAS' : 'COSTCO WHSE',
    purchasedAt,
    subtotalCents,
    taxCents,
    totalCents,
    paymentLast4,
    sourceHash: sha256Hex(`costco:${barcode}`),
    needsReview: flagged,
    items,
  };
}

// --- line helpers -------------------------------------------------------------

const FEE_PATTERN = /REDEMP\s*VAL|\bCRV\b|BOTTLE\s*DEP(?:OSIT)?\b|\bBAG\s*FEE\b/i;

export const CRV_FEE_NAME = 'California Redemption Value (CRV)';
export const BOTTLE_DEPOSIT_NAME = 'Bottle deposit';
export const BAG_FEE_NAME = 'Bag fee';
/** The canonical names this parser assigns to fee lines (not products). */
export const FEE_NAMES: ReadonlySet<string> = new Set([CRV_FEE_NAME, BOTTLE_DEPOSIT_NAME, BAG_FEE_NAME]);

/** Fixed names for recognized fee lines; anything else on a fee line is unnamed (never the catalog name). */
function feeName(desc01: string): string | null {
  if (/REDEMP\s*VAL|\bCRV\b/i.test(desc01)) return CRV_FEE_NAME;
  if (/BOTTLE\s*DEP(?:OSIT)?\b/i.test(desc01)) return BOTTLE_DEPOSIT_NAME;
  if (/\bBAG\s*FEE\b/i.test(desc01)) return BAG_FEE_NAME;
  return null;
}

/**
 * Fuel lines have no catalog entry ("REGULAR GAS" echoed back); the grade is
 * printed separately ("Regular", "Premium", "Diesel"), which names the line
 * deterministically — a gas receipt should never need a human to say what it
 * was.
 */
function fuelName(grade: unknown, desc01: string): string | null {
  const g = (str(grade) ?? '').trim() || desc01.replace(/\b(GAS|UNLEADED|FUEL)\b/gi, '').trim();
  if (!g) return null;
  const title = g.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  return /diesel/i.test(title) ? `${title} Fuel` : `${title} Gasoline`;
}

/**
 * Costco's `itemActualName` is a real catalog name when it has mixed case
 * ("Kirkland Signature Paper Towels, 2-Ply, 160 Sheets, 12-count"). When the
 * catalog has no entry the field echoes the receipt text in ALL CAPS, which is
 * not a canonical name.
 */
function catalogName(actual: unknown): string | null {
  const s = str(actual)?.trim();
  if (!s || s.startsWith('/')) return null;
  if (!/[a-z]/.test(s)) return null;
  return s;
}

const GIFT_TENDER = /shop\s*card|gift|cash\s*card/;
const CARD_TENDER = /visa|master|amex|american|discover|debit|credit|card|chip/;

function isCardTender(tender: Unknown | null): boolean {
  const desc = (str(tender?.tenderDescription) ?? '').toLowerCase();
  return CARD_TENDER.test(desc) && !GIFT_TENDER.test(desc);
}

function refundDestinationFor(tender: Unknown | null): RefundDestination | undefined {
  const desc = (str(tender?.tenderDescription) ?? '').toLowerCase();
  if (GIFT_TENDER.test(desc)) return 'gift_card';
  if (CARD_TENDER.test(desc)) return 'card';
  return undefined;
}

/** Last four digits of a (masked) tender string; never anything more. */
function last4(value: unknown): string | null {
  const s = str(value);
  if (!s) return null;
  const m = s.match(/(\d{4})\s*$/);
  return m ? m[1]! : null;
}

// --- value helpers ------------------------------------------------------------

function isObject(v: unknown): v is Unknown {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function firstObject(v: unknown): Unknown | null {
  if (!Array.isArray(v)) return null;
  const first = v[0];
  return isObject(first) ? first : null;
}

function str(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/** Dollars → integer cents; null when absent or not numeric. */
function cents(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.round(n * 100);
}

function isoDate(v: unknown): string | null {
  const s = str(v);
  const m = s?.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1]! : null;
}
