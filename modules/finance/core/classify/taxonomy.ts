export const H1_TAXONOMY = [
  'Groceries',
  'Dining',
  'Entertainment',
  'Subscriptions',
  'Shopping',
  'Health & Medical',
  'Travel',
  'Transportation',
  'Utilities',
  'Housing',
  'Education',
  'Personal Care',
  'Electronics',
  'Clothing',
  'Books & Media',
  'Pet Care',
  'Home Improvement',
  'Insurance',
  'Transfers',
  'Other',
] as const satisfies readonly string[];

export type H1Category = (typeof H1_TAXONOMY)[number];

export function clampToTaxonomy(category: string, taxonomy: readonly string[]): string {
  return taxonomy.includes(category) ? category : 'Other';
}
