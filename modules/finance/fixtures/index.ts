import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseCsv } from 'csv-parse/sync';
import * as XLSX from 'xlsx';

/**
 * Sanitized, real-structure sample fixtures (FR-22). Every file here is SYNTHETIC:
 * real column layout, fake account numbers (masked to a last-four), no real PII.
 * They exist so the CLI, the seed, and the integration test exercise the actual
 * source formats without ever touching real financial data (operator privacy rule).
 *
 * Living under `modules/finance/fixtures` (not `core`), this module may use Node +
 * SheetJS; it never imports from `core`, so it cannot leak format knowledge inward.
 */

const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url));

/** Sanitized bank statement: real export header with bank preamble rows, fake
 *  account number, and a refund credit line (REF1005, FR-22 return case). */
export const BANK_STATEMENT_CSV = join(FIXTURES_DIR, 'bank', 'sample-bank-statement.csv');

/** Sanitized Amazon "Request My Data" → Order History CSV: verbatim 28-column
 *  header, a split order, and a gift-card return (the store-credit ledger case). */
export const AMAZON_ORDER_HISTORY_CSV = join(FIXTURES_DIR, 'amazon', 'Retail.OrderHistory.1.csv');

/** The committed text fixtures, for the PII-scan test to assert sanitization. */
export const TEXT_FIXTURE_FILES = [BANK_STATEMENT_CSV, AMAZON_ORDER_HISTORY_CSV] as const;

export function readFixtureText(path: string): string {
  return readFileSync(path, 'utf8');
}

export function readFixtureBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

/**
 * Build a real `.xlsx` workbook from the sanitized bank CSV so the Excel ingest
 * path (the brief's primary bank format) is exercised end to end without
 * committing an opaque binary blob. The CSV is the single source of truth; the
 * workbook is derived from it at call time.
 */
export function buildBankStatementXlsx(): Uint8Array {
  const text = readFixtureText(BANK_STATEMENT_CSV);
  const rows = parseCsv(text, {
    bom: true,
    relax_column_count: true,
    skip_empty_lines: false,
  }) as string[][];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Statement');
  const buf = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return new Uint8Array(buf);
}
