import { describe, expect, it, vi } from 'vitest';
import { createTimelineHandlers } from '../../src/cloud/merchantTimeline.js';
import { createSupabaseRestClient } from '../../src/cloud/supabaseRest.js';

function createMockStore(overrides = {}) {
    return {
        getMerchantPrintJob: vi.fn().mockImplementation(async ({ jobId }) => (
            jobId === 'missing-job'
                ? null
                : {
                    job_id: jobId,
                    org_id: 'org-1',
                    merchant_id: 'merchant-1',
                    node_id: 'node-secret',
                    printer_id: 'printer-secret',
                    file_id: 'file-1',
                    status: 'queued',
                }
        )),
        listMerchantJobEvents: vi.fn().mockResolvedValue([
            {
                event_id: 'event-2',
                org_id: 'org-1',
                merchant_id: 'merchant-1',
                job_id: 'job-1',
                order_id: 'order-1',
                batch_id: 'batch-1',
                file_id: 'file-1',
                slice_job_id: 'slice-1',
                event_type: 'job.routed',
                message: 'Job routed',
                payload: {
                    public_status: 'queued',
                    storage_path: 'internal/event/path',
                    node_id: 'node-secret',
                    printer_id: 'printer-secret',
                    spool_id: 'spool-secret',
                    selected_printer_id: 'printer-secret',
                },
                metadata: {
                    note: 'merchant visible',
                    command_id: 'command-secret',
                    local_printer_id: 'local-secret',
                },
                occurred_at: '2026-07-01T12:05:00.000Z',
                created_at: '2026-07-01T12:05:01.000Z',
            },
        ]),
        listMerchantJobArtifacts: vi.fn().mockResolvedValue([
            {
                artifact_id: 'artifact-1',
                org_id: 'org-1',
                merchant_id: 'merchant-1',
                job_id: 'job-1',
                file_id: 'file-1',
                artifact_type: 'print_file',
                storage_path: 'internal/artifact/path',
                provider: 'internal',
                payload: {
                    original_name: 'part.gcode.3mf',
                    storage_path: 'internal/payload/path',
                    printer_id: 'printer-secret',
                },
                metadata: {
                    note: 'merchant visible',
                    spool_id: 'spool-secret',
                },
                created_at: '2026-07-01T12:06:00.000Z',
            },
        ]),
        ...overrides,
    };
}

function createHandlers(overrides = {}) {
    const store = createMockStore(overrides.store);
    const authenticateMerchant = vi.fn().mockResolvedValue({
        merchant: {
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            status: 'active',
        },
    });

    return {
        store,
        authenticateMerchant,
        ...createTimelineHandlers({
            store,
            authenticateMerchant,
        }),
    };
}

function createMockResponse() {
    return {
        statusCode: 200,
        body: null,
        headers: {},
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        },
        setHeader(name, value) {
            this.headers[name] = value;
        },
        end(payload) {
            this.body = payload ? JSON.parse(payload) : null;
            return this;
        },
    };
}

async function importTimelineRoute(path, store = createMockStore()) {
    vi.resetModules();
    vi.doMock('../../src/cloud/supabaseRest.js', () => ({
        createSupabaseRestClient: vi.fn(() => store),
    }));
    const route = await import(path);
    vi.doUnmock('../../src/cloud/supabaseRest.js');
    return route.default;
}

