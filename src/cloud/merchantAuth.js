import { createHash, randomBytes as defaultRandomBytes, timingSafeEqual } from 'node:crypto';

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

export function generateMerchantApiKey({ randomBytes = defaultRandomBytes } = {}) {
    return `pkx_live_${randomBytes(32).toString('base64url')}`;
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

export async function authenticateMerchantRequest(req, {
    store,
    pepper,
    now = () => new Date(),
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

    if (typeof store.touchMerchantApiKey === 'function') {
        await store.touchMerchantApiKey(apiKey.key_id, now().toISOString());
    }

    return { merchant, apiKey };
}
