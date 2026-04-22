import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function persist(jobs) {
  const tmp = JOBS_FILE + '.tmp';
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(jobs, null, 2));
  fs.renameSync(tmp, JOBS_FILE);
}

export function listJobs() {
  return load().map(({ source, dest, ...rest }) => ({
    ...rest,
    // Strip secrets from list view — full secrets only returned by getJob()
    source: { ...source, secretAccessKey: '***' },
    dest:   { ...dest,   secretAccessKey: '***' },
  }));
}

export function getJob(id) {
  return load().find((j) => j.id === id) || null;
}

export function createJob(data) {
  const jobs = load();
  const job = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...data };
  jobs.push(job);
  persist(jobs);
  return job;
}

export function updateJob(id, data) {
  const jobs = load();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx < 0) return null;
  jobs[idx] = { ...jobs[idx], ...data, id, updatedAt: new Date().toISOString() };
  persist(jobs);
  return jobs[idx];
}

export function deleteJob(id) {
  const jobs = load();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx < 0) return false;
  jobs.splice(idx, 1);
  persist(jobs);
  return true;
}
