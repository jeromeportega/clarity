import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/0001_h3_matches.sql',
);

describe('migration 0001_h3_matches shape (AC3, FR-3, FR-7)', () => {
  it('migration file exists and is readable', () => {
    const content = readFileSync(MIGRATION_PATH, 'utf8');
    expect(content.length).toBeGreaterThan(0);
  });

  it('adds rationale TEXT column (FR-3)', () => {
    const content = readFileSync(MIGRATION_PATH, 'utf8');
    expect(content).toContain('ADD COLUMN rationale TEXT');
  });

  it('adds store_credit_balance_id column (FR-7)', () => {
    const content = readFileSync(MIGRATION_PATH, 'utf8');
    expect(content).toContain('ADD COLUMN store_credit_balance_id TEXT');
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
    expect(content).toMatch(/ALTER TABLE matches/);
  });

  it('contains no DROP or DML DELETE statements (ON DELETE FK clause is fine)', () => {
    const content = readFileSync(MIGRATION_PATH, 'utf8');
    expect(content).not.toMatch(/\bDROP\b/);
    expect(content).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});
