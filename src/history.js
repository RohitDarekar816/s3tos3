import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = path.join(__dirname, '..', 'data', 'history.json');
const MAX_ENTRIES = 100;

function load() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return [];
  }
}

export function getHistory() {
  return load();
}

function atomicWrite(file, content) {
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

export function appendHistory(entry) {
  const history = load();
  history.unshift({ id: crypto.randomUUID(), ...entry });
  if (history.length > MAX_ENTRIES) history.splice(MAX_ENTRIES);
  atomicWrite(HISTORY_FILE, JSON.stringify(history, null, 2));
}

export function clearHistory() {
  atomicWrite(HISTORY_FILE, '[]');
}
