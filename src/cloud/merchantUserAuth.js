import { createHash, randomBytes as defaultRandomBytes, timingSafeEqual } from 'node:crypto';

// Human sign-in for merchants (portal sessions + password resets). Mirrors the
// platform admin auth scheme: passwords are bcrypt-hashed by the handlers,
// while the high-entropy session/reset tokens below use peppered sha256.
// Machine credentials (pkx_live_ API keys, pkx_setup_ tokens) stay in
// merchantAuth.js — this module is only for people signing in with a password.

export const MERCHANT_USER_SESSION_PREFIX = 'pkx_muser_session_';
export const MERCHANT_USER_RESET_PREFIX = 'pkx_muser_reset_';

export class MerchantUserAuthError extends Error {
    constructor(statusCode, code, message = code) {
        super(message);
        this.name = 'MerchantUserAuthError';
        this.statusCode = statusCode;
        this.code = code;
    }
}

export function normalizeMerchantUserEmail(value) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error('email is required');
    }
    const email = value.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        throw new Error('email must be valid');
    }
    return email;
}

export function getMerchantUserBearerToken(headers = {}) {
    const value = headers.authorization || headers.Authorization;
    if (typeof value !== 'string') return null;

    const match = value.match(/^Bearer\s+(.+)$/i);
    if (!match) return null;

    const token = match[1].trim();
    return token.length > 0 ? token : null;
}

export function isMerchantUserSessionToken(token) {
    return typeof token === 'string' && token.startsWith(MERCHANT_USER_SESSION_PREFIX);
}

export function generateMerchantUserSessionToken({ randomBytes = defaultRandomBytes } = {}) {
    return `${MERCHANT_USER_SESSION_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function generateMerchantUserPasswordResetToken({ randomBytes = defaultRandomBytes } = {}) {
    return `${MERCHANT_USER_RESET_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function hashMerchantUserSecret(secret, pepper) {
    if (!secret || typeof secret !== 'string') {
        throw new Error('merchant user secret is required');
    }
    if (!pepper || typeof pepper !== 'string') {
        throw new Error('merchant user secret pepper is required');
    }

    return createHash('sha256').update(`${pepper}:${secret}`, 'utf8').digest('hex');
}

export function merchantUserSecretHashesMatch(receivedHash, expectedHash) {
    if (typeof receivedHash !== 'string' || typeof expectedHash !== 'string') return false;

    const received = Buffer.from(receivedHash);
    const expected = Buffer.from(expectedHash);
    if (received.length !== expected.length) return false;

    return timingSafeEqual(received, expected);
}

export function buildMerchantUserSessionRecord({ merchantUser, rawToken, pepper, expiresAt }) {
    if (!merchantUser?.merchant_user_id || !merchantUser?.merchant_id) {
        throw new Error('merchant user is required');
    }

    return {
        secret: rawToken,
        record: {
            merchant_user_id: merchantUser.merchant_user_id,
            merchant_id: merchantUser.merchant_id,
            token_prefix: rawToken.slice(0, 26),
            token_hash: hashMerchantUserSecret(rawToken, pepper),
            expires_at: expiresAt,
        },
    };
}

export function buildMerchantUserPasswordResetRecord({ merchantUser, rawToken, pepper, expiresAt }) {
    if (!merchantUser?.merchant_user_id) {
        throw new Error('merchant user is required');
    }

    return {
        secret: rawToken,
        record: {
            merchant_user_id: merchantUser.merchant_user_id,
            token_prefix: rawToken.slice(0, 24),
            token_hash: hashMerchantUserSecret(rawToken, pepper),
            expires_at: expiresAt,
        },
    };
}

// Authenticates a merchant portal session token. The merchant itself may still
// be pending approval or suspended — sign-in stays available so owners can see
// their account status; endpoints that act on the farm must additionally check
// merchant.status === 'active'.
export async function authenticateMerchantUser(req, {
    store,
    pepper,
    now = () => new Date(),
} = {}) {
    if (!store) throw new Error('store is required');
    if (!pepper) throw new Error('merchant user secret pepper is required');

    const rawToken = getMerchantUserBearerToken(req.headers || {});
    if (!rawToken) {
        throw new MerchantUserAuthError(401, 'missing_session_token');
    }

    const computedHash = hashMerchantUserSecret(rawToken, pepper);
    const session = await store.findMerchantUserSessionByHash(computedHash);
    if (!session || !merchantUserSecretHashesMatch(session.token_hash, computedHash)) {
        throw new MerchantUserAuthError(401, 'invalid_session_token');
    }
    if (session.revoked_at) {
        throw new MerchantUserAuthError(401, 'session_revoked');
    }
    if (session.expires_at && new Date(session.expires_at).getTime() <= now().getTime()) {
        throw new MerchantUserAuthError(401, 'session_expired');
    }

    const merchantUser = await store.findMerchantUserById(session.merchant_user_id);
    if (!merchantUser || merchantUser.status !== 'active') {
        throw new MerchantUserAuthError(403, 'merchant_user_not_active');
    }

    const merchant = await store.findMerchantById(merchantUser.merchant_id);
    if (!merchant) {
        throw new MerchantUserAuthError(403, 'merchant_not_found');
    }

    if (typeof store.touchMerchantUserSession === 'function') {
        try {
            await store.touchMerchantUserSession(session.session_id, now().toISOString());
        } catch {
            /* best-effort last-used tracking */
        }
    }

    return { merchantUser, merchant, session };
}
