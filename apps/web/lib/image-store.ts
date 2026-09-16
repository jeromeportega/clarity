import { join } from 'node:path';

import { get, put } from '@vercel/blob';

import { assertSafeImageKey, type ImageStore, type StoredImage } from '../../../modules/finance/core/receipts/store/image-store';
import { LocalFileImageStore } from '../../../modules/finance/core/receipts/store/local-file-image-store';

/**
 * Receipt images in a PRIVATE Vercel Blob store: nothing is reachable by URL;
 * every read goes through `/api/receipts/image/[receiptId]`, which checks the
 * household first. The token comes from the environment the way the SDK
 * expects (`BLOB_READ_WRITE_TOKEN`); this class never sees it.
 */
export class VercelBlobImageStore implements ImageStore {
  async put(key: string, bytes: Uint8Array, mimeType: string): Promise<void> {
    assertSafeImageKey(key);
    await put(key, Buffer.from(bytes), {
      access: 'private',
      contentType: mimeType,
      addRandomSuffix: false,
      // The key is derived from the image hash, so a re-upload of the same
      // photo writes the same bytes to the same key.
      allowOverwrite: true,
    });
  }

  async get(key: string): Promise<StoredImage | null> {
    assertSafeImageKey(key);
    const result = await get(key, { access: 'private' });
    if (!result || result.statusCode !== 200) return null;
    const bytes = new Uint8Array(await new Response(result.stream).arrayBuffer());
    return { bytes, mimeType: result.blob.contentType || 'application/octet-stream' };
  }
}

let _store: ImageStore | undefined;

/**
 * The composition root for receipt images: the Blob store when its token is
 * configured (every Vercel environment of this project), else the local disk
 * under the data directory (dev, tests, a fresh clone).
 */
export function getImageStore(env: Record<string, string | undefined> = process.env): ImageStore {
  _store ??= env.BLOB_READ_WRITE_TOKEN?.trim()
    ? new VercelBlobImageStore()
    : new LocalFileImageStore(join(env.CLARITY_DATA_DIR ?? join(process.cwd(), 'data'), 'receipt-images'));
  return _store;
}
