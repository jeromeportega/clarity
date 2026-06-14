import type { QueueItemType } from '../../../../../../../../modules/finance/core/queue/types';
import type { CorrectionVariant } from '../../../../../../../../modules/finance/core/corrections/apply';

export const VALID_ITEM_TYPES: readonly QueueItemType[] = [
  'sku_resolution',
  'ambiguous_match',
  'unmatched_txn',
  'flagged_receipt',
];

export const VALID_CORRECTION_VARIANTS: readonly CorrectionVariant['variant'][] = [
  'pickCategoryId',
  'pickMatchCandidateId',
  'editResolution',
];
