/**
 * Gate-safety scanner. Serialises arbitrary data to JSON and reports all
 * PAN-shaped and API-key-shaped strings found.
 *
 * Exported as a standalone module so CI scripts and other test suites can
 * import it without pulling in Vitest test-registration side effects.
 */

export interface GateViolation {
  kind: 'pan' | 'api_key';
  match: string;
}

/** 13–19 consecutive digits is PAN-length. */
const PAN_PATTERN = /\d{13,19}/g;

/** Known API-key prefix patterns (global flag required for matchAll). */
const API_KEY_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}/g,  // OpenAI / Anthropic-style secret keys
  /\bAKIA[A-Z0-9]{16}\b/g,     // AWS IAM access key ID
];

/**
 * Serialises `data` to JSON and scans exhaustively for violations.
 * Returns every match found, not just the first per category.
 */
export function scanForViolations(data: unknown): GateViolation[] {
  const json = JSON.stringify(data);
  const violations: GateViolation[] = [];

  for (const m of json.matchAll(PAN_PATTERN)) {
    violations.push({ kind: 'pan', match: m[0] });
  }

  for (const pattern of API_KEY_PATTERNS) {
    for (const m of json.matchAll(new RegExp(pattern.source, 'g'))) {
      violations.push({ kind: 'api_key', match: m[0] });
    }
  }

  return violations;
}
