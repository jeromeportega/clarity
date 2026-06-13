import { NotImplementedError, type RawInput, type SourceAdapter } from './source-adapter';

/**
 * Stub slot for a future retailer-API source (FR-9). The contract seam exists so
 * entry points can compose it into the adapter list today; the implementation
 * lands in a later horizon. `supports` always declines, so it never runs.
 */
export const retailerApiAdapter: SourceAdapter = {
  kind: 'retailer-api',
  supports: (): boolean => false,
  normalize: (_input: RawInput): never => {
    throw new NotImplementedError('retailer-api adapter is not implemented in H1');
  },
};
