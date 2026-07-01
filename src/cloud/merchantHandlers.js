import { parseJsonBody } from './agentProtocol.js';
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

const SETUP_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

function normalizeSignup(body) {
    const source = isPlainObject(body) ? body : {};
    return {
        company_name: requiredString(source.company_name, 'company_name'),
        contact_email: normalizeEmail(source.contact_email),
        contact_name: optionalString(source.contact_name),
        website: optionalString(source.website),
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

function handleMerchantAuthError(res, error) {
    if (error instanceof MerchantAuthError) {
        return sendJson(res, error.statusCode, { ok: false, error: error.code });
    }
    return null;
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

            if (!fullAutoEnabled) {
                return sendJson(res, 201, {
                    ok: true,
                    merchant: redactMerchant(merchant),
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
            const context = await authenticateMerchantRequest(req, { store, pepper, now });
            return sendJson(res, 200, {
                ok: true,
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

        return authenticateMerchantRequest(req, { store, pepper, now });
    }

    return async function merchantApiKeysHandler(req, res) {
        if (req.method === 'GET') {
            try {
                const context = await authenticateMerchantRequest(req, { store, pepper, now });
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
            const apiKey = await createLiveKeyForMerchant({
                store,
                merchant: context.merchant,
                name: normalizeKeyName(parseJsonBody(req.body)),
                pepper,
                liveKeyFactory,
            });

            if (context.setupToken && typeof store.markMerchantSetupTokenUsed === 'function') {
                await store.markMerchantSetupTokenUsed(context.setupToken.setup_token_id, now().toISOString());
            }

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
            const context = await authenticateMerchantRequest(req, { store, pepper, now });
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
