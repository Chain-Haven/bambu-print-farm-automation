import { describe, expect, it, vi } from 'vitest';
import { hashMerchantApiKey } from '../../src/cloud/merchantAuth.js';
import { createBillingHandlers } from '../../src/cloud/merchantBilling.js';
import { createRealtimeHandlers } from '../../src/cloud/merchantRealtime.js';
import { createShippingHandlers } from '../../src/cloud/merchantShipments.js';

const now = () => new Date('2026-07-01T12:00:00.000Z');
const routeRawKey = 'pkx_live_task8';
const routePepper = 'pepper';

function orderRow(overrides = {}) {
    return {
        order_id: overrides.order_id || 'order-1',
        org_id: 'org-1',
        merchant_id: 'merchant-1',
        status: 'ready_to_ship',
        shipping_address: { name: 'Ada Lovelace', country: 'US' },
        metadata: {},
        created_at: '2026-07-01T11:00:00.000Z',
        ...overrides,
    };
}

function shipmentRow(overrides = {}) {
    return {
        shipment_id: overrides.shipment_id || 'shipment-1',
        org_id: 'org-1',
        merchant_id: 'merchant-1',
        order_id: overrides.order_id ?? 'order-1',
        status: overrides.status || 'label_created',
        carrier: overrides.carrier || 'mock_carrier',
        service_level: overrides.service_level || 'mock_ground',
        tracking_number: overrides.tracking_number || 'track-1',
        ship_to: overrides.ship_to || { name: 'Ada Lovelace', country: 'US' },
        packages: overrides.packages || [{ weight_grams: 250 }],
        metadata: overrides.metadata || {
            note: 'merchant visible',
            provider_payload: {
                provider_shipment_id: 'shippo_123',
                rate_id: 'rate_abc',
                token: 'provider-secret',
            },
            provider_response: { provider_label_id: 'label_secret_123' },
            storage_url: 'https://storage.internal/label.pdf?token=secret',
        },
        created_at: '2026-07-01T12:00:00.000Z',
        updated_at: '2026-07-01T12:00:00.000Z',
        ...overrides,
    };
}

function labelRow(overrides = {}) {
    return {
        label_id: overrides.label_id || 'label-1',
        org_id: 'org-1',
        merchant_id: 'merchant-1',
        shipment_id: overrides.shipment_id || 'shipment-1',
        provider: 'mock',
        label_url: overrides.label_url || 'mock://shipments/shipment-1/label.pdf',
        tracking_number: overrides.tracking_number || 'track-1',
        label_payload: overrides.label_payload || {
            token: 'provider-secret',
            signed_url: 'https://signed.example/secret',
        },
        metadata: overrides.metadata || {
            format: 'pdf',
            download_url: 'https://signed.example/download',
            note: 'merchant visible',
        },
        created_at: '2026-07-01T12:00:00.000Z',
        updated_at: '2026-07-01T12:00:00.000Z',
        ...overrides,
    };
}

function rateCardRow(overrides = {}) {
    return {
        rate_card_id: overrides.rate_card_id || 'rate-card-1',
        org_id: 'org-1',
        merchant_id: 'merchant-1',
        name: 'Active rates',
        currency: 'USD',
        status: 'active',
        rates: [
            { code: 'order.submitted', description: 'Order intake', unit: 'event', amount_cents: 200 },
            { code: 'machine_time', description: 'Machine time', unit: 'minute', amount_cents: 10 },
        ],
        metadata: { note: 'merchant visible', token: 'rate-secret' },
        effective_at: '2026-07-01T00:00:00.000Z',
        created_at: '2026-07-01T00:00:00.000Z',
        updated_at: '2026-07-01T00:00:00.000Z',
        ...overrides,
    };
}

function usageRows() {
    return [
        {
            usage_event_id: 'usage-1',
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            job_id: 'job-1',
            file_id: 'file-1',
            event_type: 'order.submitted',
            quantity: 1,
            metrics: { order_id: 'order-1', note: 'visible', token: 'usage-secret' },
            created_at: '2026-07-01T12:00:00.000Z',
        },
        {
            usage_event_id: 'usage-2',
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            job_id: 'job-1',
            file_id: 'file-1',
            event_type: 'machine_time',
            quantity: 3,
            metrics: { order_id: 'order-1', minutes: 3, signed_url: 'https://signed.example/usage' },
            created_at: '2026-07-01T12:05:00.000Z',
        },
    ];
}

function invoiceRow(overrides = {}) {
    return {
        invoice_id: overrides.invoice_id || 'invoice-1',
        org_id: 'org-1',
        merchant_id: 'merchant-1',
        status: 'issued',
        period_start: '2026-07-01T00:00:00.000Z',
        period_end: '2026-07-31T23:59:59.000Z',
        currency: 'USD',
        subtotal: 12.5,
        total: 12.5,
        metadata: { note: 'merchant visible', token_hash: 'invoice-secret' },
        created_at: '2026-07-01T12:00:00.000Z',
        updated_at: '2026-07-01T12:00:00.000Z',
        ...overrides,
    };
}

