import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSkuOrAbbrev, normalizeStore } from '../dictionary/normalize';
import type { Resolution, ResolutionQuery, SkuResolver } from './sku-resolver';

// =============================================================================
// The recorded generic LLM seam — replays a previously-captured Resolution from
// a fixture instead of calling Anthropic, so `npm test` is fully offline (no
// API key, no network). It plugs in wherever the live AnthropicSkuResolver would
// (e.g. as the `llm` of LlmSkuResolver), and is keyed identically to the eval
// harness (epic contract §9):
//
//   fixtures/resolver/<normalizeStore(store)>__<normalizeSkuOrAbbrev(sku ?? description)>.json
//
// Because it normalizes the key with the SAME functions the dictionary uses, a
// fixture written for one spelling/casing of a store is found for any equivalent
// spelling — the recorded seam and the dictionary agree on keys.
// =============================================================================

const DEFAULT_FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'resolver',
);

export interface RecordedSkuResolverOpts {
  fixturesDir?: string;
}

export function resolverFixtureKey(store: string, skuOrAbbrev: string): string {
  return `${normalizeStore(store)}__${normalizeSkuOrAbbrev(skuOrAbbrev)}`;
}

export class RecordedSkuResolver implements SkuResolver {
  private readonly fixturesDir: string;

  constructor(opts: RecordedSkuResolverOpts = {}) {
    this.fixturesDir = opts.fixturesDir ?? DEFAULT_FIXTURES_DIR;
  }

  async resolve(query: ResolutionQuery): Promise<Resolution> {
    const key = resolverFixtureKey(query.store, query.sku ?? query.description);
    const path = join(this.fixturesDir, `${key}.json`);

    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      throw new Error(
        `RecordedSkuResolver: no fixture for key "${key}" (expected ${path}). ` +
          'Record the resolver output for this (store, sku/description) pair.',
      );
    }

    return JSON.parse(raw) as Resolution;
  }
}
