import type { Cents, ClassifiedItem } from '../reconcile/model';

export interface RollupCell {
  category: string;
  month: string; // YYYY-MM
  netSpendCents: Cents;
  eventIds: string[];
}

export type Rollup = RollupCell[];

export interface Correction {
  kind: 'relink_match' | 'reject_match' | 'reclassify_item';
  matchId?: string;
  itemRef?: ClassifiedItem['itemRef'];
  newTransactionId?: string;
  newCategory?: string;
}