function invoiceLineRow(overrides = {}) {
    return {
        invoice_line_id: overrides.invoice_line_id || 'line-1',
        org_id: 'org-1',
        merchant_id: 'merchant-1',
        invoice_id: overrides.invoice_id || 'invoice-1',
        order_id: 'order-1',
        job_id: 'job-1',
        file_id: 'file-1',
        shipment_id: 'shipment-1',
        slice_job_id: 'slice-1',
        description: 'Machine time',
        quantity: 3,
        unit_amount: 0.1,
        total_amount: 0.3,
        metadata: { note: 'merchant visible', storage_path: 'internal/path' },
        created_at: '2026-07-01T12:00:00.000Z',
        updated_at: '2026-07-01T12:00:00.000Z',
        ...overrides,
    };
}

function tokenRow(overrides = {}) {
    return {
        token_id: overrides.token_id || 'token-1',
        org_id: 'org-1',
        merchant_id: 'merchant-1',
        token_prefix: overrides.token_prefix || 'pkx_mock_rt_abc',
        token_hash: overrides.token_hash || 'stored-token-hash-secret',
        scopes: overrides.scopes || ['jobs:read', 'orders:read'],
        channel_names: overrides.channel_names || ['pkx_rt_token1_jobs', 'pkx_rt_token1_orders'],
        expires_at: overrides.expires_at || '2026-07-01T12:15:00.000Z',
        revoked_at: overrides.revoked_at ?? null,
        metadata: overrides.metadata || { provider: 'mock', token: 'metadata-secret' },
        created_at: '2026-07-01T12:00:00.000Z',
        updated_at: '2026-07-01T12:00:00.000Z',
        ...overrides,
    };
}

