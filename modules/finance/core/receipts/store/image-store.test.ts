import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assertSafeImageKey, receiptImageKey } from './image-store';
import { LocalFileImageStore } from './local-file-image-store';

describe('receiptImageKey', () => {
  it('is derived from the household and the image hash — nothing else', () => {
    expect(receiptImageKey('hh_user_1', 'abc123')).toBe('receipts/hh_user_1/abc123');
  });
});

describe('assertSafeImageKey', () => {
  it('accepts plain segments', () => {
    expect(() => assertSafeImageKey('receipts/demo-household-0000/0f2a')).not.toThrow();
    expect(() => assertSafeImageKey('receipts/hh_user_2abc/e3b0c442')).not.toThrow();
  });

  it('rejects anything a filesystem or URL could read as up, root, or empty', () => {
    for (const bad of ['', 'a', '/receipts/x/y', 'receipts//y', 'receipts/../y', 'receipts/./y', 'receipts/x/y z', 'receipts/x/y?', `receipts/x/${String.fromCharCode(0)}`]) {
      expect(() => assertSafeImageKey(bad), bad).toThrow(/unsafe image key/);
    }
  });
});

describe('LocalFileImageStore', () => {
  let root: string;
  let store: LocalFileImageStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'clarity-images-'));
    store = new LocalFileImageStore(root);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('round-trips bytes and content type', async () => {
    const key = receiptImageKey('hh-1', 'hash-1');
    await store.put(key, new Uint8Array([1, 2, 3]), 'image/png');
    expect(await store.get(key)).toEqual({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' });
  });

  it('a missing key is null, not an error', async () => {
    expect(await store.get(receiptImageKey('hh-1', 'nope'))).toBeNull();
  });

  it('writing the same key again replaces the image (idempotent re-upload)', async () => {
    const key = receiptImageKey('hh-1', 'hash-1');
    await store.put(key, new Uint8Array([1]), 'image/png');
    await store.put(key, new Uint8Array([9, 9]), 'application/pdf');
    expect(await store.get(key)).toEqual({ bytes: new Uint8Array([9, 9]), mimeType: 'application/pdf' });
  });

  it('keys are scoped by household: the same hash under two households is two images', async () => {
    await store.put(receiptImageKey('hh-1', 'same'), new Uint8Array([1]), 'image/png');
    await store.put(receiptImageKey('hh-2', 'same'), new Uint8Array([2]), 'image/png');
    expect((await store.get(receiptImageKey('hh-1', 'same')))!.bytes).toEqual(new Uint8Array([1]));
    expect((await store.get(receiptImageKey('hh-2', 'same')))!.bytes).toEqual(new Uint8Array([2]));
  });

  it('an unrecognised content type is stored and served as application/octet-stream', async () => {
    const key = receiptImageKey('hh-1', 'weird');
    await store.put(key, new Uint8Array([7]), 'text/html');
    expect(await store.get(key)).toEqual({ bytes: new Uint8Array([7]), mimeType: 'application/octet-stream' });
  });

  it('concurrent writes of the same key both succeed and leave one readable image', async () => {
    const key = receiptImageKey('hh-1', 'race');
    await Promise.all([
      store.put(key, new Uint8Array([1, 1, 1]), 'image/png'),
      store.put(key, new Uint8Array([1, 1, 1]), 'image/png'),
      store.put(key, new Uint8Array([1, 1, 1]), 'image/png'),
    ]);
    expect(await store.get(key)).toEqual({ bytes: new Uint8Array([1, 1, 1]), mimeType: 'image/png' });
  });

  it('concurrent writes of the same key with DIFFERENT content types leave the last one readable — never nothing', async () => {
    const key = receiptImageKey('hh-1', 'race-mime');
    await Promise.all([
      store.put(key, new Uint8Array([1]), 'image/jpeg'),
      store.put(key, new Uint8Array([2]), 'image/png'),
      store.put(key, new Uint8Array([3]), 'application/pdf'),
    ]);
    expect(await store.get(key)).toEqual({ bytes: new Uint8Array([3]), mimeType: 'application/pdf' });
    // …and a later write still goes through (the lock is released).
    await store.put(key, new Uint8Array([4]), 'image/png');
    expect(await store.get(key)).toEqual({ bytes: new Uint8Array([4]), mimeType: 'image/png' });
  });

  it('a failed write does not wedge later writes to the same key', async () => {
    const key = receiptImageKey('hh-1', 'after-failure');
    // Make the first write fail by putting a directory where its file must go.
    const { mkdirSync, readdirSync } = await import('node:fs');
    const obstacle = join(root, 'receipts', 'hh-1', 'after-failure.png');
    mkdirSync(obstacle, { recursive: true });
    await expect(store.put(key, new Uint8Array([1]), 'image/png')).rejects.toThrow();
    // The failed write left no temp file behind…
    expect(readdirSync(join(root, 'receipts', 'hh-1')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    rmSync(obstacle, { recursive: true, force: true });
    // …and the next write to the same key is not stuck behind it.
    await store.put(key, new Uint8Array([2]), 'image/jpeg');
    expect(await store.get(key)).toEqual({ bytes: new Uint8Array([2]), mimeType: 'image/jpeg' });
  });

  it('never leaves the store root', async () => {
    await expect(store.put('receipts/../../etc/passwd', new Uint8Array([1]), 'text/plain')).rejects.toThrow(/unsafe image key/);
    await expect(store.get('receipts/x/..')).rejects.toThrow(/unsafe image key/);
  });
});
