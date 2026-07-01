import { describe, expect, it, vi } from 'vitest';
import { createOrderHandlers } from '../../src/cloud/merchantOrders.js';

const now = () => new Date('2026-07-01T12:00:00.000Z');

function createMockStore(overrides = {}) {
    return {
        getMerchantFile: vi.fn().mockImplementation(async ({ fileId }) => ({
            file_id: fileId,
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            original_name: fileId === 'source-file' ? 'source.stl' : 'ready.gcode.3mf',
            file_mode: fileId === 'source-file' ? 'source_model' : 'ready_to_print',
            status: 'uploaded',
        })),
        createMerchantOrder: vi.fn().mockImplementation(async (order) => order),
        getMerchantOrder: vi.fn().mockImplementation(async ({ orderId }) => ({
            order_id: orderId,
            external_order_id: '1001',
            status: 'submitted',
            metadata: { item_count: 2 },
            created_at: '2026-07-01T12:00:00.000Z',
        })),
        updateMerchantOrder: vi.fn().mockImplementation(async ({ orderId, fields }) => ({
            order_id: orderId,
            external_order_id: '1001',
            metadata: { item_count: 2 },
            ...fields,
        })),
        createMerchantOrderItem: vi.fn().mockImplementation(async (item) => item),
        createMerchantUsageEvent: vi.fn().mockImplementation(async (event) => event),
        recordMerchantJobEvent: vi.fn().mockImplementation(async (event) => event),
        createMerchantSliceJob: vi.fn().mockImplementation(async (sliceJob) => sliceJob),
        updateMerchantSliceJob: vi.fn().mockImplementation(async ({ sliceJobId, fields }) => ({
            slice_job_id: sliceJobId,
            ...fields,
        })),
        createMerchantJobArtifact: vi.fn().mockImplementation(async (artifact) => artifact),
        ...overrides,
    };
}

function createMockAdapters(overrides = {}) {
    return {
        slicer: {
            createSliceJob: vi.fn().mockResolvedValue({
                provider: 'mock',
                slice_job_id: 'slice-1',
                status: 'completed_mock',
                created_at: '2026-07-01T12:00:00.000Z',
                updated_at: '2026-07-01T12:00:00.000Z',
                completed_at: '2026-07-01T12:00:00.000Z',
                artifact: {
                    provider: 'mock',
                    artifact_id: 'artifact-1',
                    original_name: 'source.mock-sliced.gcode.3mf',
                    content_type: 'model/3mf',
                    created_at: '2026-07-01T12:00:00.000Z',
                },
            }),
        },
        ...overrides,
    };
}

