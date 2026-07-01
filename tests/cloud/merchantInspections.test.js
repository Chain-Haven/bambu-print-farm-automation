import { describe, expect, it, vi } from 'vitest';
import { hashMerchantApiKey } from '../../src/cloud/merchantAuth.js';
import { createInspectionHandlers } from '../../src/cloud/merchantInspections.js';
import { createSupabaseRestClient } from '../../src/cloud/supabaseRest.js';

const now = () => new Date('2026-07-01T12:00:00.000Z');
const routeRawKey = 'pkx_live_inspection';
const routePepper = 'pepper';

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
                    status: 'completed',
                    options: { storage_path: 'internal/job/path' },
                }
        )),
        getMerchantInspectionByJob: vi.fn().mockResolvedValue(null),
        getMerchantInspection: vi.fn().mockImplementation(async ({ inspectionId }) => ({
            inspection_id: inspectionId,
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            job_id: 'job-1',
            provider: 'mock',
            status: 'manual_review',
            decision: null,
            metadata: {
                note: 'merchant visible',
                node_id: 'node-secret',
                printer_id: 'printer-secret',
                signedUrl: 'https://signed.example/inspection',
            },
        })),
        createMerchantInspection: vi.fn().mockImplementation(async (inspection) => ({
            ...inspection,
            created_at: inspection.created_at || '2026-07-01T12:00:00.000Z',
            updated_at: inspection.updated_at || '2026-07-01T12:00:00.000Z',
        })),
        updateMerchantInspection: vi.fn().mockImplementation(async ({ inspectionId, fields }) => ({
            inspection_id: inspectionId,
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            job_id: 'job-1',
            provider: 'mock',
            metadata: {
                note: 'merchant visible',
                storage_path: 'internal/inspection/path',
            },
            ...fields,
        })),
        recordMerchantJobEvent: vi.fn().mockImplementation(async (event) => event),
        ...overrides,
    };
}

