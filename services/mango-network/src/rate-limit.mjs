const positiveInteger = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
  return value;
};

/**
 * In-memory fixed-window limiter. Keys should combine the client IP and a
 * normalized route pattern; callers must not use raw, attacker-controlled URLs.
 */
export function createRateLimiter({ limit = 60, windowMs = 60_000, clock = () => Date.now(), maxKeys = 10_000 } = {}) {
  positiveInteger(limit, 'limit');
  positiveInteger(windowMs, 'windowMs');
  positiveInteger(maxKeys, 'maxKeys');
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');

  const entries = new Map();

  function prune(now) {
    for (const [key, entry] of entries) {
      if (entry.resetAt <= now) entries.delete(key);
    }
    while (entries.size >= maxKeys) entries.delete(entries.keys().next().value);
  }

  return Object.freeze({
    consume(key) {
      if (typeof key !== 'string' || !key) throw new TypeError('rate-limit key must be a non-empty string');
      const now = clock();
      let entry = entries.get(key);
      if (!entry || entry.resetAt <= now) {
        if (!entry && entries.size >= maxKeys) prune(now);
        entry = { count: 0, resetAt: now + windowMs };
        entries.set(key, entry);
      }
      entry.count += 1;
      const remaining = Math.max(0, limit - entry.count);
      return Object.freeze({
        allowed: entry.count <= limit,
        limit,
        remaining,
        resetAt: entry.resetAt,
        retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
      });
    },
    clear() { entries.clear(); },
    get size() { return entries.size; }
  });
}
