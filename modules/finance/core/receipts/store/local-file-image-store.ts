import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

import { assertSafeImageKey, type ImageStore, type StoredImage } from './image-store';

/**
 * Receipt images on the local disk, for dev and tests (and any deployment
 * with a durable disk). One file per key, `<root>/<key>.<ext>`, the extension
 * carrying the content type — so a write is ONE atomic rename (temp file
 * named by a UUID, so racing writers never share a temp path) and a reader
 * never sees a half-written image or a content type from another write.
 */
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'application/pdf': 'pdf',
};
const MIME_BY_EXT: Record<string, string> = Object.fromEntries(Object.entries(EXT_BY_MIME).map(([m, e]) => [e, m]));
const FALLBACK_EXT = 'bin';
const ALL_EXTS = [...Object.keys(MIME_BY_EXT), FALLBACK_EXT];

export class LocalFileImageStore implements ImageStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async put(key: string, bytes: Uint8Array, mimeType: string): Promise<void> {
    const base = this.pathFor(key);
    const ext = EXT_BY_MIME[mimeType] ?? FALLBACK_EXT;
    await mkdir(dirname(base), { recursive: true });
    const tmp = `${base}.${randomUUID()}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, `${base}.${ext}`);
    // A re-upload with a different content type replaces the old file.
    await Promise.all(ALL_EXTS.filter((e) => e !== ext).map((e) => rm(`${base}.${e}`, { force: true })));
  }

  async get(key: string): Promise<StoredImage | null> {
    const base = this.pathFor(key);
    for (const ext of ALL_EXTS) {
      try {
        const bytes = await readFile(`${base}.${ext}`);
        return { bytes: new Uint8Array(bytes), mimeType: MIME_BY_EXT[ext] ?? 'application/octet-stream' };
      } catch (err) {
        if ((err as { code?: string }).code !== 'ENOENT') throw err;
      }
    }
    return null;
  }

  private pathFor(key: string): string {
    assertSafeImageKey(key);
    const file = resolve(this.root, ...key.split('/'));
    // Belt to the key check's braces: the resolved path must stay under root.
    if (file !== this.root && !file.startsWith(this.root + sep)) {
      throw new Error(`image key escapes the store root: ${JSON.stringify(key)}`);
    }
    return file;
  }
}
