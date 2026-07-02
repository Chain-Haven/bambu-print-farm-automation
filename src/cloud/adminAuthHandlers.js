import bcrypt from 'bcryptjs';
import { parseJsonBody } from './agentProtocol.js';
import { createRpmLimiter } from '../utils/rateLimiter.js';
import { createMailer } from './mailer.js';
import {
    AdminAuthError,
    DEFAULT_SUPER_ADMIN_EMAILS,
    authenticateCloudAdmin,
    buildAdminPasswordResetRecord,
    buildAdminSessionRecord,
    generateAdminPasswordResetToken,
    generateAdminSessionToken,
    getAdminBearerToken,
    hashAdminSecret,
    normalizeAdminEmail,
} from './adminAuth.js';

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 12;

// Best-effort per-email throttle for login / reset requests (exact on a
// long-running node, per-instance on serverless).
const ADMIN_LOGIN_RATE_LIMIT_RPM = Number.parseInt(process.env.ADMIN_LOGIN_RATE_LIMIT_RPM || '10', 10);
const defaultAdminLoginRateLimiter = ADMIN_LOGIN_RATE_LIMIT_RPM > 0
    ? createRpmLimiter(ADMIN_LOGIN_RATE_LIMIT_RPM)
    : null;

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

async function mintAdminSession({ store, adminUser, pepper, now, sessionTokenFactory }) {
    const issuedAt = now();
    const expiresAt = new Date(issuedAt.getTime() + SESSION_TTL_MS).toISOString();
    const rawToken = sessionTokenFactory();
    const session = buildAdminSessionRecord({ adminUser, rawToken, pepper, expiresAt });
    const record = await store.createAdminSession(session.record);

    return {
        secret: session.secret,
        session: {
            session_id: record?.session_id,
            token_prefix: record?.token_prefix || session.record.token_prefix,
            expires_at: record?.expires_at || expiresAt,
        },
    };
}

