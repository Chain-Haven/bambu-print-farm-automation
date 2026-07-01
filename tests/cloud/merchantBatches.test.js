import { describe, expect, it, vi } from 'vitest';
import { createBatchHandlers } from '../../src/cloud/merchantBatches.js';
import { createSupabaseRestClient } from '../../src/cloud/supabaseRest.js';

const now = () => new Date('2026-07-01T12:00:00.000Z');

function createMockStore(overrides = {}) {
    const batches = new Map(Object.entries({
        'batch-1': {
            batch_id: 'batch-1',
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            name: 'PLA queue',
            strategy: 'batch_by_material',
            status: 'queued',
            metadata: {
                note: 'merchant visible',
                node_id: 'node-secret',
                printer_id: 'printer-secret',
            },
            created_at: '2026-07-01T12:00:00.000Z',
        },
        'completed-batch': {
            batch_id: 'completed-batch',
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            name: 'Done batch',
            strategy: 'batch_by_material',
            status: 'completed',
        },
        'canceled-batch': {
            batch_id: 'canceled-batch',
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            name: 'Canceled batch',
            strategy: 'batch_by_material',
            status: 'canceled',
        },
    }));
    const batchItems = new Map([
        ['batch-1', [
            {
                batch_item_id: 'item-existing-1',
                org_id: 'org-1',
                merchant_id: 'merchant-1',
                batch_id: 'batch-1',
                file_id: 'file-1',
                quantity: 2,
                metadata: { note: 'item visible', spool_id: 'spool-secret' },
            },
        ]],
    ]);

    return {
        createMerchantBatch: vi.fn().mockImplementation(async (batch) => {
            const row = {
                batch_id: batch.batch_id || 'batch-1',
                org_id: 'org-1',
                merchant_id: 'merchant-1',
                created_at: '2026-07-01T12:00:00.000Z',
                ...batch,
            };
            batches.set(row.batch_id, row);
            return row;
        }),
        getMerchantBatch: vi.fn().mockImplementation(async ({ batchId }) => batches.get(batchId) || null),
        updateMerchantBatch: vi.fn().mockImplementation(async ({ batchId, fields }) => {
            const current = batches.get(batchId);
            if (!current) return null;
            const updated = { ...current, ...fields };
            batches.set(batchId, updated);
            return updated;
        }),
        createMerchantBatchItem: vi.fn().mockImplementation(async (item) => {
            const row = {
                batch_item_id: item.batch_item_id || `item-${item.file_id || item.job_id || '1'}`,
                org_id: 'org-1',
                merchant_id: 'merchant-1',
                ...item,
            };
            batchItems.set(item.batch_id, [...(batchItems.get(item.batch_id) || []), row]);
            return row;
        }),
        listMerchantBatchItems: vi.fn().mockImplementation(async ({ batchId }) => batchItems.get(batchId) || []),
        createNodeCommand: vi.fn(),
        cancelNodeCommand: vi.fn(),
        sendPrinterCommand: vi.fn(),
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
        ...createBatchHandlers({
            store,
            authenticateMerchant,
            now,
        }),
    };
}

