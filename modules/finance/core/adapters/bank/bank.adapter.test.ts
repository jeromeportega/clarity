import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import * as XLSX from 'xlsx';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Isolate this file's throwaway DBs from the shared tmpdir (mirrors pipeline.test.ts).
process.env.TMPDIR = mkdtempSync(join(tmpdir(), 'clarity-bank-test-'));

import { createTestDb, type FinanceDb } from '../../../db/client';
import { accounts, households, transactions } from '../../../db/schema';
import type { RawInput } from '../source-adapter';
import { importSource } from '../../ingest/pipeline';
import { bankAdapter } from './bank.adapter';

const REAL_HEADER = 'Posted Date,Reference Number,Payee,Address,Amount';

function csvInput(filename: string, body: string): RawInput {
  return { kind: 'bank', filename, bytes: new TextEncoder().encode(body) };
}

/** Build an .xlsx RawInput from a matrix of cell values (numbers stay numeric). */
function xlsxInput(filename: string, matrix: unknown[][]): RawInput {
  const ws = XLSX.utils.aoa_to_sheet(matrix);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  return { kind: 'bank', filename, bytes: new Uint8Array(buf) };
}

describe('bankAdapter — contract', () => {
  it('declares kind "bank"', () => {
    expect(bankAdapter.kind).toBe('bank');
  });

  it('supports .xlsx, .xls, and .csv bank inputs (case-insensitive)', () => {
    for (const filename of ['stmt.xlsx', 'stmt.xls', 'stmt.csv', 'STMT.CSV', 'Statement.XLSX']) {
      expect(bankAdapter.supports({ kind: 'bank', filename, bytes: new Uint8Array() })).toBe(true);
    }
  });

  it('does not support non-bank kinds or unknown extensions', () => {
    expect(bankAdapter.supports({ kind: 'bank', filename: 'stmt.pdf', bytes: new Uint8Array() })).toBe(
      false,
    );
    expect(bankAdapter.supports({ kind: 'amazon', filename: 'orders.csv', bytes: new Uint8Array() })).toBe(
      false,
    );
  });
});

