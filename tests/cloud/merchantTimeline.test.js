import { describe, expect, it, vi } from 'vitest';
import { hashMerchantApiKey } from '../../src/cloud/merchantAuth.js';
import { createTimelineHandlers } from '../../src/cloud/merchantTimeline.js';
import { createSupabaseRestClient } from '../../src/cloud/supabaseRest.js';

const routeRawKey = 'pkx_live_secret';
const routePepper = 'pepper';

function decodeCursor(cursor) {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
}

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
                    status: 'safe public status',
                    message: 'safe public message',
                    node: 'node-secret',
                    printer: 'printer-secret',
                    spool: 'spool-secret',
                    storage: 'internal-storage',
                    storagePath: 'internal/camel/path',
                    signed_url: 'https://signed.example/secret',
                    signedUrl: 'https://signed.example/camel',
                    download_url: 'https://signed.example/download',
                    downloadUrl: 'https://signed.example/download-camel',
                    upload_url: 'https://signed.example/upload',
                    uploadUrl: 'https://signed.example/upload-camel',
                    url: 'https://signed.example/generic',
                    href: 'https://signed.example/href',
                    secret: 'secret-value',
                    api_key: 'api-key-secret',
                    apiKey: 'api-key-camel',
                    authorization: 'Bearer secret',
                    password: 'password-secret',
                    token: 'token-secret',
                    tokenHash: 'token-hash-secret',
                    storage_path: 'internal/event/path',
                    node_id: 'node-secret',
                    printer_id: 'printer-secret',
                    spool_id: 'spool-secret',
                    selected_printer_id: 'printer-secret',
                },
                metadata: {
                    note: 'merchant visible',
                    signedUrl: 'https://signed.example/meta',
                    downloadUrl: 'https://signed.example/meta-download',
                    url: 'https://signed.example/meta-generic',
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
                    signedUrl: 'https://signed.example/artifact',
                    download_url: 'https://signed.example/artifact-download',
                    uploadUrl: 'https://signed.example/artifact-upload',
                    url: 'https://signed.example/artifact-generic',
                    href: 'https://signed.example/artifact-href',
                    apiKey: 'artifact-api-key',
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

function createAuthenticatedRouteStore(overrides = {}) {
    const keyHash = hashMerchantApiKey(routeRawKey, routePepper);
    return createMockStore({
        findMerchantApiKeyByHash: vi.fn().mockResolvedValue({
            key_id: 'key-1',
            key_hash: keyHash,
            merchant_id: 'merchant-1',
            org_id: 'org-1',
        }),
        findMerchantById: vi.fn().mockResolvedValue({
            merchant_id: 'merchant-1',
            org_id: 'org-1',
            status: 'active',
        }),
        touchMerchantApiKey: vi.fn().mockResolvedValue(null),
        ...overrides,
    });
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
                    payload: {
                        public_status: 'queued',
                        status: 'safe public status',
                        message: 'safe public message',
                    },
                    metadata: { note: 'merchant visible' },
                },
            ],
            next_cursor: expect.any(String),
        });
        expect(decodeCursor(result.next_cursor)).toEqual({
            ts: '2026-07-01T12:05:00.000Z',
            id: 'event-2',
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
            cursor: {
                ts: '2026-07-01T12:10:00.000Z',
                id: null,
            },
            limit: 1,
        });
        expect(JSON.stringify(result)).not.toContain('org-1');
        expect(JSON.stringify(result)).not.toContain('merchant-1');
        expect(JSON.stringify(result)).not.toContain('node-secret');
        expect(JSON.stringify(result)).not.toContain('printer-secret');
        expect(JSON.stringify(result)).not.toContain('spool-secret');
        expect(JSON.stringify(result)).not.toContain('command-secret');
        expect(JSON.stringify(result)).not.toContain('storage_path');
        expect(JSON.stringify(result)).not.toContain('internal-storage');
        expect(JSON.stringify(result)).not.toContain('internal/camel/path');
        expect(JSON.stringify(result)).not.toContain('signed.example');
        expect(JSON.stringify(result)).not.toContain('secret-value');
        expect(JSON.stringify(result)).not.toContain('api-key-secret');
        expect(JSON.stringify(result)).not.toContain('api-key-camel');
        expect(JSON.stringify(result)).not.toContain('Bearer secret');
        expect(JSON.stringify(result)).not.toContain('password-secret');
        expect(JSON.stringify(result)).not.toContain('token-secret');
        expect(JSON.stringify(result)).not.toContain('token-hash-secret');
        expect(JSON.stringify(result)).not.toContain('internal/event/path');
    });

    it('rejects malformed raw cursors before querying timeline children', async () => {
        const { listJobEvents, listJobArtifacts, store } = createHandlers();

        await expect(listJobEvents({ job_id: 'job-1', cursor: 'not-a-date' })).rejects.toMatchObject({
            statusCode: 400,
            code: 'invalid_payload',
        });
        await expect(listJobArtifacts({ job_id: 'job-1', cursor: 'also-not-a-date' })).rejects.toMatchObject({
            statusCode: 400,
            code: 'invalid_payload',
        });
        expect(store.listMerchantJobEvents).not.toHaveBeenCalled();
        expect(store.listMerchantJobArtifacts).not.toHaveBeenCalled();
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
            cursor: {
                ts: '2026-07-01T12:10:00.000Z',
                id: null,
            },
            limit: 25,
        });
        expect(JSON.stringify(result)).not.toContain('storage_path');
        expect(JSON.stringify(result)).not.toContain('internal/artifact/path');
        expect(JSON.stringify(result)).not.toContain('internal/payload/path');
        expect(JSON.stringify(result)).not.toContain('printer-secret');
        expect(JSON.stringify(result)).not.toContain('spool-secret');
        expect(JSON.stringify(result)).not.toContain('signed.example');
        expect(JSON.stringify(result)).not.toContain('artifact-api-key');
    });

    it('returns stable cursors that preserve same-timestamp page boundaries', async () => {
        const { listJobEvents, store } = createHandlers({
            store: {
                listMerchantJobEvents: vi.fn()
                    .mockResolvedValueOnce([
                        {
                            event_id: 'event-b',
                            job_id: 'job-1',
                            event_type: 'job.progress',
                            occurred_at: '2026-07-01T12:05:00.000Z',
                        },
                    ])
                    .mockResolvedValueOnce([
                        {
                            event_id: 'event-a',
                            job_id: 'job-1',
                            event_type: 'job.progress',
                            occurred_at: '2026-07-01T12:05:00.000Z',
                        },
                    ]),
            },
        });

        const first = await listJobEvents({ job_id: 'job-1', limit: 1 });
        const second = await listJobEvents({ job_id: 'job-1', limit: 1, cursor: first.next_cursor });

        expect(decodeCursor(first.next_cursor)).toEqual({
            ts: '2026-07-01T12:05:00.000Z',
            id: 'event-b',
        });
        expect(second.events[0]).toMatchObject({
            event_id: 'event-a',
            occurred_at: '2026-07-01T12:05:00.000Z',
        });
        expect(store.listMerchantJobEvents.mock.calls[1][0]).toMatchObject({
            cursor: {
                ts: '2026-07-01T12:05:00.000Z',
                id: 'event-b',
            },
        });
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
            cursor: {
                ts: '2026-07-01T12:10:00.000Z',
                id: 'event-9',
            },
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
        expect(requestUrl.searchParams.get('or')).toBe(
            '(occurred_at.lt.2026-07-01T12:10:00.000Z,and(occurred_at.eq.2026-07-01T12:10:00.000Z,event_id.lt.event-9))',
        );
        expect(requestUrl.searchParams.get('order')).toBe('occurred_at.desc,event_id.desc');
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
            cursor: {
                ts: '2026-07-01T12:10:00.000Z',
                id: 'artifact-9',
            },
            limit: 250,
        });

        expect(rows).toEqual([{ artifact_id: 'artifact-1' }]);
        const requestUrl = new URL(fetchImpl.mock.calls[0][0]);
        expect(requestUrl.pathname).toBe('/rest/v1/merchant_job_artifacts');
        expect(requestUrl.searchParams.get('merchant_id')).toBe('eq.merchant-1');
        expect(requestUrl.searchParams.get('job_id')).toBe('eq.job-1');
        expect(requestUrl.searchParams.get('file_id')).toBe('eq.file-1');
        expect(requestUrl.searchParams.get('artifact_type')).toBe('eq.print_file');
        expect(requestUrl.searchParams.get('or')).toBe(
            '(created_at.lt.2026-07-01T12:10:00.000Z,and(created_at.eq.2026-07-01T12:10:00.000Z,artifact_id.lt.artifact-9))',
        );
        expect(requestUrl.searchParams.get('order')).toBe('created_at.desc,artifact_id.desc');
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

    it('returns public-safe 400 envelopes for invalid event and artifact cursors', async () => {
        const previousPepper = process.env.MERCHANT_API_KEY_PEPPER;
        process.env.MERCHANT_API_KEY_PEPPER = routePepper;
        const store = createAuthenticatedRouteStore();
        const eventsHandler = await importTimelineRoute('../../api/public/print-jobs/[job_id]/events.js', store);
        const artifactsHandler = await importTimelineRoute('../../api/public/print-jobs/[job_id]/artifacts.js', store);
        const eventsRes = createMockResponse();
        const artifactsRes = createMockResponse();

        try {
            await eventsHandler({
                method: 'GET',
                headers: { authorization: `Bearer ${routeRawKey}` },
                query: { job_id: 'job-1', cursor: 'not-a-date' },
            }, eventsRes);
            await artifactsHandler({
                method: 'GET',
                headers: { authorization: `Bearer ${routeRawKey}` },
                query: { job_id: 'job-1', cursor: 'not-a-date' },
            }, artifactsRes);
        } finally {
            if (previousPepper === undefined) {
                delete process.env.MERCHANT_API_KEY_PEPPER;
            } else {
                process.env.MERCHANT_API_KEY_PEPPER = previousPepper;
            }
        }

        expect(eventsRes.statusCode).toBe(400);
        expect(eventsRes.body).toMatchObject({
            ok: false,
            error: 'invalid_payload',
            message: 'cursor must be a valid timeline cursor',
            request_id: expect.stringMatching(/^req_/),
        });
        expect(artifactsRes.statusCode).toBe(400);
        expect(artifactsRes.body).toMatchObject({
            ok: false,
            error: 'invalid_payload',
            message: 'cursor must be a valid timeline cursor',
            request_id: expect.stringMatching(/^req_/),
        });
        expect(store.listMerchantJobEvents).not.toHaveBeenCalled();
        expect(store.listMerchantJobArtifacts).not.toHaveBeenCalled();
    });
});