function createScopedBody(body) {
    return Object.defineProperties({ ...body }, {
        org_id: {
            enumerable: true,
            get() {
                throw new Error('body org_id was read');
            },
        },
        merchant_id: {
            enumerable: true,
            get() {
                throw new Error('body merchant_id was read');
            },
        },
    });
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

async function importBatchRoute(path, store = createMockStore()) {
    vi.resetModules();
    vi.doMock('../../src/cloud/supabaseRest.js', () => ({
        createSupabaseRestClient: vi.fn(() => store),
    }));
    const route = await import(path);
    vi.doUnmock('../../src/cloud/supabaseRest.js');
    return route.default;
}

describe('merchant batch handlers', () => {
    it('creates and reads merchant-scoped batches with items and safe public projections', async () => {
        const { createBatch, getBatch, store } = createHandlers();

        const created = await createBatch(createScopedBody({
            name: 'PLA queue',
            strategy: 'batch_by_material',
            status: 'queued',
            settings: { max_jobs: 10 },
            metadata: {
                note: 'merchant visible',
                node_id: 'node-secret',
                printer_id: 'printer-secret',
                spool_id: 'spool-secret',
            },
            items: [
                {
                    order_id: 'order-1',
                    file_id: 'file-1',
                    quantity: 2,
                    metadata: { note: 'first item', storage_path: 'internal/item/path' },
                },
                {
                    job_id: 'job-1',
                    quantity: 1,
                },
            ],
        }));
        const fetched = await getBatch({ batch_id: created.batch_id });

        expect(created).toMatchObject({
            ok: true,
            batch_id: expect.any(String),
            name: 'PLA queue',
            strategy: 'batch_by_material',
            status: 'queued',
            item_count: 2,
            metadata: { note: 'merchant visible' },
        });
        expect(fetched).toMatchObject({
            ok: true,
            batch_id: created.batch_id,
            item_count: expect.any(Number),
        });
        expect(JSON.stringify({ created, fetched })).not.toContain('org-1');
        expect(JSON.stringify({ created, fetched })).not.toContain('merchant-1');
        expect(JSON.stringify({ created, fetched })).not.toContain('node-secret');
        expect(JSON.stringify({ created, fetched })).not.toContain('printer-secret');
        expect(JSON.stringify({ created, fetched })).not.toContain('spool-secret');
        expect(JSON.stringify({ created, fetched })).not.toContain('storage_path');

        expect(store.createMerchantBatch).toHaveBeenCalledWith(expect.objectContaining({
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            name: 'PLA queue',
            strategy: 'batch_by_material',
            status: 'queued',
        }));
        expect(store.createMerchantBatchItem).toHaveBeenCalledTimes(2);
        expect(store.createMerchantBatchItem.mock.calls[0][0]).toMatchObject({
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            batch_id: created.batch_id,
            order_id: 'order-1',
            file_id: 'file-1',
            quantity: 2,
        });
    });

    it('pauses, resumes, and cancels only future scheduling state without hardware commands', async () => {
        const {
            pauseBatch,
            resumeBatch,
            cancelBatch,
            store,
        } = createHandlers();

        const paused = await pauseBatch({ batch_id: 'batch-1' });
        const resumed = await resumeBatch({ batch_id: 'batch-1' });
        const canceled = await cancelBatch({ batch_id: 'batch-1' });

        expect(paused).toMatchObject({
            ok: true,
            batch_id: 'batch-1',
            status: 'paused',
            paused_at: '2026-07-01T12:00:00.000Z',
        });
        expect(resumed).toMatchObject({
            ok: true,
            batch_id: 'batch-1',
            status: 'running',
            started_at: '2026-07-01T12:00:00.000Z',
        });
        expect(canceled).toMatchObject({
            ok: true,
            batch_id: 'batch-1',
            status: 'canceled',
            canceled_at: '2026-07-01T12:00:00.000Z',
        });
        expect(store.updateMerchantBatch.mock.calls.map(([call]) => call.fields.status)).toEqual([
            'paused',
            'running',
            'canceled',
        ]);
        expect(store.createNodeCommand).not.toHaveBeenCalled();
        expect(store.cancelNodeCommand).not.toHaveBeenCalled();
        expect(store.sendPrinterCommand).not.toHaveBeenCalled();
    });

    it('rejects invalid item quantities and terminal batch transitions', async () => {
        const { createBatch, pauseBatch, resumeBatch, cancelBatch } = createHandlers();

        await expect(createBatch({
            name: 'Invalid',
            items: [{ file_id: 'file-1', quantity: 0 }],
        })).rejects.toMatchObject({
            statusCode: 400,
            code: 'invalid_payload',
        });
        await expect(pauseBatch({ batch_id: 'completed-batch' })).rejects.toMatchObject({
            statusCode: 409,
            code: 'batch_transition_invalid',
        });
        await expect(resumeBatch({ batch_id: 'canceled-batch' })).rejects.toMatchObject({
            statusCode: 409,
            code: 'batch_transition_invalid',
        });
        await expect(cancelBatch({ batch_id: 'canceled-batch' })).rejects.toMatchObject({
            statusCode: 409,
            code: 'batch_transition_invalid',
        });
    });
});

describe('merchant batch store helpers', () => {
    it('lists batch items with merchant and batch filters and bounded limits', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify([{ batch_item_id: 'item-1' }]),
        });
        const store = createSupabaseRestClient({
            supabaseUrl: 'https://example.supabase.co',
            serviceRoleKey: 'service_role',
            fetchImpl,
        });

        const rows = await store.listMerchantBatchItems({
            merchantId: 'merchant-1',
            batchId: 'batch-1',
            limit: 250,
        });

        expect(rows).toEqual([{ batch_item_id: 'item-1' }]);
        const requestUrl = new URL(fetchImpl.mock.calls[0][0]);
        expect(requestUrl.pathname).toBe('/rest/v1/merchant_batch_items');
        expect(requestUrl.searchParams.get('merchant_id')).toBe('eq.merchant-1');
        expect(requestUrl.searchParams.get('batch_id')).toBe('eq.batch-1');
        expect(requestUrl.searchParams.get('limit')).toBe('100');
    });
});

describe('merchant batch public routes', () => {
    it('imports route handlers and returns v2 method envelopes', async () => {
        const routes = await Promise.all([
            importBatchRoute('../../api/public/batches/index.js'),
            importBatchRoute('../../api/public/batches/[batch_id].js'),
            importBatchRoute('../../api/public/batches/[batch_id]/pause.js'),
            importBatchRoute('../../api/public/batches/[batch_id]/resume.js'),
            importBatchRoute('../../api/public/batches/[batch_id]/cancel.js'),
        ]);
        const responses = routes.map(() => createMockResponse());

        await routes[0]({ method: 'GET', headers: {} }, responses[0]);
        await routes[1]({ method: 'POST', headers: {}, query: { batch_id: 'batch-1' } }, responses[1]);
        await routes[2]({ method: 'GET', headers: {}, query: { batch_id: 'batch-1' } }, responses[2]);
        await routes[3]({ method: 'GET', headers: {}, query: { batch_id: 'batch-1' } }, responses[3]);
        await routes[4]({ method: 'GET', headers: {}, query: { batch_id: 'batch-1' } }, responses[4]);

        expect(responses.map((res) => res.statusCode)).toEqual([405, 405, 405, 405, 405]);
        expect(responses.map((res) => res.headers.Allow)).toEqual(['POST', 'GET', 'POST', 'POST', 'POST']);
        for (const response of responses) {
            expect(response.body).toMatchObject({
                ok: false,
                error: 'method_not_allowed',
                request_id: expect.stringMatching(/^req_/),
            });
        }
    });
});
