export const dbState = {
  running: false,
  stopRequested: false,
  repeatTimer: null,
  currentCycle: 0,
  stats: {
    totalTables: 0,
    syncedTables: 0,
    failedTables: 0,
    skippedTables: 0,
    totalRows: 0,
    syncedRows: 0,
    failedRows: 0,
    bytesTransferred: 0,
  },
  startedAt: null,
  config: null,
  lastFailedTables: [],
};

export function resetDbStats() {
  dbState.stats = {
    totalTables: 0,
    syncedTables: 0,
    failedTables: 0,
    skippedTables: 0,
    totalRows: 0,
    syncedRows: 0,
    failedRows: 0,
    bytesTransferred: 0,
  };
  dbState.startedAt = Date.now();
  dbState.stopRequested = false;
  dbState.lastFailedTables = [];
}