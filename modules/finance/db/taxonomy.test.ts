import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient, type Client } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TAXONOMY, TAXONOMY_IDS, categoryIdFor, categoryNameFor } from './taxonomy';

describe('taxonomy — one list, stable slug ids', () => {
  it('has unique ids and names, and every id is a slug', () => {
    expect(new Set(TAXONOMY.map((c) => c.id)).size).toBe(TAXONOMY.length);
    expect(new Set(TAXONOMY.map((c) => c.name)).size).toBe(TAXONOMY.length);
    for (const c of TAXONOMY) expect(c.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(TAXONOMY_IDS).toContain('other');
    expect(TAXONOMY_IDS).toContain('household');
  });

  it('categoryIdFor resolves ids, display names, loose spellings and legacy names', () => {
    expect(categoryIdFor('groceries')).toBe('groceries');
    expect(categoryIdFor('Groceries')).toBe('groceries');
    expect(categoryIdFor('Health & Medical')).toBe('health-medical');
    expect(categoryIdFor('health and medical')).toBe('health-medical');
    expect(categoryIdFor('Personal Care')).toBe('personal-care');
    expect(categoryIdFor('transport')).toBe('transportation');
    expect(categoryIdFor('mortgage_rent')).toBe('housing');
    expect(categoryIdFor('  Other ')).toBe('other');
  });

  it('categoryIdFor is null for non-categories', () => {
    expect(categoryIdFor('')).toBeNull();
    expect(categoryIdFor(null)).toBeNull();
    expect(categoryIdFor('snacks')).toBeNull();
    expect(categoryIdFor('11111111-2222-3333-4444-555555555555')).toBeNull();
  });

  it('categoryNameFor maps an id back to its display name', () => {
    expect(categoryNameFor('books-media')).toBe('Books & Media');
    expect(categoryNameFor('nope')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Migration 0005 — the data migration that unified the two legacy taxonomies.
// Applies 0000–0004 to a fresh DB, plants both legacy shapes plus rows that
// reference them, applies 0005, and asserts everything is re-pointed.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const SLUG_IDS = TAXONOMY.map((c) => c.id);

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => join(MIGRATIONS_DIR, f));
}

async function apply(client: Client, file: string): Promise<void> {
  await client.executeMultiple(readFileSync(file, 'utf8'));
}

describe('migration 0005_taxonomy_unification', () => {
  let dir: string;
  let client: Client;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'clarity-taxonomy-mig-'));
    client = createClient({ url: `file:${join(dir, 'm.db')}` });
    const files = migrationFiles();
    const before = files.filter((f) => !f.includes('0005_'));
    expect(files.some((f) => f.includes('0005_taxonomy_unification'))).toBe(true);
    for (const f of before) await apply(client, f);
  });

  afterEach(() => {
    client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('seeds the slug rows, re-points legacy references, and removes legacy rows', async () => {
    // Legacy shape 1: the old seed (lowercase names, random ids).
    // Legacy shape 2: the old sink (Title-Case names, random ids).
    await client.executeMultiple(`
      INSERT INTO categories (id, name) VALUES ('uuid-transport', 'transport');
      INSERT INTO categories (id, name) VALUES ('uuid-groceries', 'Groceries');
      INSERT INTO categories (id, name) VALUES ('uuid-mortgage', 'mortgage_rent');
      INSERT INTO categories (id, name) VALUES ('uuid-health', 'Health & Medical');
      INSERT INTO households (id, name) VALUES ('hh', 'H');
      INSERT INTO receipts (id, household_id, source, store, purchased_at, total_cents) VALUES ('r1', 'hh', 'photo', 'COSTCO WHSE', '2026-01-01', 100);
      INSERT INTO receipt_items (id, receipt_id, line_no, raw_description, quantity, line_price_cents, category_id) VALUES ('i1', 'r1', 1, 'A', 1, 50, 'uuid-transport');
      INSERT INTO receipt_items (id, receipt_id, line_no, raw_description, quantity, line_price_cents, category_id) VALUES ('i2', 'r1', 2, 'B', 1, 25, 'uuid-groceries');
      INSERT INTO receipt_items (id, receipt_id, line_no, raw_description, quantity, line_price_cents, category_id) VALUES ('i3', 'r1', 3, 'C', 1, 25, 'uuid-health');
      INSERT INTO receipt_items (id, receipt_id, line_no, raw_description, quantity, line_price_cents, category_id) VALUES ('i4', 'r1', 4, 'D', 1, 0, NULL);
      INSERT INTO sku_dictionary (household_id, store, sku_or_abbrev, canonical_name, category, name_confidence, category_confidence, source, updated_at)
        VALUES ('hh', 'COSTCO', 'X', 'Thing', 'transport', 1, 1, 'auto', 0);
      INSERT INTO sku_dictionary (household_id, store, sku_or_abbrev, canonical_name, category, name_confidence, category_confidence, source, updated_at)
        VALUES ('hh', 'COSTCO', 'Y', 'Thing 2', 'Health & Medical', 1, 1, 'human', 0);
      INSERT INTO sku_dictionary (household_id, store, sku_or_abbrev, canonical_name, category, name_confidence, category_confidence, source, updated_at)
        VALUES ('hh', 'COSTCO', 'Z', 'Thing 3', 'groceries', 1, 1, 'auto', 0);
      -- Auto write-backs stored whatever listCategories() returned: the legacy random ids.
      INSERT INTO sku_dictionary (household_id, store, sku_or_abbrev, canonical_name, category, name_confidence, category_confidence, source, updated_at)
        VALUES ('hh', 'COSTCO', 'W', 'Thing 4', 'uuid-transport', 1, 1, 'auto', 0);
      INSERT INTO sku_dictionary (household_id, store, sku_or_abbrev, canonical_name, category, name_confidence, category_confidence, source, updated_at)
        VALUES ('hh', 'COSTCO', 'V', 'Thing 5', 'uuid-health', 1, 1, 'auto', 0);
    `);

    await apply(client, migrationFiles().find((f) => f.includes('0005_'))!);

    const cats = await client.execute('SELECT id, name FROM categories ORDER BY rowid');
    expect(cats.rows.map((r) => r.id)).toEqual(SLUG_IDS);
    expect(cats.rows.find((r) => r.id === 'health-medical')?.name).toBe('Health & Medical');

    const items = await client.execute('SELECT id, category_id FROM receipt_items ORDER BY line_no');
    expect(items.rows.map((r) => [r.id, r.category_id])).toEqual([
      ['i1', 'transportation'],
      ['i2', 'groceries'],
      ['i3', 'health-medical'],
      ['i4', null],
    ]);

    const dict = await client.execute('SELECT sku_or_abbrev, category FROM sku_dictionary ORDER BY sku_or_abbrev');
    expect(dict.rows.map((r) => [r.sku_or_abbrev, r.category])).toEqual([
      ['V', 'health-medical'], // legacy id → resolved through the category row
      ['W', 'transportation'],
      ['X', 'transportation'], // legacy name
      ['Y', 'health-medical'],
      ['Z', 'groceries'],
    ]);
  });

  it('is a no-op on a database that already has exactly the slug rows', async () => {
    const m5 = migrationFiles().find((f) => f.includes('0005_'))!;
    await apply(client, m5);
    await apply(client, m5);
    const cats = await client.execute('SELECT id FROM categories ORDER BY rowid');
    expect(cats.rows.map((r) => r.id)).toEqual(SLUG_IDS);
  });
});
