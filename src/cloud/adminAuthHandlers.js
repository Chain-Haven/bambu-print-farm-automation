import bcrypt from 'bcryptjs';
import { parseJsonBody } from './agentProtocol.js';
import {
    AdminAuthError,
    DEFAULT_SUPER_ADMIN_EMAILS,
    authenticateCloudAdmin,
    buildAdminPasswordResetRecord,
    buildAdminSessionRecord,
    generateAdminPasswordResetToken,
    generateAdminSessionToken,
    hashAdminSecret,
    normalizeAdminEmail,
} from './adminAuth.js';

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function sendJson(res, statusCode, payload) {
    if (typeof res.status === 'function' && typeof res.json === 'function') {
        return res.status(statusCode).json(payload);
    }

    res.statusCode = statusCode;
    if (typeof res.setHeader === 'function') {
        res.setHeader('Content-Type', 'application/json');
    }
    return res.end(JSON.stringify(payload));
}

function methodNotAllowed(res, methods) {
    if (typeof res.setHeader === 'function') {
        res.setHeader('Allow', methods);
    }
    return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value, name) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${name} is required`);
    }
    return value.trim();
}

function redactAdmin(adminUser) {
    if (!adminUser) return null;
    const {
        admin_user_id,
        email,
        role,
        status,
        last_login_at,
        created_at,
        updated_at,
    } = adminUser;

    return {
        admin_user_id,
        email,
        role,
        status,
        last_login_at,
        created_at,
        updated_at,
    };
}

function handleAdminAuthError(res, error) {
    if (error instanceof AdminAuthError) {
        return sendJson(res, error.statusCode, { ok: false, error: error.code });
    }
    return null;
}

function normalizeAppBaseUrl(value, req) {
    const host = typeof req?.headers?.host === 'string' ? req.headers.host.trim() : '';
    const inferred = host ? `https://${host}` : '';
    const base = value || process.env.APP_BASE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : inferred);
    return requiredString(base, 'app_base_url').replace(/\/+$/, '');
}

async function requireAdminContext(req, res, { store, bootstrapToken, pepper, now }) {
    try {
        return await authenticateCloudAdmin(req, { store, bootstrapToken, pepper, now });
    } catch (error) {
        handleAdminAuthError(res, error);
        return null;
    }
}

async function issuePasswordReset({
    store,
    adminUser,
    pepper,
    now,
    resetTokenFactory,
}) {
    if (!pepper) throw new Error('admin secret pepper is required');

    const issuedAt = now();
    const expiresAt = new Date(issuedAt.getTime() + RESET_TOKEN_TTL_MS).toISOString();
    const rawToken = resetTokenFactory();
    const reset = buildAdminPasswordResetRecord({
        adminUser,
        rawToken,
        pepper,
        expiresAt,
    });
    await store.createAdminPasswordResetToken(reset.record);

    return {
        secret: reset.secret,
        expires_at: expiresAt,
    };
}

function buildResetLink(appBaseUrl, resetToken) {
    return `${appBaseUrl}/admin-reset?token=${encodeURIComponent(resetToken)}`;
}

export function createCloudAdminBootstrapHandler({
    store,
    bootstrapToken = process.env.CLOUD_ADMIN_TOKEN,
    pepper = process.env.ADMIN_SESSION_PEPPER || process.env.NODE_TOKEN_PEPPER,
    now = () => new Date(),
    resetTokenFactory = generateAdminPasswordResetToken,
    appBaseUrl = null,
} = {}) {
    if (!store) throw new Error('store is required');

    return async function cloudAdminBootstrapHandler(req, res) {
        if (req.method && req.method !== 'POST') {
            return methodNotAllowed(res, 'POST');
        }

        try {
            const context = await requireAdminContext(req, res, { store, bootstrapToken, pepper, now });
            if (!context) return null;

            const body = parseJsonBody(req.body);
            const shouldIssueResetTokens = isPlainObject(body) && body.issue_reset_tokens === true;
            const baseUrl = shouldIssueResetTokens ? normalizeAppBaseUrl(appBaseUrl, req) : null;
            const admins = [];
            const resetLinks = [];

            for (const email of DEFAULT_SUPER_ADMIN_EMAILS) {
                const admin = await store.upsertPlatformAdminUser({
                    email,
                    role: 'super_admin',
                    status: 'active',
                });
                admins.push(redactAdmin(admin));

                if (shouldIssueResetTokens) {
                    const reset = await issuePasswordReset({
                        store,
                        adminUser: admin,
                        pepper,
                        now,
                        resetTokenFactory,
                    });
                    resetLinks.push({
                        email: admin.email,
                        reset_token: reset.secret,
                        reset_url: buildResetLink(baseUrl, reset.secret),
                        expires_at: reset.expires_at,
                    });
                }
            }

            return sendJson(res, 200, {
                ok: true,
                admins,
                reset_links: resetLinks,
            });
        } catch (error) {
            return sendJson(res, 400, {
                ok: false,
                error: 'admin_bootstrap_failed',
                message: error.message,
            });
        }
    };
}

