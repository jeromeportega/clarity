/**
 * Gate-safety scan (AC4, NFR-3).
 *
 * Walks the synthetic fixture corpus and fails on:
 *   - API-key-shaped strings (OpenAI `sk-` prefix, AWS `AKIA` prefix)
 *   - PAN-shaped strings (13–19 consecutive digits)
 *
 * The scanner is proved live by feeding it a poisoned in-memory fixture for
 * each violation category and asserting that violations are found.
 */

import { describe, expect, it } from 'vitest';

import { FIXTURE_INPUTS } from '../__fixtures__/index';

// ── Scanner ─────────────────────────────────────────────────────────────────

/** 13–19 consecutive digits is PAN-length. */
const PAN_PATTERN = /\d{13,19}/;

/** Known API-key prefix patterns. */
const API_KEY_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}/,  // OpenAI / Anthropic-style secret keys (sk-... or sk-proj-...)
  /\bAKIA[A-Z0-9]{16}\b/,     // AWS IAM access key ID
];

export interface GateViolation {
  kind: 'pan' | 'api_key';
  match: string;
}

/**
 * Serialises `data` to JSON and scans for violations.
 * Returns an empty array when the data is clean.
 */
export function scanForViolations(data: unknown): GateViolation[] {
  const json = JSON.stringify(data);
  const violations: GateViolation[] = [];

  const panMatch = json.match(PAN_PATTERN);
  if (panMatch) {
    violations.push({ kind: 'pan', match: panMatch[0] });
  }

  for (const pattern of API_KEY_PATTERNS) {
    const m = json.match(pattern);
    if (m) {
      violations.push({ kind: 'api_key', match: m[0] });
    }
  }

  return violations;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('gate-safety: real fixtures are clean', () => {
  it('FIXTURE_INPUTS contains no PAN-shaped digit sequences', () => {
    const violations = scanForViolations(FIXTURE_INPUTS).filter((v) => v.kind === 'pan');
    expect(violations, `PAN violations found: ${JSON.stringify(violations)}`).toHaveLength(0);
  });

  it('FIXTURE_INPUTS contains no API-key-shaped strings', () => {
    const violations = scanForViolations(FIXTURE_INPUTS).filter((v) => v.kind === 'api_key');
    expect(violations, `API key violations found: ${JSON.stringify(violations)}`).toHaveLength(0);
  });
});

describe('gate-safety: scanner demonstrably catches violations', () => {
  it('detects a planted OpenAI-style secret key (sk- prefix)', () => {
    const poisoned = { id: 'sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890abcd' };
    const violations = scanForViolations(poisoned).filter((v) => v.kind === 'api_key');
    expect(violations.length).toBeGreaterThan(0);
  });

  it('detects a planted AWS IAM access key (AKIA prefix)', () => {
    const poisoned = { accessKey: 'AKIAIOSFODNN7EXAMPLE' };
    const violations = scanForViolations(poisoned).filter((v) => v.kind === 'api_key');
    expect(violations.length).toBeGreaterThan(0);
  });

  it('detects a planted PAN-shaped digit sequence (16-digit Visa test PAN)', () => {
    const poisoned = { cardNumber: '4111111111111111' };
    const violations = scanForViolations(poisoned).filter((v) => v.kind === 'pan');
    expect(violations.length).toBeGreaterThan(0);
  });

  it('does not flag short numeric fixture IDs as PANs', () => {
    const safeData = { amount: 4999, id: 'bank-line-001', lastFour: '1234' };
    const violations = scanForViolations(safeData).filter((v) => v.kind === 'pan');
    expect(violations).toHaveLength(0);
  });
});