describe('merchant print job timeline handlers', () => {
    it('lists merchant-scoped job events with filters, cursors, limits, and redacted payloads', async () => {
        const { listJobEvents, store } = createHandlers();

        const result = await listJobEvents({
            job_id: 'job-1',
            event_type: 'job.routed',
            order_id: 'order-1',
            batch_id: 'batch-1',
            file_id: 'file-1',
            slice_id: 'slice-1',
            cursor: '2026-07-01T12:10:00.000Z',
            limit: '1',
        });

        expect(result).toMatchObject({
            ok: true,
            job_id: 'job-1',
            events: [
                {
                    event_id: 'event-2',
                    job_id: 'job-1',
                    order_id: 'order-1',
                    batch_id: 'batch-1',
                    file_id: 'file-1',
                    slice_id: 'slice-1',
                    event_type: 'job.routed',
                    payload: { public_status: 'queued' },
                    metadata: { note: 'merchant visible' },
                },
            ],
            next_cursor: '2026-07-01T12:05:00.000Z',
        });
        expect(store.getMerchantPrintJob).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            jobId: 'job-1',
        });
        expect(store.listMerchantJobEvents).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            jobId: 'job-1',
            orderId: 'order-1',
            batchId: 'batch-1',
            fileId: 'file-1',
            sliceId: 'slice-1',
            eventType: 'job.routed',
            cursor: '2026-07-01T12:10:00.000Z',
            limit: 1,
        });
        expect(JSON.stringify(result)).not.toContain('org-1');
        expect(JSON.stringify(result)).not.toContain('merchant-1');
        expect(JSON.stringify(result)).not.toContain('node-secret');
        expect(JSON.stringify(result)).not.toContain('printer-secret');
        expect(JSON.stringify(result)).not.toContain('spool-secret');
        expect(JSON.stringify(result)).not.toContain('command-secret');
        expect(JSON.stringify(result)).not.toContain('storage_path');
        expect(JSON.stringify(result)).not.toContain('internal/event/path');
    });

    it('lists merchant-scoped job artifacts without exposing storage paths', async () => {
        const { listJobArtifacts, store } = createHandlers();

        const result = await listJobArtifacts({
            job_id: 'job-1',
            artifact_type: 'print_file',
            file_id: 'file-1',
            cursor: '2026-07-01T12:10:00.000Z',
            limit: 25,
        });

        expect(result).toMatchObject({
            ok: true,
            job_id: 'job-1',
            artifacts: [
                {
                    artifact_id: 'artifact-1',
                    job_id: 'job-1',
                    file_id: 'file-1',
                    artifact_type: 'print_file',
                    provider: 'internal',
                    payload: { original_name: 'part.gcode.3mf' },
                    metadata: { note: 'merchant visible' },
                },
            ],
        });
        expect(store.listMerchantJobArtifacts).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            jobId: 'job-1',
            fileId: 'file-1',
            artifactType: 'print_file',
            cursor: '2026-07-01T12:10:00.000Z',
            limit: 25,
        });
        expect(JSON.stringify(result)).not.toContain('storage_path');
        expect(JSON.stringify(result)).not.toContain('internal/artifact/path');
        expect(JSON.stringify(result)).not.toContain('internal/payload/path');
        expect(JSON.stringify(result)).not.toContain('printer-secret');
        expect(JSON.stringify(result)).not.toContain('spool-secret');
    });

    it('requires the print job to belong to the authenticated merchant before listing children', async () => {
        const { listJobEvents, listJobArtifacts, store } = createHandlers();

        await expect(listJobEvents({ job_id: 'missing-job' })).rejects.toMatchObject({
            statusCode: 404,
            code: 'print_job_not_found',
        });
        await expect(listJobArtifacts({ job_id: 'missing-job' })).rejects.toMatchObject({
            statusCode: 404,
            code: 'print_job_not_found',
        });
        expect(store.listMerchantJobEvents).not.toHaveBeenCalled();
        expect(store.listMerchantJobArtifacts).not.toHaveBeenCalled();
    });
});

