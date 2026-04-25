export const clusterState = {
  running: false,
  clusters: {},
  config: null,
  stats: {
    totalReplicas: 0,
    syncReplicas: 0,
    asyncReplicas: 0,
    maxLag: 0,
    lagAlert: false,
  },
  history: [],
};

export function resetClusterStats() {
  clusterState.stats = {
    totalReplicas: 0,
    syncReplicas: 0,
    asyncReplicas: 0,
    maxLag: 0,
    lagAlert: false,
  };
}

export function setClusterConfig(config) {
  clusterState.config = config;
}

export function getClusterConfig() {
  return clusterState.config;
}