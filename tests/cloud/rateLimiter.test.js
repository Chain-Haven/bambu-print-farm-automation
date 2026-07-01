import { describe, expect, it, vi } from 'vitest';
import { createRateLimiter, createRpmLimiter, rateLimitMiddleware } from '../../src/utils/rateLimiter.js';
import { MerchantAuthError, authenticateMerchantRequest, hashMerchantApiKey } from '../../src/cloud/merchantAuth.js';

describe('token-bucket rate limiter', () => {
    it('allows up to capacity then denies with a retry hint', () => {
        let t = 0;
        const limiter = createRateLimiter({ capacity: 3, refillPerSec: 1, now: () => t });
        expect(limiter.check('k').allowed).toBe(true);
        expect(limiter.check('k').allowed).toBe(true);
        expect(limiter.check('k').allowed).toBe(true);
        const denied = limiter.check('k');
        expect(denied.allowed).toBe(false);
        expect(denied.retryAfterMs).toBeGreaterThan(0);
    });

    it('refills over time', () => {
        let t = 0;
        const limiter = createRateLimiter({ capacity: 1, refillPerSec: 1, now: () => t });
        expect(limiter.check('k').allowed).toBe(true);
        expect(limiter.check('k').allowed).toBe(false);
        t = 1000; // one second later -> one token back
        expect(limiter.check('k').allowed).toBe(true);
    });

    it('keys are independent', () => {
        const limiter = createRateLimiter({ capacity: 1, refillPerSec: 0, now: () => 0 });
        expect(limiter.check('a').allowed).toBe(true);
        expect(limiter.check('b').allowed).toBe(true); // different key, fresh bucket
        expect(limiter.check('a').allowed).toBe(false);
    });

    it('middleware returns 429 with Retry-After when over the limit', () => {
        const limiter = createRateLimiter({ capacity: 1, refillPerSec: 0, now: () => 0 });
        const mw = rateLimitMiddleware({ limiter, keyFn: () => 'x' });
        const makeRes = () => {
            const res = { headers: {}, statusCode: 200 };
            res.setHeader = (k, v) => { res.headers[k] = v; };
            res.status = (code) => { res.statusCode = code; return res; };
            res.json = (body) => { res.body = body; return res; };
            return res;
        };
        const next = vi.fn();

        const res1 = makeRes();
        mw({ ip: '1.2.3.4' }, res1, next);
        expect(next).toHaveBeenCalledTimes(1);

        const res2 = makeRes();
        mw({ ip: '1.2.3.4' }, res2, next);
        expect(next).toHaveBeenCalledTimes(1); // not called again
        expect(res2.statusCode).toBe(429);
        expect(res2.body.error).toBe('rate_limited');
        expect(res2.headers['Retry-After']).toBeDefined();
    });
});

describe('merchant API per-key rate limiting', () => {
    function makeStore() {
        return {
            findMerchantApiKeyByHash: vi.fn().mockResolvedValue({
                key_id: 'key-1',
                merchant_id: 'merchant-1',
                org_id: 'org-1',
                key_hash: hashMerchantApiKey('pkx_live_secret', 'pepper'),
            }),
            findMerchantById: vi.fn().mockResolvedValue({
                merchant_id: 'merchant-1', org_id: 'org-1', status: 'active',
            }),
            touchMerchantApiKey: vi.fn(),
        };
    }

    const req = { headers: { authorization: 'Bearer pkx_live_secret' } };

    it('rejects with 429 once a key exceeds its bucket', async () => {
        const store = makeStore();
        // capacity 1, no refill -> second authenticated call is limited.
        const rateLimiter = createRateLimiter({ capacity: 1, refillPerSec: 0, now: () => 0 });
        const opts = { store, pepper: 'pepper', rateLimiter };

        await expect(authenticateMerchantRequest(req, opts)).resolves.toBeTruthy();
        await expect(authenticateMerchantRequest(req, opts)).rejects.toMatchObject({
            name: 'MerchantAuthError',
            statusCode: 429,
            code: 'rate_limited',
        });
    });

    it('does not consume the bucket for invalid keys', async () => {
        const store = {
            findMerchantApiKeyByHash: vi.fn().mockResolvedValue(null),
        };
        const rateLimiter = createRateLimiter({ capacity: 1, refillPerSec: 0, now: () => 0 });
        await expect(authenticateMerchantRequest(req, { store, pepper: 'pepper', rateLimiter }))
            .rejects.toBeInstanceOf(MerchantAuthError);
        // Bucket untouched: a valid key still gets its full allowance.
        expect(rateLimiter.check('key-1').allowed).toBe(true);
    });
});
