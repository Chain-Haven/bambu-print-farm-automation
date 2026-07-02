import bcrypt from 'bcryptjs';
import { parseJsonBody } from './agentProtocol.js';
import { createRpmLimiter } from '../utils/rateLimiter.js';
import { createMailer } from './mailer.js';
import {
    MerchantUserAuthError,
    authenticateMerchantUser,
    buildMerchantUserPasswordResetRecord,
    buildMerchantUserSessionRecord,
    generateMerchantUserPasswordResetToken,
    generateMerchantUserSessionToken,
    hashMerchantUserSecret,
    normalizeMerchantUserEmail,
} from './merchantUserAuth.js';

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 12;

// Best-effort per-email login throttle (exact on a long-running node,
// per-instance on serverless).
const MERCHANT_LOGIN_RATE_LIMIT_RPM = Number.parseInt(process.env.MERCHANT_LOGIN_RATE_LIMIT_RPM || '10', 10);
const defaultLoginRateLimiter = MERCHANT_LOGIN_RATE_LIMIT_RPM > 0
    ? createRpmLimiter(MERCHANT_LOGIN_RATE_LIMIT_RPM)
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

function requiredString(value, name) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${name} is required`);
    }
    return value.trim();
}

function requiredPassword(value) {
    if (typeof value !== 'string' || value.length < MIN_PASSWORD_LENGTH) {
        throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    return value;
}

export function redactMerchantUser(merchantUser) {
    if (!merchantUser) return null;
    const {
        merchant_user_id,
        merchant_id,
        org_id,
        email,
        display_name,
        role,
        status,
        last_login_at,
        created_at,
        updated_at,
    } = merchantUser;

    return {
        merchant_user_id,
        merchant_id,
        org_id,
        email,
        display_name,
        role,
        status,
        last_login_at,
        created_at,
        updated_at,
    };
}

function redactMerchantSummary(merchant) {
    if (!merchant) return null;
    const {
        merchant_id,
        org_id,
        company_name,
        contact_email,
        status,
        approval_mode,
        created_at,
    } = merchant;

    return { merchant_id, org_id, company_name, contact_email, status, approval_mode, created_at };
}

function handleMerchantUserAuthError(res, error) {
    if (error instanceof MerchantUserAuthError) {
        return sendJson(res, error.statusCode, { ok: false, error: error.code });
    }
    return null;
}

function buildPortalResetLink(appBaseUrl, resetToken) {
    return `${appBaseUrl}/merchant?reset_token=${encodeURIComponent(resetToken)}`;
}

function normalizeAppBaseUrl(value, req) {
    const host = typeof req?.headers?.host === 'string' ? req.headers.host.trim() : '';
    const inferred = host ? `https://${host}` : '';
    const base = value || process.env.APP_BASE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : inferred);
    return requiredString(base, 'app_base_url').replace(/\/+$/, '');
}

// Shared by the public signup handler: creates the human account behind a new
// merchant. The password is hashed here so signup never stores plaintext.
export async function createMerchantUserForSignup({
    store,
    merchant,
    email,
    displayName = null,
    password,
    role = 'owner',
    bcryptCost = 12,
}) {
    if (!store || typeof store.createMerchantUser !== 'function') {
        throw new Error('store does not support merchant users');
    }
    if (!merchant?.merchant_id || !merchant?.org_id) {
        throw new Error('merchant is required');
    }

    const passwordHash = await bcrypt.hash(requiredPassword(password), bcryptCost);
    return store.createMerchantUser({
        merchant_id: merchant.merchant_id,
        org_id: merchant.org_id,
        email: normalizeMerchantUserEmail(email),
        display_name: displayName || null,
        role,
        status: 'active',
        password_hash: passwordHash,
    });
}

