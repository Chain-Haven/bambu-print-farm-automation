import { describe, expect, it, vi } from 'vitest';
import { hashMerchantApiKey } from '../../src/cloud/merchantAuth.js';
import { createOrderHandlers } from '../../src/cloud/merchantOrders.js';

const now = () => new Date('2026-07-01T12:00:00.000Z');
const routeRawKey = 'pkx_live_test';
const routePepper = 'pepper';

function createMockStore(overrides = {}) {
    return {
        findMerchantOrderByIdempotencyKey: vi.fn().mockResolvedValue(null),
        findMerchantOrderByExternalOrderId: vi.fn().mockResolvedValue(null),
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
        cancelMerchantOrderIfCancelable: vi.fn().mockImplementation(async ({ orderId, canceledAt }) => ({
            order_id: orderId,
            external_order_id: '1001',
            status: 'canceled',
            canceled_at: canceledAt,
            metadata: { item_count: 2 },
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
            status: 'draft',
            submitted_at: null,
            metadata: expect.objectContaining({
                item_count: 2,
                creation_status: 'creating',
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
                status: 'submitted',
                submitted_at: '2026-07-01T12:00:00.000Z',
                metadata: expect.objectContaining({
                    creation_status: 'submitted',
                    item_count: 2,
                }),
            },
        });
        expect(store.cancelMerchantOrderIfCancelable).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            orderId: order.order_id,
            canceledAt: '2026-07-01T12:00:00.000Z',
            cancelableStatuses: expect.arrayContaining(['draft', 'submitted']),
        });
    });

    it('persists storefront customization and feeds color/material into routing requirements', async () => {
        const { createOrder, store } = createHandlers();

        await createOrder({
            merchant_order_id: '2002',
            items: [
                {
                    file_id: 'ready-file',
                    quantity: 1,
                    customization: {
                        case_type: 'iphone-15-slim',
                        design_id: 'tmpl-monogram',
                        color: '#0A7',
                        material: 'PLA',
                        placement: [
                            { asset_file_id: 'logo-1', face: 'back', x_mm: 10, y_mm: 20, width_mm: 30, mode: 'emboss' },
                        ],
                    },
                },
            ],
        });

        const [itemArg] = store.createMerchantOrderItem.mock.calls[0];
        // Customization persisted verbatim in the item metadata.
        expect(itemArg.metadata.customization).toMatchObject({
            case_type: 'iphone-15-slim',
            design_id: 'tmpl-monogram',
            color: '#0A7',
            material: 'PLA',
        });
        expect(itemArg.metadata.customization.placement[0]).toMatchObject({
            asset_file_id: 'logo-1', face: 'back', x_mm: 10, mode: 'emboss',
        });
        // Color/material promoted into routing requirements (capability-aware routing).
        expect(itemArg.requirements.color).toBe('#0A7');
        expect(itemArg.requirements.material).toBe('PLA');
    });

    it('does not add a customization key when none is supplied', async () => {
        const { createOrder, store } = createHandlers();
        await createOrder({ merchant_order_id: '2003', items: [{ file_id: 'ready-file', quantity: 1 }] });
        const [itemArg] = store.createMerchantOrderItem.mock.calls[0];
        expect(itemArg.metadata).not.toHaveProperty('customization');
        expect(itemArg).not.toHaveProperty('customization');
    });

    it('prevalidates every file before creating a durable order', async () => {
        const { createOrder, store } = createHandlers({
            store: {
                getMerchantFile: vi.fn().mockImplementation(async ({ fileId }) => {
                    if (fileId === 'missing-file') return null;
                    return {
                        file_id: fileId,
                        org_id: 'org-1',
                        merchant_id: 'merchant-1',
                        original_name: 'ready.gcode.3mf',
                        file_mode: 'ready_to_print',
                        status: 'uploaded',
                    };
                }),
            },
        });

        await expect(createOrder({
            merchant_order_id: '1002',
            items: [
                { file_id: 'ready-file', quantity: 1 },
                { file_id: 'missing-file', quantity: 1 },
            ],
        })).rejects.toMatchObject({
            statusCode: 404,
            code: 'file_not_found',
        });

        expect(store.getMerchantFile).toHaveBeenCalledTimes(2);
        expect(store.createMerchantOrder).not.toHaveBeenCalled();
        expect(store.createMerchantOrderItem).not.toHaveBeenCalled();
        expect(store.createMerchantUsageEvent).not.toHaveBeenCalled();
        expect(store.recordMerchantJobEvent).not.toHaveBeenCalled();
    });

    it('rejects unusable file statuses before creating an order', async () => {
        const { createOrder, store } = createHandlers({
            store: {
                getMerchantFile: vi.fn().mockResolvedValue({
                    file_id: 'deleted-file',
                    org_id: 'org-1',
                    merchant_id: 'merchant-1',
                    original_name: 'ready.gcode.3mf',
                    file_mode: 'ready_to_print',
                    status: 'deleted',
                }),
            },
        });

        await expect(createOrder({
            merchant_order_id: '1003',
            items: [{ file_id: 'deleted-file', quantity: 1 }],
        })).rejects.toMatchObject({
            statusCode: 422,
            code: 'file_not_usable',
        });

        expect(store.createMerchantOrder).not.toHaveBeenCalled();
        expect(store.createMerchantOrderItem).not.toHaveBeenCalled();
    });

    it('rejects malformed quantity and amount instead of coercing them', async () => {
        const { createOrder, store } = createHandlers();

        await expect(createOrder({
            merchant_order_id: '1004',
            items: [{ file_id: 'ready-file', quantity: -1 }],
        })).rejects.toMatchObject({
            statusCode: 400,
            code: 'invalid_payload',
        });
        await expect(createOrder({
            merchant_order_id: '1005',
            items: [{ file_id: 'ready-file', quantity: 1, unit_amount: -0.01 }],
        })).rejects.toMatchObject({
            statusCode: 400,
            code: 'invalid_payload',
        });

        expect(store.createMerchantOrder).not.toHaveBeenCalled();
    });

    it('replays existing orders by idempotency key from headers or body', async () => {
        const existingOrder = {
            order_id: 'order-existing',
            external_order_id: '1006',
            idempotency_key: 'idem-1',
            status: 'submitted',
            metadata: { item_count: 1 },
            created_at: '2026-07-01T11:00:00.000Z',
        };
        const { createOrder, store } = createHandlers({
            store: {
                findMerchantOrderByIdempotencyKey: vi.fn().mockResolvedValue(existingOrder),
            },
        });

        const replay = await createOrder({
            merchant_order_id: '1006',
            items: [{ file_id: 'ready-file', quantity: 1 }],
        }, { headers: { 'Idempotency-Key': 'idem-1' } });
        const bodyReplay = await createOrder({
            merchant_order_id: '1006',
            idempotency_key: 'idem-1',
            items: [{ file_id: 'ready-file', quantity: 1 }],
        });

        expect(replay).toMatchObject({
            order_id: 'order-existing',
            merchant_order_id: '1006',
            item_count: 1,
        });
        expect(bodyReplay).toMatchObject({ order_id: 'order-existing' });
        expect(JSON.stringify(replay)).not.toContain('idempotent_replay');
        expect(replay._http_status).toBe(200);
        expect(store.findMerchantOrderByIdempotencyKey).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            idempotencyKey: 'idem-1',
        });
        expect(store.getMerchantFile).not.toHaveBeenCalled();
        expect(store.createMerchantOrder).not.toHaveBeenCalled();
    });

    it('replays existing orders by external order id before inserting', async () => {
        const existingOrder = {
            order_id: 'order-external',
            external_order_id: '1007',
            status: 'submitted',
            metadata: { item_count: 1 },
        };
        const { createOrder, store } = createHandlers({
            store: {
                findMerchantOrderByExternalOrderId: vi.fn().mockResolvedValue(existingOrder),
            },
        });

        const replay = await createOrder({
            merchant_order_id: '1007',
            items: [{ file_id: 'ready-file', quantity: 1 }],
        });

        expect(replay).toMatchObject({
            order_id: 'order-external',
            merchant_order_id: '1007',
        });
        expect(JSON.stringify(replay)).not.toContain('idempotent_replay');
        expect(replay._http_status).toBe(200);
        expect(store.findMerchantOrderByExternalOrderId).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            externalOrderId: '1007',
        });
        expect(store.createMerchantOrder).not.toHaveBeenCalled();
    });

    it('rejects idempotency key reuse with a different external order id', async () => {
        const { createOrder, store } = createHandlers({
            store: {
                findMerchantOrderByIdempotencyKey: vi.fn().mockResolvedValue({
                    order_id: 'order-idem-a',
                    external_order_id: '1008',
                    idempotency_key: 'idem-conflict',
                    status: 'submitted',
                    metadata: { item_count: 1 },
                }),
            },
        });

        await expect(createOrder({
            merchant_order_id: 'DIFFERENT-1008',
            items: [{ file_id: 'ready-file', quantity: 1 }],
        }, { headers: { 'Idempotency-Key': 'idem-conflict' } })).rejects.toMatchObject({
            statusCode: 409,
            code: 'idempotency_conflict',
        });

        expect(store.getMerchantFile).not.toHaveBeenCalled();
        expect(store.createMerchantOrder).not.toHaveBeenCalled();
    });

    it('rejects requests whose idempotency key and external order id match different rows', async () => {
        const { createOrder, store } = createHandlers({
            store: {
                findMerchantOrderByIdempotencyKey: vi.fn().mockResolvedValue({
                    order_id: 'order-a',
                    external_order_id: '1009-A',
                    idempotency_key: 'idem-two-rows',
                    status: 'submitted',
                    metadata: { item_count: 1 },
                }),
                findMerchantOrderByExternalOrderId: vi.fn().mockResolvedValue({
                    order_id: 'order-b',
                    external_order_id: '1009-B',
                    idempotency_key: 'other-key',
                    status: 'submitted',
                    metadata: { item_count: 1 },
                }),
            },
        });

        await expect(createOrder({
            merchant_order_id: '1009-B',
            items: [{ file_id: 'ready-file', quantity: 1 }],
        }, { headers: { 'Idempotency-Key': 'idem-two-rows' } })).rejects.toMatchObject({
            statusCode: 409,
            code: 'idempotency_conflict',
        });

        expect(store.findMerchantOrderByIdempotencyKey).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            idempotencyKey: 'idem-two-rows',
        });
        expect(store.findMerchantOrderByExternalOrderId).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            externalOrderId: '1009-B',
        });
        expect(store.getMerchantFile).not.toHaveBeenCalled();
        expect(store.createMerchantOrder).not.toHaveBeenCalled();
    });

    it('rejects duplicate replays while an existing order is still creating', async () => {
        const { createOrder, store } = createHandlers({
            store: {
                findMerchantOrderByIdempotencyKey: vi.fn().mockResolvedValue({
                    order_id: 'order-creating',
                    external_order_id: '1010',
                    idempotency_key: 'idem-creating',
                    status: 'draft',
                    metadata: { item_count: 1, creation_status: 'creating' },
                }),
            },
        });

        await expect(createOrder({
            merchant_order_id: '1010',
            items: [{ file_id: 'ready-file', quantity: 1 }],
        }, { headers: { 'Idempotency-Key': 'idem-creating' } })).rejects.toMatchObject({
            statusCode: 409,
            code: 'order_creation_in_progress',
        });

        expect(store.getMerchantFile).not.toHaveBeenCalled();
        expect(store.createMerchantOrder).not.toHaveBeenCalled();
    });

    it('rejects duplicate replays for previously failed order creation', async () => {
        const { createOrder, store } = createHandlers({
            store: {
                findMerchantOrderByExternalOrderId: vi.fn().mockResolvedValue({
                    order_id: 'order-failed',
                    external_order_id: '1011',
                    status: 'failed',
                    metadata: { item_count: 1, failure_code: 'order_creation_failed' },
                }),
            },
        });

        await expect(createOrder({
            merchant_order_id: '1011',
            items: [{ file_id: 'ready-file', quantity: 1 }],
        })).rejects.toMatchObject({
            statusCode: 409,
            code: 'order_creation_failed',
        });

        expect(store.getMerchantFile).not.toHaveBeenCalled();
        expect(store.createMerchantOrder).not.toHaveBeenCalled();
    });

    it('marks the order failed when item creation fails after order creation', async () => {
        const { createOrder, store } = createHandlers({
            store: {
                createMerchantOrderItem: vi.fn()
                    .mockImplementationOnce(async (item) => item)
                    .mockRejectedValueOnce(new Error('insert item failed')),
            },
        });

        await expect(createOrder({
            merchant_order_id: '1008',
            items: [
                { file_id: 'ready-file-1', quantity: 1 },
                { file_id: 'ready-file-2', quantity: 1 },
            ],
        })).rejects.toMatchObject({
            statusCode: 500,
            code: 'order_creation_failed',
        });

        const orderId = store.createMerchantOrder.mock.calls[0][0].order_id;
        expect(store.updateMerchantOrder).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            orderId,
            fields: {
                status: 'failed',
                metadata: expect.objectContaining({
                    item_count: 2,
                    failure_code: 'order_creation_failed',
                    failure_stage: 'create_items',
                }),
            },
        });
        expect(store.recordMerchantJobEvent).toHaveBeenCalledWith(expect.objectContaining({
            order_id: orderId,
            event_type: 'order.failed',
            payload: expect.objectContaining({
                failure_code: 'order_creation_failed',
                failure_stage: 'create_items',
            }),
        }));
    });

    it('marks the order failed when auto-slicing fails after order creation', async () => {
        const { createOrder, store } = createHandlers({
            adapters: {
                slicer: {
                    createSliceJob: vi.fn().mockRejectedValue(new Error('slice failed')),
                },
            },
        });

        await expect(createOrder({
            merchant_order_id: '1009',
            auto_slice: true,
            items: [{ file_id: 'source-file', quantity: 1 }],
        })).rejects.toMatchObject({
            statusCode: 500,
            code: 'order_creation_failed',
        });

        const orderId = store.createMerchantOrder.mock.calls[0][0].order_id;
        expect(store.createMerchantOrderItem).not.toHaveBeenCalled();
        expect(store.updateMerchantOrder).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            orderId,
            fields: {
                status: 'failed',
                metadata: expect.objectContaining({
                    failure_code: 'order_creation_failed',
                    failure_stage: 'create_items',
                }),
            },
        });
    });

    it('submits the order even when usage and audit events fail after item creation', async () => {
        let createdOrder;
        const { createOrder, store } = createHandlers({
            store: {
                createMerchantOrder: vi.fn().mockImplementation(async (order) => {
                    createdOrder = order;
                    return order;
                }),
                updateMerchantOrder: vi.fn().mockImplementation(async ({ fields }) => ({
                    ...createdOrder,
                    ...fields,
                })),
                createMerchantUsageEvent: vi.fn().mockRejectedValue(new Error('usage failed')),
                recordMerchantJobEvent: vi.fn().mockRejectedValue(new Error('event failed')),
            },
        });

        const order = await createOrder({
            merchant_order_id: '1012',
            items: [{ file_id: 'ready-file', quantity: 1 }],
        });

        expect(order).toMatchObject({
            status: 'submitted',
            merchant_order_id: '1012',
            item_count: 1,
        });
        expect(store.createMerchantOrderItem).toHaveBeenCalledTimes(1);
        expect(store.updateMerchantOrder).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            orderId: order.order_id,
            fields: {
                status: 'submitted',
                submitted_at: '2026-07-01T12:00:00.000Z',
                metadata: expect.objectContaining({ creation_status: 'submitted' }),
            },
        });
        expect(store.createMerchantUsageEvent).toHaveBeenCalled();
        expect(store.recordMerchantJobEvent).toHaveBeenCalled();
    });

    it('rejects non-cancelable order states before updating', async () => {
        const { cancelOrder, store } = createHandlers({
            store: {
                cancelMerchantOrderIfCancelable: vi.fn().mockResolvedValue(null),
                getMerchantOrder: vi.fn().mockResolvedValue({
                    order_id: 'order-complete',
                    status: 'completed',
                    metadata: { item_count: 1 },
                }),
            },
        });

        await expect(cancelOrder({ order_id: 'order-complete' })).rejects.toMatchObject({
            statusCode: 409,
            code: 'order_not_cancelable',
        });

        expect(store.updateMerchantOrder).not.toHaveBeenCalled();
        expect(store.recordMerchantJobEvent).not.toHaveBeenCalled();
    });

    it('returns canceled when cancel event recording fails after the status update', async () => {
        const { cancelOrder, store } = createHandlers({
            store: {
                getMerchantOrder: vi.fn().mockResolvedValue({
                    order_id: 'order-submitted',
                    status: 'submitted',
                    metadata: { item_count: 1 },
                }),
                recordMerchantJobEvent: vi.fn().mockRejectedValue(new Error('event failed')),
            },
        });

        await expect(cancelOrder({ order_id: 'order-submitted' })).resolves.toMatchObject({
            status: 'canceled',
        });

        expect(store.cancelMerchantOrderIfCancelable).toHaveBeenCalled();
        expect(store.updateMerchantOrder).not.toHaveBeenCalled();
        expect(store.recordMerchantJobEvent).toHaveBeenCalled();
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

    it('creates orders with 201 responses and clean public JSON', async () => {
        let createdOrder;
        const store = createAuthenticatedRouteStore({
            createMerchantOrder: vi.fn().mockImplementation(async (order) => {
                createdOrder = order;
                return order;
            }),
            updateMerchantOrder: vi.fn().mockImplementation(async ({ fields }) => ({
                ...createdOrder,
                ...fields,
            })),
        });
        const handler = await importOrdersIndexRoute(store);
        const res = createMockResponse();
        const originalPepper = process.env.NODE_TOKEN_PEPPER;
        process.env.NODE_TOKEN_PEPPER = routePepper;

        try {
            await handler({
                method: 'POST',
                headers: { authorization: `Bearer ${routeRawKey}` },
                body: {
                    merchant_order_id: '1013',
                    items: [{ file_id: 'ready-file', quantity: 1 }],
                },
            }, res);
        } finally {
            if (originalPepper === undefined) delete process.env.NODE_TOKEN_PEPPER;
            else process.env.NODE_TOKEN_PEPPER = originalPepper;
        }

        expect(res.statusCode).toBe(201);
        expect(res.body).toMatchObject({
            ok: true,
            status: 'submitted',
            merchant_order_id: '1013',
            item_count: 1,
        });
        expect(JSON.stringify(res.body)).not.toContain('_http_status');
        expect(JSON.stringify(res.body)).not.toContain('idempotent_replay');
    });

    it('returns HTTP 200 for idempotent route replays with clean public JSON', async () => {
        const store = createAuthenticatedRouteStore({
            findMerchantOrderByIdempotencyKey: vi.fn().mockResolvedValue({
                order_id: 'order-replay',
                external_order_id: '1014',
                status: 'submitted',
                metadata: { item_count: 1 },
            }),
        });
        const handler = await importOrdersIndexRoute(store);
        const res = createMockResponse();
        const originalPepper = process.env.NODE_TOKEN_PEPPER;
        process.env.NODE_TOKEN_PEPPER = routePepper;

        try {
            await handler({
                method: 'POST',
                headers: {
                    authorization: `Bearer ${routeRawKey}`,
                    'Idempotency-Key': 'idem-route',
                },
                body: {
                    merchant_order_id: '1014',
                    items: [{ file_id: 'ready-file', quantity: 1 }],
                },
            }, res);
        } finally {
            if (originalPepper === undefined) delete process.env.NODE_TOKEN_PEPPER;
            else process.env.NODE_TOKEN_PEPPER = originalPepper;
        }

        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({
            ok: true,
            order_id: 'order-replay',
            merchant_order_id: '1014',
            item_count: 1,
        });
        expect(JSON.stringify(res.body)).not.toContain('_http_status');
        expect(JSON.stringify(res.body)).not.toContain('idempotent_replay');
        expect(store.createMerchantOrder).not.toHaveBeenCalled();
    });

    it('returns route-level conflict envelopes for idempotency identity mismatches', async () => {
        const store = createAuthenticatedRouteStore({
            findMerchantOrderByIdempotencyKey: vi.fn().mockResolvedValue({
                order_id: 'order-route-conflict',
                external_order_id: '1014-A',
                idempotency_key: 'idem-route-conflict',
                status: 'submitted',
                metadata: { item_count: 1 },
            }),
        });
        const handler = await importOrdersIndexRoute(store);
        const res = createMockResponse();
        const originalPepper = process.env.NODE_TOKEN_PEPPER;
        process.env.NODE_TOKEN_PEPPER = routePepper;

        try {
            await handler({
                method: 'POST',
                headers: {
                    authorization: `Bearer ${routeRawKey}`,
                    'Idempotency-Key': 'idem-route-conflict',
                },
                body: {
                    merchant_order_id: '1014-B',
                    items: [{ file_id: 'ready-file', quantity: 1 }],
                },
            }, res);
        } finally {
            if (originalPepper === undefined) delete process.env.NODE_TOKEN_PEPPER;
            else process.env.NODE_TOKEN_PEPPER = originalPepper;
        }

        expect(res.statusCode).toBe(409);
        expect(res.body).toMatchObject({
            ok: false,
            error: 'idempotency_conflict',
            request_id: expect.stringMatching(/^req_/),
        });
        expect(store.createMerchantOrder).not.toHaveBeenCalled();
    });

    it('returns route-level conflict envelopes for in-progress duplicate creation', async () => {
        const store = createAuthenticatedRouteStore({
            findMerchantOrderByIdempotencyKey: vi.fn().mockResolvedValue({
                order_id: 'order-route-creating',
                external_order_id: '1015',
                status: 'draft',
                metadata: { item_count: 1, creation_status: 'creating' },
            }),
        });
        const handler = await importOrdersIndexRoute(store);
        const res = createMockResponse();
        const originalPepper = process.env.NODE_TOKEN_PEPPER;
        process.env.NODE_TOKEN_PEPPER = routePepper;

        try {
            await handler({
                method: 'POST',
                headers: {
                    authorization: `Bearer ${routeRawKey}`,
                    'Idempotency-Key': 'idem-route-creating',
                },
                body: {
                    merchant_order_id: '1015',
                    items: [{ file_id: 'ready-file', quantity: 1 }],
                },
            }, res);
        } finally {
            if (originalPepper === undefined) delete process.env.NODE_TOKEN_PEPPER;
            else process.env.NODE_TOKEN_PEPPER = originalPepper;
        }

        expect(res.statusCode).toBe(409);
        expect(res.body).toMatchObject({
            ok: false,
            error: 'order_creation_in_progress',
            request_id: expect.stringMatching(/^req_/),
        });
        expect(store.createMerchantOrder).not.toHaveBeenCalled();
    });
});