// Bootstrap runs with the shared CLOUD_ADMIN_TOKEN and covers two flows:
//   - one-shot first-time setup: body {email, password} seeds the default
//     super admins, sets the password for the matching account, and returns a
//     ready-to-use session so the console signs straight in;
//   - legacy: body {issue_reset_tokens:true} returns admin-reset links instead.
export function createCloudAdminBootstrapHandler({
    store,
    bootstrapToken = process.env.CLOUD_ADMIN_TOKEN,
    pepper = process.env.ADMIN_SESSION_PEPPER || process.env.NODE_TOKEN_PEPPER,
    now = () => new Date(),
    resetTokenFactory = generateAdminPasswordResetToken,
    sessionTokenFactory = generateAdminSessionToken,
    bcryptCost = 12,
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
            const wantsAccountSetup = isPlainObject(body)
                && typeof body.email === 'string'
                && typeof body.password === 'string';
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

            if (wantsAccountSetup) {
                if (!pepper) throw new Error('admin secret pepper is required');
                const email = normalizeAdminEmail(body.email);
                const password = body.password;
                if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
                    throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
                }

                const admin = await store.findPlatformAdminByEmail(email);
                if (!admin || admin.status !== 'active') {
                    return sendJson(res, 403, { ok: false, error: 'email_not_authorized' });
                }

                const passwordHash = await bcrypt.hash(password, bcryptCost);
                const updated = await store.updatePlatformAdminPassword(admin.admin_user_id, passwordHash);
                if (typeof store.revokeAdminSessions === 'function') {
                    await store.revokeAdminSessions(admin.admin_user_id, now().toISOString());
                }
                const minted = await mintAdminSession({
                    store,
                    adminUser: updated || admin,
                    pepper,
                    now,
                    sessionTokenFactory,
                });
                if (typeof store.updatePlatformAdminLastLogin === 'function') {
                    await store.updatePlatformAdminLastLogin(admin.admin_user_id, now().toISOString());
                }

                return sendJson(res, 200, {
                    ok: true,
                    admins,
                    admin: redactAdmin(updated || admin),
                    admin_session_token: minted.secret,
                    session: minted.session,
                });
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

// Self-service "forgot password". Anyone may request a reset for an email; the
// public response is identical whether or not the account exists, and the link
// is only delivered by email (or the server log when no mailer is configured).
// An authenticated admin (session or bootstrap token) gets the link back in
// the response body, which the console uses as a support tool.
export function createCloudAdminPasswordResetHandler({
    store,
    bootstrapToken = process.env.CLOUD_ADMIN_TOKEN,
    pepper = process.env.ADMIN_SESSION_PEPPER || process.env.NODE_TOKEN_PEPPER,
    now = () => new Date(),
    resetTokenFactory = generateAdminPasswordResetToken,
    appBaseUrl = null,
    mailer = createMailer(),
    requestRateLimiter = defaultAdminLoginRateLimiter,
} = {}) {
    if (!store) throw new Error('store is required');

    return async function cloudAdminPasswordResetHandler(req, res) {
        if (req.method && req.method !== 'POST') {
            return methodNotAllowed(res, 'POST');
        }

        const generic = {
            ok: true,
            message: 'If that email belongs to an operator account, a password reset link has been sent.',
        };

        try {
            let context = null;
            if (getAdminBearerToken(req.headers || {})) {
                context = await requireAdminContext(req, res, { store, bootstrapToken, pepper, now });
                if (!context) return null;
            }

            const body = parseJsonBody(req.body);
            const email = normalizeAdminEmail(body.email);

            if (!context && requestRateLimiter) {
                const verdict = requestRateLimiter.check(`admin-reset:${email}`);
                if (!verdict.allowed) {
                    return sendJson(res, 429, { ok: false, error: 'rate_limited' });
                }
            }

            const admin = await store.findPlatformAdminByEmail(email);
            if (!admin) {
                if (context) return sendJson(res, 404, { ok: false, error: 'admin_not_found' });
                return sendJson(res, 200, generic);
            }
            if (admin.status !== 'active') {
                if (context) return sendJson(res, 403, { ok: false, error: 'admin_not_active' });
                return sendJson(res, 200, generic);
            }

            const reset = await issuePasswordReset({
                store,
                adminUser: admin,
                pepper,
                now,
                resetTokenFactory,
            });
            const baseUrl = normalizeAppBaseUrl(appBaseUrl, req);
            const resetUrl = buildResetLink(baseUrl, reset.secret);

            let emailSent = false;
            try {
                const outcome = await mailer.send({
                    to: admin.email,
                    subject: 'Reset your PrintKinetix operator password',
                    text: [
                        'A password reset was requested for your PrintKinetix operator account.',
                        '',
                        `Reset your password: ${resetUrl}`,
                        '',
                        'This link expires in 1 hour. If you did not request this, you can ignore this email.',
                    ].join('\n'),
                });
                emailSent = outcome?.sent === true;
            } catch {
                /* best-effort delivery — the public response never reveals the outcome */
            }

            if (context) {
                return sendJson(res, 201, {
                    ok: true,
                    admin: redactAdmin(admin),
                    reset_token: reset.secret,
                    reset_url: resetUrl,
                    expires_at: reset.expires_at,
                    email_sent: emailSent,
                });
            }

            return sendJson(res, 200, generic);
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

            // Consume the one-time token BEFORE writing the password: the
            // store consume is conditional (used_at is null) and returns null
            // when another request already redeemed it, so a double submit
            // cannot set two passwords, and a failure after this point never
            // leaves a still-live token behind.
            const usedAt = now().toISOString();
            const consumed = await store.markAdminPasswordResetTokenUsed(reset.reset_token_id, usedAt);
            if (!consumed) {
                return sendJson(res, 401, { ok: false, error: 'reset_token_used' });
            }

            const passwordHash = await bcrypt.hash(password, bcryptCost);
            const updated = await store.updatePlatformAdminPassword(admin.admin_user_id, passwordHash);
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
    loginRateLimiter = defaultAdminLoginRateLimiter,
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

            if (loginRateLimiter) {
                const verdict = loginRateLimiter.check(`admin-login:${email}`);
                if (!verdict.allowed) {
                    return sendJson(res, 429, { ok: false, error: 'rate_limited' });
                }
            }

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

export function createCloudAdminLogoutHandler({
    store,
    bootstrapToken = process.env.CLOUD_ADMIN_TOKEN,
    pepper = process.env.ADMIN_SESSION_PEPPER || process.env.NODE_TOKEN_PEPPER,
    now = () => new Date(),
} = {}) {
    if (!store) throw new Error('store is required');

    return async function cloudAdminLogoutHandler(req, res) {
        if (req.method && req.method !== 'POST') {
            return methodNotAllowed(res, 'POST');
        }

        try {
            const context = await requireAdminContext(req, res, { store, bootstrapToken, pepper, now });
            if (!context) return null;

            // Bootstrap-token auth has no server-side session to revoke.
            if (context.type === 'session') {
                const body = parseJsonBody(req.body);
                const everywhere = isPlainObject(body) && body.all === true;
                if (everywhere && typeof store.revokeAdminSessions === 'function') {
                    await store.revokeAdminSessions(context.adminUser.admin_user_id, now().toISOString());
                } else if (typeof store.revokeAdminSession === 'function') {
                    await store.revokeAdminSession(context.session.session_id, now().toISOString());
                }
                return sendJson(res, 200, { ok: true, revoked_all: everywhere });
            }

            return sendJson(res, 200, { ok: true, revoked_all: false });
        } catch (error) {
            return sendJson(res, 400, {
                ok: false,
                error: 'admin_logout_failed',
                message: error.message,
            });
        }
    };
}

// Super-admin management of operator accounts: list, create (with an invite
// reset link), disable/enable, and issue reset links for colleagues. The two
// default Chain Haven super admins can never be disabled.
export function createCloudAdminUsersHandler({
    store,
    bootstrapToken = process.env.CLOUD_ADMIN_TOKEN,
    pepper = process.env.ADMIN_SESSION_PEPPER || process.env.NODE_TOKEN_PEPPER,
    now = () => new Date(),
    resetTokenFactory = generateAdminPasswordResetToken,
    appBaseUrl = null,
    mailer = createMailer(),
} = {}) {
    if (!store) throw new Error('store is required');

    async function issueResetLink({ req, admin }) {
        const reset = await issuePasswordReset({
            store,
            adminUser: admin,
            pepper,
            now,
            resetTokenFactory,
        });
        const baseUrl = normalizeAppBaseUrl(appBaseUrl, req);
        const resetUrl = buildResetLink(baseUrl, reset.secret);

        let emailSent = false;
        try {
            const outcome = await mailer.send({
                to: admin.email,
                subject: 'Set your PrintKinetix operator password',
                text: [
                    'An operator account was prepared for you on the PrintKinetix console.',
                    '',
                    `Set your password: ${resetUrl}`,
                    '',
                    'This link expires in 1 hour.',
                ].join('\n'),
            });
            emailSent = outcome?.sent === true;
        } catch {
            /* best-effort delivery */
        }

        return {
            reset_token: reset.secret,
            reset_url: resetUrl,
            expires_at: reset.expires_at,
            email_sent: emailSent,
        };
    }

    return async function cloudAdminUsersHandler(req, res) {
        if (req.method && !['GET', 'POST'].includes(req.method)) {
            return methodNotAllowed(res, 'GET, POST');
        }

        try {
            const context = await requireAdminContext(req, res, { store, bootstrapToken, pepper, now });
            if (!context) return null;
            if (context.adminUser.role !== 'super_admin') {
                return sendJson(res, 403, { ok: false, error: 'super_admin_required' });
            }

            if (req.method === 'GET' || !req.method) {
                if (typeof store.listPlatformAdminUsers !== 'function') {
                    return sendJson(res, 200, { ok: true, admins: [] });
                }
                const admins = await store.listPlatformAdminUsers();
                return sendJson(res, 200, {
                    ok: true,
                    admins: (admins || []).map(redactAdmin),
                });
            }

            const body = parseJsonBody(req.body);
            const action = requiredString(body.action, 'action');
            const email = normalizeAdminEmail(body.email);

            if (action === 'create') {
                const role = body.role === 'super_admin' ? 'super_admin' : 'admin';
                const existing = await store.findPlatformAdminByEmail(email);
                if (existing) {
                    return sendJson(res, 409, { ok: false, error: 'admin_already_exists' });
                }
                const admin = await store.upsertPlatformAdminUser({
                    email,
                    role,
                    status: 'active',
                });
                const invite = await issueResetLink({ req, admin });
                return sendJson(res, 201, {
                    ok: true,
                    admin: redactAdmin(admin),
                    ...invite,
                });
            }

            const admin = await store.findPlatformAdminByEmail(email);
            if (!admin) {
                return sendJson(res, 404, { ok: false, error: 'admin_not_found' });
            }

            if (action === 'reset_link') {
                if (admin.status !== 'active') {
                    return sendJson(res, 403, { ok: false, error: 'admin_not_active' });
                }
                const reset = await issueResetLink({ req, admin });
                return sendJson(res, 201, {
                    ok: true,
                    admin: redactAdmin(admin),
                    ...reset,
                });
            }

            if (action === 'disable') {
                if (DEFAULT_SUPER_ADMIN_EMAILS.includes(admin.email)) {
                    return sendJson(res, 403, { ok: false, error: 'cannot_disable_default_super_admin' });
                }
                if (context.adminUser.email === admin.email) {
                    return sendJson(res, 403, { ok: false, error: 'cannot_disable_self' });
                }
                const updated = await store.updatePlatformAdminStatus(admin.admin_user_id, 'disabled');
                if (typeof store.revokeAdminSessions === 'function') {
                    await store.revokeAdminSessions(admin.admin_user_id, now().toISOString());
                }
                return sendJson(res, 200, { ok: true, admin: redactAdmin(updated || admin) });
            }

            if (action === 'enable') {
                const updated = await store.updatePlatformAdminStatus(admin.admin_user_id, 'active');
                return sendJson(res, 200, { ok: true, admin: redactAdmin(updated || admin) });
            }

            return sendJson(res, 400, { ok: false, error: 'unknown_admin_user_action' });
        } catch (error) {
            return sendJson(res, 400, {
                ok: false,
                error: 'admin_users_failed',
                message: error.message,
            });
        }
    };
}
