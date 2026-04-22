import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CP_DIR = path.join(__dirname, '..', 'data', 'checkpoints');

// Key is base64url of "srcBucket:dstBucket" — safe for any bucket name pair.
export function makeKey(srcBucket, dstBucket) {
  return Buffer.from(`${srcBucket}:${dstBucket}`).toString('base64url');
}

function filePath(key) {
  return path.join(CP_DIR, `${key}.json`);
}

export function saveCheckpoint(key, completedKeys) {
  fs.mkdirSync(CP_DIR, { recursive: true });
  const fp = filePath(key);
  const tmp = fp + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({
    key,
    completedKeys: [...completedKeys],
    savedAt: new Date().toISOString(),
    count: completedKeys.size,
  }));
  fs.renameSync(tmp, fp);
}

export function loadCheckpoint(key) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath(key), 'utf8'));
    return { completedKeys: new Set(data.completedKeys), savedAt: data.savedAt, count: data.count };
  } catch {
    return null;
  }
}

export function removeCheckpoint(key) {
  try { fs.unlinkSync(filePath(key)); } catch {}
}

export function listCheckpoints() {
  try {
    return fs.readdirSync(CP_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(CP_DIR, f), 'utf8'));
          return { key: data.key, savedAt: data.savedAt, count: data.count };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