export function createMerchantLoginHandler({
    store,
    pepper = process.env.MERCHANT_API_KEY_PEPPER || process.env.NODE_TOKEN_PEPPER,
    sessionTokenFactory = generateMerchantUserSessionToken,
    bcryptCompare = bcrypt.compare,
    now = () => new Date(),
    loginRateLimiter = defaultLoginRateLimiter,
} = {}) {
    if (!store) throw new Error('store is required');

    return async function merchantLoginHandler(req, res) {
        if (req.method && req.method !== 'POST') {
            return methodNotAllowed(res, 'POST');
        }

        try {
            if (!pepper) throw new Error('merchant user secret pepper is required');
            const body = parseJsonBody(req.body);
            const email = normalizeMerchantUserEmail(body.email);
            const password = requiredString(body.password, 'password');

            if (loginRateLimiter) {
                const verdict = loginRateLimiter.check(`merchant-login:${email}`);
                if (!verdict.allowed) {
                    return sendJson(res, 429, { ok: false, error: 'rate_limited' });
                }
            }

            const merchantUser = await store.findMerchantUserByEmail(email);
            if (!merchantUser || merchantUser.status !== 'active' || !merchantUser.password_hash) {
                return sendJson(res, 401, { ok: false, error: 'invalid_merchant_credentials' });
            }
            const passwordOk = await bcryptCompare(password, merchantUser.password_hash);
            if (!passwordOk) {
                return sendJson(res, 401, { ok: false, error: 'invalid_merchant_credentials' });
            }

            const merchant = await store.findMerchantById(merchantUser.merchant_id);
            if (!merchant) {
                return sendJson(res, 403, { ok: false, error: 'merchant_not_found' });
            }

            const issuedAt = now();
            const expiresAt = new Date(issuedAt.getTime() + SESSION_TTL_MS).toISOString();
            const rawToken = sessionTokenFactory();
            const session = buildMerchantUserSessionRecord({
                merchantUser,
                rawToken,
                pepper,
                expiresAt,
            });
            const record = await store.createMerchantUserSession(session.record);
            const loggedInAt = issuedAt.toISOString();
            if (typeof store.updateMerchantUserLastLogin === 'function') {
                await store.updateMerchantUserLastLogin(merchantUser.merchant_user_id, loggedInAt);
            }

            return sendJson(res, 200, {
                ok: true,
                merchant_user: redactMerchantUser({ ...merchantUser, last_login_at: loggedInAt }),
                merchant: redactMerchantSummary(merchant),
                merchant_session_token: session.secret,
                session: {
                    session_id: record?.session_id,
                    token_prefix: record?.token_prefix || session.record.token_prefix,
                    expires_at: record?.expires_at || expiresAt,
                },
            });
        } catch (error) {
            return sendJson(res, 400, {
                ok: false,
                error: 'merchant_login_failed',
                message: error.message,
            });
        }
    };
}

export function createMerchantLogoutHandler({
    store,
    pepper = process.env.MERCHANT_API_KEY_PEPPER || process.env.NODE_TOKEN_PEPPER,
    now = () => new Date(),
} = {}) {
    if (!store) throw new Error('store is required');

    return async function merchantLogoutHandler(req, res) {
        if (req.method && req.method !== 'POST') {
            return methodNotAllowed(res, 'POST');
        }

        try {
            const context = await authenticateMerchantUser(req, { store, pepper, now });
            if (typeof store.revokeMerchantUserSession === 'function') {
                await store.revokeMerchantUserSession(context.session.session_id, now().toISOString());
            }
            return sendJson(res, 200, { ok: true });
        } catch (error) {
            const handled = handleMerchantUserAuthError(res, error);
            if (handled) return handled;
            return sendJson(res, 400, {
                ok: false,
                error: 'merchant_logout_failed',
                message: error.message,
            });
        }
    };
}

export function createMerchantPortalMeHandler({
    store,
    pepper = process.env.MERCHANT_API_KEY_PEPPER || process.env.NODE_TOKEN_PEPPER,
    now = () => new Date(),
} = {}) {
    if (!store) throw new Error('store is required');

    return async function merchantPortalMeHandler(req, res) {
        if (req.method && req.method !== 'GET') {
            return methodNotAllowed(res, 'GET');
        }

        try {
            const context = await authenticateMerchantUser(req, { store, pepper, now });
            return sendJson(res, 200, {
                ok: true,
                merchant_user: redactMerchantUser(context.merchantUser),
                merchant: redactMerchantSummary(context.merchant),
            });
        } catch (error) {
            const handled = handleMerchantUserAuthError(res, error);
            if (handled) return handled;
            return sendJson(res, 500, {
                ok: false,
                error: 'merchant_session_lookup_failed',
                message: error.message,
            });
        }
    };
}

