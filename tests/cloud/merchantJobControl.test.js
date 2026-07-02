import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/cloud/merchantAuth.js', () => {
    class MerchantAuthError extends Error {
        constructor(statusCode, code) { super(code); this.statusCode = statusCode; this.code = code; }
    }
    return {
        MerchantAuthError,
        authenticateMerchantRequest: vi.fn(),
        requireScope: (apiKey, requiredScope) => {
            const scopes = Array.isArray(apiKey?.scopes) && apiKey.scopes.length > 0 ? apiKey.scopes : ['*'];
            if (!(scopes.includes('*') || scopes.includes(requiredScope))) {
                throw new MerchantAuthError(403, 'insufficient_scope');
            }
        },
    };
});

import { authenticateMerchantRequest } from '../../src/cloud/merchantAuth.js';
import { createMerchantPrintJobControlHandler } from '../../src/cloud/merchantLifecycleHandlers.js';

const merchant = { org_id: 'org-1', merchant_id: 'merchant-1', status: 'active' };

function mockRes() {
    const res = { statusCode: 200, headers: {}, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (p) => { res.body = p; return res; };
    res.setHeader = (k, v) => { res.headers[k] = v; };
    res.end = (p) => { if (p !== undefined) res.body = JSON.parse(p); return res; };
    return res;
}

function setup({ job, apiKey = undefined, ...storeOverrides } = {}) {
    const store = {
        getMerchantPrintJob: vi.fn().mockResolvedValue(job ?? null),
        createNodeCommand: vi.fn().mockImplementation(async (cmd) => ({
            command_id: 'cmd-1', status: 'queued', ...cmd,
        })),
        ...storeOverrides,
    };
    authenticateMerchantRequest.mockResolvedValue(apiKey !== undefined ? { merchant, apiKey } : { merchant });
    const handler = createMerchantPrintJobControlHandler({ store, pepper: 'p', now: () => new Date('2026-07-01T00:00:00Z') });
    return { store, handler };
}

describe('merchant print job control handler', () => {
    it('rejects unsupported methods and invalid actions', async () => {
        const { handler } = setup();
        const r = mockRes();
        await handler({ method: 'GET', headers: {}, body: {} }, r);
        expect(r.statusCode).toBe(405);

        const r2 = mockRes();
        await handler({ method: 'POST', headers: {}, body: { action: 'eject', job_id: 'job-1' } }, r2);
        expect(r2.statusCode).toBe(400);
        expect(r2.body).toMatchObject({ ok: false, error: 'invalid_control_action' });
    });

    it('returns 404 when the merchant does not own the job', async () => {
        const { handler } = setup({ job: null });
        const r = mockRes();
        await handler({ method: 'POST', headers: {}, body: { action: 'pause', job_id: 'job-1' } }, r);
        expect(r.statusCode).toBe(404);
        expect(r.body).toMatchObject({ ok: false, error: 'print_job_not_found' });
    });

    it('returns 409 when the job has not been routed to a printer', async () => {
        const { handler } = setup({ job: { job_id: 'job-1', node_id: null, printer_id: null } });
        const r = mockRes();
        await handler({ method: 'POST', headers: {}, body: { action: 'pause', job_id: 'job-1' } }, r);
        expect(r.statusCode).toBe(409);
        expect(r.body).toMatchObject({ ok: false, error: 'job_not_dispatched' });
    });

    it('enqueues a printer.pause command scoped to the merchant job and returns 202', async () => {
        const { store, handler } = setup({
            job: {
                job_id: 'job-1', node_id: 'node-1', printer_id: 'cloud-printer-1',
                routing_summary: { selected_local_printer_id: 'P1S-001' },
            },
        });
        const r = mockRes();
        await handler({ method: 'POST', headers: {}, body: { action: 'pause', job_id: 'job-1' } }, r);
        expect(r.statusCode).toBe(202);
        expect(r.body).toMatchObject({ ok: true, job_id: 'job-1', action: 'pause' });
        expect(store.createNodeCommand).toHaveBeenCalledWith(expect.objectContaining({
            org_id: 'org-1',
            node_id: 'node-1',
            printer_id: 'cloud-printer-1',
            job_id: 'job-1',
            command_type: 'printer.pause',
            payload: expect.objectContaining({ local_printer_id: 'P1S-001', action: 'pause' }),
        }));
    });

    it('maps stop/resume to the right command type', async () => {
        const { store, handler } = setup({
            job: { job_id: 'job-1', node_id: 'node-1', printer_id: 'p-1', routing_summary: {} },
        });
        for (const action of ['resume', 'stop']) {
            const r = mockRes();
            await handler({ method: 'POST', headers: {}, body: { action, job_id: 'job-1' } }, r);
            expect(r.statusCode).toBe(202);
            expect(store.createNodeCommand).toHaveBeenLastCalledWith(expect.objectContaining({
                command_type: action === 'resume' ? 'printer.resume' : 'printer.stop',
            }));
        }
    });

    it('rejects a key whose scopes do not include print:control', async () => {
        const { store, handler } = setup({
            job: { job_id: 'job-1', node_id: 'node-1', printer_id: 'p-1', routing_summary: {} },
            apiKey: { key_id: 'k-1', scopes: ['print:read'] },
        });
        const r = mockRes();
        await handler({ method: 'POST', headers: {}, body: { action: 'pause', job_id: 'job-1' } }, r);
        expect(r.statusCode).toBe(403);
        expect(r.body).toMatchObject({ ok: false, error: 'insufficient_scope' });
        expect(store.createNodeCommand).not.toHaveBeenCalled();
    });

    it('allows a key whose scopes include print:control', async () => {
        const { handler } = setup({
            job: { job_id: 'job-1', node_id: 'node-1', printer_id: 'p-1', routing_summary: {} },
            apiKey: { key_id: 'k-1', scopes: ['print:control', 'print:read'] },
        });
        const r = mockRes();
        await handler({ method: 'POST', headers: {}, body: { action: 'pause', job_id: 'job-1' } }, r);
        expect(r.statusCode).toBe(202);
    });
});
