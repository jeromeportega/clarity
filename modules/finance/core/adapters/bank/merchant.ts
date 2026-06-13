import { normalizeMerchant } from '../../normalize';

/**
 * Bank-specific merchant cleanup. Bank `Payee` strings trail store/branch numbers
 * (`COSTCO WHSE #0420`) and processor reference codes (`AMZN Mktp US*RT4K9`) that
 * are noise for matching. We strip those markers BEFORE handing off to the shared
 * {@link normalizeMerchant}, because the shared pass would flatten `#`/`*` to
 * spaces and leave the digits behind. Source-specific by design — the shared
 * normalizer stays generic.
 */
export function cleanBankMerchant(raw: string): string {
  const stripped = raw
    // Drop a reference tail introduced by '*' (up to the next space).
    .replace(/\*\S*/g, ' ')
    // Drop store/branch numbers like '#0420' or '# 123'.
    .replace(/#\s*\w+/g, ' ');
  return normalizeMerchant(stripped);
}