function createHandlers(overrides = {}) {
    const store = createMockStore(overrides.store);
    const adapters = overrides.adapters || {
        inspection: {
            getInspection: vi.fn().mockResolvedValue({
                provider: 'mock',
                status: 'passed',
                decision: null,
                inspected_at: '2026-07-01T12:01:00.000Z',
                summary: 'Layer lines look good',
                findings: [{ code: 'ok' }],
                metadata: {
                    note: 'merchant visible',
                    node_id: 'node-secret',
                    printer_id: 'printer-secret',
                    storage_path: 'internal/adapter/path',
                    signedUrl: 'https://signed.example/adapter',
                },
            }),
        },
    };
    const authenticateMerchant = vi.fn().mockResolvedValue({
        merchant: {
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            status: 'active',
        },
    });

    return {
        store,
        adapters,
        authenticateMerchant,
        ...createInspectionHandlers({
            store,
            adapters,
            authenticateMerchant,
            now,
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

async function importInspectionRoute(path, store = createMockStore()) {
    vi.resetModules();
    vi.doMock('../../src/cloud/supabaseRest.js', () => ({
        createSupabaseRestClient: vi.fn(() => store),
    }));
    const route = await import(path);
    vi.doUnmock('../../src/cloud/supabaseRest.js');
    return route.default;
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

describe('merchant inspection handlers', () => {
    it('creates, fetches, and safely replays merchant-scoped inspections with redacted metadata', async () => {
        const createdInspection = {
            inspection_id: 'inspection-1',
            job_id: 'job-1',
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            provider: 'mock',
            status: 'passed',
            decision: null,
            inspected_at: '2026-07-01T12:01:00.000Z',
            metadata: {
                note: 'merchant visible',
                summary: 'Layer lines look good',
                findings: [{ code: 'ok' }],
                node_id: 'node-secret',
                printer_id: 'printer-secret',
                signedUrl: 'https://signed.example/inspection',
            },
            created_at: '2026-07-01T12:00:00.000Z',
            updated_at: '2026-07-01T12:00:00.000Z',
        };
        const { requestInspection, getInspectionForJob, store, adapters } = createHandlers({
            store: {
                getMerchantInspectionByJob: vi.fn()
                    .mockResolvedValueOnce(null)
                    .mockResolvedValueOnce(createdInspection)
                    .mockResolvedValueOnce(createdInspection),
                createMerchantInspection: vi.fn().mockResolvedValue(createdInspection),
            },
        });

        const created = await requestInspection({ job_id: 'job-1' });
        const fetched = await getInspectionForJob({ job_id: 'job-1' });
        const replayed = await requestInspection({ job_id: 'job-1' });

        expect(created).toMatchObject({
            ok: true,
            inspection_id: 'inspection-1',
            job_id: 'job-1',
            provider: 'mock',
            status: 'passed',
            inspected_at: '2026-07-01T12:01:00.000Z',
            metadata: {
                note: 'merchant visible',
                summary: 'Layer lines look good',
                findings: [{ code: 'ok' }],
            },
        });
        expect(fetched).toMatchObject({ inspection_id: 'inspection-1', status: 'passed' });
        expect(replayed).toMatchObject({ inspection_id: 'inspection-1', status: 'passed' });
        expect(created._http_status).toBe(201);
        expect(fetched._http_status).toBeUndefined();
        expect(replayed._http_status).toBe(200);
        expect(adapters.inspection.getInspection).toHaveBeenCalledTimes(1);
        expect(store.createMerchantInspection).toHaveBeenCalledTimes(1);
        expect(store.getMerchantPrintJob).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            jobId: 'job-1',
        });
        expect(store.recordMerchantJobEvent.mock.calls.map(([event]) => event.event_type)).toEqual([
            'inspection.requested',
            'inspection.completed',
        ]);
        expect(JSON.stringify({ created, fetched, replayed })).not.toContain('org-1');
        expect(JSON.stringify({ created, fetched, replayed })).not.toContain('merchant-1');
        expect(JSON.stringify({ created, fetched, replayed })).not.toContain('node-secret');
        expect(JSON.stringify({ created, fetched, replayed })).not.toContain('printer-secret');
        expect(JSON.stringify({ created, fetched, replayed })).not.toContain('signed.example');
    });

    it('falls back to manual review when the inspection adapter is unavailable and event writes fail', async () => {
        const { requestInspection, store } = createHandlers({
            adapters: {},
            store: {
                recordMerchantJobEvent: vi.fn().mockRejectedValue(new Error('event write failed')),
            },
        });

        const result = await requestInspection({ job_id: 'job-1' });

        expect(result).toMatchObject({
            ok: true,
            job_id: 'job-1',
            provider: 'manual_review',
            status: 'manual_review',
            metadata: { reason: 'inspection_adapter_unavailable' },
        });
        expect(store.createMerchantInspection).toHaveBeenCalledWith(expect.objectContaining({
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            job_id: 'job-1',
            provider: 'manual_review',
            status: 'manual_review',
        }));
        expect(store.recordMerchantJobEvent).toHaveBeenCalled();
    });

    it('returns not found for missing jobs or missing existing inspections before creating rows', async () => {
        const { requestInspection, getInspectionForJob, store } = createHandlers({
            store: {
                getMerchantPrintJob: vi.fn().mockResolvedValue(null),
            },
        });

        await expect(requestInspection({ job_id: 'missing-job' })).rejects.toMatchObject({
            statusCode: 404,
            code: 'print_job_not_found',
        });
        await expect(getInspectionForJob({ job_id: 'missing-job' })).rejects.toMatchObject({
            statusCode: 404,
            code: 'print_job_not_found',
        });
        expect(store.createMerchantInspection).not.toHaveBeenCalled();
    });

    it('sets merchant inspection decisions by inspection_id without exposing internal fields', async () => {
        const { acceptInspection, rejectInspection, manualReviewInspection, store } = createHandlers();

        const accepted = await acceptInspection({ inspection_id: 'inspection-1' });
        const rejected = await rejectInspection({ inspection_id: 'inspection-1' });
        const manualReview = await manualReviewInspection({ inspection_id: 'inspection-1' });

        expect(accepted).toMatchObject({ status: 'passed', decision: 'accepted' });
        expect(rejected).toMatchObject({ status: 'failed', decision: 'rejected' });
        expect(manualReview).toMatchObject({ status: 'manual_review', decision: 'manual_review' });
        expect(store.getMerchantInspection).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            inspectionId: 'inspection-1',
        });
        expect(store.updateMerchantInspection.mock.calls.map(([call]) => call.fields)).toEqual([
            expect.objectContaining({ status: 'passed', decision: 'accepted' }),
            expect.objectContaining({ status: 'failed', decision: 'rejected' }),
            expect.objectContaining({ status: 'manual_review', decision: 'manual_review' }),
        ]);
        expect(store.recordMerchantJobEvent.mock.calls.map(([event]) => event.event_type)).toContain('inspection.decision');
        expect(JSON.stringify({ accepted, rejected, manualReview })).not.toContain('internal/inspection/path');
        expect(JSON.stringify({ accepted, rejected, manualReview })).not.toContain('org-1');
        expect(JSON.stringify({ accepted, rejected, manualReview })).not.toContain('merchant-1');
    });
});

describe('merchant inspection store helpers', () => {
    it('gets and lists merchant inspections with merchant, id, job, status, and limit filters', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify([{ inspection_id: 'inspection-1' }]),
        });
        const store = createSupabaseRestClient({
            supabaseUrl: 'https://example.supabase.co',
            serviceRoleKey: 'service_role',
            fetchImpl,
        });

        await store.getMerchantInspection({ merchantId: 'merchant-1', inspectionId: 'inspection-1' });
        await store.listMerchantInspections({
            merchantId: 'merchant-1',
            jobId: 'job-1',
            orderId: 'order-1',
            status: 'manual_review',
            limit: 250,
        });

        const getUrl = new URL(fetchImpl.mock.calls[0][0]);
        const listUrl = new URL(fetchImpl.mock.calls[1][0]);
        expect(getUrl.pathname).toBe('/rest/v1/merchant_inspections');
        expect(getUrl.searchParams.get('merchant_id')).toBe('eq.merchant-1');
        expect(getUrl.searchParams.get('inspection_id')).toBe('eq.inspection-1');
        expect(getUrl.searchParams.get('limit')).toBe('1');
        expect(listUrl.pathname).toBe('/rest/v1/merchant_inspections');
        expect(listUrl.searchParams.get('merchant_id')).toBe('eq.merchant-1');
        expect(listUrl.searchParams.get('job_id')).toBe('eq.job-1');
        expect(listUrl.searchParams.get('order_id')).toBe('eq.order-1');
        expect(listUrl.searchParams.get('status')).toBe('eq.manual_review');
        expect(listUrl.searchParams.get('limit')).toBe('100');
    });
});

