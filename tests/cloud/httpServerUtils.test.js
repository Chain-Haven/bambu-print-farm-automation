import { describe, expect, it, vi } from 'vitest';
import {
    CORS_HEADERS,
    InvalidJsonError,
    getRequestId,
    methodNotAllowed,
    sendHandlerError,
    sendJson,
    withCors,
} from '../../src/cloud/httpServerUtils.js';
import { parseJsonBody } from '../../src/cloud/agentProtocol.js';

function createMockResponse() {
    const res = {
        statusCode: 200,
        headers: {},
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        },
        setHeader(key, value) {
            this.headers[key] = value;
        },
        end(payload) {
            if (payload !== undefined) this.body = JSON.parse(payload);
            return this;
        },
    };
    return res;
}

describe('httpServerUtils', () => {
    it('methodNotAllowed returns a unified 405 with message + request_id + Allow header', () => {
        const res = createMockResponse();
        methodNotAllowed(res, 'POST', 'req_123');
        expect(res.statusCode).toBe(405);
        expect(res.headers.Allow).toBe('POST');
        expect(res.body).toEqual({
            ok: false,
            error: 'method_not_allowed',
            message: 'Method not allowed',
            request_id: 'req_123',
        });
    });

    it('sendHandlerError sanitizes 500s and never leaks error.message', () => {
        const res = createMockResponse();
        sendHandlerError(res, new Error('postgres://user:pass@host/db failed'), 'req_500');
        expect(res.statusCode).toBe(500);
        expect(res.body.ok).toBe(false);
        expect(res.body.error).toBe('internal_error');
        expect(res.body.message).toBe('Unexpected server error');
        expect(res.body.request_id).toBe('req_500');
        expect(JSON.stringify(res.body)).not.toContain('postgres://');
        expect(JSON.stringify(res.body)).not.toContain('user:pass');
    });

    it('sendHandlerError maps InvalidJsonError to 400 invalid_json', () => {
        const res = createMockResponse();
        sendHandlerError(res, new InvalidJsonError(), 'req_json');
        expect(res.statusCode).toBe(400);
        expect(res.body).toMatchObject({ ok: false, error: 'invalid_json', request_id: 'req_json' });
    });

    it('sendHandlerError preserves code + message for 4xx client errors', () => {
        const res = createMockResponse();
        const err = Object.assign(new Error('Merchant not active'), { statusCode: 403, code: 'merchant_not_active' });
        sendHandlerError(res, err, 'req_403');
        expect(res.statusCode).toBe(403);
        expect(res.body).toMatchObject({
            ok: false,
            error: 'merchant_not_active',
            message: 'Merchant not active',
            request_id: 'req_403',
        });
    });

    it('getRequestId reuses an inbound x-request-id and otherwise mints one', () => {
        expect(getRequestId({ headers: { 'x-request-id': 'client-abc' } })).toBe('client-abc');
        expect(getRequestId({ headers: {} })).toMatch(/^req_[0-9a-f-]{36}$/);
    });

    it('parseJsonBody throws InvalidJsonError on malformed JSON', () => {
        expect(() => parseJsonBody('{ not valid json')).toThrow(InvalidJsonError);
        // Empty/non-string bodies still collapse to {} (no false 400s).
        expect(parseJsonBody('')).toEqual({});
        expect(parseJsonBody(undefined)).toEqual({});
    });

    it('withCors sets CORS headers and answers OPTIONS preflight with 204', async () => {
        const inner = vi.fn();
        const wrapped = withCors(inner);
        const res = createMockResponse();
        let ended = false;
        res.end = () => { ended = true; return res; };
        res.status = (code) => { res.statusCode = code; return res; };

        wrapped({ method: 'OPTIONS', headers: {} }, res);
        expect(ended).toBe(true);
        expect(res.statusCode).toBe(204);
        expect(res.headers['Access-Control-Allow-Origin']).toBe(CORS_HEADERS['Access-Control-Allow-Origin']);
        expect(res.headers['Access-Control-Allow-Headers']).toContain('Authorization');
        expect(inner).not.toHaveBeenCalled();
    });

    it('withCors delegates non-OPTIONS requests and still attaches headers', async () => {
        const inner = vi.fn((req, res) => sendJson(res, 200, { ok: true }));
        const wrapped = withCors(inner);
        const res = createMockResponse();
        wrapped({ method: 'GET', headers: {} }, res);
        expect(inner).toHaveBeenCalledTimes(1);
        expect(res.headers['Access-Control-Allow-Origin']).toBe('*');
        expect(res.body).toEqual({ ok: true });
    });
});
