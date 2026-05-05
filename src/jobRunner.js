export const activeJobs = new Map();

let _io = null;

export function initJobManager(io) {
  _io = io;
}

export function addJob(job) {
  activeJobs.set(job.id, {
    ...job,
    status: 'running',
    startedAt: Date.now(),
    abortController: new AbortController(),
  });
  emitJobs();
}

export function getJob(jobId) {
  return activeJobs.get(jobId);
}

export function getActiveJobs() {
  return Array.from(activeJobs.values());
}

export function updateJobProgress(jobId, progress) {
  const job = activeJobs.get(jobId);
  if (!job) return null;
  
  job.progress = progress.progress || 0;
  job.stats = progress.stats || job.stats;
  emitJobs();
  return job;
}

export function removeJob(jobId) {
  const job = activeJobs.get(jobId);
  if (job?.abortController) {
    job.abortController.abort();
  }
  activeJobs.delete(jobId);
  emitJobs();
}

export function pauseJob(jobId) {
  const job = activeJobs.get(jobId);
  if (!job) return null;
  job.status = 'paused';
  emitJobs();
  return job;
}

export function resumeJob(jobId) {
  const job = activeJobs.get(jobId);
  if (!job) return null;
  job.status = 'running';
  emitJobs();
  return job;
}

export function stopJob(jobId) {
  const job = activeJobs.get(jobId);
  if (!job) return null;
  job.status = 'stopped';
  job.abortController.abort();
  emitJobs();
  return job;
}

function emitJobs() {
  if (_io) {
    _io.emit('jobs:update', {
      jobs: Array.from(activeJobs.values()).map(job => ({
        id: job.id,
        name: job.name,
        type: job.type,
        status: job.status,
        progress: job.progress,
        stats: job.stats,
        startedAt: job.startedAt,
      })),
    });
  }
}