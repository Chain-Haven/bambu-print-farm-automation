import { createHttpError } from './merchantApiV2.js';

const INTERNAL_EXACT_KEYS = new Set([
    'accesscode',
    'apikey',
    'authorization',
    'commandid',
    'downloadurl',
    'href',
    'keyhash',
    'localprinterid',
    'merchantid',
    'node',
    'nodeid',
    'orgid',
    'password',
    'printer',
    'printerid',
    'secret',
    'selectednodeid',
    'selectedprinterid',
    'signedurl',
    'spool',
    'spoolid',
    'storage',
    'storagepath',
    'token',
    'tokenhash',
    'uploadurl',
    'url',
]);

const INTERNAL_KEY_PATTERNS = [
    'accesscode',
    'apikey',
    'authorization',
    'commandtoken',
    'downloadurl',
    'href',
    'keyhash',
    'localprinter',
    'merchantsecret',
    'nodeid',
    'password',
    'printerid',
    'secret',
    'selectednode',
    'selectedprinter',
    'signedurl',
    'spoolid',
    'storagepath',
    'storageurl',
    'token',
    'uploadurl',
    'url',
];

export function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function safeObject(value) {
    return isPlainObject(value) ? value : {};
}

export function optionalString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function requiredString(value, name) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw createHttpError(400, 'invalid_payload', `${name} is required`);
    }
    return value.trim();
}

export function normalizeLimit(value, fallback = 50, max = 100) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(1, Math.min(parsed, max));
}

export function normalizeOptionalTimestamp(value, name) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
        throw createHttpError(400, 'invalid_payload', `${name} must be an ISO timestamp`);
    }
    return value.trim();
}

function normalizedKey(key) {
    return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isInternalPublicKey(key) {
    const normalized = normalizedKey(key);
    if (INTERNAL_EXACT_KEYS.has(normalized)) return true;
    return INTERNAL_KEY_PATTERNS.some((pattern) => normalized.includes(pattern));
}

export function redactPublicValue(value) {
    if (Array.isArray(value)) return value.map((item) => redactPublicValue(item));
    if (!isPlainObject(value)) return value;

    const output = {};
    for (const [key, child] of Object.entries(value)) {
        if (isInternalPublicKey(key)) continue;
        const redacted = redactPublicValue(child);
        if (redacted !== undefined) output[key] = redacted;
    }
    return output;
}

export async function getAuthenticatedMerchant(authenticateMerchant, request) {
    if (typeof authenticateMerchant !== 'function') {
        throw new Error('authenticateMerchant is required');
    }
    const context = await authenticateMerchant(request);
    const merchant = context?.merchant || context;
    if (!merchant?.org_id || !merchant?.merchant_id) {
        throw createHttpError(403, 'merchant_scope_missing', 'Merchant scope is unavailable');
    }
    return merchant;
}
