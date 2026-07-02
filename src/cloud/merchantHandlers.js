import { parseJsonBody } from './agentProtocol.js';
import { createRequestId } from './httpServerUtils.js';
import {
    MerchantAuthError,
    authenticateMerchantRequest,
    authenticateMerchantSetupToken,
    buildMerchantApiKeyRecord,
    buildMerchantSetupTokenRecord,
    generateMerchantApiKey,
    generateMerchantSetupToken,
    getMerchantSetupToken,
} from './merchantAuth.js';
import {
    MerchantUserAuthError,
    authenticateMerchantUser,
    getMerchantUserBearerToken,
    isMerchantUserSessionToken,
} from './merchantUserAuth.js';
import {
    createMerchantUserForSignup,
    redactMerchantUser,
} from './merchantUserHandlers.js';
import { SupabaseMissingTableError } from './supabaseRest.js';

const SETUP_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_PASSWORD_LENGTH = 12;

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

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

function methodNotAllowed(res, methods, requestId = createRequestId()) {
    if (typeof res.setHeader === 'function') {
        res.setHeader('Allow', methods);
    }
    return sendJson(res, 405, {
        ok: false,
        error: 'method_not_allowed',
        message: 'Method not allowed',
        request_id: requestId,
    });
}

function requiredString(value, name) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${name} is required`);
    }
    return value.trim();
}

function optionalString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeEmail(value) {
    const email = requiredString(value, 'contact_email').toLowerCase();
    if (!email.includes('@')) {
        throw new Error('contact_email must be a valid email address');
    }
    return email;
}

function optionalPassword(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || value.length < MIN_PASSWORD_LENGTH) {
        throw new Error(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
    return value;
}

function normalizeSignup(body) {
    const source = isPlainObject(body) ? body : {};
    return {
        company_name: requiredString(source.company_name, 'company_name'),
        contact_email: normalizeEmail(source.contact_email),
        contact_name: optionalString(source.contact_name),
        website: optionalString(source.website),
        password: optionalPassword(source.password),
    };
}

function normalizeKeyName(body) {
    const source = isPlainObject(body) ? body : {};
    return optionalString(source.name) || 'Production';
}

function normalizeKeyId(body) {
    const source = isPlainObject(body) ? body : {};
    return requiredString(source.key_id, 'key_id');
}

function redactMerchant(merchant) {
    if (!merchant) return null;
    const {
        merchant_id,
        org_id,
        company_name,
        contact_email,
        contact_name,
        website,
        status,
        approval_mode,
        metadata,
        approved_at,
        rejected_at,
        created_at,
        updated_at,
    } = merchant;

    return Object.fromEntries(Object.entries({
        merchant_id,
        org_id,
        company_name,
        contact_email,
        contact_name,
        website,
        status,
        approval_mode,
        metadata,
        approved_at,
        rejected_at,
        created_at,
        updated_at,
    }).filter(([, value]) => value !== undefined));
}

function redactApiKey(apiKey) {
    if (!apiKey) return null;
    const {
        key_id,
        merchant_id,
        org_id,
        name,
        key_prefix,
        last_used_at,
        revoked_at,
        created_at,
    } = apiKey;

    return Object.fromEntries(Object.entries({
        key_id,
        merchant_id,
        org_id,
        name,
        key_prefix,
        last_used_at,
        revoked_at,
        created_at,
    }).filter(([, value]) => value !== undefined));
}

function handleMerchantAuthError(res, error, requestId = createRequestId()) {
    if (error instanceof MerchantAuthError || error instanceof MerchantUserAuthError) {
        return sendJson(res, error.statusCode, {
            ok: false,
            error: error.code,
            message: 'Authentication failed',
            request_id: requestId,
        });
    }
    return null;
}

// Portal sessions (humans signed in with a password) may manage the same
// resources as API keys. The merchant must be active for farm actions.
async function authenticateMerchantHumanOrKey(req, { store, pepper, now }) {
    if (isMerchantUserSessionToken(getMerchantUserBearerToken(req.headers || {}))) {
        const context = await authenticateMerchantUser(req, { store, pepper, now });
        if (context.merchant.status !== 'active') {
            throw new MerchantUserAuthError(403, 'merchant_not_active');
        }
        return { merchant: context.merchant, merchantUser: context.merchantUser };
    }

    return authenticateMerchantRequest(req, { store, pepper, now });
}

async function getFullAutoEnabled(store) {
    if (typeof store.getPlatformSetting !== 'function') return false;
    const setting = await store.getPlatformSetting('full_auto_merchant_mode', { enabled: false });
    return setting?.enabled === true;
}

async function createSetupTokenForMerchant({ store, merchant, pepper, now, setupTokenFactory }) {
    if (!pepper) throw new Error('merchant api key pepper is required');

    const issuedAt = now();
    const expiresAt = new Date(issuedAt.getTime() + SETUP_TOKEN_TTL_MS).toISOString();
    const rawToken = setupTokenFactory();
    const setupToken = buildMerchantSetupTokenRecord({
        merchant,
        rawToken,
        pepper,
        expiresAt,
    });

    await store.createMerchantSetupToken(setupToken.record);

    return {
        secret: setupToken.secret,
        expires_at: expiresAt,
    };
}

async function createLiveKeyForMerchant({ store, merchant, name, pepper, liveKeyFactory }) {
    if (!pepper) throw new Error('merchant api key pepper is required');

    const rawKey = liveKeyFactory();
    const apiKey = buildMerchantApiKeyRecord({
        merchant,
        name,
        rawKey,
        pepper,
    });
    const record = await store.createMerchantApiKey(apiKey.record);

    return {
        secret: apiKey.secret,
        record,
    };
}

export function createMerchantSignupHandler({
    store,
    pepper = process.env.MERCHANT_API_KEY_PEPPER || process.env.NODE_TOKEN_PEPPER,
    now = () => new Date(),
    setupTokenFactory = generateMerchantSetupToken,
    bcryptCost = 12,
}) {
    if (!store) throw new Error('store is required');

    return async function merchantSignupHandler(req, res) {
        if (req.method && req.method !== 'POST') {
            return methodNotAllowed(res, 'POST');
        }

        try {
            const body = normalizeSignup(parseJsonBody(req.body));
            const fullAutoEnabled = await getFullAutoEnabled(store);
            const existing = typeof store.findMerchantByEmail === 'function'
                ? await store.findMerchantByEmail(body.contact_email)
                : null;

            if (existing) {
                return sendJson(res, 409, { ok: false, error: 'merchant_already_exists' });
            }

            const existingUser = typeof store.findMerchantUserByEmail === 'function'
                ? await store.findMerchantUserByEmail(body.contact_email).catch((error) => {
                    if (error instanceof SupabaseMissingTableError) return null;
                    throw error;
                })
                : null;
            if (existingUser) {
                return sendJson(res, 409, { ok: false, error: 'merchant_already_exists' });
            }

            const organization = await store.createOrganization({ name: body.company_name });
            const approvedAt = fullAutoEnabled ? now().toISOString() : undefined;
            const merchant = await store.createMerchant({
                org_id: organization.org_id,
                company_name: body.company_name,
                contact_email: body.contact_email,
                contact_name: body.contact_name,
                website: body.website,
                status: fullAutoEnabled ? 'active' : 'pending',
                approval_mode: fullAutoEnabled ? 'full_auto' : 'approval_required',
                ...(approvedAt ? { approved_at: approvedAt } : {}),
                metadata: { signup_source: 'public_api' },
            });

            // A password at signup creates the portal owner account so the
            // merchant can sign in immediately (even while pending approval).
            let merchantUser = null;
            let portal_auth_deferred = false;
            if (body.password && typeof store.createMerchantUser === 'function') {
                try {
                    merchantUser = await createMerchantUserForSignup({
                        store,
                        merchant,
                        email: body.contact_email,
                        displayName: body.contact_name,
                        password: body.password,
                        bcryptCost,
                    });
                } catch (error) {
                    if (error instanceof SupabaseMissingTableError) {
                        portal_auth_deferred = true;
                    } else {
                        throw error;
                    }
                }
            }

            if (!fullAutoEnabled) {
                return sendJson(res, 201, {
                    ok: true,
                    merchant: redactMerchant(merchant),
                    ...(merchantUser ? { merchant_user: redactMerchantUser(merchantUser) } : {}),
                    ...(portal_auth_deferred ? {
                        portal_auth_deferred: true,
                        message: 'Merchant created. Portal sign-in will be enabled after the operator applies the merchant user database migration.',
                    } : {}),
                    approval_required: true,
                });
            }

            const setupToken = await createSetupTokenForMerchant({
                store,
                merchant,
                pepper,
                now,
                setupTokenFactory,
            });

            return sendJson(res, 201, {
                ok: true,
                merchant: redactMerchant(merchant),
                ...(merchantUser ? { merchant_user: redactMerchantUser(merchantUser) } : {}),
                ...(portal_auth_deferred ? {
                    portal_auth_deferred: true,
                    message: 'Merchant created. Portal sign-in will be enabled after the operator applies the merchant user database migration.',
                } : {}),
                approval_required: false,
                merchant_setup_token: setupToken.secret,
                setup_token_expires_at: setupToken.expires_at,
            });
        } catch (error) {
            return sendJson(res, 400, {
                ok: false,
                error: 'merchant_signup_failed',
                message: error.message,
            });
        }
    };
}

export function createMerchantMeHandler({
    store,
    pepper = process.env.MERCHANT_API_KEY_PEPPER || process.env.NODE_TOKEN_PEPPER,
    now = () => new Date(),
}) {
    if (!store) throw new Error('store is required');

    return async function merchantMeHandler(req, res) {
        if (req.method && req.method !== 'GET') {
            return methodNotAllowed(res, 'GET');
        }

        try {
            // Portal sessions may look themselves up regardless of merchant
            // status (owners of pending merchants need to see where they stand).
            if (isMerchantUserSessionToken(getMerchantUserBearerToken(req.headers || {}))) {
                const context = await authenticateMerchantUser(req, { store, pepper, now });
                return sendJson(res, 200, {
                    ok: true,
                    auth_type: 'portal_session',
                    merchant: redactMerchant(context.merchant),
                    merchant_user: redactMerchantUser(context.merchantUser),
                });
            }

            const context = await authenticateMerchantRequest(req, { store, pepper, now });
            return sendJson(res, 200, {
                ok: true,
                auth_type: 'api_key',
                merchant: redactMerchant(context.merchant),
                api_key: redactApiKey(context.apiKey),
            });
        } catch (error) {
            const handled = handleMerchantAuthError(res, error);
            if (handled) return handled;
            return sendJson(res, 500, {
                ok: false,
                error: 'merchant_lookup_failed',
                message: error.message,
            });
        }
    };
}

export function createMerchantApiKeysHandler({
    store,
    pepper = process.env.MERCHANT_API_KEY_PEPPER || process.env.NODE_TOKEN_PEPPER,
    now = () => new Date(),
    liveKeyFactory = generateMerchantApiKey,
}) {
    if (!store) throw new Error('store is required');

    async function authenticateForKeyCreation(req) {
        if (getMerchantSetupToken(req.headers || {})) {
            const context = await authenticateMerchantSetupToken(req, { store, pepper, now });
            return { ...context, setupToken: context.setupToken };
        }

        return authenticateMerchantHumanOrKey(req, { store, pepper, now });
    }

    return async function merchantApiKeysHandler(req, res) {
        if (req.method === 'GET') {
            try {
                const context = await authenticateMerchantHumanOrKey(req, { store, pepper, now });
                const apiKeys = await store.listMerchantApiKeys(context.merchant.merchant_id);
                return sendJson(res, 200, {
                    ok: true,
                    api_keys: apiKeys.map(redactApiKey),
                });
            } catch (error) {
                const handled = handleMerchantAuthError(res, error);
                if (handled) return handled;
                return sendJson(res, 500, {
                    ok: false,
                    error: 'list_api_keys_failed',
                    message: error.message,
                });
            }
        }

        if (req.method && req.method !== 'POST') {
            return methodNotAllowed(res, 'GET, POST');
        }

        try {
            const context = await authenticateForKeyCreation(req);

            // When authenticated via a one-time setup token, atomically consume the
            // token BEFORE minting the key. The store consume is conditional
            // (used_at=is.null) and returns null if the token was already used, so
            // concurrent requests cannot mint multiple keys from one token, and a
            // failure here leaves no dangling key behind.
            if (context.setupToken && typeof store.markMerchantSetupTokenUsed === 'function') {
                const consumed = await store.markMerchantSetupTokenUsed(
                    context.setupToken.setup_token_id,
                    now().toISOString(),
                );
                if (!consumed) {
                    throw new MerchantAuthError(401, 'setup_token_used');
                }
            }

            const apiKey = await createLiveKeyForMerchant({
                store,
                merchant: context.merchant,
                name: normalizeKeyName(parseJsonBody(req.body)),
                pepper,
                liveKeyFactory,
            });

            return sendJson(res, 201, {
                ok: true,
                api_key: redactApiKey(apiKey.record),
                api_key_secret: apiKey.secret,
            });
        } catch (error) {
            const handled = handleMerchantAuthError(res, error);
            if (handled) return handled;
            return sendJson(res, 400, {
                ok: false,
                error: 'create_api_key_failed',
                message: error.message,
            });
        }
    };
}

export function createMerchantApiKeyRevokeHandler({
    store,
    pepper = process.env.MERCHANT_API_KEY_PEPPER || process.env.NODE_TOKEN_PEPPER,
    now = () => new Date(),
}) {
    if (!store) throw new Error('store is required');

    return async function merchantApiKeyRevokeHandler(req, res) {
        if (req.method && req.method !== 'POST') {
            return methodNotAllowed(res, 'POST');
        }

        try {
            const context = await authenticateMerchantHumanOrKey(req, { store, pepper, now });
            const revoked = await store.revokeMerchantApiKey({
                merchantId: context.merchant.merchant_id,
                keyId: normalizeKeyId(parseJsonBody(req.body)),
                revokedAt: now().toISOString(),
            });

            if (!revoked) {
                return sendJson(res, 404, { ok: false, error: 'api_key_not_found' });
            }

            return sendJson(res, 200, {
                ok: true,
                api_key: redactApiKey(revoked),
            });
        } catch (error) {
            const handled = handleMerchantAuthError(res, error);
            if (handled) return handled;
            return sendJson(res, 400, {
                ok: false,
                error: 'revoke_api_key_failed',
                message: error.message,
            });
        }
    };
}
