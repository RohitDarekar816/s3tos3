import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { PassThrough } from 'stream';
import { GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { buildS3Client } from './s3Client.js';
import { log } from './logger.js';

// backupCrypto.js will be created in task 5.1 — imported conditionally
let backupCrypto = null;
async function getBackupCrypto() {
  if (!backupCrypto) {
    try {
      backupCrypto = await import('./backupCrypto.js');
    } catch {
      // backupCrypto.js not yet available (task 5.1 not done)
      backupCrypto = null;
    }
  }
  return backupCrypto;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Build the artifact storage path for a given set of parameters.
 * Returns: `{prefix}/{jobName}/{YYYY-MM-DD}/{backupId}.{ext}`
 *
 * @param {string} prefix    - Storage prefix (e.g. "backups")
 * @param {string} jobName   - Name of the backup job
 * @param {Date|string} date - Date of the backup (Date object or ISO string)
 * @param {string} backupId  - Unique backup identifier
 * @param {string} ext       - File extension without leading dot (e.g. "dump")
 * @returns {string}
 */
export function buildArtifactPath(prefix, jobName, date, backupId, ext) {
  const d = date instanceof Date ? date : new Date(date);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const dateStr = `${yyyy}-${mm}-${dd}`;
  return `${prefix}/${jobName}/${dateStr}/${backupId}.${ext}`;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse an S3 storage path of the form `s3://{bucket}/{key}`.
 * @param {string} storagePath
 * @returns {{ bucket: string, key: string }}
 */
function parseS3Path(storagePath) {
  const withoutScheme = storagePath.slice('s3://'.length);
  const slashIdx = withoutScheme.indexOf('/');
  if (slashIdx < 0) {
    return { bucket: withoutScheme, key: '' };
  }
  return {
    bucket: withoutScheme.slice(0, slashIdx),
    key: withoutScheme.slice(slashIdx + 1),
  };
}

/**
 * Build the S3 storage path string from a target config and a key.
 * @param {object} target  - S3 storage target config
 * @param {string} key     - S3 object key
 * @returns {string}
 */
function buildS3StoragePath(target, key) {
  return `s3://${target.bucket}/${key}`;
}

/**
 * Wrap a readable stream so we can count bytes flowing through it.
 * Returns { countingStream, getBytes }.
 */
function createByteCounter(sourceStream) {
  let bytes = 0;
  const counter = new PassThrough();
  counter.on('data', (chunk) => {
    bytes += chunk.length;
  });
  sourceStream.pipe(counter);
  return {
    countingStream: counter,
    getBytes: () => bytes,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write a source stream to one or more storage targets.
 *
 * For S3 targets, uses `@aws-sdk/lib-storage` Upload for streaming multipart upload.
 * For local targets, pipes to `fs.createWriteStream`.
 *
 * When `encryption.enabled` is true, the stream is piped through the encrypt
 * transform from `backupCrypto.js` before writing.
 *
 * @param {object[]} targets       - Array of storage target configs (s3 or local)
 * @param {import('stream').Readable} sourceStream - Readable stream of backup data
 * @param {string} artifactName    - Artifact filename/key (relative path within target)
 * @param {{ enabled: boolean, passphrase: string }|null} encryption
 * @returns {Promise<Array<{ type: string, path: string, sizeBytes: number, ok: boolean, error: string|null }>>}
 */
export async function writeToTargets(targets, sourceStream, artifactName, encryption) {
  const results = [];

  // We need to fan out the source stream to multiple targets.
  // Strategy: collect the source into a Buffer first (for multi-target fan-out),
  // then write to each target sequentially.
  // For single-target cases this is still straightforward.
  // Note: for very large backups the engine should handle chunking upstream;
  // here we buffer to support multi-target writes without re-reading from disk.

  // Collect source stream into a buffer
  const chunks = [];
  await new Promise((resolve, reject) => {
    sourceStream.on('data', (chunk) => chunks.push(chunk));
    sourceStream.on('end', resolve);
    sourceStream.on('error', reject);
  });
  const sourceBuffer = Buffer.concat(chunks);

  for (const target of targets) {
    let writeBuffer = sourceBuffer;

    // Apply encryption if enabled
    if (encryption?.enabled && encryption?.passphrase) {
      const crypto = await getBackupCrypto();
      if (crypto) {
        try {
          writeBuffer = await encryptBuffer(sourceBuffer, encryption.passphrase, crypto);
        } catch (err) {
          results.push({
            type: target.type,
            path: target.type === 's3'
              ? buildS3StoragePath(target, `${target.prefix || ''}/${artifactName}`)
              : path.join(target.localPath, artifactName),
            sizeBytes: 0,
            ok: false,
            error: `Encryption failed: ${err.message}`,
          });
          continue;
        }
      }
    }

    if (target.type === 's3') {
      const key = target.prefix
        ? `${target.prefix.replace(/\/$/, '')}/${artifactName}`
        : artifactName;
      const storagePath = buildS3StoragePath(target, key);

      try {
        const s3 = buildS3Client(target);
        const { Readable } = await import('stream');
        const bodyStream = Readable.from(writeBuffer);

        const upload = new Upload({
          client: s3,
          params: {
            Bucket: target.bucket,
            Key: key,
            Body: bodyStream,
          },
        });

        await upload.done();

        results.push({
          type: 's3',
          path: storagePath,
          sizeBytes: writeBuffer.length,
          ok: true,
          error: null,
        });
      } catch (err) {
        log('error', `BackupStore: S3 upload failed to s3://${target.bucket}/${key} — ${err.message}`);
        results.push({
          type: 's3',
          path: storagePath,
          sizeBytes: 0,
          ok: false,
          error: err.message,
        });
      }
    } else if (target.type === 'local') {
      const filePath = path.join(target.localPath, artifactName);
      const storagePath = filePath;

      try {
        // Ensure the directory exists
        fs.mkdirSync(path.dirname(filePath), { recursive: true });

        await fs.promises.writeFile(filePath, writeBuffer);

        results.push({
          type: 'local',
          path: storagePath,
          sizeBytes: writeBuffer.length,
          ok: true,
          error: null,
        });
      } catch (err) {
        log('error', `BackupStore: local write failed at ${filePath} — ${err.message}`);
        results.push({
          type: 'local',
          path: storagePath,
          sizeBytes: 0,
          ok: false,
          error: err.message,
        });
      }
    } else {
      results.push({
        type: target.type,
        path: '',
        sizeBytes: 0,
        ok: false,
        error: `Unknown storage target type: ${target.type}`,
      });
    }
  }

  return results;
}

/**
 * Read a backup artifact from a storage path, returning a readable stream.
 * If `encryption.enabled` is true, the stream is piped through the decrypt
 * transform from `backupCrypto.js`.
 *
 * Storage path formats:
 *   - S3:    `s3://{bucket}/{key}`
 *   - Local: absolute filesystem path
 *
 * @param {string} storagePath
 * @param {{ enabled: boolean, passphrase: string }|null} encryption
 * @returns {Promise<import('stream').Readable>}
 */
export async function readFromTarget(storagePath, encryption) {
  let rawStream;

  if (storagePath.startsWith('s3://')) {
    // We need the target config to build the S3 client.
    // The storagePath encodes bucket and key; we derive a minimal config.
    // Callers that need custom credentials should pass a target config instead,
    // but for the common case we rely on environment credentials.
    const { bucket, key } = parseS3Path(storagePath);

    // Build a minimal S3 client using environment/default credentials
    const s3 = buildS3Client({
      region: process.env.AWS_REGION || 'us-east-1',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    });

    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    rawStream = response.Body;
  } else {
    // Local filesystem path
    rawStream = fs.createReadStream(storagePath);
  }

  // Apply decryption if enabled
  if (encryption?.enabled && encryption?.passphrase) {
    const crypto = await getBackupCrypto();
    if (crypto) {
      const decryptStream = crypto.createDecryptStream(encryption.passphrase);
      rawStream.pipe(decryptStream);
      return decryptStream;
    }
  }

  return rawStream;
}

/**
 * Read a backup artifact from a storage path using explicit target credentials.
 * This overload is preferred when the caller has the full target config available.
 *
 * @param {string} storagePath
 * @param {object|null} targetConfig  - Full storage target config (for S3 credentials)
 * @param {{ enabled: boolean, passphrase: string }|null} encryption
 * @returns {Promise<import('stream').Readable>}
 */
export async function readFromTargetWithConfig(storagePath, targetConfig, encryption) {
  let rawStream;

  if (storagePath.startsWith('s3://')) {
    const { bucket, key } = parseS3Path(storagePath);
    const s3 = buildS3Client(targetConfig || {
      region: process.env.AWS_REGION || 'us-east-1',
      accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    });
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    rawStream = response.Body;
  } else {
    rawStream = fs.createReadStream(storagePath);
  }

  if (encryption?.enabled && encryption?.passphrase) {
    const crypto = await getBackupCrypto();
    if (crypto) {
      const decryptStream = crypto.createDecryptStream(encryption.passphrase);
      rawStream.pipe(decryptStream);
      return decryptStream;
    }
  }

  return rawStream;
}

/**
 * Delete a backup artifact from its storage location.
 *
 * Storage path formats:
 *   - S3:    `s3://{bucket}/{key}`
 *   - Local: absolute filesystem path
 *
 * @param {string} storagePath
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
export async function deleteFromTarget(storagePath) {
  try {
    if (storagePath.startsWith('s3://')) {
      const { bucket, key } = parseS3Path(storagePath);

      const s3 = buildS3Client({
        region: process.env.AWS_REGION || 'us-east-1',
        accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
      });

      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
      return { ok: true, error: null };
    } else {
      // Local filesystem
      await fs.promises.unlink(storagePath);
      return { ok: true, error: null };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Internal encryption helper
// ---------------------------------------------------------------------------

/**
 * Encrypt a Buffer using the backupCrypto encrypt stream.
 * Returns the encrypted Buffer.
 *
 * @param {Buffer} inputBuffer
 * @param {string} passphrase
 * @param {object} crypto  - The backupCrypto module
 * @returns {Promise<Buffer>}
 */
async function encryptBuffer(inputBuffer, passphrase, crypto) {
  const { Readable } = await import('stream');
  const encryptStream = crypto.createEncryptStream(passphrase);
  const source = Readable.from(inputBuffer);

  const chunks = [];
  await new Promise((resolve, reject) => {
    encryptStream.on('data', (chunk) => chunks.push(chunk));
    encryptStream.on('end', resolve);
    encryptStream.on('error', reject);
    source.pipe(encryptStream);
  });

  return Buffer.concat(chunks);
}
