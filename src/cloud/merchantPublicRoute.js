import { createHttpError, createRequestId, publicError } from './merchantApiV2.js';
import { MerchantAuthError, authenticateMerchantRequest } from './merchantAuth.js';
import { createSupabaseRestClient } from './supabaseRest.js';

function sendJson(res, statusCode, payload) {
    if (typeof res.status === 'function' && typeof res.json === 'function') {
        return res.status(statusCode).json(payload);
    }
    res.statusCode = statusCode;
    if (typeof res.setHeader === 'function') res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(payload));
}

function methodNotAllowed(res, methods, requestId) {
    if (typeof res.setHeader === 'function') res.setHeader('Allow', methods);
    return sendJson(
        res,
        405,
        publicError(createHttpError(405, 'method_not_allowed', 'Method not allowed'), requestId),
    );
}

function statusForError(error) {
    return Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : 500;
}

function publicAuthError(error, requestId) {
    return {
        ok: false,
        error: error.code || 'merchant_auth_failed',
        message: 'Merchant authentication failed',
        request_id: requestId,
    };
}

function statusForResult(result, fallbackStatus) {
    return Number.isInteger(result?._http_status) ? result._http_status : fallbackStatus;
}

export function routeParam(req, name) {
    const value = req.query?.[name];
    return Array.isArray(value) ? value[0] : value;
}

export function routeQuery(req) {
    const query = {};
    for (const [key, value] of Object.entries(req.query || {})) {
        query[key] = Array.isArray(value) ? value[0] : value;
    }
    return query;
}

export function createMerchantRouteContext() {
    const store = createSupabaseRestClient();
    const now = () => new Date();
    const authenticateMerchant = (request) => authenticateMerchantRequest(request, {
        store,
        pepper: process.env.MERCHANT_API_KEY_PEPPER || process.env.NODE_TOKEN_PEPPER,
        now,
    });
    return { store, now, authenticateMerchant };
}

export async function runMerchantRoute(req, res, {
    methods,
    successStatus = 200,
    handle,
}) {
    const requestId = createRequestId();
    if (req.method && req.method !== methods) return methodNotAllowed(res, methods, requestId);

    try {
        const result = await handle(requestId);
        return sendJson(res, statusForResult(result, successStatus), result);
    } catch (error) {
        if (error instanceof MerchantAuthError) {
            return sendJson(res, error.statusCode, publicAuthError(error, requestId));
        }
        return sendJson(res, statusForError(error), publicError(error, requestId));
    }
}
