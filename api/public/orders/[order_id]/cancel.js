import { MerchantAuthError, authenticateMerchantRequest } from '../../../../src/cloud/merchantAuth.js';
import { createHttpError, createRequestId, publicError } from '../../../../src/cloud/merchantApiV2.js';
import { createOrderHandlers } from '../../../../src/cloud/merchantOrders.js';
import { createSupabaseRestClient } from '../../../../src/cloud/supabaseRest.js';

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

function routeOrderId(req) {
    const value = req.query?.order_id;
    return Array.isArray(value) ? value[0] : value;
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

export default async function handler(req, res) {
    const requestId = createRequestId();
    if (req.method && req.method !== 'POST') return methodNotAllowed(res, 'POST', requestId);

    const store = createSupabaseRestClient();
    const now = () => new Date();
    const { cancelOrder } = createOrderHandlers({
        store,
        now,
        authenticateMerchant: (request) => authenticateMerchantRequest(request, {
            store,
            pepper: process.env.MERCHANT_API_KEY_PEPPER || process.env.NODE_TOKEN_PEPPER,
            now,
        }),
    });

    try {
        const result = await cancelOrder({ order_id: routeOrderId(req) }, req, requestId);
        return sendJson(res, 200, result);
    } catch (error) {
        if (error instanceof MerchantAuthError) {
            return sendJson(res, error.statusCode, publicAuthError(error, requestId));
        }
        return sendJson(res, statusForError(error), publicError(error, requestId));
    }
}
