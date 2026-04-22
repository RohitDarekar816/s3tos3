export const state = {
  running: false,
  stopRequested: false,
  repeatTimer: null,
  currentCycle: 0,
  stats: {
    total: 0,
    synced: 0,
    failed: 0,
    skipped: 0,
    bytesTransferred: 0,
    bytesTotal: 0,
  },
  startedAt: null,
  config: null,
  // Populated at end of each run; used by the retry-failed endpoint
  lastFailedObjects: [],
  // Checkpoint key for the current run (srcBucket:dstBucket in base64url)
  currentCheckpointKey: null,
};

export function resetStats() {
  state.stats = {
    total: 0,
    synced: 0,
    failed: 0,
    skipped: 0,
    bytesTransferred: 0,
    bytesTotal: 0,
  };
  state.startedAt = Date.now();
  state.stopRequested = false;
  state.lastFailedObjects = [];
}
