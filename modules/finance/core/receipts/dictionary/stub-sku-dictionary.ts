import { normalizeSkuOrAbbrev, normalizeStore } from './normalize';
import type { DictionaryEntry, SkuDictionary } from './sku-dictionary';

// In-memory SkuDictionary used by `npm test` so the H2 pipeline is testable
// offline (no key, no network). Behaviorally identical to LibSqlSkuDictionary:
// keys are normalized internally and upsert enforces human-wins precedence only.
export class StubSkuDictionary implements SkuDictionary {
  private readonly rows = new Map<string, DictionaryEntry>();
  readonly scopedHouseholdId: string;

  // One instance is one household's dictionary; the id is kept for parity with
  // the libSQL implementation (composition roots check the two agree).
  constructor(opts: { householdId?: string } = {}) {
    this.scopedHouseholdId = opts.householdId ?? 'stub-household';
  }

  async lookup(store: string, skuOrAbbrev: string): Promise<DictionaryEntry | null> {
    const found = this.rows.get(keyOf(store, skuOrAbbrev));
    return found ? { ...found } : null;
  }

  async upsert(entry: DictionaryEntry): Promise<void> {
    const store = normalizeStore(entry.store);
    const skuOrAbbrev = normalizeSkuOrAbbrev(entry.skuOrAbbrev);
    const key = keyOf(store, skuOrAbbrev);
    const existing = this.rows.get(key);
    // Human-wins precedence: a human row always overwrites. An auto row writes
    // only when no row exists — it never clobbers an existing row.
    if (existing && entry.source !== 'human') return;
    this.rows.set(key, { ...entry, store, skuOrAbbrev });
  }
}

// A separator that cannot appear in a normalised key, so ('A B', 'C') and
// ('A', 'B C') never collide the way a space-joined key would.
function keyOf(store: string, skuOrAbbrev: string): string {
  return `${normalizeStore(store)}\u001f${normalizeSkuOrAbbrev(skuOrAbbrev)}`;
}