export function createCloudAdminPasswordResetHandler({
    store,
    bootstrapToken = process.env.CLOUD_ADMIN_TOKEN,
    pepper = process.env.ADMIN_SESSION_PEPPER || process.env.NODE_TOKEN_PEPPER,
    now = () => new Date(),
    resetTokenFactory = generateAdminPasswordResetToken,
    appBaseUrl = null,
} = {}) {
    if (!store) throw new Error('store is required');

    return async function cloudAdminPasswordResetHandler(req, res) {
        if (req.method && req.method !== 'POST') {
            return methodNotAllowed(res, 'POST');
        }

        try {
            const context = await requireAdminContext(req, res, { store, bootstrapToken, pepper, now });
            if (!context) return null;

            const body = parseJsonBody(req.body);
            const email = normalizeAdminEmail(body.email);
            const admin = await store.findPlatformAdminByEmail(email);
            if (!admin) {
                return sendJson(res, 404, { ok: false, error: 'admin_not_found' });
            }
            if (admin.status !== 'active') {
                return sendJson(res, 403, { ok: false, error: 'admin_not_active' });
            }

            const reset = await issuePasswordReset({
                store,
                adminUser: admin,
                pepper,
                now,
                resetTokenFactory,
            });
            const baseUrl = normalizeAppBaseUrl(appBaseUrl, req);

            return sendJson(res, 201, {
                ok: true,
                admin: redactAdmin(admin),
                reset_token: reset.secret,
                reset_url: buildResetLink(baseUrl, reset.secret),
                expires_at: reset.expires_at,
            });
        } catch (error) {
            return sendJson(res, 400, {
                ok: false,
                error: 'admin_password_reset_failed',
                message: error.message,
            });
        }
    };
}

export function createCloudAdminSetPasswordHandler({
    store,
    pepper = process.env.ADMIN_SESSION_PEPPER || process.env.NODE_TOKEN_PEPPER,
    bcryptCost = 12,
    now = () => new Date(),
} = {}) {
    if (!store) throw new Error('store is required');

    return async function cloudAdminSetPasswordHandler(req, res) {
        if (req.method && req.method !== 'POST') {
            return methodNotAllowed(res, 'POST');
        }

        try {
            if (!pepper) throw new Error('admin secret pepper is required');
            const body = parseJsonBody(req.body);
            const resetToken = requiredString(body.reset_token, 'reset_token');
            const password = requiredString(body.password, 'password');
            if (password.length < 12) throw new Error('password must be at least 12 characters');

            const computedHash = hashAdminSecret(resetToken, pepper);
            const reset = await store.findAdminPasswordResetTokenByHash(computedHash);
            if (!reset || reset.token_hash !== computedHash) {
                return sendJson(res, 401, { ok: false, error: 'invalid_reset_token' });
            }
            if (reset.used_at) {
                return sendJson(res, 401, { ok: false, error: 'reset_token_used' });
            }
            if (reset.expires_at && new Date(reset.expires_at).getTime() <= now().getTime()) {
                return sendJson(res, 401, { ok: false, error: 'reset_token_expired' });
            }

            const admin = await store.findPlatformAdminById(reset.admin_user_id);
            if (!admin || admin.status !== 'active') {
                return sendJson(res, 403, { ok: false, error: 'admin_not_active' });
            }

            const passwordHash = await bcrypt.hash(password, bcryptCost);
            const updated = await store.updatePlatformAdminPassword(admin.admin_user_id, passwordHash);
            const usedAt = now().toISOString();
            await store.markAdminPasswordResetTokenUsed(reset.reset_token_id, usedAt);
            if (typeof store.revokeAdminSessions === 'function') {
                await store.revokeAdminSessions(admin.admin_user_id, usedAt);
            }

            return sendJson(res, 200, {
                ok: true,
                admin: redactAdmin(updated || admin),
            });
        } catch (error) {
            return sendJson(res, 400, {
                ok: false,
                error: 'admin_set_password_failed',
                message: error.message,
            });
        }
    };
}

