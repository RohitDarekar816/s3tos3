import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, '..', 'logs');

let _io = null;
let _stream = null;

export function init(io) {
  _io = io;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  _stream = fs.createWriteStream(path.join(LOG_DIR, `${date}.log`), { flags: 'a' });
}

const TAG = {
  info:    'INFO ',
  success: 'OK   ',
  error:   'ERROR',
  skip:    'SKIP ',
  warning: 'WARN ',
};

export function log(level, message) {
  const ts = new Date().toISOString();
  const tag = TAG[level] || 'LOG  ';
  const line = `${ts} [${tag}] ${message}`;

  if (_io) _io.emit('log', { ts: Date.now(), level, message });
  process.stdout.write(line + '\n');
  _stream?.write(line + '\n');
}