function createHandlers(overrides = {}) {
    const store = createMockStore(overrides.store);
    const adapters = createMockAdapters(overrides.adapters);
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
        ...createOrderHandlers({
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

async function importOrdersIndexRoute(store = createMockStore()) {
    vi.resetModules();
    vi.doMock('../../src/cloud/supabaseRest.js', () => ({
        createSupabaseRestClient: vi.fn(() => store),
    }));
    const route = await import('../../api/public/orders/index.js');
    vi.doUnmock('../../src/cloud/supabaseRest.js');
    return route.default;
}

async function importOrderDetailRoute(store = createMockStore()) {
    vi.resetModules();
    vi.doMock('../../src/cloud/supabaseRest.js', () => ({
        createSupabaseRestClient: vi.fn(() => store),
    }));
    const route = await import('../../api/public/orders/[order_id].js');
    vi.doUnmock('../../src/cloud/supabaseRest.js');
    return route.default;
}

async function importOrderCancelRoute(store = createMockStore()) {
    vi.resetModules();
    vi.doMock('../../src/cloud/supabaseRest.js', () => ({
        createSupabaseRestClient: vi.fn(() => store),
    }));
    const route = await import('../../api/public/orders/[order_id]/cancel.js');
    vi.doUnmock('../../src/cloud/supabaseRest.js');
    return route.default;
}

describe('merchant order handlers', () => {
    it('creates, reads, and cancels merchant-scoped orders safely', async () => {
        const {
            createOrder,
            getOrder,
            cancelOrder,
            store,
            adapters,
        } = createHandlers();
        const body = {
            merchant_order_id: '1001',
            auto_submit: true,
            auto_slice: true,
            items: [
                {
                    file_id: 'ready-file',
                    sku: 'READY-1',
                    name: 'Ready part',
                    quantity: 1,
                    requirements: { materials: ['PLA'] },
                },
                {
                    file_id: 'source-file',
                    sku: 'SRC-1',
                    name: 'Source part',
                    quantity: 1,
                    requirements: { materials: ['PETG'] },
                    profile: { quality: 'standard' },
                },
            ],
        };
        Object.defineProperties(body, {
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

        const order = await createOrder(body);
        const fetched = await getOrder({ order_id: order.order_id });
        const canceled = await cancelOrder({ order_id: order.order_id });

        expect(order).toMatchObject({
            status: 'submitted',
            merchant_order_id: '1001',
            item_count: 2,
        });
        expect(fetched).toMatchObject({ order_id: order.order_id, item_count: 2 });
        expect(canceled).toMatchObject({ status: 'canceled' });
        expect(order).not.toHaveProperty('org_id');
        expect(order).not.toHaveProperty('merchant_id');
        expect(JSON.stringify(order)).not.toContain('node_id');
        expect(JSON.stringify(order)).not.toContain('printer_id');
        expect(JSON.stringify(order)).not.toContain('spool_id');

        expect(store.createMerchantOrder).toHaveBeenCalledWith(expect.objectContaining({
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            external_order_id: '1001',
            status: 'submitted',
            submitted_at: '2026-07-01T12:00:00.000Z',
            metadata: expect.objectContaining({
                item_count: 2,
                auto_submit_requested: true,
                auto_slice_requested: true,
            }),
        }));
        expect(store.createMerchantOrderItem).toHaveBeenCalledTimes(2);
        expect(store.createMerchantOrderItem.mock.calls[0][0]).toMatchObject({
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            order_id: order.order_id,
            file_id: 'ready-file',
            metadata: expect.objectContaining({
                auto_submit_requested: true,
                auto_submit_status: 'intent_recorded',
            }),
        });
        expect(store.createMerchantOrderItem.mock.calls[1][0]).toMatchObject({
            order_id: order.order_id,
            file_id: 'source-file',
            slice_job_id: 'slice-1',
            metadata: expect.objectContaining({
                auto_slice_requested: true,
                auto_slice_status: 'created',
            }),
        });
        expect(adapters.slicer.createSliceJob).toHaveBeenCalledWith(expect.objectContaining({
            merchant: expect.objectContaining({ merchant_id: 'merchant-1' }),
            sourceFile: expect.objectContaining({ file_id: 'source-file' }),
            profile: { quality: 'standard' },
            requirements: { materials: ['PETG'] },
        }));
        expect(store.createMerchantUsageEvent.mock.calls.map(([event]) => event.event_type)).toEqual([
            'order.submitted',
            'order.item.submitted',
            'order.item.submitted',
        ]);
        expect(store.recordMerchantJobEvent.mock.calls.map(([event]) => event.event_type)).toEqual([
            'order.submitted',
            'order.item.submitted',
            'order.item.submitted',
            'order.canceled',
        ]);
        expect(store.updateMerchantOrder).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            orderId: order.order_id,
            fields: {
                status: 'canceled',
                canceled_at: '2026-07-01T12:00:00.000Z',
            },
        });
    });
});

describe('merchant order public routes', () => {
    it('returns v2 public error envelopes for unsupported methods', async () => {
        const indexHandler = await importOrdersIndexRoute();
        const detailHandler = await importOrderDetailRoute();
        const cancelHandler = await importOrderCancelRoute();
        const indexRes = createMockResponse();
        const detailRes = createMockResponse();
        const cancelRes = createMockResponse();

        await indexHandler({ method: 'GET', headers: {} }, indexRes);
        await detailHandler({ method: 'POST', headers: {}, query: { order_id: 'order-1' } }, detailRes);
        await cancelHandler({ method: 'GET', headers: {}, query: { order_id: 'order-1' } }, cancelRes);

        expect(indexRes.statusCode).toBe(405);
        expect(indexRes.headers.Allow).toBe('POST');
        expect(indexRes.body).toMatchObject({
            ok: false,
            error: 'method_not_allowed',
            request_id: expect.stringMatching(/^req_/),
        });
        expect(detailRes.statusCode).toBe(405);
        expect(detailRes.headers.Allow).toBe('GET');
        expect(detailRes.body).toMatchObject({
            ok: false,
            error: 'method_not_allowed',
            request_id: expect.stringMatching(/^req_/),
        });
        expect(cancelRes.statusCode).toBe(405);
        expect(cancelRes.headers.Allow).toBe('POST');
        expect(cancelRes.body).toMatchObject({
            ok: false,
            error: 'method_not_allowed',
            request_id: expect.stringMatching(/^req_/),
        });
    });
});
