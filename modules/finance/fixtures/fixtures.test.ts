import { describe, expect, it } from 'vitest';

import { amazonAdapter } from '../core/adapters/amazon/amazon.adapter';
import { bankAdapter } from '../core/adapters/bank/bank.adapter';
import type { RawInput } from '../core/adapters/source-adapter';
import {
  AMAZON_ORDER_HISTORY_CSV,
  BANK_STATEMENT_CSV,
  TEXT_FIXTURE_FILES,
  buildBankStatementXlsx,
  readFixtureBytes,
  readFixtureText,
} from './index';

/** A run of 13–19 digits would be a full PAN/account number — never allowed. */
const LONG_DIGIT_RUN = /\d{13,19}/;
/** US SSN shape — never allowed. */
const SSN = /\b\d{3}-\d{2}-\d{4}\b/;

describe('fixtures are sanitized (no real PII)', () => {
  it.each(TEXT_FIXTURE_FILES)('%s contains no full PAN or SSN pattern', (file) => {
    const text = readFixtureText(file);
    expect(text).not.toMatch(LONG_DIGIT_RUN);
    expect(text).not.toMatch(SSN);
  });

  it('the bank statement masks its account number to a last-four only', () => {
    const text = readFixtureText(BANK_STATEMENT_CSV);
    expect(text).toContain('XXXXXXXXXXXX1234');
    expect(text).not.toMatch(LONG_DIGIT_RUN);
  });
});

describe('fixtures keep the real source structure', () => {
  it('the bank statement carries the real export header (with preamble above it)', () => {
    const text = readFixtureText(BANK_STATEMENT_CSV);
    expect(text).toContain('Posted Date,Reference Number,Payee,Address,Amount');
    expect(text).toContain('Account Number,XXXXXXXXXXXX1234');
  });

  it('the Amazon CSV uses the verbatim 28-column header and includes a return case (FR-22)', () => {
    const text = readFixtureText(AMAZON_ORDER_HISTORY_CSV);
    const header = text.split('\n')[0] ?? '';
    expect(header.startsWith('ASIN,')).toBe(true);
    expect(header).toContain('"Order ID"');
    expect(header).toContain('"Payment Method Type"');
    // A genuine refund line: negative total under a Returned/Refunded status.
    expect(text).toContain('-24.00');
    expect(text).toContain('Returned');
  });
});

describe('fixtures normalize through the real adapters', () => {
  function bankInput(filename: string, bytes: Uint8Array): RawInput {
    return { kind: 'bank', filename, bytes };
  }

  it('the bank CSV yields valid transactions including a refund credit', async () => {
    const batch = await bankAdapter.normalize(
      bankInput('sample-bank-statement.csv', readFixtureBytes(BANK_STATEMENT_CSV)),
    );
    expect(batch.errors).toEqual([]);
    expect(batch.transactions).toHaveLength(7);

    const refund = batch.transactions.find((t) => t.amountCents === 5499);
    expect(refund?.direction).toBe('credit');
    expect(batch.transactions.some((t) => t.direction === 'debit')).toBe(true);
  });

  it('the bank Excel workbook (built from the CSV) parses identically', async () => {
    const csvBatch = await bankAdapter.normalize(
      bankInput('sample-bank-statement.csv', readFixtureBytes(BANK_STATEMENT_CSV)),
    );
    const xlsxBatch = await bankAdapter.normalize(
      bankInput('sample-bank-statement.xlsx', buildBankStatementXlsx()),
    );
    expect(xlsxBatch.errors).toEqual([]);
    expect(xlsxBatch.transactions.map((t) => t.postedDate)).toEqual(
      csvBatch.transactions.map((t) => t.postedDate),
    );
    expect(xlsxBatch.transactions.map((t) => t.amountCents)).toEqual(
      csvBatch.transactions.map((t) => t.amountCents),
    );
  });

  it('the Amazon CSV yields two orders, one with a gift-card return', async () => {
    const batch = await amazonAdapter.normalize({
      kind: 'amazon',
      filename: 'Retail.OrderHistory.1.csv',
      bytes: readFixtureBytes(AMAZON_ORDER_HISTORY_CSV),
    });
    expect(batch.errors).toEqual([]);
    expect(batch.orders).toHaveLength(2);

    const returnOrder = batch.orders.find((o) => o.externalOrderId === 'AMZN-DEMO-002');
    const returnItem = returnOrder?.items.find((i) => i.isReturn);
    expect(returnItem).toBeDefined();
    expect(returnItem?.amountCents).toBe(-2400);
    expect(returnItem?.refundDestination).toBe('gift_card');
  });
});
