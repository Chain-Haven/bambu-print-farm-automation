import { parseJsonBody } from '../../../src/cloud/agentProtocol.js';
import { MerchantAuthError, authenticateMerchantRequest } from '../../../src/cloud/merchantAuth.js';
import { createFileHandlers } from '../../../src/cloud/merchantFiles.js';
import { publicError } from '../../../src/cloud/merchantApiV2.js';
import { createSupabaseRestClient } from '../../../src/cloud/supabaseRest.js';

function sendJson(res, statusCode, payload) {
    if (typeof res.status === 'function' && typeof res.json === 'function') {
        return res.status(statusCode).json(payload);
    }
    res.statusCode = statusCode;
    if (typeof res.setHeader === 'function') res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(payload));
}

function methodNotAllowed(res, methods) {
    if (typeof res.setHeader === 'function') res.setHeader('Allow', methods);
    return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
}

function statusForError(error) {
    return Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : 500;
}

export default async function handler(req, res) {
    if (req.method && req.method !== 'POST') return methodNotAllowed(res, 'POST');

    const store = createSupabaseRestClient();
    const now = () => new Date();
    const { createFile } = createFileHandlers({
        store,
        now,
        authenticateMerchant: (request) => authenticateMerchantRequest(request, {
            store,
            pepper: process.env.MERCHANT_API_KEY_PEPPER || process.env.NODE_TOKEN_PEPPER,
            now,
        }),
    });

    try {
        const result = await createFile(parseJsonBody(req.body), req);
        return sendJson(res, 201, result);
    } catch (error) {
        if (error instanceof MerchantAuthError) {
            return sendJson(res, error.statusCode, { ok: false, error: error.code });
        }
        return sendJson(res, statusForError(error), publicError(error));
    }
}
