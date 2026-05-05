const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), 'data');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readJobs() {
  ensureDir();
  try {
    const data = fs.readFileSync(JOBS_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

function writeJobs(jobs) {
  ensureDir();
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

export function createJob(job) {
  const jobs = readJobs();
  const id = 'job_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  const newJob = {
    id,
    name: job.name || 'Unnamed Job',
    type: job.type || 's3',
    source: job.source,
    dest: job.dest,
    settings: job.settings || {},
    status: 'pending',
    progress: 0,
    stats: { total: 0, synced: 0, failed: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    error: null,
  };
  jobs.push(newJob);
  writeJobs(jobs);
  return newJob;
}

export function getJobs() {
  return readJobs();
}

export function getJob(id) {
  const jobs = readJobs();
  return jobs.find(j => j.id === id);
}

export function updateJob(id, updates) {
  const jobs = readJobs();
  const index = jobs.findIndex(j => j.id === id);
  if (index === -1) return null;
  
  jobs[index] = { ...jobs[index], ...updates, updatedAt: new Date().toISOString() };
  writeJobs(jobs);
  return jobs[index];
}

export function deleteJob(id) {
  const jobs = readJobs();
  const filtered = jobs.filter(j => j.id !== id);
  if (filtered.length === jobs.length) return false;
  writeJobs(filtered);
  return true;
}

export function pauseJob(id) {
  return updateJob(id, { status: 'paused' });
}

export function resumeJob(id) {
  return updateJob(id, { status: 'running' });
}

export function stopJob(id) {
  return updateJob(id, { status: 'stopped' });
}

export function updateJobStats(id, stats) {
  const jobs = readJobs();
  const index = jobs.findIndex(j => j.id === id);
  if (index === -1) return null;
  
  jobs[index].stats = { ...jobs[index].stats, ...stats };
  jobs[index].updatedAt = new Date().toISOString();
  writeJobs(jobs);
  return jobs[index];
}

export function clearJobs() {
  writeJobs([]);
}