import { describe, expect, it } from 'vitest';

import { parseCsv } from '../csv';

describe('parseCsv (RFC-4180 tokenizer)', () => {
  it('splits a simple comma-separated document into rows of fields', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('keeps commas that are inside double-quoted fields', () => {
    expect(parseCsv('"Smith, John",42')).toEqual([['Smith, John', '42']]);
  });

  it('unescapes doubled double-quotes inside a quoted field', () => {
    expect(parseCsv('"she said ""hi""",x')).toEqual([['she said "hi"', 'x']]);
  });

  it('handles CRLF and bare LF line endings interchangeably', () => {
    expect(parseCsv('a,b\r\nc,d\ne,f')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ]);
  });

  it('preserves newlines embedded inside a quoted field', () => {
    expect(parseCsv('"line1\nline2",next')).toEqual([['line1\nline2', 'next']]);
  });

  it('strips a leading UTF-8 BOM', () => {
    expect(parseCsv('﻿a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('ignores a trailing newline rather than emitting a blank row', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('preserves empty fields between commas', () => {
    expect(parseCsv('a,,c')).toEqual([['a', '', 'c']]);
  });
});
