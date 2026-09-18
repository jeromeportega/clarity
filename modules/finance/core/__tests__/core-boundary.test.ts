import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Core-boundary guard (ADR-009, FR-5/FR-6). `modules/finance/core` is pure
 * TypeScript: no Next.js or React may leak in. This test is itself the automated
 * check — `story-001-007` runs it as a CI gate.
 *
 * Scope is `core` only; `db` is intentionally exempt. Test/fixture files are not
 * scanned: they legitimately contain framework-import *strings* as fixtures (see
 * the negative case below), which would otherwise self-trigger the guard.
 */

const CORE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A module specifier is forbidden if it is, or is a subpath of, a framework
 * (next / react / react-dom) or a concrete provider / credential holder the
 * core must only ever receive by injection: the AI Gateway provider, the old
 * Anthropic SDK, Clerk, Vercel Blob. Core may import `ai` itself — the
 * model-agnostic calling convention — but never the thing that authenticates.
 */
function isForbiddenModule(spec: string): boolean {
  return /^(?:next|react|react-dom|@ai-sdk\/gateway|@anthropic-ai\/sdk|@clerk\/[^/]+|@vercel\/blob|plaid)(?:\/.*)?$/.test(spec);
}

/**
 * Pure scanner: returns every forbidden module specifier imported by a source
 * string. Detects `import ... from '…'`, side-effect `import '…'`, re-exports
 * (`export ... from '…'`), `require('…')`, and dynamic `import('…')`.
 */
export function findForbiddenImports(source: string): string[] {
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
  ];
  const found = new Set<string>();
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const spec = m[1];
      if (spec && isForbiddenModule(spec)) found.add(spec);
    }
  }
  return [...found];
}

function isScannableSource(name: string): boolean {
  if (!name.endsWith('.ts')) return false;
  return !name.endsWith('.test.ts') && !name.endsWith('.spec.ts');
}

function collectCoreSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectCoreSources(full));
    } else if (entry.isFile() && isScannableSource(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('core boundary (no Next.js / React under modules/finance/core)', () => {
  it('detects framework imports in a source string (proves the guard catches leaks)', () => {
    expect(findForbiddenImports(`import { NextResponse } from 'next/server';`)).toContain(
      'next/server',
    );
    expect(findForbiddenImports(`import React from 'react';`)).toContain('react');
    expect(findForbiddenImports(`import { useState } from "react";`)).toContain('react');
    expect(findForbiddenImports(`export { redirect } from 'next/navigation';`)).toContain(
      'next/navigation',
    );
    expect(findForbiddenImports(`const x = require('react-dom');`)).toContain('react-dom');
    expect(findForbiddenImports(`const m = await import('next/headers');`)).toContain(
      'next/headers',
    );
    expect(findForbiddenImports(`import 'react-dom/client';`)).toContain('react-dom/client');
  });

  it('does not flag legitimate non-framework imports', () => {
    expect(findForbiddenImports(`import { gateway } from '@ai-sdk/gateway';`)).toContain('@ai-sdk/gateway');
    expect(findForbiddenImports(`import Anthropic from '@anthropic-ai/sdk';`)).toContain('@anthropic-ai/sdk');
    expect(findForbiddenImports(`import { auth } from '@clerk/nextjs/server';`)).toContain('@clerk/nextjs/server');
    expect(findForbiddenImports(`import { PlaidApi } from 'plaid';`)).toContain('plaid');
    expect(findForbiddenImports(`import { generateText } from 'ai';`)).toEqual([]);
    expect(findForbiddenImports(`import { sql } from 'drizzle-orm';`)).toEqual([]);
    expect(findForbiddenImports(`import { createHash } from 'node:crypto';`)).toEqual([]);
    expect(findForbiddenImports(`import { foo } from '../model/normalized';`)).toEqual([]);
    // A merchant string that merely contains the word "react" is not an import.
    expect(findForbiddenImports(`const note = 'the reaction was from the next room';`)).toEqual([]);
  });

  it('passes on the current core tree (zero next/react imports)', () => {
    const files = collectCoreSources(CORE_DIR);
    expect(files.length, 'expected to scan at least one core source file').toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const forbidden = findForbiddenImports(readFileSync(file, 'utf8'));
      if (forbidden.length > 0) {
        violations.push(`${relative(CORE_DIR, file)} -> ${forbidden.join(', ')}`);
      }
    }
    expect(violations, `framework imports leaked into core:\n${violations.join('\n')}`).toEqual([]);
  });
});