function createMockStore(overrides = {}) {
    return {
        getMerchantOrder: vi.fn().mockImplementation(async ({ orderId }) => (
            orderId === 'missing-order' ? null : orderRow({ order_id: orderId })
        )),
        createMerchantShipment: vi.fn().mockImplementation(async (shipment) => shipmentRow(shipment)),
        findMerchantShipmentByIdempotencyKey: vi.fn().mockResolvedValue(null),
        listMerchantShipments: vi.fn().mockResolvedValue([
            shipmentRow({ shipment_id: 'shipment-1' }),
            shipmentRow({ shipment_id: 'shipment-2', status: 'created' }),
        ]),
        getMerchantShipment: vi.fn().mockImplementation(async ({ shipmentId }) => (
            shipmentId === 'missing-shipment' ? null : shipmentRow({ shipment_id: shipmentId })
        )),
        updateMerchantShipmentStatus: vi.fn().mockImplementation(async ({ shipmentId, status }) => (
            shipmentRow({ shipment_id: shipmentId, status })
        )),
        createMerchantShippingLabel: vi.fn().mockImplementation(async (label) => labelRow(label)),
        updateMerchantShippingLabel: vi.fn().mockImplementation(async ({ labelId, fields }) => labelRow({
            label_id: labelId,
            ...fields,
        })),
        listMerchantShippingLabels: vi.fn().mockResolvedValue([labelRow()]),
        getMerchantShippingLabelByShipment: vi.fn().mockResolvedValue(null),
        recordMerchantJobEvent: vi.fn().mockImplementation(async (event) => event),
        getMerchantRateCard: vi.fn().mockResolvedValue(rateCardRow()),
        listMerchantUsageEvents: vi.fn().mockResolvedValue(usageRows()),
        listMerchantInvoices: vi.fn().mockResolvedValue([invoiceRow()]),
        getMerchantInvoice: vi.fn().mockImplementation(async ({ invoiceId }) => (
            invoiceId === 'missing-invoice' ? null : invoiceRow({ invoice_id: invoiceId })
        )),
        listMerchantInvoiceLines: vi.fn().mockResolvedValue([invoiceLineRow()]),
        createMerchantInvoice: vi.fn().mockImplementation(async (invoice) => invoice),
        createMerchantInvoiceLine: vi.fn().mockImplementation(async (line) => line),
        createMerchantRealtimeToken: vi.fn().mockImplementation(async (token) => tokenRow(token)),
        listMerchantRealtimeTokens: vi.fn().mockResolvedValue([tokenRow()]),
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

function createAdapters(overrides = {}) {
    return {
        shipping: {
            createShipment: vi.fn().mockResolvedValue({
                provider: 'mock',
                shipment_id: '11111111-1111-4111-8111-111111111111',
                status: 'label_created',
                carrier: 'mock_carrier',
                service_level: 'mock_ground',
                tracking_number: 'mock-track-1',
                ship_to: { name: 'Ada Lovelace', country: 'US' },
                packages: [{ weight_grams: 250 }],
                created_at: '2026-07-01T12:00:00.000Z',
                updated_at: '2026-07-01T12:00:00.000Z',
                label: {
                    provider: 'mock',
                    label_id: '22222222-2222-4222-8222-222222222222',
                    shipment_id: '11111111-1111-4111-8111-111111111111',
                    label_url: 'mock://shipments/11111111-1111-4111-8111-111111111111/label.pdf',
                    tracking_number: 'mock-track-1',
                    format: 'pdf',
                    token: 'provider-secret',
                    signed_url: 'https://signed.example/label',
                    created_at: '2026-07-01T12:00:00.000Z',
                },
            }),
        },
        billing: {
            getRateCard: vi.fn().mockResolvedValue({
                provider: 'mock',
                rate_card_id: 'mock-rate-card',
                currency: 'USD',
                rates: [{ code: 'machine_time', description: 'Machine time', unit: 'minute', amount_cents: 10 }],
                created_at: '2026-07-01T12:00:00.000Z',
                updated_at: '2026-07-01T12:00:00.000Z',
            }),
        },
        realtime: {
            createMerchantToken: vi.fn().mockResolvedValue({
                provider: 'mock',
                token_id: '33333333-3333-4333-8333-333333333333',
                token: 'pkx_mock_rt_secret_raw_token',
                scopes: ['jobs:read'],
                issued_at: '2026-07-01T12:00:00.000Z',
                expires_at: '2026-07-01T13:00:00.000Z',
            }),
        },
        ...overrides,
    };
}

function createHandlers(factory, overrides = {}) {
    const store = createMockStore(overrides.store);
    const adapters = createAdapters(overrides.adapters);
    const authenticateMerchant = vi.fn().mockResolvedValue({
        merchant: { org_id: 'org-1', merchant_id: 'merchant-1', status: 'active' },
    });
    return {
        store,
        adapters,
        authenticateMerchant,
        ...factory({ store, adapters, authenticateMerchant, now }),
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

async function importPublicRoute(path, store = createMockStore()) {
    vi.resetModules();
    vi.doMock('../../src/cloud/supabaseRest.js', () => ({
        createSupabaseRestClient: vi.fn(() => store),
    }));
    const route = await import(path);
    vi.doUnmock('../../src/cloud/supabaseRest.js');
    return route.default;
}

describe('merchant shipping public handlers', () => {
    it('creates, lists, gets, and labels merchant-scoped shipments with safe projections', async () => {
        const {
            createShipment,
            listShipments,
            getShipment,
            createLabel,
            store,
            adapters,
        } = createHandlers(createShippingHandlers);

        const created = await createShipment({
            order_id: 'order-1',
            ship_to: { name: 'Ada Lovelace', country: 'US' },
            packages: [{ weight_grams: 250 }],
            metadata: {
                note: 'merchant visible',
                storage_url: 'https://storage.internal/secret',
                token: 'metadata-secret',
            },
        });
        const listed = await listShipments({ order_id: 'order-1', status: 'label_created', limit: '2' });
        const fetched = await getShipment({ shipment_id: created.shipment_id });
        const label = await createLabel({ shipment_id: created.shipment_id });

        expect(created).toMatchObject({
            ok: true,
            shipment_id: '11111111-1111-4111-8111-111111111111',
            order_id: 'order-1',
            status: 'label_created',
            tracking_number: 'mock-track-1',
            label: {
                label_id: '22222222-2222-4222-8222-222222222222',
                label_url: 'mock://shipments/11111111-1111-4111-8111-111111111111/label.pdf',
            },
        });
        expect(created._http_status).toBe(201);
        expect(listed).toMatchObject({
            ok: true,
            shipments: [
                { shipment_id: 'shipment-1', order_id: 'order-1' },
                { shipment_id: 'shipment-2', status: 'created' },
            ],
        });
        expect(fetched).toMatchObject({ ok: true, shipment_id: created.shipment_id });
        expect(label).toMatchObject({
            ok: true,
            label: {
                shipment_id: created.shipment_id,
                provider: 'mock',
                label_url: expect.stringMatching(/^mock:\/\//),
            },
        });
        expect(store.getMerchantOrder).toHaveBeenCalledWith({ merchantId: 'merchant-1', orderId: 'order-1' });
        expect(store.createMerchantShipment).toHaveBeenCalledWith(expect.objectContaining({
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            order_id: 'order-1',
            status: 'label_created',
        }));
        expect(store.createMerchantShippingLabel).toHaveBeenCalledWith(expect.objectContaining({
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            shipment_id: created.shipment_id,
            provider: 'mock',
        }));
        expect(store.listMerchantShipments).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            orderId: 'order-1',
            status: 'label_created',
            limit: 2,
        });
        expect(store.recordMerchantJobEvent).toHaveBeenCalledWith(expect.objectContaining({
            event_type: 'shipment.created',
            order_id: 'order-1',
        }));
        expect(adapters.shipping.createShipment).toHaveBeenCalledWith(expect.objectContaining({
            merchant: expect.objectContaining({ merchant_id: 'merchant-1' }),
            order: expect.objectContaining({ order_id: 'order-1' }),
        }));
        expect(JSON.stringify({ created, listed, fetched, label })).not.toContain('org-1');
        expect(JSON.stringify({ created, listed, fetched, label })).not.toContain('merchant-1');
        expect(JSON.stringify({ created, listed, fetched, label })).not.toContain('provider-secret');
        expect(JSON.stringify({ created, listed, fetched, label })).not.toContain('provider_payload');
        expect(JSON.stringify({ created, listed, fetched, label })).not.toContain('provider_response');
        expect(JSON.stringify({ created, listed, fetched, label })).not.toContain('shippo_123');
        expect(JSON.stringify({ created, listed, fetched, label })).not.toContain('rate_abc');
        expect(JSON.stringify({ created, listed, fetched, label })).not.toContain('label_secret_123');
        expect(JSON.stringify({ created, listed, fetched, label })).not.toContain('metadata-secret');
        expect(JSON.stringify({ created, listed, fetched, label })).not.toContain('signed.example');
        expect(JSON.stringify({ created, listed, fetched, label })).not.toContain('storage.internal');
    });

    it('replays idempotent shipment creates and rejects mismatched retries before adapter side effects', async () => {
        const idempotencyRequest = {
            order_id: 'order-1',
            service_level: 'mock_ground',
            ship_to: { name: 'Ada Lovelace', country: 'US' },
            packages: [{ weight_grams: 250 }],
        };
        const existingShipment = shipmentRow({
            shipment_id: 'shipment-idem',
            idempotency_key: 'idem-ship',
            metadata: {
                note: 'merchant visible',
                idempotency_request: idempotencyRequest,
            },
        });
        const {
            createShipment,
            store,
            adapters,
        } = createHandlers(createShippingHandlers, {
            store: {
                findMerchantShipmentByIdempotencyKey: vi.fn().mockResolvedValue(existingShipment),
            },
        });

        const replayed = await createShipment({
            ...idempotencyRequest,
            idempotency_key: 'body-ignored-by-header',
        }, { headers: { 'Idempotency-Key': 'idem-ship' } });

        await expect(createShipment({
            ...idempotencyRequest,
            packages: [{ weight_grams: 999 }],
            idempotency_key: 'idem-ship',
        })).rejects.toMatchObject({
            statusCode: 409,
            code: 'idempotency_conflict',
        });

        expect(replayed).toMatchObject({
            ok: true,
            shipment_id: 'shipment-idem',
            status: 'label_created',
        });
        expect(replayed._http_status).toBe(200);
        expect(adapters.shipping.createShipment).not.toHaveBeenCalled();
        expect(store.createMerchantShipment).not.toHaveBeenCalled();
        expect(JSON.stringify(replayed)).not.toContain('idem-ship');
        expect(JSON.stringify(replayed)).not.toContain('idempotency');
    });

    it('claims idempotent shipment rows before adapter calls and finalizes only the claimant row', async () => {
        const operations = [];
        const {
            createShipment,
            store,
            adapters,
        } = createHandlers(createShippingHandlers, {
            store: {
                createMerchantShipment: vi.fn().mockImplementation(async (shipment) => {
                    operations.push(`claim:${shipment.status}`);
                    return shipmentRow({
                        ...shipment,
                        shipment_id: 'shipment-claim',
                        status: 'label_requested',
                    });
                }),
                updateMerchantShipmentStatus: vi.fn().mockImplementation(async ({ shipmentId, status, fields }) => {
                    operations.push(`finalize:${status}`);
                    return shipmentRow({
                        shipment_id: shipmentId,
                        status,
                        ...fields,
                    });
                }),
                createMerchantShippingLabel: vi.fn().mockImplementation(async (label) => labelRow({
                    ...label,
                    label_id: 'label-claim',
                })),
            },
            adapters: {
                shipping: {
                    createShipment: vi.fn().mockImplementation(async () => {
                        operations.push('adapter');
                        return {
                            provider: 'mock',
                            shipment_id: 'provider-shipment-id',
                            status: 'label_created',
                            carrier: 'mock_carrier',
                            service_level: 'mock_ground',
                            tracking_number: 'mock-track-claim',
                            label: {
                                provider: 'mock',
                                label_id: 'provider-label-id',
                                label_url: 'mock://shipments/shipment-claim/label.pdf',
                                tracking_number: 'mock-track-claim',
                                format: 'pdf',
                            },
                            created_at: '2026-07-01T12:00:00.000Z',
                        };
                    }),
                },
            },
        });

        const result = await createShipment({
            order_id: 'order-1',
            service_level: 'mock_ground',
            ship_to: { name: 'Ada Lovelace', country: 'US' },
            packages: [{ weight_grams: 250 }],
            idempotency_key: 'idem-claim',
        });

        expect(operations).toEqual(['claim:label_requested', 'adapter', 'finalize:label_created']);
        expect(result).toMatchObject({
            ok: true,
            shipment_id: 'shipment-claim',
            status: 'label_created',
            tracking_number: 'mock-track-claim',
            label: { label_id: 'label-claim' },
        });
        expect(store.createMerchantShipment).toHaveBeenCalledWith(expect.objectContaining({
            idempotency_key: 'idem-claim',
            status: 'label_requested',
            carrier: null,
            tracking_number: null,
            metadata: expect.objectContaining({
                idempotency_request: {
                    order_id: 'order-1',
                    service_level: 'mock_ground',
                    ship_to: { name: 'Ada Lovelace', country: 'US' },
                    packages: [{ weight_grams: 250 }],
                },
            }),
        }));
        expect(adapters.shipping.createShipment).toHaveBeenCalledTimes(1);
        expect(store.updateMerchantShipmentStatus).toHaveBeenCalledWith(expect.objectContaining({
            merchantId: 'merchant-1',
            shipmentId: 'shipment-claim',
            status: 'label_created',
            fields: expect.objectContaining({
                carrier: 'mock_carrier',
                tracking_number: 'mock-track-claim',
            }),
        }));
        expect(JSON.stringify(result)).not.toContain('idempotency');
    });

    it('replays a raced idempotency claim without calling the shipping adapter', async () => {
        const idempotencyRequest = {
            order_id: 'order-1',
            service_level: 'mock_ground',
            ship_to: { name: 'Ada Lovelace', country: 'US' },
            packages: [{ weight_grams: 250 }],
        };
        const existingShipment = shipmentRow({
            shipment_id: 'shipment-race',
            idempotency_key: 'idem-race',
            status: 'label_requested',
            metadata: {
                adapter_failure: {
                    message: 'provider timeout detail',
                    failed_at: '2026-07-01T12:00:00.000Z',
                },
                idempotency_request: idempotencyRequest,
            },
        });
        const {
            createShipment,
            store,
            adapters,
        } = createHandlers(createShippingHandlers, {
            store: {
                createMerchantShipment: vi.fn().mockRejectedValue(new Error('duplicate idempotency claim')),
                findMerchantShipmentByIdempotencyKey: vi.fn()
                    .mockResolvedValueOnce(null)
                    .mockResolvedValue(existingShipment),
            },
        });

        const result = await createShipment({
            ...idempotencyRequest,
            idempotency_key: 'idem-race',
        });

        expect(result).toMatchObject({
            ok: true,
            shipment_id: 'shipment-race',
            status: 'label_requested',
        });
        expect(result._http_status).toBe(200);
        expect(adapters.shipping.createShipment).not.toHaveBeenCalled();
        expect(store.createMerchantShipment).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(result)).not.toContain('idempotency');
        expect(JSON.stringify(result)).not.toContain('adapter_failure');
        expect(JSON.stringify(result)).not.toContain('provider timeout detail');
    });

    it('replays an existing label when label insert loses a race', async () => {
        const existingLabel = labelRow({ label_id: 'label-race', shipment_id: 'shipment-1' });
        const {
            createLabel,
            store,
        } = createHandlers(createShippingHandlers, {
            store: {
                getMerchantShippingLabelByShipment: vi.fn()
                    .mockResolvedValueOnce(null)
                    .mockResolvedValueOnce(existingLabel),
                createMerchantShippingLabel: vi.fn().mockRejectedValue(new Error('duplicate label')),
            },
        });

        const result = await createLabel({ shipment_id: 'shipment-1' });

        expect(result).toMatchObject({
            ok: true,
            label: {
                label_id: 'label-race',
                shipment_id: 'shipment-1',
            },
        });
        expect(store.getMerchantShippingLabelByShipment).toHaveBeenCalledTimes(2);
        expect(store.createMerchantShippingLabel).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(result)).not.toContain('provider-secret');
        expect(JSON.stringify(result)).not.toContain('signed.example');
    });

    it('claims a placeholder label before adapter work and finalizes the claimed label', async () => {
        const operations = [];
        const {
            createLabel,
            store,
            adapters,
        } = createHandlers(createShippingHandlers, {
            store: {
                createMerchantShippingLabel: vi.fn().mockImplementation(async (label) => {
                    operations.push(`claim-label:${label.label_url ?? 'pending'}`);
                    return labelRow({
                        ...label,
                        label_id: 'label-claim',
                        label_url: null,
                        tracking_number: null,
                        metadata: { label_claim_status: 'pending' },
                    });
                }),
                updateMerchantShippingLabel: vi.fn().mockImplementation(async ({ labelId, fields }) => {
                    operations.push('finalize-label');
                    return labelRow({
                        label_id: labelId,
                        ...fields,
                    });
                }),
            },
            adapters: {
                shipping: {
                    createShipment: vi.fn().mockImplementation(async () => {
                        operations.push('adapter');
                        return {
                            provider: 'mock',
                            tracking_number: 'mock-track-label',
                            label: {
                                provider: 'mock',
                                label_url: 'mock://shipments/shipment-1/label.pdf',
                                tracking_number: 'mock-track-label',
                                format: 'pdf',
                            },
                        };
                    }),
                },
            },
        });

        const result = await createLabel({ shipment_id: 'shipment-1' });

        expect(operations).toEqual(['claim-label:pending', 'adapter', 'finalize-label']);
        expect(result).toMatchObject({
            ok: true,
            label: {
                label_id: 'label-claim',
                label_url: 'mock://shipments/shipment-1/label.pdf',
                tracking_number: 'mock-track-label',
            },
        });
        expect(store.createMerchantShippingLabel).toHaveBeenCalledWith(expect.objectContaining({
            shipment_id: 'shipment-1',
            provider: 'mock',
            label_url: null,
            tracking_number: null,
            metadata: expect.objectContaining({ label_claim_status: 'pending' }),
        }));
        expect(adapters.shipping.createShipment).toHaveBeenCalledTimes(1);
    });
});

describe('merchant billing public handlers', () => {
    it('returns rate cards, usage summaries, invoices, and non-persisted previews', async () => {
        const {
            getRateCard,
            listUsage,
            listInvoices,
            getInvoice,
            previewInvoice,
            store,
        } = createHandlers(createBillingHandlers);

        const rateCard = await getRateCard();
        const usage = await listUsage({
            job_id: 'job-1',
            order_id: 'order-1',
            file_id: 'file-1',
            created_from: '2026-07-01T00:00:00.000Z',
            created_to: '2026-07-02T00:00:00.000Z',
            limit: '2',
        });
        const invoices = await listInvoices({ status: 'issued', limit: '1' });
        const invoice = await getInvoice({ invoice_id: 'invoice-1' });
        const preview = await previewInvoice({ order_id: 'order-1' });

        expect(rateCard).toMatchObject({
            ok: true,
            rate_card: {
                rate_card_id: 'rate-card-1',
                currency: 'USD',
                rates: expect.arrayContaining([expect.objectContaining({ code: 'order.submitted' })]),
            },
        });
        expect(usage).toMatchObject({
            ok: true,
            usage: expect.arrayContaining([
                expect.objectContaining({ usage_event_id: 'usage-1', order_id: 'order-1' }),
            ]),
            summary: {
                event_count: 2,
                total_quantity: 4,
                by_event_type: {
                    'machine_time': { event_count: 1, quantity: 3 },
                    'order.submitted': { event_count: 1, quantity: 1 },
                },
            },
        });
        expect(invoices).toMatchObject({ ok: true, invoices: [{ invoice_id: 'invoice-1', status: 'issued' }] });
        expect(invoice).toMatchObject({
            ok: true,
            invoice: {
                invoice_id: 'invoice-1',
                lines: [expect.objectContaining({ invoice_line_id: 'line-1' })],
            },
        });
        expect(preview).toMatchObject({
            ok: true,
            invoice_preview: {
                status: 'preview',
                currency: 'USD',
                lines: expect.any(Array),
            },
        });
        expect(store.listMerchantUsageEvents).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            jobId: 'job-1',
            orderId: 'order-1',
            fileId: 'file-1',
            createdFrom: '2026-07-01T00:00:00.000Z',
            createdTo: '2026-07-02T00:00:00.000Z',
            limit: 2,
        });
        expect(store.listMerchantInvoices).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            status: 'issued',
            limit: 1,
        });
        expect(store.getMerchantInvoice).toHaveBeenCalledWith({ merchantId: 'merchant-1', invoiceId: 'invoice-1' });
        expect(store.listMerchantInvoiceLines).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            invoiceId: 'invoice-1',
            limit: 100,
        });
        expect(store.createMerchantInvoice).not.toHaveBeenCalled();
        expect(store.createMerchantInvoiceLine).not.toHaveBeenCalled();
        expect(JSON.stringify({ rateCard, usage, invoices, invoice, preview })).not.toContain('org-1');
        expect(JSON.stringify({ rateCard, usage, invoices, invoice, preview })).not.toContain('merchant-1');
        expect(JSON.stringify({ rateCard, usage, invoices, invoice, preview })).not.toContain('rate-secret');
        expect(JSON.stringify({ rateCard, usage, invoices, invoice, preview })).not.toContain('usage-secret');
        expect(JSON.stringify({ rateCard, usage, invoices, invoice, preview })).not.toContain('invoice-secret');
        expect(JSON.stringify({ rateCard, usage, invoices, invoice, preview })).not.toContain('signed.example');
        expect(JSON.stringify({ rateCard, usage, invoices, invoice, preview })).not.toContain('internal/path');
    });

    it('falls back to the billing adapter when no active DB rate card exists', async () => {
        const { getRateCard, store, adapters } = createHandlers(createBillingHandlers, {
            store: { getMerchantRateCard: vi.fn().mockResolvedValue(null) },
        });

        const result = await getRateCard();

        expect(result).toMatchObject({
            ok: true,
            rate_card: {
                rate_card_id: 'mock-rate-card',
                provider: 'mock',
                currency: 'USD',
            },
        });
        expect(store.getMerchantRateCard).toHaveBeenCalledWith({ merchantId: 'merchant-1' });
        expect(adapters.billing.getRateCard).toHaveBeenCalledWith({
            merchant: expect.objectContaining({ merchant_id: 'merchant-1' }),
        });
    });
});