describe('bankAdapter.normalize — CSV (the demo path)', () => {
  it('normalizes dates, signed cents, direction, and merchant for the real export header', async () => {
    const body = [
      REAL_HEADER,
      '01/15/2026,REF001,COSTCO WHSE #0420,"123 MAIN ST, SEATTLE WA",-54.99',
      '01/16/2026,REF002,AMZN Mktp US*RT4K9,AMAZON.COM,12.34',
      '01/17/2026,REF003,SOME STORE,ADDR,"($1,234.56)"',
    ].join('\n');

    const batch = await bankAdapter.normalize(csvInput('stmt.csv', body));
    expect(batch.errors).toHaveLength(0);
    expect(batch.transactions).toHaveLength(3);

    const [debit, credit, parenNeg] = batch.transactions;
    expect(debit).toMatchObject({
      postedDate: '2026-01-15',
      amountCents: -5499,
      direction: 'debit',
      rawMerchant: 'COSTCO WHSE #0420',
      normalizedMerchant: 'COSTCO WHSE',
    });
    expect(credit).toMatchObject({
      postedDate: '2026-01-16',
      amountCents: 1234,
      direction: 'credit',
      normalizedMerchant: 'AMZN MKTP US',
    });
    expect(parenNeg).toMatchObject({ amountCents: -123456, direction: 'debit' });

    // Every transaction carries a non-empty source-row hash.
    for (const t of batch.transactions) {
      expect(t.sourceRowHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('detects the header when bank preamble rows precede it', async () => {
    const body = [
      'Account ending 7061',
      'Statement period 01/01/2026 - 01/31/2026',
      '',
      REAL_HEADER,
      '01/20/2026,REF010,TRADER JOES #455,SEATTLE WA,-31.00',
    ].join('\n');

    const batch = await bankAdapter.normalize(csvInput('stmt.csv', body));
    expect(batch.errors).toHaveLength(0);
    expect(batch.transactions).toHaveLength(1);
    expect(batch.transactions[0]).toMatchObject({
      postedDate: '2026-01-20',
      amountCents: -3100,
      normalizedMerchant: 'TRADER JOES',
    });
  });

  it('skips a malformed row as a structured ImportError and keeps the valid rows (FR-20)', async () => {
    const body = [
      REAL_HEADER,
      '01/15/2026,REF001,GOOD ROW,ADDR,-10.00',
      'not-a-date,REF002,BAD DATE,ADDR,5.00',
      '01/17/2026,REF003,BAD AMOUNT,ADDR,abc',
      '01/18/2026,REF004,ALSO GOOD,ADDR,20.00',
    ].join('\n');

    const batch = await bankAdapter.normalize(csvInput('stmt.csv', body));
    // Two valid rows persist; two malformed rows surface — nothing silently dropped.
    expect(batch.transactions).toHaveLength(2);
    expect(batch.errors).toHaveLength(2);
    expect(batch.transactions.map((t) => t.normalizedMerchant)).toEqual(['GOOD ROW', 'ALSO GOOD']);
    for (const err of batch.errors) {
      expect(err.rowRef).toContain('stmt.csv');
      expect(typeof err.reason).toBe('string');
      expect(err.reason.length).toBeGreaterThan(0);
    }
  });

  it('reports a single ImportError when no header row can be found', async () => {
    const batch = await bankAdapter.normalize(csvInput('stmt.csv', 'just,some,junk\n1,2,3'));
    expect(batch.transactions).toHaveLength(0);
    expect(batch.errors).toHaveLength(1);
  });
});

describe('bankAdapter.normalize — Excel (.xlsx via SheetJS)', () => {
  it('normalizes an Excel serial date to ISO and reads cell VALUES not formulas', () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Posted Date', 'Payee', 'Amount'],
      [45678, 'COSTCO WHSE #0420', 0],
    ]);
    // Amount is a formula whose cached value is 12.34; the adapter must use the value.
    ws['C2'] = { t: 'n', f: '10+2.34', v: 12.34 };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const batchOrPromise = bankAdapter.normalize({
      kind: 'bank',
      filename: 'stmt.xlsx',
      bytes: new Uint8Array(buf),
    });
    return Promise.resolve(batchOrPromise).then((batch) => {
      expect(batch.errors).toHaveLength(0);
      expect(batch.transactions).toHaveLength(1);
      expect(batch.transactions[0]).toMatchObject({
        postedDate: '2025-01-21', // serial 45678
        amountCents: 1234, // from the formula's cached VALUE, not the formula text
        direction: 'credit',
        normalizedMerchant: 'COSTCO WHSE',
      });
    });
  });

  it('surfaces the 1900 leap-year phantom (serial 60) as an ImportError, not 1900-02-29', async () => {
    const batch = await bankAdapter.normalize(
      xlsxInput('stmt.xlsx', [
        ['Posted Date', 'Payee', 'Amount'],
        [59, 'OK BEFORE', -1.0],
        [60, 'PHANTOM LEAP DAY', -2.0],
        [61, 'OK AFTER', -3.0],
      ]),
    );
    expect(batch.transactions).toHaveLength(2);
    expect(batch.transactions.map((t) => t.postedDate)).toEqual(['1900-02-28', '1900-03-01']);
    expect(batch.errors).toHaveLength(1);
    expect(batch.errors[0]?.raw).toBeDefined();
  });
});

describe('bankAdapter → importSource → DB (integration, FR-19)', () => {
  let db: FinanceDb;
  let cleanup: () => void;
  let householdId: string;
  let accountId: string;

  beforeEach(async () => {
    const handle = createTestDb();
    db = handle.db;
    cleanup = handle.cleanup;
    await db.run(sql`PRAGMA foreign_keys = ON`);
    householdId = randomUUID();
    accountId = randomUUID();
    await db.insert(households).values({ id: householdId, name: 'Test Household' });
    await db.insert(accounts).values({ id: accountId, householdId, name: 'Card 7061', type: 'credit_card' });
  });

  afterEach(() => cleanup());

  const sample = () =>
    csvInput(
      'stmt.csv',
      [
        REAL_HEADER,
        '01/15/2026,REF001,COSTCO WHSE #0420,SEATTLE WA,-54.99',
        '01/16/2026,REF002,AMZN Mktp US*RT4K9,AMAZON,12.34',
      ].join('\n'),
    );

  async function txnCount(): Promise<number> {
    const r = await db.run(sql`SELECT count(*) AS c FROM transactions`);
    return Number(r.rows[0]?.c);
  }

  it('re-importing the same file produces zero duplicates (idempotent)', async () => {
    const first = await importSource(db, sample(), { householdId, accountId }, [bankAdapter]);
    expect(first.inserted.transactions).toBe(2);
    expect(first.skippedDuplicates).toBe(0);
    expect(await txnCount()).toBe(2);

    const second = await importSource(db, sample(), { householdId, accountId }, [bankAdapter]);
    expect(second.inserted.transactions).toBe(0);
    expect(second.skippedDuplicates).toBe(2);
    expect(await txnCount()).toBe(2); // no new rows on re-import
  });

  it('persists valid rows and surfaces malformed rows through the result (FR-20)', async () => {
    const input = csvInput(
      'stmt.csv',
      [
        REAL_HEADER,
        '01/15/2026,REF001,GOOD ROW,ADDR,-10.00',
        '01/17/2026,REF003,BAD AMOUNT,ADDR,abc',
      ].join('\n'),
    );
    const result = await importSource(db, input, { householdId, accountId }, [bankAdapter]);
    expect(result.inserted.transactions).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(await txnCount()).toBe(1);
  });

  it('keeps two same-day/same-amount/same-merchant rows distinct via sourceRowHash (ADR-003)', async () => {
    const input = csvInput(
      'stmt.csv',
      [
        REAL_HEADER,
        '01/15/2026,REF001,COSTCO WHSE #0420,SEATTLE WA,-54.99',
        '01/15/2026,REF002,COSTCO WHSE #0420,SEATTLE WA,-54.99',
      ].join('\n'),
    );
    const result = await importSource(db, input, { householdId, accountId }, [bankAdapter]);
    // Distinct reference numbers feed distinct source-row hashes → both persist.
    expect(result.inserted.transactions).toBe(2);
    expect(result.skippedDuplicates).toBe(0);
    expect(await txnCount()).toBe(2);
  });
});
