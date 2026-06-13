import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageHash } from '../image-hash';
import {
  assertSupportedMimeType,
  type ExtractedReceipt,
  type ReceiptImageInput,
  type VisionProvider,
} from './vision-provider';

// Replays a recorded `ExtractedReceipt` keyed by `imageHash(input.bytes)` from
// `fixtures/vision/<hash>.json` (epic contract §9). This is the provider wired
// into the default `npm test` gate: no Anthropic client, no API key, no network.
// It keys on the exact byte hash so the same photo always replays the same
// extraction — the recorded counterpart of the live call.
export class RecordedVisionProvider implements VisionProvider {
  private readonly fixturesDir: string;

  constructor(opts: { fixturesDir?: string } = {}) {
    this.fixturesDir =
      opts.fixturesDir ??
      join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'vision');
  }

  async extract(input: ReceiptImageInput): Promise<ExtractedReceipt> {
    // Same FR-5 boundary as the live provider: unsupported media types are a
    // caller error, not an unreadable photo.
    assertSupportedMimeType(input.mimeType);

    const hash = imageHash(input.bytes);
    const path = join(this.fixturesDir, `${hash}.json`);

    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      throw new Error(
        `No recorded vision fixture for imageHash ${hash} (expected ${path}). ` +
          'Record one under fixtures/vision/ or wire the live provider.',
      );
    }

    return JSON.parse(raw) as ExtractedReceipt;
  }
}
