/**
 * Tests for src/backupCrypto.js
 *
 * Covers:
 *  - Encrypt/decrypt round-trip (unit + property-based)
 *  - Header structure verification (unit + property-based)
 *  - Wrong passphrase emits an error event (unit)
 *  - Property 15: Encryption round-trip preserves plaintext (Validates: Requirements 13.2)
 *  - Property 16: Encrypted artifact header has correct structure (Validates: Requirements 13.3)
 */

import { describe, it, expect } from 'vitest';
import { pipeline } from 'stream/promises';
import { Readable, Writable, PassThrough } from 'stream';
import * as fc from 'fast-check';
import { createEncryptStream, createDecryptStream } from '../../src/backupCrypto.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Encrypts `data` with `passphrase` and returns the full encrypted Buffer.
 */
async function encrypt(passphrase, data) {
  const chunks = [];
  const encryptStream = createEncryptStream(passphrase);
  const collector = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  });

  await pipeline(Readable.from(data), encryptStream, collector);
  return Buffer.concat(chunks);
}

/**
 * Decrypts `encryptedData` with `passphrase` and returns the plaintext Buffer.
 * Rejects if the stream emits an error.
 */
function decrypt(passphrase, encryptedData) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const decryptStream = createDecryptStream(passphrase);

    decryptStream.on('data', (chunk) => chunks.push(chunk));
    decryptStream.on('end', () => resolve(Buffer.concat(chunks)));
    decryptStream.on('error', reject);

    decryptStream.end(encryptedData);
  });
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe('createEncryptStream / createDecryptStream', () => {
  it('round-trip: decrypted output equals original plaintext', async () => {
    const passphrase = 'correct-horse-battery-staple';
    const plaintext = Buffer.from('Hello, backup world!');

    const encrypted = await encrypt(passphrase, plaintext);
    const decrypted = await decrypt(passphrase, encrypted);

    expect(decrypted).toEqual(plaintext);
  });

  it('round-trip: works with empty plaintext', async () => {
    const passphrase = 'empty-test';
    const plaintext = Buffer.alloc(0);

    const encrypted = await encrypt(passphrase, plaintext);
    const decrypted = await decrypt(passphrase, encrypted);

    expect(decrypted).toEqual(plaintext);
  });

  it('round-trip: works with large binary data', async () => {
    const passphrase = 'large-data-passphrase';
    const plaintext = Buffer.alloc(1024 * 64, 0xab); // 64 KB of 0xab bytes

    const encrypted = await encrypt(passphrase, plaintext);
    const decrypted = await decrypt(passphrase, encrypted);

    expect(decrypted).toEqual(plaintext);
  });

  it('round-trip: works when data arrives in multiple chunks', async () => {
    const passphrase = 'chunked-passphrase';
    const plaintext = Buffer.from('chunk1chunk2chunk3');

    // Split into 3 separate writes
    const chunks = [];
    const decryptStream = createDecryptStream(passphrase);
    const encryptStream = createEncryptStream(passphrase);

    // Collect encrypted output
    const encryptedChunks = [];
    encryptStream.on('data', (c) => encryptedChunks.push(c));
    await new Promise((resolve, reject) => {
      encryptStream.on('end', resolve);
      encryptStream.on('error', reject);
      encryptStream.write(Buffer.from('chunk1'));
      encryptStream.write(Buffer.from('chunk2'));
      encryptStream.end(Buffer.from('chunk3'));
    });
    const encrypted = Buffer.concat(encryptedChunks);

    // Decrypt
    const decrypted = await decrypt(passphrase, encrypted);
    expect(decrypted).toEqual(plaintext);
  });

  // -------------------------------------------------------------------------
  // Header structure tests
  // -------------------------------------------------------------------------

  it('header: first byte is version 0x01', async () => {
    const encrypted = await encrypt('any-passphrase', Buffer.from('data'));
    expect(encrypted[0]).toBe(0x01);
  });

  it('header: total encrypted output is at least 45 bytes (header overhead)', async () => {
    const encrypted = await encrypt('any-passphrase', Buffer.from(''));
    // 1 (version) + 16 (salt) + 12 (IV) + 16 (auth tag) = 45 bytes minimum
    expect(encrypted.length).toBeGreaterThanOrEqual(45);
  });

  it('header: version byte at offset 0 is 0x01', async () => {
    const encrypted = await encrypt('passphrase', Buffer.from('test data'));
    expect(encrypted.readUInt8(0)).toBe(0x01);
  });

  it('header: salt occupies bytes 1–16 (16 bytes)', async () => {
    const encrypted = await encrypt('passphrase', Buffer.from('test data'));
    // Salt should be 16 non-trivially-zero bytes (random)
    const salt = encrypted.slice(1, 17);
    expect(salt.length).toBe(16);
  });

  it('header: IV occupies bytes 17–28 (12 bytes)', async () => {
    const encrypted = await encrypt('passphrase', Buffer.from('test data'));
    const iv = encrypted.slice(17, 29);
    expect(iv.length).toBe(12);
  });

  it('header: auth tag occupies bytes 29–44 (16 bytes)', async () => {
    const encrypted = await encrypt('passphrase', Buffer.from('test data'));
    const authTag = encrypted.slice(29, 45);
    expect(authTag.length).toBe(16);
  });

  it('header: two encryptions of the same data produce different salts and IVs', async () => {
    const passphrase = 'same-passphrase';
    const data = Buffer.from('same data');

    const enc1 = await encrypt(passphrase, data);
    const enc2 = await encrypt(passphrase, data);

    const salt1 = enc1.slice(1, 17);
    const salt2 = enc2.slice(1, 17);
    const iv1 = enc1.slice(17, 29);
    const iv2 = enc2.slice(17, 29);

    // Salts and IVs should be random — extremely unlikely to collide
    expect(salt1.equals(salt2)).toBe(false);
    expect(iv1.equals(iv2)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Wrong passphrase / corruption tests
  // -------------------------------------------------------------------------

  it('wrong passphrase: emits an error event and does not produce output', async () => {
    const plaintext = Buffer.from('sensitive data');
    const encrypted = await encrypt('correct-passphrase', plaintext);

    await expect(decrypt('wrong-passphrase', encrypted)).rejects.toThrow(
      /Decryption failed/
    );
  });

  it('corrupted ciphertext: emits an error event', async () => {
    const plaintext = Buffer.from('some data to corrupt');
    const encrypted = await encrypt('passphrase', plaintext);

    // Flip a byte in the ciphertext region (after the 45-byte header)
    const corrupted = Buffer.from(encrypted);
    if (corrupted.length > 45) {
      corrupted[45] ^= 0xff;
    }

    await expect(decrypt('passphrase', corrupted)).rejects.toThrow(
      /Decryption failed/
    );
  });

  it('corrupted auth tag: emits an error event', async () => {
    const plaintext = Buffer.from('auth tag corruption test');
    const encrypted = await encrypt('passphrase', plaintext);

    // Corrupt the auth tag (bytes 29–44)
    const corrupted = Buffer.from(encrypted);
    corrupted[29] ^= 0xff;

    await expect(decrypt('passphrase', corrupted)).rejects.toThrow(
      /Decryption failed/
    );
  });

  it('wrong passphrase: no partial plaintext is emitted before the error', async () => {
    const plaintext = Buffer.alloc(1024, 0x42); // 1 KB
    const encrypted = await encrypt('correct', plaintext);

    const receivedChunks = [];
    const decryptStream = createDecryptStream('wrong');

    await new Promise((resolve) => {
      decryptStream.on('data', (chunk) => receivedChunks.push(chunk));
      decryptStream.on('error', () => resolve()); // error expected
      decryptStream.on('end', resolve);
      decryptStream.end(encrypted);
    });

    // No data should have been pushed before the error
    expect(receivedChunks.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Property-based tests
// ---------------------------------------------------------------------------

describe('Property 15: Encryption round-trip preserves plaintext', () => {
  /**
   * Validates: Requirements 13.2
   *
   * For any passphrase and any plaintext byte sequence, encrypting the data
   * and then decrypting with the same passphrase SHALL produce a byte sequence
   * identical to the original plaintext.
   */
  it('encrypt then decrypt with same passphrase returns original bytes', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 128 }),   // passphrase
        fc.uint8Array({ minLength: 0, maxLength: 512 }), // plaintext bytes
        async (passphrase, plaintextArray) => {
          const plaintext = Buffer.from(plaintextArray);
          const encrypted = await encrypt(passphrase, plaintext);
          const decrypted = await decrypt(passphrase, encrypted);
          return decrypted.equals(plaintext);
        }
      ),
      { numRuns: 50 }
    );
  }, 60_000); // PBKDF2 × 50 runs is CPU-intensive — allow 60s
});

describe('Property 16: Encrypted artifact header has correct structure', () => {
  /**
   * Validates: Requirements 13.3
   *
   * For any passphrase and plaintext, the encrypted artifact SHALL begin with
   * version byte 0x01 at offset 0, a 16-byte salt at offset 1, and a 12-byte
   * IV at offset 17 — totaling a 29-byte deterministic header prefix (before
   * the 16-byte auth tag).
   */
  it('encrypted output has correct header layout', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 128 }),    // passphrase
        fc.uint8Array({ minLength: 0, maxLength: 256 }), // plaintext
        async (passphrase, plaintextArray) => {
          const plaintext = Buffer.from(plaintextArray);
          const encrypted = await encrypt(passphrase, plaintext);

          // Must be at least 45 bytes (full header)
          if (encrypted.length < 45) return false;

          // Offset 0: version byte must be 0x01
          if (encrypted[0] !== 0x01) return false;

          // Offset 1–16: 16-byte salt (just verify length by checking offsets)
          const salt = encrypted.slice(1, 17);
          if (salt.length !== 16) return false;

          // Offset 17–28: 12-byte IV
          const iv = encrypted.slice(17, 29);
          if (iv.length !== 12) return false;

          // Offset 29–44: 16-byte auth tag
          const authTag = encrypted.slice(29, 45);
          if (authTag.length !== 16) return false;

          return true;
        }
      ),
      { numRuns: 50 }
    );
  }, 60_000); // PBKDF2 × 50 runs is CPU-intensive — allow 60s
});
