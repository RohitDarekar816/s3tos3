/**
 * backupCrypto.js
 *
 * Provides AES-256-GCM encryption/decryption Transform streams for backup artifacts.
 *
 * Artifact binary layout:
 *   Offset  Length  Field
 *   ------  ------  -----
 *   0       1       Format version byte (0x01)
 *   1       16      PBKDF2 salt
 *   17      12      AES-GCM IV
 *   29      16      AES-GCM auth tag
 *   45      N       Ciphertext (encrypted backup data)
 *
 * Total header overhead: 45 bytes.
 *
 * NOTE: Because the GCM auth tag is only available after all plaintext has been
 * encrypted (i.e., after cipher.final()), the encrypt stream must buffer all
 * ciphertext internally and emit it only in the flush phase, after the full
 * 45-byte header (including the auth tag) has been written.
 */

import crypto from 'crypto';
import { Transform } from 'stream';

const FORMAT_VERSION = 0x01;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const HEADER_LENGTH = 1 + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH; // 45 bytes

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_KEY_LENGTH = 32;
const PBKDF2_DIGEST = 'sha256';

/**
 * Derives a 32-byte AES key from a passphrase and salt using PBKDF2.
 *
 * @param {string} passphrase
 * @param {Buffer} salt - 16-byte salt
 * @returns {Buffer} 32-byte key
 */
function deriveKey(passphrase, salt) {
  return crypto.pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, PBKDF2_DIGEST);
}

/**
 * Creates a Transform stream that encrypts data using AES-256-GCM.
 *
 * Output format:
 *   [version(1)] [salt(16)] [iv(12)] [authTag(16)] [ciphertext(N)]
 *
 * Because the GCM auth tag is only available after all plaintext is processed,
 * the stream buffers all ciphertext internally and emits the full output
 * (header + ciphertext) in the flush phase.
 *
 * @param {string} passphrase - The encryption passphrase
 * @returns {Transform} A Transform stream that encrypts its input
 */
export function createEncryptStream(passphrase) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  // Buffer all ciphertext chunks; we emit them only after we have the auth tag
  const ciphertextChunks = [];

  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        const encrypted = cipher.update(chunk);
        if (encrypted.length > 0) {
          ciphertextChunks.push(encrypted);
        }
        callback();
      } catch (err) {
        callback(err);
      }
    },

    flush(callback) {
      try {
        // Finalize the cipher — for GCM this may return remaining ciphertext
        const final = cipher.final();
        if (final.length > 0) {
          ciphertextChunks.push(final);
        }

        // Auth tag is available only after cipher.final()
        const authTag = cipher.getAuthTag();

        // Build the full 45-byte header: version + salt + iv + authTag
        const header = Buffer.concat([
          Buffer.from([FORMAT_VERSION]),
          salt,
          iv,
          authTag,
        ]);

        // Emit header first, then all buffered ciphertext
        this.push(header);
        for (const chunk of ciphertextChunks) {
          this.push(chunk);
        }

        callback();
      } catch (err) {
        callback(err);
      }
    },
  });

  return transform;
}

/**
 * Creates a Transform stream that decrypts AES-256-GCM encrypted data.
 *
 * The stream:
 *   1. Buffers the first 45 bytes to read the header (version + salt + IV + auth tag)
 *   2. Derives the key from the passphrase + salt
 *   3. Creates a decipher with the IV and sets the auth tag
 *   4. Pipes remaining bytes through the decipher
 *   5. On GCM authentication failure, emits an 'error' event and does NOT push
 *      any decrypted data
 *
 * @param {string} passphrase - The decryption passphrase
 * @returns {Transform} A Transform stream that decrypts its input
 */
export function createDecryptStream(passphrase) {
  let headerBuffer = Buffer.alloc(0);
  let headerConsumed = false;
  let decipher = null;
  // Accumulate all decrypted chunks; only push them on successful flush
  // to prevent partial data from being written on auth failure.
  const decryptedChunks = [];

  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      try {
        if (!headerConsumed) {
          // Accumulate bytes until we have the full 45-byte header
          headerBuffer = Buffer.concat([headerBuffer, chunk]);

          if (headerBuffer.length < HEADER_LENGTH) {
            // Not enough data yet — wait for more
            callback();
            return;
          }

          // Parse the header
          // Offset 0:  version byte (1)
          // Offset 1:  salt (16)
          // Offset 17: IV (12)
          // Offset 29: auth tag (16)
          const salt = headerBuffer.slice(1, 1 + SALT_LENGTH);
          const iv = headerBuffer.slice(1 + SALT_LENGTH, 1 + SALT_LENGTH + IV_LENGTH);
          const authTag = headerBuffer.slice(
            1 + SALT_LENGTH + IV_LENGTH,
            1 + SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH
          );

          // Derive the key and create the decipher
          const key = deriveKey(passphrase, salt);
          decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
          decipher.setAuthTag(authTag);

          headerConsumed = true;

          // Any bytes after the header in this chunk are ciphertext
          const remaining = headerBuffer.slice(HEADER_LENGTH);
          if (remaining.length > 0) {
            const decrypted = decipher.update(remaining);
            if (decrypted.length > 0) {
              decryptedChunks.push(decrypted);
            }
          }

          callback();
        } else {
          // Header already consumed — pass through the decipher
          const decrypted = decipher.update(chunk);
          if (decrypted.length > 0) {
            decryptedChunks.push(decrypted);
          }
          callback();
        }
      } catch (err) {
        callback(err);
      }
    },

    flush(callback) {
      try {
        if (!decipher) {
          // No data was received or header was incomplete
          callback(new Error('Decryption failed — incomplete or missing header'));
          return;
        }

        // decipher.final() triggers GCM auth tag verification.
        // If the tag doesn't match, this throws an error.
        let final;
        try {
          final = decipher.final();
        } catch (_authError) {
          // GCM authentication failed — do NOT push any decrypted data
          callback(
            new Error(
              'Decryption failed — incorrect passphrase or corrupted artifact'
            )
          );
          return;
        }

        // Authentication succeeded — push all accumulated decrypted data
        for (const chunk of decryptedChunks) {
          this.push(chunk);
        }
        if (final.length > 0) {
          this.push(final);
        }

        callback();
      } catch (err) {
        callback(err);
      }
    },
  });

  return transform;
}