describe('merchant realtime public handlers', () => {
    it('mints bounded realtime tokens and lists only non-secret token metadata', async () => {
        const {
            createToken,
            listTokens,
            store,
            adapters,
        } = createHandlers(createRealtimeHandlers);

        const created = await createToken({ scopes: ['jobs:read'], ttl_seconds: 99999 });
        const listed = await listTokens({ limit: '1' });

        expect(created).toMatchObject({
            ok: true,
            token: 'pkx_mock_rt_secret_raw_token',
            token_record: {
                token_id: '33333333-3333-4333-8333-333333333333',
                token_prefix: 'pkx_mock_rt_secret',
                scopes: ['jobs:read'],
                expires_at: '2026-07-01T13:00:00.000Z',
            },
        });
        expect(created._http_status).toBe(201);
        expect(listed).toMatchObject({
            ok: true,
            tokens: [expect.objectContaining({ token_id: 'token-1', token_prefix: 'pkx_mock_rt_abc' })],
        });
        expect(adapters.realtime.createMerchantToken).toHaveBeenCalledWith(expect.objectContaining({
            merchant: expect.objectContaining({ merchant_id: 'merchant-1' }),
            scopes: ['jobs:read'],
            expiresInSeconds: 3600,
        }));
        expect(store.createMerchantRealtimeToken).toHaveBeenCalledWith(expect.objectContaining({
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            token_prefix: 'pkx_mock_rt_secret',
            scopes: ['jobs:read'],
            channel_names: [expect.stringMatching(/^pkx_rt_[a-f0-9]{16}_jobs$/)],
            expires_at: '2026-07-01T13:00:00.000Z',
        }));
        const persisted = store.createMerchantRealtimeToken.mock.calls[0][0];
        expect(persisted.channel_names[0]).not.toContain('3333333333334333');
        expect(persisted.token_hash).not.toBe('pkx_mock_rt_secret_raw_token');
        expect(persisted.token_hash).not.toBe('33333333-3333-4333-8333-333333333333');
        expect(store.listMerchantRealtimeTokens).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            limit: 1,
        });
        expect(JSON.stringify({ created, listed })).not.toContain('stored-token-hash-secret');
        expect(JSON.stringify({ created, listed })).not.toContain(persisted.token_hash);
        expect(JSON.stringify({ created, listed })).not.toContain('metadata-secret');
        expect(JSON.stringify({ created, listed })).not.toContain('merchant-1');
    });

    it('caps persisted and public realtime expiry even when the adapter returns a later expiry', async () => {
        const { createToken, store } = createHandlers(createRealtimeHandlers, {
            adapters: {
                realtime: {
                    createMerchantToken: vi.fn().mockResolvedValue({
                        provider: 'mock',
                        token_id: '44444444-4444-4444-8444-444444444444',
                        token: 'pkx_mock_rt_day_later',
                        scopes: ['events:read'],
                        issued_at: '2026-07-01T12:00:00.000Z',
                        expires_at: '2026-07-02T12:00:00.000Z',
                    }),
                },
            },
        });

        const result = await createToken({ scopes: ['events:read'], ttl_seconds: 60 });

        expect(result).toMatchObject({
            ok: true,
            token_record: {
                expires_at: '2026-07-01T12:01:00.000Z',
                channel_names: [expect.stringMatching(/^pkx_rt_[a-f0-9]{16}_events$/)],
            },
        });
        expect(store.createMerchantRealtimeToken).toHaveBeenCalledWith(expect.objectContaining({
            expires_at: '2026-07-01T12:01:00.000Z',
            channel_names: [expect.stringMatching(/^pkx_rt_[a-f0-9]{16}_events$/)],
        }));
        expect(store.createMerchantRealtimeToken.mock.calls[0][0].channel_names[0]).not.toContain('4444444444444444');
        expect(JSON.stringify(result)).not.toContain('merchant-1');
    });

    it('uses server time when adapter issued_at is future dated or malformed', async () => {
        const future = createHandlers(createRealtimeHandlers, {
            adapters: {
                realtime: {
                    createMerchantToken: vi.fn().mockResolvedValue({
                        provider: 'mock',
                        token_id: '55555555-5555-4555-8555-555555555555',
                        token: 'pkx_mock_rt_future',
                        scopes: ['billing:read'],
                        issued_at: '2026-07-02T12:00:00.000Z',
                        expires_at: '2026-07-02T13:00:00.000Z',
                    }),
                },
            },
        });
        const malformed = createHandlers(createRealtimeHandlers, {
            adapters: {
                realtime: {
                    createMerchantToken: vi.fn().mockResolvedValue({
                        provider: 'mock',
                        token_id: '66666666-6666-4666-8666-666666666666',
                        token: 'pkx_mock_rt_malformed',
                        scopes: ['shipments:read'],
                        issued_at: 'not-a-date',
                        expires_at: 'also-not-a-date',
                    }),
                },
            },
        });

        const futureResult = await future.createToken({ scopes: ['billing:read'], ttl_seconds: 120 });
        const malformedResult = await malformed.createToken({ scopes: ['shipments:read'], ttl_seconds: 60 });

        expect(futureResult).toMatchObject({
            ok: true,
            token_record: {
                expires_at: '2026-07-01T12:02:00.000Z',
            },
        });
        expect(future.store.createMerchantRealtimeToken).toHaveBeenCalledWith(expect.objectContaining({
            created_at: '2026-07-01T12:00:00.000Z',
            expires_at: '2026-07-01T12:02:00.000Z',
            metadata: expect.objectContaining({
                issued_at: '2026-07-01T12:00:00.000Z',
            }),
        }));
        expect(malformedResult).toMatchObject({
            ok: true,
            token_record: {
                expires_at: '2026-07-01T12:01:00.000Z',
            },
        });
        expect(malformed.store.createMerchantRealtimeToken).toHaveBeenCalledWith(expect.objectContaining({
            created_at: '2026-07-01T12:00:00.000Z',
            expires_at: '2026-07-01T12:01:00.000Z',
            metadata: expect.objectContaining({
                issued_at: '2026-07-01T12:00:00.000Z',
            }),
        }));
        expect(JSON.stringify({ futureResult, malformedResult })).not.toContain('merchant-1');
    });

    it('rejects realtime scopes outside the public allowlist', async () => {
        const { createToken } = createHandlers(createRealtimeHandlers);

        await expect(createToken({ scopes: ['admin:write'] })).rejects.toMatchObject({
            statusCode: 400,
            code: 'invalid_payload',
        });
    });
});

