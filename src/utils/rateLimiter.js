// src/utils/rateLimiter.js — dependency-free token-bucket rate limiter.
//
// Deterministic (injectable clock) so it is fully testable. Used to protect the
// public merchant API per API key and available as Express middleware. Note: on
// serverless the bucket state is per-instance (best-effort); a long-running node
// enforces it exactly.

export function createRateLimiter({ capacity = 60, refillPerSec = 1, now = () => Date.now() } = {}) {
    const buckets = new Map();

    function refill(key, t) {
        let bucket = buckets.get(key);
        if (!bucket) {
            bucket = { tokens: capacity, last: t };
            buckets.set(key, bucket);
            return bucket;
        }
        const elapsedSec = Math.max(0, (t - bucket.last) / 1000);
        bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSec);
        bucket.last = t;
        return bucket;
    }

    return {
        /** Attempt to spend `cost` tokens for `key`. */
        check(key, cost = 1) {
            const t = now();
            const bucket = refill(key, t);
            if (bucket.tokens >= cost) {
                bucket.tokens -= cost;
                return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
            }
            const deficit = cost - bucket.tokens;
            return {
                allowed: false,
                remaining: Math.floor(bucket.tokens),
                retryAfterMs: Math.ceil((deficit / refillPerSec) * 1000),
            };
        },
        reset(key) {
            if (key === undefined) buckets.clear();
            else buckets.delete(key);
        },
        size() {
            return buckets.size;
        },
    };
}

// Convenience: a requests-per-minute bucket (burst == rpm, steady refill == rpm/60/s).
export function createRpmLimiter(rpm, opts = {}) {
    const capacity = Math.max(1, Math.floor(rpm));
    return createRateLimiter({ capacity, refillPerSec: capacity / 60, ...opts });
}

// Express middleware factory. Keys by req.ip unless a keyFn is supplied.
export function rateLimitMiddleware({
    rpm = 60,
    keyFn = (req) => req.ip || 'global',
    limiter = createRpmLimiter(rpm),
    code = 'rate_limited',
} = {}) {
    return function rateLimit(req, res, next) {
        const { allowed, retryAfterMs, remaining } = limiter.check(keyFn(req));
        if (typeof res.setHeader === 'function') {
            res.setHeader('X-RateLimit-Remaining', String(Math.max(0, remaining)));
        }
        if (allowed) return next();
        if (typeof res.setHeader === 'function') {
            res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
        }
        return res.status(429).json({ error: code, retry_after_ms: retryAfterMs });
    };
}
