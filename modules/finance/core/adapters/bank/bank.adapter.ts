import { parse as parseCsv } from 'csv-parse/sync';
import * as XLSX from 'xlsx';

import { sha256Hex } from '../../idempotency/keys';
import type { NormalizedTransaction } from '../../model/normalized';
import { parseAmountToCents, toIsoDate } from '../../normalize';
import type { ImportError, NormalizedBatch, RawInput, SourceAdapter } from '../source-adapter';
import { excelSerialToIsoDate } from './excel-serial-date';
import { detectHeader, type BankColumnMap, type Cell } from './header-detect';
import { cleanBankMerchant } from './merchant';

/**
 * Bank statement adapter (FR-9, story-001-004). Excel (`.xlsx`/`.xls` via SheetJS)
 * is the brief's primary format; CSV is the demo path. Both are reduced to a
 * common cell matrix, then share one pipeline: header detection → per-row
 * normalization (dates incl. the 1900 leap-year guard, signed cents, merchant
 * cleanup) → a {@link NormalizedBatch}. SheetJS reads cell VALUES (`.v`), never
 * formulas.
 *
 * The adapter NEVER touches the DB — `persist.ts` owns idempotency and the
 * `transactionDedupKey`. Malformed rows become structured {@link ImportError}
 * entries and are never silently dropped (FR-20).
 */

const FIELD_SEP = String.fromCharCode(0);

function readMatrix(input: RawInput): Cell[][] {
  if (/\.csv$/i.test(input.filename)) {
    const text = Buffer.from(input.bytes).toString('utf8');
    return parseCsv(text, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    }) as Cell[][];
  }

  // Excel: read VALUES (raw cell `.v`), not formulas, and keep numeric serials
  // numeric so the serial-date guard can run.
  const workbook = XLSX.read(Buffer.from(input.bytes), { type: 'buffer' });
  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    blankrows: false,
    defval: null,
  }) as Cell[][];
}

function isBlankRow(row: Cell[]): boolean {
  return row.every((c) => c === null || c === undefined || String(c).trim() === '');
}

/** Stable per-row fingerprint over every raw cell, so two otherwise-identical
 *  rows still differ when any field does — e.g. the bank's reference number
 *  (ADR-003). Deterministic for the same file, making re-import idempotent. */
function sourceRowHash(row: Cell[]): string {
  const canonical = row.map((c) => (c === null || c === undefined ? '' : String(c))).join(FIELD_SEP);
  return sha256Hex(canonical);
}

function normalizeDate(cell: Cell): string {
  if (typeof cell === 'number') return excelSerialToIsoDate(cell);
  const s = String(cell ?? '').trim();
  if (s.length === 0) throw new Error('missing date');
  return toIsoDate(s);
}

function normalizeRow(row: Cell[], columns: BankColumnMap): NormalizedTransaction {
  const postedDate = normalizeDate(row[columns.date]);

  const amountCell = row[columns.amount];
  const amountRaw = typeof amountCell === 'number' ? amountCell : String(amountCell ?? '').trim();
  if (amountRaw === '') throw new Error('missing amount');
  const amountCents = parseAmountToCents(amountRaw);

  const rawMerchant = String(row[columns.payee] ?? '').trim();
  if (rawMerchant.length === 0) throw new Error('missing payee');

  return {
    postedDate,
    amountCents,
    direction: amountCents < 0 ? 'debit' : 'credit',
    rawMerchant,
    normalizedMerchant: cleanBankMerchant(rawMerchant),
    sourceRowHash: sourceRowHash(row),
  };
}

export const bankAdapter: SourceAdapter = {
  kind: 'bank',

  supports(input: RawInput): boolean {
    return input.kind === 'bank' && /\.(xlsx|xls|csv)$/i.test(input.filename);
  },

  normalize(input: RawInput): NormalizedBatch {
    const transactions: NormalizedTransaction[] = [];
    const errors: ImportError[] = [];

    const matrix = readMatrix(input);
    const detected = detectHeader(matrix);
    if (!detected) {
      errors.push({
        rowRef: input.filename,
        reason: 'no recognizable header row (need date, amount, and payee columns)',
      });
      return { transactions, orders: [], receipts: [], errors };
    }

    for (let i = detected.headerRowIndex + 1; i < matrix.length; i++) {
      const row = matrix[i];
      if (!row || isBlankRow(row)) continue;
      try {
        transactions.push(normalizeRow(row, detected.columns));
      } catch (err) {
        errors.push({
          rowRef: `${input.filename} row ${i + 1}`,
          reason: err instanceof Error ? err.message : String(err),
          raw: row,
        });
      }
    }

    return { transactions, orders: [], receipts: [], errors };
  },
};