describe('merchant timeline store helpers', () => {
    it('lists merchant job events with safe merchant, resource, event type, cursor, and limit filters', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify([{ event_id: 'event-1' }]),
        });
        const store = createSupabaseRestClient({
            supabaseUrl: 'https://example.supabase.co',
            serviceRoleKey: 'service_role',
            fetchImpl,
        });

        const rows = await store.listMerchantJobEvents({
            merchantId: 'merchant-1',
            jobId: 'job-1',
            orderId: 'order-1',
            batchId: 'batch-1',
            fileId: 'file-1',
            sliceId: 'slice-1',
            eventType: 'job.routed',
            cursor: '2026-07-01T12:10:00.000Z',
            limit: 250,
        });

        expect(rows).toEqual([{ event_id: 'event-1' }]);
        const requestUrl = new URL(fetchImpl.mock.calls[0][0]);
        expect(requestUrl.pathname).toBe('/rest/v1/merchant_job_events');
        expect(requestUrl.searchParams.get('merchant_id')).toBe('eq.merchant-1');
        expect(requestUrl.searchParams.get('job_id')).toBe('eq.job-1');
        expect(requestUrl.searchParams.get('order_id')).toBe('eq.order-1');
        expect(requestUrl.searchParams.get('batch_id')).toBe('eq.batch-1');
        expect(requestUrl.searchParams.get('file_id')).toBe('eq.file-1');
        expect(requestUrl.searchParams.get('slice_job_id')).toBe('eq.slice-1');
        expect(requestUrl.searchParams.get('event_type')).toBe('eq.job.routed');
        expect(requestUrl.searchParams.get('occurred_at')).toBe('lt.2026-07-01T12:10:00.000Z');
        expect(requestUrl.searchParams.get('order')).toBe('occurred_at.desc');
        expect(requestUrl.searchParams.get('limit')).toBe('100');
    });

    it('lists merchant job artifacts with safe job, file, artifact type, cursor, and limit filters', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify([{ artifact_id: 'artifact-1' }]),
        });
        const store = createSupabaseRestClient({
            supabaseUrl: 'https://example.supabase.co',
            serviceRoleKey: 'service_role',
            fetchImpl,
        });

        const rows = await store.listMerchantJobArtifacts({
            merchantId: 'merchant-1',
            jobId: 'job-1',
            fileId: 'file-1',
            artifactType: 'print_file',
            cursor: '2026-07-01T12:10:00.000Z',
            limit: 250,
        });

        expect(rows).toEqual([{ artifact_id: 'artifact-1' }]);
        const requestUrl = new URL(fetchImpl.mock.calls[0][0]);
        expect(requestUrl.pathname).toBe('/rest/v1/merchant_job_artifacts');
        expect(requestUrl.searchParams.get('merchant_id')).toBe('eq.merchant-1');
        expect(requestUrl.searchParams.get('job_id')).toBe('eq.job-1');
        expect(requestUrl.searchParams.get('file_id')).toBe('eq.file-1');
        expect(requestUrl.searchParams.get('artifact_type')).toBe('eq.print_file');
        expect(requestUrl.searchParams.get('created_at')).toBe('lt.2026-07-01T12:10:00.000Z');
        expect(requestUrl.searchParams.get('limit')).toBe('100');
    });
});

describe('merchant timeline public routes', () => {
    it('imports route handlers and returns v2 method envelopes', async () => {
        const eventsHandler = await importTimelineRoute('../../api/public/print-jobs/[job_id]/events.js');
        const artifactsHandler = await importTimelineRoute('../../api/public/print-jobs/[job_id]/artifacts.js');
        const eventsRes = createMockResponse();
        const artifactsRes = createMockResponse();

        await eventsHandler({ method: 'POST', headers: {}, query: { job_id: 'job-1' } }, eventsRes);
        await artifactsHandler({ method: 'POST', headers: {}, query: { job_id: 'job-1' } }, artifactsRes);

        expect(eventsRes.statusCode).toBe(405);
        expect(eventsRes.headers.Allow).toBe('GET');
        expect(eventsRes.body).toMatchObject({
            ok: false,
            error: 'method_not_allowed',
            request_id: expect.stringMatching(/^req_/),
        });
        expect(artifactsRes.statusCode).toBe(405);
        expect(artifactsRes.headers.Allow).toBe('GET');
        expect(artifactsRes.body).toMatchObject({
            ok: false,
            error: 'method_not_allowed',
            request_id: expect.stringMatching(/^req_/),
        });
    });
});
