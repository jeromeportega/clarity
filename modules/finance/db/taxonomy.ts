/**
 * The ONE category taxonomy.
 *
 * `id` is a stable slug — it is the `categories.id` primary key, the value
 * stored in `receipt_items.category_id` and `sku_dictionary.category`, the
 * value the SKU resolver is allowed to pick, and the value a correction sends.
 * `name` is the display form the classifier emits and rollups show.
 *
 * Pure data with no imports so both `db/` and `core/` (and the web app) can
 * depend on it. Seeded into `categories` by migration 0005 and by the seed
 * scripts (insert-or-ignore on id), so every database carries exactly these
 * rows.
 */
export interface TaxonomyCategory {
  readonly id: string;
  readonly name: string;
}

export const TAXONOMY = [
  { id: 'groceries', name: 'Groceries' },
  { id: 'household', name: 'Household' },
  { id: 'dining', name: 'Dining' },
  { id: 'entertainment', name: 'Entertainment' },
  { id: 'subscriptions', name: 'Subscriptions' },
  { id: 'shopping', name: 'Shopping' },
  { id: 'health-medical', name: 'Health & Medical' },
  { id: 'travel', name: 'Travel' },
  { id: 'transportation', name: 'Transportation' },
  { id: 'utilities', name: 'Utilities' },
  { id: 'housing', name: 'Housing' },
  { id: 'education', name: 'Education' },
  { id: 'personal-care', name: 'Personal Care' },
  { id: 'electronics', name: 'Electronics' },
  { id: 'clothing', name: 'Clothing' },
  { id: 'books-media', name: 'Books & Media' },
  { id: 'pet-care', name: 'Pet Care' },
  { id: 'home-improvement', name: 'Home Improvement' },
  { id: 'insurance', name: 'Insurance' },
  { id: 'transfers', name: 'Transfers' },
  { id: 'other', name: 'Other' },
] as const satisfies readonly TaxonomyCategory[];

export type CategoryId = (typeof TAXONOMY)[number]['id'];
export type CategoryName = (typeof TAXONOMY)[number]['name'];

export const TAXONOMY_IDS: readonly CategoryId[] = TAXONOMY.map((c) => c.id);
export const TAXONOMY_NAMES: readonly CategoryName[] = TAXONOMY.map((c) => c.name);

/** Names the taxonomy used to go by; kept so old rows and old inputs still resolve. */
const LEGACY_ALIASES: Readonly<Record<string, CategoryId>> = {
  transport: 'transportation',
  mortgage_rent: 'housing',
  mortgage: 'housing',
  rent: 'housing',
  health: 'health-medical',
  medical: 'health-medical',
  'health & medical': 'health-medical',
  'books & media': 'books-media',
  'personal care': 'personal-care',
  'pet care': 'pet-care',
  'home improvement': 'home-improvement',
};

/**
 * Resolve any of: a category id, a display name, a legacy name, or a loosely
 * formatted variant ("Health and Medical") to the canonical id. Null when the
 * value is not a category at all.
 */
export function categoryIdFor(value: string | null | undefined): CategoryId | null {
  if (!value) return null;
  const raw = value.trim();
  if ((TAXONOMY_IDS as readonly string[]).includes(raw)) return raw as CategoryId;
  const byName = TAXONOMY.find((c) => c.name.toLowerCase() === raw.toLowerCase());
  if (byName) return byName.id;
  const lower = raw.toLowerCase();
  if (lower in LEGACY_ALIASES) return LEGACY_ALIASES[lower]!;
  // "Health & Medical", "health and medical", "health/medical" → health-medical
  const slug = lower
    .replace(/\s*&\s*|\s+and\s+/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if ((TAXONOMY_IDS as readonly string[]).includes(slug)) return slug as CategoryId;
  if (slug in LEGACY_ALIASES) return LEGACY_ALIASES[slug]!;
  return null;
}

export function categoryNameFor(id: string): string | null {
  return TAXONOMY.find((c) => c.id === id)?.name ?? null;
}
