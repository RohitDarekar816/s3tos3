// Shared token-bucket bandwidth limiter.
// All concurrent transfers pull from the same pool, enforcing a true total limit.

let maxBps = 0;       // bytes/sec (0 = unlimited)
let tokens = 0;       // current token balance
let lastRefill = Date.now();
const queue = [];     // [{bytes, resolve}]
let scheduled = false;

function refill() {
  const now = Date.now();
  const elapsed = (now - lastRefill) / 1000;
  tokens = Math.min(maxBps, tokens + elapsed * maxBps);
  lastRefill = now;
}

function drain() {
  scheduled = false;
  if (maxBps <= 0) return;

  refill();

  let dispatched = false;
  while (queue.length > 0) {
    const item = queue[0];
    if (tokens >= item.bytes) {
      tokens -= item.bytes;
      queue.shift();
      item.resolve();
      dispatched = true;
    } else {
      break;
    }
  }

  if (queue.length > 0 && !scheduled) {
    // Wait enough time to accumulate tokens for the next item
    const wait = Math.max(10, ((queue[0].bytes - tokens) / maxBps) * 1000);
    scheduled = true;
    setTimeout(drain, wait);
  }
}

export function setLimit(mbps) {
  maxBps = mbps > 0 ? mbps * 1024 * 1024 : 0;
  tokens = maxBps;
  lastRefill = Date.now();
}

export function getLimit() { return maxBps; }

export function consume(bytes) {
  if (maxBps <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    queue.push({ bytes, resolve });
    if (!scheduled) drain();
  });
}
