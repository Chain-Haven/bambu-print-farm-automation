// Shared HTTP response helpers for the cloud API surfaces (public merchant,
// cloud admin, edge agent). Centralizes the v2-style JSON shape —
// { ok, error, message, request_id } — so every surface returns consistent,
// sanitized errors with correlation ids and never leaks error.message on 500s.
import crypto from 'node:crypto';
import { createRequestId, publicOk } from './merchantApiV2.js';

export { createRequestId, publicOk };

const SAFE_ERROR_DETAIL_MAX_LENGTH = 220;

export function sendJson(res, statusCode, payload) {
    if (typeof res.status === 'function' && typeof res.json === 'function') {
        return res.status(statusCode).json(payload);
    }
    res.statusCode = statusCode;
    if (typeof res.setHeader === 'function') {
        res.setHeader('Content-Type', 'application/json');
    }
    return res.end(JSON.stringify(payload));
}

// Reuse an inbound x-request-id when present so callers can correlate logs;
// otherwise mint a fresh one.
export function getRequestId(req) {
    const headers = req?.headers || {};
    const inbound = headers['x-request-id'] || headers['X-Request-Id'];
    if (typeof inbound === 'string' && inbound.trim() !== '') return inbound.trim();
    return createRequestId();
}

export function statusForError(error, fallback = 500) {
    return Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : fallback;
}

export class InvalidJsonError extends Error {
    constructor() {
        super('Malformed JSON body');
        this.name = 'InvalidJsonError';
        this.statusCode = 400;
        this.code = 'invalid_json';
    }
}

export function methodNotAllowed(res, methods, requestId) {
    if (typeof res.setHeader === 'function') res.setHeader('Allow', methods);
    return sendJson(res, 405, {
        ok: false,
        error: 'method_not_allowed',
        message: 'Method not allowed',
        request_id: requestId,
    });
}

// One error sender for handler catch blocks. Maps InvalidJsonError -> 400,
// client errors (4xx with a code) -> their status/code/message, and everything
// else -> a sanitized 500 that never includes error.message.
export function sendHandlerError(res, error, requestId, { fallbackCode = 'internal_error' } = {}) {
    if (error instanceof InvalidJsonError) {
        return sendJson(res, 400, {
            ok: false,
            error: 'invalid_json',
            message: 'Malformed JSON body',
            request_id: requestId,
        });
    }

    const status = statusForError(error);
    if (status >= 500) {
        return sendJson(res, status, {
            ok: false,
            error: fallbackCode,
            message: 'Unexpected server error',
            request_id: requestId,
        });
    }

    const code = (typeof error?.code === 'string' && error.code.length > 0) ? error.code : fallbackCode;
    return sendJson(res, status, {
        ok: false,
        error: code,
        message: error?.message || 'Unexpected server error',
        request_id: requestId,
    });
}

// Build a client error response without throwing (for handlers that send
// explicit 4xx and still want the unified shape).
export function sendClientError(res, statusCode, code, message, requestId) {
    return sendJson(res, statusCode, {
        ok: false,
        error: code,
        message: message || 'Unexpected server error',
        request_id: requestId,
    });
}

// Redact secrets from operational error messages before they reach logs.
export function sanitizeOperationalError(error) {
    return String(error?.message || error || 'unknown error')
        .replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/gi, 'postgres://[redacted]')
        .replace(/\b(password|pass|pwd)=([^&\s]+)/gi, '$1=[redacted]')
        .replace(/\b(apikey|authorization|bearer)\s*[:=]\s*[^\s,'"<>]+/gi, '$1=[redacted]')
        .replace(/pkx_(?:live|setup|node|admin_reset|admin_session|muser_session)_[A-Za-z0-9_-]+/g, 'pkx_[redacted]')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, SAFE_ERROR_DETAIL_MAX_LENGTH);
}

// CORS for Vercel serverless functions. Local server.js sets CORS globally;
// the deployed api/** functions need this wrapper so browser clients on other
// origins can read public/spec/health routes and preflight succeeds.
export const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Request-Id, X-Cloud-Admin-Token',
    'Access-Control-Max-Age': '86400',
};

export function applyCorsHeaders(res) {
    if (typeof res.setHeader !== 'function') return;
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
        try {
            res.setHeader(key, value);
        } catch {
            /* headers may already be set */
        }
    }
}

export function withCors(handler) {
    return function corsHandler(req, res) {
        applyCorsHeaders(res);
        if (req.method === 'OPTIONS') {
            if (typeof res.status === 'function') return res.status(204).end();
            res.statusCode = 204;
            return res.end();
        }
        return handler(req, res);
    };
}

// Default OPTIONS preflight response for handlers that don't use withCors but
// still want to acknowledge a preflight without 405ing.
export function handleOptionsPreflight(req, res) {
    if (req.method === 'OPTIONS') {
        applyCorsHeaders(res);
        if (typeof res.status === 'function') return res.status(204).end();
        res.statusCode = 204;
        return res.end();
    }
    return false;
}

export { crypto };
