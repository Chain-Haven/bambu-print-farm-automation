import crypto from 'node:crypto';

const PUBLIC_SAFE_ERRORS = new WeakSet();

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
    return { ...payload, ok: true, request_id: requestId };
}

export function publicError(error, requestId = createRequestId()) {
    const isObjectError = error !== null && typeof error === 'object';
    const isClientError = (
        isObjectError
        && PUBLIC_SAFE_ERRORS.has(error)
        && Number.isInteger(error.statusCode)
        && error.statusCode >= 400
        && error.statusCode < 500
        && typeof error.code === 'string'
        && error.code.length > 0
    );

    if (!isClientError) {
        return {
            ok: false,
            error: 'internal_error',
            message: 'Unexpected server error',
            request_id: requestId,
        };
    }

    return {
        ok: false,
        error: error.code,
        message: error.message || 'Unexpected server error',
        request_id: requestId,
    };
}

export function createHttpError(statusCode, code, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.code = code;
    PUBLIC_SAFE_ERRORS.add(error);
    return error;
}
