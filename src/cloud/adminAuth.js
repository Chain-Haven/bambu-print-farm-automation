import { createHash, randomBytes as defaultRandomBytes, timingSafeEqual } from 'node:crypto';

export const DEFAULT_SUPER_ADMIN_EMAILS = [
    'info@chainhaven.co',
    'ianmebert@gmail.com',
];

export class AdminAuthError extends Error {
    constructor(statusCode, code, message = code) {
        super(message);
        this.name = 'AdminAuthError';
        this.statusCode = statusCode;
        this.code = code;
    }
}

export function normalizeAdminEmail(value) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error('admin email is required');
    }
    const email = value.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        throw new Error('admin email must be valid');
    }
    return email;
}

export function getAdminBearerToken(headers = {}) {
    const direct = headers['x-cloud-admin-token'] || headers['X-Cloud-Admin-Token'];
    if (typeof direct === 'string' && direct.trim()) return direct.trim();

    const authorization = headers.authorization || headers.Authorization;
    if (typeof authorization !== 'string') return null;

    const match = authorization.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : null;
}

export function generateAdminPasswordResetToken({ randomBytes = defaultRandomBytes } = {}) {
    return `pkx_admin_reset_${randomBytes(32).toString('base64url')}`;
}

export function generateAdminSessionToken({ randomBytes = defaultRandomBytes } = {}) {
    return `pkx_admin_session_${randomBytes(32).toString('base64url')}`;
}

export function hashAdminSecret(secret, pepper) {
    if (!secret || typeof secret !== 'string') {
        throw new Error('admin secret is required');
    }
    if (!pepper || typeof pepper !== 'string') {
        throw new Error('admin secret pepper is required');
    }

    return createHash('sha256').update(`${pepper}:${secret}`, 'utf8').digest('hex');
}

export function adminSecretHashesMatch(receivedHash, expectedHash) {
    if (typeof receivedHash !== 'string' || typeof expectedHash !== 'string') return false;

    const received = Buffer.from(receivedHash);
    const expected = Buffer.from(expectedHash);
    if (received.length !== expected.length) return false;

    return timingSafeEqual(received, expected);
}

function rawTokensMatch(received, expected) {
    if (!received || !expected) return false;

    const receivedBytes = Buffer.from(received);
    const expectedBytes = Buffer.from(expected);
    if (receivedBytes.length !== expectedBytes.length) return false;

    return timingSafeEqual(receivedBytes, expectedBytes);
}

export function buildAdminPasswordResetRecord({ adminUser, rawToken, pepper, expiresAt }) {
    if (!adminUser?.admin_user_id) {
        throw new Error('admin user is required');
    }

    return {
        secret: rawToken,
        record: {
            admin_user_id: adminUser.admin_user_id,
            token_prefix: rawToken.slice(0, 24),
            token_hash: hashAdminSecret(rawToken, pepper),
            expires_at: expiresAt,
        },
    };
}

export function buildAdminSessionRecord({ adminUser, rawToken, pepper, expiresAt }) {
    if (!adminUser?.admin_user_id) {
        throw new Error('admin user is required');
    }

    return {
        secret: rawToken,
        record: {
            admin_user_id: adminUser.admin_user_id,
            token_prefix: rawToken.slice(0, 26),
            token_hash: hashAdminSecret(rawToken, pepper),
            expires_at: expiresAt,
        },
    };
}

function isAdminRole(role) {
    return role === 'super_admin' || role === 'admin';
}

export async function authenticateCloudAdmin(req, {
    store,
    bootstrapToken = process.env.CLOUD_ADMIN_TOKEN,
    pepper = process.env.ADMIN_SESSION_PEPPER || process.env.NODE_TOKEN_PEPPER,
    now = () => new Date(),
} = {}) {
    const rawToken = getAdminBearerToken(req.headers || {});
    if (!rawToken) {
        throw new AdminAuthError(401, 'missing_admin_token');
    }

    if (bootstrapToken && rawTokensMatch(rawToken, bootstrapToken)) {
        return {
            type: 'bootstrap',
            adminUser: {
                admin_user_id: 'bootstrap',
                email: 'bootstrap',
                role: 'super_admin',
                status: 'active',
            },
        };
    }

    if (!store || typeof store.findAdminSessionByHash !== 'function' || !pepper) {
        throw new AdminAuthError(403, 'invalid_admin_token');
    }

    const computedHash = hashAdminSecret(rawToken, pepper);
    const session = await store.findAdminSessionByHash(computedHash);
    if (!session || !adminSecretHashesMatch(session.token_hash, computedHash)) {
        throw new AdminAuthError(403, 'invalid_admin_token');
    }
    if (session.revoked_at) {
        throw new AdminAuthError(401, 'admin_session_revoked');
    }
    if (session.expires_at && new Date(session.expires_at).getTime() <= now().getTime()) {
        throw new AdminAuthError(401, 'admin_session_expired');
    }

    const adminUser = await store.findPlatformAdminById(session.admin_user_id);
    if (!adminUser || adminUser.status !== 'active') {
        throw new AdminAuthError(403, 'admin_not_active');
    }
    if (!isAdminRole(adminUser.role)) {
        throw new AdminAuthError(403, 'admin_not_authorized');
    }

    if (typeof store.touchAdminSession === 'function') {
        await store.touchAdminSession(session.session_id, now().toISOString());
    }

    return { type: 'session', adminUser, session };
}
