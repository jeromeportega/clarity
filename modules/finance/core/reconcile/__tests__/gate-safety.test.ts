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
import { scanForViolations } from '../gate-scanner';

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

  it('detects multiple PANs in a single fixture (exhaustive scan)', () => {
    const poisoned = { card1: '4111111111111111', card2: '5500005555555559' };
    const violations = scanForViolations(poisoned).filter((v) => v.kind === 'pan');
    expect(violations.length).toBeGreaterThanOrEqual(2);
  });

  it('does not flag short numeric fixture IDs as PANs', () => {
    const safeData = { amount: 4999, id: 'bank-line-001', lastFour: '1234' };
    const violations = scanForViolations(safeData).filter((v) => v.kind === 'pan');
    expect(violations).toHaveLength(0);
  });
});