describe('merchant inspection public routes', () => {
    it('imports route handlers and returns v2 method envelopes', async () => {
        const inspectionHandler = await importInspectionRoute('../../api/public/print-jobs/[job_id]/inspection.js');
        const acceptHandler = await importInspectionRoute('../../api/public/inspections/[inspection_id]/accept.js');
        const rejectHandler = await importInspectionRoute('../../api/public/inspections/[inspection_id]/reject.js');
        const manualReviewHandler = await importInspectionRoute('../../api/public/inspections/[inspection_id]/manual-review.js');
        const responses = [createMockResponse(), createMockResponse(), createMockResponse(), createMockResponse()];

        await inspectionHandler({ method: 'DELETE', headers: {}, query: { job_id: 'job-1' } }, responses[0]);
        await acceptHandler({ method: 'GET', headers: {}, query: { inspection_id: 'inspection-1' } }, responses[1]);
        await rejectHandler({ method: 'GET', headers: {}, query: { inspection_id: 'inspection-1' } }, responses[2]);
        await manualReviewHandler({ method: 'GET', headers: {}, query: { inspection_id: 'inspection-1' } }, responses[3]);

        expect(responses[0].statusCode).toBe(405);
        expect(responses[0].headers.Allow).toBe('GET, POST');
        expect(responses[0].body).toMatchObject({ ok: false, error: 'method_not_allowed' });
        for (const response of responses.slice(1)) {
            expect(response.statusCode).toBe(405);
            expect(response.headers.Allow).toBe('POST');
            expect(response.body).toMatchObject({ ok: false, error: 'method_not_allowed' });
        }
    });

    it('returns 404 envelopes when a route-level inspection does not exist', async () => {
        const originalPepper = process.env.MERCHANT_API_KEY_PEPPER;
        process.env.MERCHANT_API_KEY_PEPPER = routePepper;
        const store = createAuthenticatedRouteStore({
            getMerchantInspectionByJob: vi.fn().mockResolvedValue(null),
        });
        const handler = await importInspectionRoute('../../api/public/print-jobs/[job_id]/inspection.js', store);
        const res = createMockResponse();

        try {
            await handler({
                method: 'GET',
                headers: { authorization: `Bearer ${routeRawKey}` },
                query: { job_id: 'job-1' },
            }, res);
        } finally {
            if (originalPepper === undefined) delete process.env.MERCHANT_API_KEY_PEPPER;
            else process.env.MERCHANT_API_KEY_PEPPER = originalPepper;
        }

        expect(res.statusCode).toBe(404);
        expect(res.body).toMatchObject({
            ok: false,
            error: 'inspection_not_found',
            request_id: expect.stringMatching(/^req_/),
        });
    });
});
