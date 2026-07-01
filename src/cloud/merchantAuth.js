import { createHash, randomBytes as defaultRandomBytes, timingSafeEqual } from 'node:crypto';
import { createRpmLimiter } from '../utils/rateLimiter.js';

// Per-API-key rate limit for the public merchant API. Configurable via
// MERCHANT_RATE_LIMIT_RPM (set <= 0 to disable). Best-effort per-instance on
// serverless; exact on a long-running node.
const MERCHANT_RATE_LIMIT_RPM = Number.parseInt(process.env.MERCHANT_RATE_LIMIT_RPM || '240', 10);
const defaultMerchantRateLimiter = MERCHANT_RATE_LIMIT_RPM > 0 ? createRpmLimiter(MERCHANT_RATE_LIMIT_RPM) : null;

export class MerchantAuthError extends Error {
    constructor(statusCode, code, message = code) {
        super(message);
        this.name = 'MerchantAuthError';
        this.statusCode = statusCode;
        this.code = code;
    }
}

export function getMerchantBearerToken(headers = {}) {
    const value = headers.authorization || headers.Authorization;
    if (typeof value !== 'string') return null;

    const match = value.match(/^Bearer\s+(.+)$/i);
    if (!match) return null;

    const token = match[1].trim();
    return token.length > 0 ? token : null;
}

export function getMerchantSetupToken(headers = {}) {
    const value = headers['x-merchant-setup-token'] || headers['X-Merchant-Setup-Token'];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function generateMerchantApiKey({ randomBytes = defaultRandomBytes } = {}) {
    return `pkx_live_${randomBytes(32).toString('base64url')}`;
}

export function generateMerchantSetupToken({ randomBytes = defaultRandomBytes } = {}) {
    return `pkx_setup_${randomBytes(32).toString('base64url')}`;
}

export function hashMerchantApiKey(token, pepper) {
    if (!token || typeof token !== 'string') {
        throw new Error('merchant api key is required');
    }
    if (!pepper || typeof pepper !== 'string') {
        throw new Error('merchant api key pepper is required');
    }

    return createHash('sha256').update(`${pepper}:${token}`, 'utf8').digest('hex');
}

export function merchantKeyHashesMatch(receivedHash, expectedHash) {
    if (typeof receivedHash !== 'string' || typeof expectedHash !== 'string') return false;

    const received = Buffer.from(receivedHash);
    const expected = Buffer.from(expectedHash);
    if (received.length !== expected.length) return false;

    return timingSafeEqual(received, expected);
}

export function buildMerchantApiKeyRecord({ merchant, name, rawKey, pepper }) {
    if (!merchant?.merchant_id || !merchant?.org_id) {
        throw new Error('active merchant is required');
    }
    if (typeof name !== 'string' || name.trim() === '') {
        throw new Error('key name is required');
    }

    return {
        secret: rawKey,
        record: {
            merchant_id: merchant.merchant_id,
            org_id: merchant.org_id,
            name: name.trim(),
            key_prefix: rawKey.slice(0, 18),
            key_hash: hashMerchantApiKey(rawKey, pepper),
        },
    };
}

export function buildMerchantSetupTokenRecord({ merchant, rawToken, pepper, expiresAt }) {
    if (!merchant?.merchant_id || !merchant?.org_id) {
        throw new Error('active merchant is required');
    }

    return {
        secret: rawToken,
        record: {
            merchant_id: merchant.merchant_id,
            org_id: merchant.org_id,
            token_prefix: rawToken.slice(0, 20),
            token_hash: hashMerchantApiKey(rawToken, pepper),
            expires_at: expiresAt,
        },
    };
}

export async function authenticateMerchantRequest(req, {
    store,
    pepper,
    now = () => new Date(),
    rateLimiter = defaultMerchantRateLimiter,
} = {}) {
    if (!store) throw new Error('store is required');
    if (!pepper) throw new Error('merchant api key pepper is required');

    const rawToken = getMerchantBearerToken(req.headers || {});
    if (!rawToken) {
        throw new MerchantAuthError(401, 'missing_api_key');
    }

    const computedHash = hashMerchantApiKey(rawToken, pepper);
    const apiKey = await store.findMerchantApiKeyByHash(computedHash);
    if (!apiKey || !merchantKeyHashesMatch(apiKey.key_hash, computedHash)) {
        throw new MerchantAuthError(401, 'invalid_api_key');
    }

    const merchant = await store.findMerchantById(apiKey.merchant_id);
    if (!merchant || merchant.status !== 'active') {
        throw new MerchantAuthError(403, 'merchant_not_active');
    }
    if (merchant.org_id !== apiKey.org_id) {
        throw new MerchantAuthError(403, 'merchant_key_scope_mismatch');
    }

    // Per-key rate limit, checked only after the key is validated so bad tokens
    // cannot exhaust a real key's bucket.
    if (rateLimiter) {
        const verdict = rateLimiter.check(apiKey.key_id);
        if (!verdict.allowed) {
            const error = new MerchantAuthError(429, 'rate_limited');
            error.retryAfterMs = verdict.retryAfterMs;
            throw error;
        }
    }

    if (typeof store.touchMerchantApiKey === 'function') {
        // Best-effort last-used tracking: a transient failure here must not reject
        // an otherwise-valid authenticated request (this runs in the hot path of
        // every merchant API call).
        try {
            await store.touchMerchantApiKey(apiKey.key_id, now().toISOString());
        } catch {
            /* ignore last-used update failures */
        }
    }

    return { merchant, apiKey };
}

export async function authenticateMerchantSetupToken(req, {
    store,
    pepper,
    now = () => new Date(),
} = {}) {
    if (!store) throw new Error('store is required');
    if (!pepper) throw new Error('merchant api key pepper is required');

    const rawToken = getMerchantSetupToken(req.headers || {});
    if (!rawToken) {
        throw new MerchantAuthError(401, 'missing_setup_token');
    }

    const computedHash = hashMerchantApiKey(rawToken, pepper);
    const setupToken = await store.findMerchantSetupTokenByHash(computedHash);
    if (!setupToken || !merchantKeyHashesMatch(setupToken.token_hash, computedHash)) {
        throw new MerchantAuthError(401, 'invalid_setup_token');
    }
    if (setupToken.used_at) {
        throw new MerchantAuthError(401, 'setup_token_used');
    }
    if (setupToken.expires_at && new Date(setupToken.expires_at).getTime() <= now().getTime()) {
        throw new MerchantAuthError(401, 'setup_token_expired');
    }

    const merchant = await store.findMerchantById(setupToken.merchant_id);
    if (!merchant || merchant.status !== 'active') {
        throw new MerchantAuthError(403, 'merchant_not_active');
    }
    if (merchant.org_id !== setupToken.org_id) {
        throw new MerchantAuthError(403, 'merchant_setup_scope_mismatch');
    }

    return { merchant, setupToken };
}
