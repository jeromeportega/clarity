import { TAXONOMY, TAXONOMY_NAMES, categoryIdFor, categoryNameFor } from '../../db/taxonomy';

export { TAXONOMY, TAXONOMY_NAMES, categoryIdFor, categoryNameFor };
export type { CategoryId, CategoryName, TaxonomyCategory } from '../../db/taxonomy';

/**
 * The classifier's vocabulary: the display names of the one taxonomy
 * (`db/taxonomy.ts`). The sink maps a classified name to its id via
 * `categoryIdFor` when stamping `receipt_items.category_id`.
 */
export const H1_TAXONOMY: readonly string[] = TAXONOMY_NAMES;

export type H1Category = (typeof TAXONOMY_NAMES)[number];

export function clampToTaxonomy(category: string, taxonomy: readonly string[]): string {
  return taxonomy.includes(category) ? category : 'Other';
}
