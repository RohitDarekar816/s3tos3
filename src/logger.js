import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(__dirname, '..', 'logs');

// ── Log level ──────────────────────────────────────────────────────────────
// Levels in ascending severity order. Only messages at or above the
// configured level are emitted.
//
// LOG_LEVEL=debug  → everything (debug, info, success, skip, warning, error)
// LOG_LEVEL=info   → info, success, skip, warning, error  (default)
// LOG_LEVEL=warn   → warning, error
// LOG_LEVEL=error  → error only

const LEVELS = { debug: 0, info: 1, success: 1, skip: 1, warning: 2, error: 3 };

function resolveLevel() {
  const raw = (process.env.LOG_LEVEL || 'info').toLowerCase().trim();
  // Accept common aliases
  if (raw === 'warn')    return 2;
  if (raw === 'verbose') return 0;
  return LEVELS[raw] ?? 1;
}

let _minLevel = resolveLevel();
let _io = null;
let _stream = null;

// Re-read LOG_LEVEL at runtime so tests can override it without restarting
export function setLogLevel(level) {
  _minLevel = LEVELS[level] ?? 1;
}

export function getLogLevel() {
  return _minLevel;
}

export function isDebugEnabled() {
  return _minLevel === 0;
}

export function init(io) {
  _io = io;
  _minLevel = resolveLevel(); // re-read in case env changed after module load
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  _stream = fs.createWriteStream(path.join(LOG_DIR, `${date}.log`), { flags: 'a' });

  if (_minLevel === 0) {
    const line = `${new Date().toISOString()} [DEBUG] Debug logging enabled (LOG_LEVEL=debug)`;
    process.stdout.write(line + '\n');
    _stream?.write(line + '\n');
  }
}

const TAG = {
  debug:   'DEBUG',
  info:    'INFO ',
  success: 'OK   ',
  error:   'ERROR',
  skip:    'SKIP ',
  warning: 'WARN ',
};

export function log(level, message) {
  const msgLevel = LEVELS[level] ?? 1;

  // Always write errors and warnings to stdout/file regardless of level setting
  // so they are never silently dropped. For other levels, apply the filter.
  if (level !== 'error' && level !== 'warning' && msgLevel < _minLevel) return;

  const ts  = new Date().toISOString();
  const tag = TAG[level] || 'LOG  ';
  const line = `${ts} [${tag}] ${message}`;

  // Write to stdout and log file unconditionally (level filter already applied)
  process.stdout.write(line + '\n');
  _stream?.write(line + '\n');

  // Emit to UI via WebSocket.
  // Debug messages are only sent to the UI when debug mode is active,
  // to avoid flooding the activity log in production.
  if (_io) {
    if (level !== 'debug' || _minLevel === 0) {
      _io.emit('log', { ts: Date.now(), level, message });
    }
  }
}

// Convenience shorthand
export function debug(message) { log('debug', message); }
