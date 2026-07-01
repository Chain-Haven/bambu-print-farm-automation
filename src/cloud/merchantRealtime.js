import crypto from 'node:crypto';
import { createHttpError, merchantScope, publicOk } from './merchantApiV2.js';
import {
    getAuthenticatedMerchant,
    normalizeLimit,
    optionalString,
    redactPublicValue,
    safeObject,
} from './merchantPublicProjections.js';

const ALLOWED_SCOPES = new Set([
    'jobs:read',
    'orders:read',
    'events:read',
    'shipments:read',
    'billing:read',
]);

const DEFAULT_SCOPES = ['jobs:read', 'orders:read', 'events:read'];
const MAX_TTL_SECONDS = 3600;
const MIN_TTL_SECONDS = 60;

function withHttpStatus(payload, statusCode) {
    Object.defineProperty(payload, '_http_status', {
        value: statusCode,
        enumerable: false,
    });
    return payload;
}

function normalizeScopes(value) {
    const scopes = Array.isArray(value) && value.length > 0 ? value : DEFAULT_SCOPES;
    const normalized = scopes.map((scope) => String(scope || '').trim()).filter(Boolean);
    if (normalized.length === 0) return DEFAULT_SCOPES;
    for (const scope of normalized) {
        if (!ALLOWED_SCOPES.has(scope)) {
            throw createHttpError(400, 'invalid_payload', 'scopes contains an unsupported realtime scope');
        }
    }
    return [...new Set(normalized)];
}

function normalizeTtlSeconds(source) {
    const raw = source.ttl_seconds ?? source.expires_in_seconds ?? source.expiresInSeconds;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return 900;
    return Math.max(MIN_TTL_SECONDS, Math.min(parsed, MAX_TTL_SECONDS));
}

function channelForScope(merchant, scope) {
    const resource = scope.split(':')[0];
    return `merchant:${merchant.merchant_id}:${resource}`;
}

function hashRealtimeToken(token, pepper = '') {
    if (!token || typeof token !== 'string') throw new Error('realtime token is required');
    const input = pepper ? `${pepper}:${token}` : token;
    return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function publicTokenRecord(record) {
    const response = {
        token_id: record.token_id,
        token_prefix: record.token_prefix,
        scopes: Array.isArray(record.scopes) ? record.scopes : [],
        channel_names: Array.isArray(record.channel_names) ? record.channel_names : [],
        expires_at: record.expires_at,
    };
    for (const key of ['revoked_at', 'created_at', 'updated_at']) {
        if (record[key] !== undefined && record[key] !== null) response[key] = record[key];
    }
    const metadata = redactPublicValue(safeObject(record.metadata));
    if (Object.keys(metadata).length > 0) response.metadata = metadata;
    return response;
}

export function createRealtimeHandlers({
    store,
    authenticateMerchant,
    adapters = {},
    now = () => new Date(),
    tokenPepper = process.env.MERCHANT_REALTIME_TOKEN_PEPPER
        || process.env.MERCHANT_API_KEY_PEPPER
        || process.env.NODE_TOKEN_PEPPER
        || '',
} = {}) {
    if (!store) throw new Error('store is required');

    async function createToken(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        if (!adapters?.realtime || typeof adapters.realtime.createMerchantToken !== 'function') {
            throw new Error('realtime adapter is required');
        }
        const source = safeObject(body);
        const scopes = normalizeScopes(source.scopes);
        const expiresInSeconds = normalizeTtlSeconds(source);
        const channelNames = scopes.map((scope) => channelForScope(merchant, scope));
        const adapterToken = await adapters.realtime.createMerchantToken({
            merchant,
            scopes,
            expiresInSeconds,
            channelNames,
        });
        const rawToken = optionalString(adapterToken.token);
        if (!rawToken) throw createHttpError(502, 'realtime_token_unavailable', 'Realtime token could not be created');
        const issuedAt = optionalString(adapterToken.issued_at) || now().toISOString();
        const expiresAt = optionalString(adapterToken.expires_at)
            || new Date(new Date(issuedAt).getTime() + expiresInSeconds * 1000).toISOString();
        const tokenRecord = await store.createMerchantRealtimeToken({
            ...merchantScope(merchant),
            token_id: optionalString(adapterToken.token_id) || crypto.randomUUID(),
            token_prefix: rawToken.slice(0, 18),
            token_hash: hashRealtimeToken(rawToken, tokenPepper),
            scopes,
            channel_names: channelNames,
            expires_at: expiresAt,
            revoked_at: null,
            metadata: {
                provider: optionalString(adapterToken.provider) || 'mock',
                issued_at: issuedAt,
            },
            created_at: issuedAt,
        });
        return withHttpStatus(publicOk({
            token: rawToken,
            token_record: publicTokenRecord(tokenRecord),
        }, requestId), 201);
    }

    async function listTokens(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const source = safeObject(body);
        const tokens = await store.listMerchantRealtimeTokens({
            merchantId: merchant.merchant_id,
            limit: normalizeLimit(source.limit, 50, 100),
        });
        return publicOk({ tokens: tokens.map(publicTokenRecord) }, requestId);
    }

    return {
        createToken,
        listTokens,
    };
}
