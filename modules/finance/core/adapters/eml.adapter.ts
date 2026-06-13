import { NotImplementedError, type RawInput, type SourceAdapter } from './source-adapter';

/**
 * Stub slot for a future `.eml` (email receipt / order confirmation) source
 * (FR-9). The contract seam exists so entry points can compose it today; the
 * implementation lands in a later horizon. `supports` always declines.
 */
export const emlAdapter: SourceAdapter = {
  kind: 'eml',
  supports: (): boolean => false,
  normalize: (_input: RawInput): never => {
    throw new NotImplementedError('eml adapter is not implemented in H1');
  },
};
