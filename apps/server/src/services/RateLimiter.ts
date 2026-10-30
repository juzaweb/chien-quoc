import type { RequestHandler } from 'express';

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Minimal fixed-window rate limiter for the unauthenticated auth endpoints.
 *
 * Two things need it: password guessing, and scrypt being deliberately
 * expensive, which makes `/auth/login` a cheap CPU-exhaustion vector.
 *
 * State is per-process and in memory. That is enough for a single game server;
 * a multi-process deployment needs a shared store instead.
 */
export function createRateLimit(options: {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}): RequestHandler {
  const buckets = new Map<string, Bucket>();
  let lastSweep = Date.now();

  /** Drops expired buckets so the map cannot grow without bound. */
  const sweep = (now: number) => {
    if (now - lastSweep < options.windowMs) return;
    lastSweep = now;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  };

  return (req, res, next) => {
    const now = Date.now();
    sweep(now);

    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    bucket.count += 1;
    if (bucket.count > options.limit) {
      const retryAfterSeconds = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({ error: 'Quá nhiều lần thử. Vui lòng đợi rồi thử lại.' });
      return;
    }

    next();
  };
}
