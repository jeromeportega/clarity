import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const MIGRATION_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../db/migrations/0002_h3_matches.sql',
);

describe('migration 0002_h3_matches shape (AC3, FR-3, FR-7)', () => {
  let sql: string;

  it('migration file exists and is readable', () => {
    sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql.length).toBeGreaterThan(0);
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

  it('alters the matches table (not a new table)', () => {
    const content = readFileSync(MIGRATION_PATH, 'utf8');
    expect(content).toMatch(/ALTER TABLE matches/);
  });

  it('contains no DROP or destructive statements', () => {
    const content = readFileSync(MIGRATION_PATH, 'utf8');
    // Case-sensitive: SQL DDL keywords are uppercase; comments may say "never drop"
    expect(content).not.toMatch(/\bDROP\b/);
    expect(content).not.toMatch(/\bDELETE\b/);
  });
});