describe('merchant commerce public routes', () => {
    it('imports route handlers and returns v2 method envelopes', async () => {
        const routes = await Promise.all([
            importPublicRoute('../../api/public/shipments/index.js'),
            importPublicRoute('../../api/public/shipments/[shipment_id].js'),
            importPublicRoute('../../api/public/shipments/[shipment_id]/labels.js'),
            importPublicRoute('../../api/public/billing/rate-card.js'),
            importPublicRoute('../../api/public/billing/usage.js'),
            importPublicRoute('../../api/public/billing/invoices/index.js'),
            importPublicRoute('../../api/public/billing/invoices/[invoice_id].js'),
            importPublicRoute('../../api/public/billing/invoices/preview.js'),
            importPublicRoute('../../api/public/realtime/tokens.js'),
        ]);
        const responses = routes.map(() => createMockResponse());

        await routes[0]({ method: 'DELETE', headers: {} }, responses[0]);
        await routes[1]({ method: 'POST', headers: {}, query: { shipment_id: 'shipment-1' } }, responses[1]);
        await routes[2]({ method: 'GET', headers: {}, query: { shipment_id: 'shipment-1' } }, responses[2]);
        await routes[3]({ method: 'POST', headers: {} }, responses[3]);
        await routes[4]({ method: 'POST', headers: {} }, responses[4]);
        await routes[5]({ method: 'POST', headers: {} }, responses[5]);
        await routes[6]({ method: 'POST', headers: {}, query: { invoice_id: 'invoice-1' } }, responses[6]);
        await routes[7]({ method: 'GET', headers: {} }, responses[7]);
        await routes[8]({ method: 'DELETE', headers: {} }, responses[8]);

        expect(responses[0].statusCode).toBe(405);
        expect(responses[0].headers.Allow).toBe('GET, POST');
        expect(responses[1].headers.Allow).toBe('GET');
        expect(responses[2].headers.Allow).toBe('POST');
        for (const response of responses.slice(3, 7)) expect(response.headers.Allow).toBe('GET');
        expect(responses[7].headers.Allow).toBe('POST');
        expect(responses[8].headers.Allow).toBe('GET, POST');
        for (const response of responses) {
            expect(response.body).toMatchObject({
                ok: false,
                error: 'method_not_allowed',
                request_id: expect.stringMatching(/^req_/),
            });
        }
    });

    it('returns raw realtime tokens only on creation and never leaks token hashes through the route', async () => {
        const originalPepper = process.env.MERCHANT_API_KEY_PEPPER;
        process.env.MERCHANT_API_KEY_PEPPER = routePepper;
        const store = createAuthenticatedRouteStore();
        const handler = await importPublicRoute('../../api/public/realtime/tokens.js', store);
        const res = createMockResponse();

        try {
            await handler({
                method: 'POST',
                headers: { authorization: `Bearer ${routeRawKey}` },
                body: { scopes: ['orders:read'], ttl_seconds: 300 },
            }, res);
        } finally {
            if (originalPepper === undefined) delete process.env.MERCHANT_API_KEY_PEPPER;
            else process.env.MERCHANT_API_KEY_PEPPER = originalPepper;
        }

        expect(res.statusCode).toBe(201);
        expect(res.body).toMatchObject({
            ok: true,
            token: expect.stringMatching(/^pkx_mock_rt_/),
            token_record: {
                scopes: ['orders:read'],
            },
        });
        expect(JSON.stringify(res.body)).not.toContain('token_hash');
        expect(JSON.stringify(res.body)).not.toContain('stored-token-hash-secret');
    });
});
