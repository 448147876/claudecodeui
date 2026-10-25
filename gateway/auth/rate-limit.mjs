/**
 * In-memory login throttle (FR-3.8): `maxFails` consecutive failures within
 * `windowMs` lock the key for `lockMs`. Applied per username and per IP.
 */
export function createRateLimiter({ maxFails, lockMs, windowMs = 60_000 }) {
  const entries = new Map();

  const entryFor = (key, now) => {
    let entry = entries.get(key);
    if (!entry || (entry.lockedUntil <= now && now - entry.firstFailAt > windowMs)) {
      entry = { fails: 0, firstFailAt: now, lockedUntil: 0 };
      entries.set(key, entry);
    }
    return entry;
  };

  return {
    /** Milliseconds left on the lock for any of the keys, or 0. */
    lockedFor(keys, now = Date.now()) {
      let longest = 0;
      for (const key of keys) {
        const entry = entries.get(key);
        if (entry && entry.lockedUntil > now) longest = Math.max(longest, entry.lockedUntil - now);
      }
      return longest;
    },

    recordFailure(keys, now = Date.now()) {
      for (const key of keys) {
        const entry = entryFor(key, now);
        if (entry.lockedUntil > now) continue;
        if (entry.lockedUntil && entry.lockedUntil <= now) {
          entry.fails = 0;
          entry.firstFailAt = now;
          entry.lockedUntil = 0;
        }
        entry.fails += 1;
        if (entry.fails >= maxFails) entry.lockedUntil = now + lockMs;
      }
    },

    recordSuccess(keys) {
      for (const key of keys) entries.delete(key);
    },
  };
}
