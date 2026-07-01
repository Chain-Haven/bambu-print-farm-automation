import crypto from 'node:crypto';

export function createRequestId(prefix = 'req') {
    return `${prefix}_${crypto.randomUUID()}`;
}

export function merchantScope(merchant) {
    return {
        org_id: merchant.org_id,
        merchant_id: merchant.merchant_id,
    };
}

export function publicOk(payload = {}, requestId = createRequestId()) {
    return { ok: true, request_id: requestId, ...payload };
}

export function publicError(error, requestId = createRequestId()) {
    return {
        ok: false,
        error: error.code || 'internal_error',
        message: error.message || 'Unexpected server error',
        request_id: requestId,
    };
}

export function createHttpError(statusCode, code, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.code = code;
    return error;
}
