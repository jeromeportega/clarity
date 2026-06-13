import { describe, expect, it } from 'vitest';
import { imageHash } from './image-hash';

describe('imageHash', () => {
  it('returns the SHA-256 hex of the bytes (known vector for "abc")', () => {
    const bytes = new TextEncoder().encode('abc');
    expect(imageHash(bytes)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes empty input deterministically', () => {
    expect(imageHash(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('is a stable idempotency key — identical bytes hash identically', () => {
    const a = new Uint8Array([1, 2, 3, 4, 5]);
    const b = new Uint8Array([1, 2, 3, 4, 5]);
    expect(imageHash(a)).toBe(imageHash(b));
  });

  it('is sensitive to a single-byte change', () => {
    expect(imageHash(new Uint8Array([0]))).not.toBe(imageHash(new Uint8Array([1])));
  });
});