// Public self-service "forgot password". The response is intentionally
// identical whether or not the email maps to an account, so the endpoint can't
// be used to enumerate merchants. The reset link is only ever delivered by
// email (or the server log when no mailer is configured) — never in the body.
export function createMerchantPasswordResetRequestHandler({
    store,
    pepper = process.env.MERCHANT_API_KEY_PEPPER || process.env.NODE_TOKEN_PEPPER,
    now = () => new Date(),
    resetTokenFactory = generateMerchantUserPasswordResetToken,
    appBaseUrl = null,
    mailer = createMailer(),
    requestRateLimiter = defaultLoginRateLimiter,
} = {}) {
    if (!store) throw new Error('store is required');

    return async function merchantPasswordResetRequestHandler(req, res) {
        if (req.method && req.method !== 'POST') {
            return methodNotAllowed(res, 'POST');
        }

        const generic = {
            ok: true,
            message: 'If that email belongs to a merchant account, a password reset link has been sent.',
        };

        try {
            if (!pepper) throw new Error('merchant user secret pepper is required');
            const body = parseJsonBody(req.body);
            const email = normalizeMerchantUserEmail(body.email);

            if (requestRateLimiter) {
                const verdict = requestRateLimiter.check(`merchant-reset:${email}`);
                if (!verdict.allowed) {
                    return sendJson(res, 429, { ok: false, error: 'rate_limited' });
                }
            }

            const merchantUser = await store.findMerchantUserByEmail(email);
            if (!merchantUser || merchantUser.status !== 'active') {
                return sendJson(res, 200, generic);
            }

            const issuedAt = now();
            const expiresAt = new Date(issuedAt.getTime() + RESET_TOKEN_TTL_MS).toISOString();
            const rawToken = resetTokenFactory();
            const reset = buildMerchantUserPasswordResetRecord({
                merchantUser,
                rawToken,
                pepper,
                expiresAt,
            });
            await store.createMerchantUserPasswordResetToken(reset.record);

            const baseUrl = normalizeAppBaseUrl(appBaseUrl, req);
            const resetUrl = buildPortalResetLink(baseUrl, rawToken);
            try {
                await mailer.send({
                    to: merchantUser.email,
                    subject: 'Reset your PrintKinetix merchant password',
                    text: [
                        'A password reset was requested for your PrintKinetix merchant account.',
                        '',
                        `Reset your password: ${resetUrl}`,
                        '',
                        'This link expires in 1 hour. If you did not request this, you can ignore this email.',
                    ].join('\n'),
                });
            } catch {
                /* best-effort delivery — the response never reveals the outcome */
            }

            return sendJson(res, 200, generic);
        } catch (error) {
            return sendJson(res, 400, {
                ok: false,
                error: 'merchant_password_reset_failed',
                message: error.message,
            });
        }
    };
}

export function createMerchantSetPasswordHandler({
    store,
    pepper = process.env.MERCHANT_API_KEY_PEPPER || process.env.NODE_TOKEN_PEPPER,
    bcryptCost = 12,
    now = () => new Date(),
} = {}) {
    if (!store) throw new Error('store is required');

    return async function merchantSetPasswordHandler(req, res) {
        if (req.method && req.method !== 'POST') {
            return methodNotAllowed(res, 'POST');
        }

        try {
            if (!pepper) throw new Error('merchant user secret pepper is required');
            const body = parseJsonBody(req.body);
            const resetToken = requiredString(body.reset_token, 'reset_token');
            const password = requiredPassword(body.password);

            const computedHash = hashMerchantUserSecret(resetToken, pepper);
            const reset = await store.findMerchantUserPasswordResetTokenByHash(computedHash);
            if (!reset || reset.token_hash !== computedHash) {
                return sendJson(res, 401, { ok: false, error: 'invalid_reset_token' });
            }
            if (reset.used_at) {
                return sendJson(res, 401, { ok: false, error: 'reset_token_used' });
            }
            if (reset.expires_at && new Date(reset.expires_at).getTime() <= now().getTime()) {
                return sendJson(res, 401, { ok: false, error: 'reset_token_expired' });
            }

            const merchantUser = await store.findMerchantUserById(reset.merchant_user_id);
            if (!merchantUser || merchantUser.status !== 'active') {
                return sendJson(res, 403, { ok: false, error: 'merchant_user_not_active' });
            }

            const passwordHash = await bcrypt.hash(password, bcryptCost);
            const updated = await store.updateMerchantUserPassword(merchantUser.merchant_user_id, passwordHash);
            const usedAt = now().toISOString();
            await store.markMerchantUserPasswordResetTokenUsed(reset.reset_token_id, usedAt);
            if (typeof store.revokeMerchantUserSessions === 'function') {
                await store.revokeMerchantUserSessions(merchantUser.merchant_user_id, usedAt);
            }

            return sendJson(res, 200, {
                ok: true,
                merchant_user: redactMerchantUser(updated || merchantUser),
            });
        } catch (error) {
            return sendJson(res, 400, {
                ok: false,
                error: 'merchant_set_password_failed',
                message: error.message,
            });
        }
    };
}
