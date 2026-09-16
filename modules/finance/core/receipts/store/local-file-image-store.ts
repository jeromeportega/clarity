import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { assertSafeImageKey, type ImageStore, type StoredImage } from './image-store';

/**
 * Receipt images on the local disk, for dev and tests (and any deployment
 * with a durable disk). Each key becomes `<root>/<key>` plus a `.mime`
 * sidecar carrying the content type. Writes are atomic (temp file + rename)
 * so a reader never sees a half-written image.
 */
export class LocalFileImageStore implements ImageStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async put(key: string, bytes: Uint8Array, mimeType: string): Promise<void> {
    const file = this.pathFor(key);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(tmp, bytes);
    await writeFile(`${tmp}.mime`, mimeType, 'utf8');
    await rename(`${tmp}.mime`, `${file}.mime`);
    await rename(tmp, file);
  }

  async get(key: string): Promise<StoredImage | null> {
    const file = this.pathFor(key);
    try {
      const [bytes, mimeType] = await Promise.all([readFile(file), readFile(`${file}.mime`, 'utf8')]);
      return { bytes: new Uint8Array(bytes), mimeType: mimeType.trim() || 'application/octet-stream' };
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return null;
      throw err;
    }
  }

  private pathFor(key: string): string {
    assertSafeImageKey(key);
    const file = resolve(this.root, ...key.split('/'));
    // Belt to the key check's braces: the resolved path must stay under root.
    if (file !== this.root && !file.startsWith(this.root + sep)) {
      throw new Error(`image key escapes the store root: ${JSON.stringify(key)}`);
    }
    return join(file);
  }
}