export function createCloudAdminLoginHandler({
    store,
    pepper = process.env.ADMIN_SESSION_PEPPER || process.env.NODE_TOKEN_PEPPER,
    sessionTokenFactory = generateAdminSessionToken,
    bcryptCompare = bcrypt.compare,
    now = () => new Date(),
} = {}) {
    if (!store) throw new Error('store is required');

    return async function cloudAdminLoginHandler(req, res) {
        if (req.method && req.method !== 'POST') {
            return methodNotAllowed(res, 'POST');
        }

        try {
            if (!pepper) throw new Error('admin secret pepper is required');
            const body = parseJsonBody(req.body);
            const email = normalizeAdminEmail(body.email);
            const password = requiredString(body.password, 'password');
            const admin = await store.findPlatformAdminByEmail(email);

            if (!admin || admin.status !== 'active' || !admin.password_hash) {
                return sendJson(res, 401, { ok: false, error: 'invalid_admin_credentials' });
            }
            const passwordOk = await bcryptCompare(password, admin.password_hash);
            if (!passwordOk) {
                return sendJson(res, 401, { ok: false, error: 'invalid_admin_credentials' });
            }

            const issuedAt = now();
            const expiresAt = new Date(issuedAt.getTime() + SESSION_TTL_MS).toISOString();
            const rawToken = sessionTokenFactory();
            const session = buildAdminSessionRecord({
                adminUser: admin,
                rawToken,
                pepper,
                expiresAt,
            });
            const record = await store.createAdminSession(session.record);
            const loggedInAt = issuedAt.toISOString();
            if (typeof store.updatePlatformAdminLastLogin === 'function') {
                await store.updatePlatformAdminLastLogin(admin.admin_user_id, loggedInAt);
            }

            return sendJson(res, 200, {
                ok: true,
                admin: redactAdmin({ ...admin, last_login_at: loggedInAt }),
                admin_session_token: session.secret,
                session: {
                    session_id: record?.session_id,
                    token_prefix: record?.token_prefix || session.record.token_prefix,
                    expires_at: record?.expires_at || expiresAt,
                },
            });
        } catch (error) {
            return sendJson(res, 400, {
                ok: false,
                error: 'admin_login_failed',
                message: error.message,
            });
        }
    };
}

export function createCloudAdminMeHandler({
    store,
    bootstrapToken = process.env.CLOUD_ADMIN_TOKEN,
    pepper = process.env.ADMIN_SESSION_PEPPER || process.env.NODE_TOKEN_PEPPER,
    now = () => new Date(),
} = {}) {
    if (!store) throw new Error('store is required');

    return async function cloudAdminMeHandler(req, res) {
        if (req.method && req.method !== 'GET') {
            return methodNotAllowed(res, 'GET');
        }

        try {
            const context = await requireAdminContext(req, res, { store, bootstrapToken, pepper, now });
            if (!context) return null;

            return sendJson(res, 200, {
                ok: true,
                auth_type: context.type,
                admin: redactAdmin(context.adminUser),
            });
        } catch (error) {
            return sendJson(res, 400, {
                ok: false,
                error: 'admin_me_failed',
                message: error.message,
            });
        }
    };
}
