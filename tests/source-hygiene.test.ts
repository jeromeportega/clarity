/**
 * No source file may contain a raw control byte.
 *
 * A NUL or other C0 control character inside a string literal is invisible in
 * an editor, makes GitHub render the whole file as a binary blob (so it cannot
 * be reviewed line by line), and is one keystroke away from the escape that
 * means the same thing. Spell them as escapes. Tab, newline and carriage return
 * are ordinary whitespace and are allowed.
 *
 * The forbidden set is built with `String.fromCharCode` on purpose: writing it
 * as escape sequences in this file is exactly how such a byte gets in.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|sql|sh|yaml|yml)$/;

// Every C0 control character except tab (9), newline (10) and carriage return (13).
const FORBIDDEN = new Set<number>();
for (let code = 0; code < 32; code++) {
  if (code !== 9 && code !== 10 && code !== 13) FORBIDDEN.add(code);
}

function trackedSourceFiles(): string[] {
  const separator = String.fromCharCode(0); // `git ls-files -z` delimits with NUL
  return execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split(separator)
    .filter((f) => f.length > 0 && SOURCE_EXTENSIONS.test(f));
}

function firstControlCharacter(text: string): { index: number; code: number } | null {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (FORBIDDEN.has(code)) return { index: i, code };
  }
  return null;
}

describe('source hygiene', () => {
  it('no tracked source file contains a raw control character', () => {
    const offenders: string[] = [];
    for (const file of trackedSourceFiles()) {
      const text = readFileSync(join(repoRoot, file), 'utf8');
      const hit = firstControlCharacter(text);
      if (hit) {
        const line = text.slice(0, hit.index).split('\n').length;
        offenders.push(`${file}:${line} (U+${hit.code.toString(16).padStart(4, '0').toUpperCase()})`);
      }
    }
    expect(offenders, 'spell control characters as escapes (backslash-u and four hex digits)').toEqual([]);
  });

  it('the scan itself sees a control character when one is present', () => {
    expect(firstControlCharacter(`abc${String.fromCharCode(0)}def`)).toEqual({ index: 3, code: 0 });
    expect(firstControlCharacter(`abc${String.fromCharCode(31)}`)).toEqual({ index: 3, code: 31 });
    expect(firstControlCharacter('tab\tnewline\ncr\r')).toBeNull();
  });
});
