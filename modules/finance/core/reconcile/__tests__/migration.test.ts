import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The H3 reconciliation migration. It was regenerated as `0002` when origin/main
// (H1 + H2's `0001_brown_karma` sku_dictionary) was merged into this branch, so
// it now diffs on top of H2's `0001` and carries ONLY H3's `matches` columns.
const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/0002_dizzy_infant_terrible.sql',
);

describe('H3 matches migration shape (AC3, FR-3, FR-7)', () => {
  it('migration file exists and is readable', () => {
    const content = readFileSync(MIGRATION_PATH, 'utf8');
    expect(content.length).toBeGreaterThan(0);
  });

  it('adds rationale text column (FR-3)', () => {
    const content = readFileSync(MIGRATION_PATH, 'utf8');
    expect(content).toMatch(/ADD\s+`?rationale`?\s+text/i);
  });

  it('adds store_credit_balance_id column (FR-7)', () => {
    const content = readFileSync(MIGRATION_PATH, 'utf8');
    expect(content).toMatch(/ADD\s+`?store_credit_balance_id`?\s+text/i);
  });

  it('store_credit_balance_id references store_credit_balances table', () => {
    const content = readFileSync(MIGRATION_PATH, 'utf8');
    expect(content).toContain('REFERENCES store_credit_balances');
  });

  it('store_credit_balance_id FK has ON DELETE SET NULL', () => {
    const content = readFileSync(MIGRATION_PATH, 'utf8');
    expect(content).toContain('ON DELETE SET NULL');
  });

  it('alters the matches table (not a new table)', () => {
    const content = readFileSync(MIGRATION_PATH, 'utf8');
    expect(content).toMatch(/ALTER TABLE `?matches`?/);
  });

  it('contains no DROP or DML DELETE statements (ON DELETE FK clause is fine)', () => {
    const content = readFileSync(MIGRATION_PATH, 'utf8');
    expect(content).not.toMatch(/\bDROP\b/);
    expect(content).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});
