import type { Cents, ClassifiedItem } from '../reconcile/model';

export interface RollupCell {
  category: string;
  month: string; // YYYY-MM
  netSpendCents: Cents;
  eventIds: string[];
}

export type Rollup = RollupCell[];

export type Correction =
  | { kind: 'relink_match'; matchId: string; newTransactionId: string }
  | { kind: 'reject_match'; matchId: string }
  | { kind: 'reclassify_item'; itemRef: ClassifiedItem['itemRef']; newCategory: string };
