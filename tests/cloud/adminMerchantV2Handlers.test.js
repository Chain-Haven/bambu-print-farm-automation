import { describe, expect, it, vi } from 'vitest';
import { createCloudMerchantV2Handler } from '../../src/cloud/adminHandlers.js';

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
    };
}

describe('cloud merchant API v2 admin handler', () => {
    it('returns a read-heavy Merchant API v2 resource envelope for a merchant', async () => {
        const store = {
            listMerchantFiles: vi.fn().mockResolvedValue([{ file_id: 'file-1' }]),
            listMerchantOrders: vi.fn().mockResolvedValue([{ order_id: 'order-1' }]),
            listMerchantSliceJobs: vi.fn().mockResolvedValue([{ slice_job_id: 'slice-1' }]),
            listMerchantBatches: vi.fn().mockResolvedValue([{ batch_id: 'batch-1' }]),
            listMerchantMaterialReservations: vi.fn().mockResolvedValue([{ reservation_id: 'reservation-1' }]),
            listMerchantShipments: vi.fn().mockResolvedValue([{ shipment_id: 'shipment-1' }]),
            listMerchantInvoices: vi.fn().mockResolvedValue([{ invoice_id: 'invoice-1' }]),
            listMerchantWebhookDeliveries: vi.fn().mockResolvedValue([{ delivery_id: 'delivery-1' }]),
            listMerchantAdapterEvents: vi.fn().mockResolvedValue([{ adapter_event_id: 'adapter-1' }]),
        };
        const handler = createCloudMerchantV2Handler({ store, adminToken: 'admin-secret' });
        const res = createMockResponse();

        await handler({
            method: 'GET',
            headers: { authorization: 'Bearer admin-secret' },
            query: { merchant_id: 'merchant-1', limit: '500' },
        }, res);

        const expectedQuery = { merchantId: 'merchant-1', limit: 100 };
        expect(store.listMerchantFiles).toHaveBeenCalledWith(expectedQuery);
        expect(store.listMerchantOrders).toHaveBeenCalledWith(expectedQuery);
        expect(store.listMerchantSliceJobs).toHaveBeenCalledWith(expectedQuery);
        expect(store.listMerchantBatches).toHaveBeenCalledWith(expectedQuery);
        expect(store.listMerchantMaterialReservations).toHaveBeenCalledWith(expectedQuery);
        expect(store.listMerchantShipments).toHaveBeenCalledWith(expectedQuery);
        expect(store.listMerchantInvoices).toHaveBeenCalledWith(expectedQuery);
        expect(store.listMerchantWebhookDeliveries).toHaveBeenCalledWith(expectedQuery);
        expect(store.listMerchantAdapterEvents).toHaveBeenCalledWith(expectedQuery);
        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({
            ok: true,
            v2: expect.objectContaining({
                orders: expect.any(Array),
                files: expect.any(Array),
                slices: expect.any(Array),
                batches: expect.any(Array),
                reservations: expect.any(Array),
                shipments: expect.any(Array),
                invoices: expect.any(Array),
                webhook_deliveries: expect.any(Array),
                adapter_events: expect.any(Array),
            }),
        });
        expect(res.body.v2).toEqual({
            orders: [{ order_id: 'order-1' }],
            files: [{ file_id: 'file-1' }],
            slices: [{ slice_job_id: 'slice-1' }],
            batches: [{ batch_id: 'batch-1' }],
            reservations: [{ reservation_id: 'reservation-1' }],
            shipments: [{ shipment_id: 'shipment-1' }],
            invoices: [{ invoice_id: 'invoice-1' }],
            webhook_deliveries: [{ delivery_id: 'delivery-1' }],
            adapter_events: [{ adapter_event_id: 'adapter-1' }],
        });
    });

    it('projects Merchant API v2 rows before sending them to the admin browser', async () => {
        const store = {
            listMerchantFiles: vi.fn().mockResolvedValue([{
                file_id: 'file-1',
                original_name: 'part.stl',
                status: 'completed',
                storage_path: 'org-1/merchant-1/files/file-1/part.stl',
                download_url: 'https://signed.example/download-secret',
                metadata: {
                    note: 'safe file note',
                    token: 'file-token-secret',
                    webhook_signing_secret: 'whsec_file_secret',
                },
            }]),
            listMerchantOrders: vi.fn().mockResolvedValue([{
                order_id: 'order-1',
                external_order_id: 'shop-1001',
                status: 'submitted',
                idempotency_key: 'idem-secret',
                totals: { total: 42, currency: 'USD' },
                metadata: {
                    note: 'safe order note',
                    token: 'order-token-secret',
                },
            }]),
            listMerchantSliceJobs: vi.fn().mockResolvedValue([{
                slice_job_id: 'slice-1',
                file_id: 'file-1',
                status: 'failed',
                profile: { name: '0.20mm' },
                result: {
                    provider_request: { api_key: 'slice-provider-secret' },
                    preview: 'safe preview',
                },
                adapter_failure: {
                    stack: 'adapter-stack-secret',
                },
            }]),
            listMerchantBatches: vi.fn().mockResolvedValue([{
                batch_id: 'batch-1',
                name: 'Night Queue',
                status: 'queued',
                settings: {
                    material: 'PLA',
                    local_printer_access_code: 'printer-code-secret',
                },
                metadata: {
                    storage_path: 'internal/batch/path',
                    note: 'safe batch note',
                },
            }]),
            listMerchantMaterialReservations: vi.fn().mockResolvedValue([{
                reservation_id: 'reservation-1',
                material: 'PLA',
                status: 'reserved',
                metadata: {
                    spool_id: 'spool-secret',
                    note: 'safe reservation note',
                },
            }]),
            listMerchantShipments: vi.fn().mockResolvedValue([{
                shipment_id: 'shipment-1',
                order_id: 'order-1',
                status: 'label_created',
                carrier: 'UPS',
                tracking_number: '1ZSAFE',
                label_url: 'https://labels.example/signed-label-secret',
                ship_to: {
                    name: 'Customer',
                    token: 'ship-token-secret',
                },
                metadata: {
                    provider_response: { raw: 'shipment-provider-secret' },
                    note: 'safe shipment note',
                },
            }]),
            listMerchantInvoices: vi.fn().mockResolvedValue([{
                invoice_id: 'invoice-1',
                status: 'issued',
                total: 42,
                currency: 'USD',
                provider_request: { token: 'invoice-provider-secret' },
                metadata: {
                    note: 'safe invoice note',
                    secret_hash: 'invoice-secret-hash',
                },
            }]),
            listMerchantWebhookDeliveries: vi.fn().mockResolvedValue([{
                delivery_id: 'delivery-1',
                webhook_id: 'webhook-1',
                event_type: 'order.created',
                status: 'failed',
                response_status: 500,
                request_payload: {
                    authorization: 'Bearer webhook-secret',
                    order_id: 'order-1',
                },
                response_body: 'webhook-response-secret',
                secret_hash: 'webhook-secret-hash',
                metadata: {
                    webhook_signing_secret: 'whsec_delivery_secret',
                    note: 'safe webhook note',
                },
            }]),
            listMerchantAdapterEvents: vi.fn().mockResolvedValue([{
                adapter_event_id: 'adapter-1',
                adapter_name: 'mock-shipping',
                event_type: 'health.failed',
                resource_type: 'shipment',
                resource_id: 'shipment-1',
                payload: {
                    provider_request: { token: 'adapter-provider-secret' },
                    adapter_failure: { stack: 'adapter-failure-secret' },
                    safe_summary: 'timeout',
                },
                metadata: {
                    node_secret: 'node-secret',
                    note: 'safe adapter note',
                },
            }]),
        };
        const handler = createCloudMerchantV2Handler({ store, adminToken: 'admin-secret' });
        const res = createMockResponse();

        await handler({
            method: 'GET',
            headers: { authorization: 'Bearer admin-secret' },
            query: { merchant_id: 'merchant-1' },
        }, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.v2.orders[0]).toMatchObject({
            order_id: 'order-1',
            external_order_id: 'shop-1001',
            status: 'submitted',
            totals: { total: 42, currency: 'USD' },
            metadata: { note: 'safe order note' },
        });
        expect(res.body.v2.files[0]).toMatchObject({
            file_id: 'file-1',
            original_name: 'part.stl',
            status: 'completed',
            metadata: { note: 'safe file note' },
        });
        expect(res.body.v2.webhook_deliveries[0]).toMatchObject({
            delivery_id: 'delivery-1',
            webhook_id: 'webhook-1',
            event_type: 'order.created',
            status: 'failed',
            response_status: 500,
            metadata: { note: 'safe webhook note' },
        });
        expect(res.body.v2.adapter_events[0]).toMatchObject({
            adapter_event_id: 'adapter-1',
            adapter_name: 'mock-shipping',
            event_type: 'health.failed',
            payload: { safe_summary: 'timeout' },
            metadata: { note: 'safe adapter note' },
        });

        const serialized = JSON.stringify(res.body);
        for (const unsafeName of [
            'storage_path',
            'download_url',
            'label_url',
            'secret_hash',
            'request_payload',
            'response_body',
            'provider_request',
            'provider_response',
            'webhook_signing_secret',
            'idempotency_key',
            'adapter_failure',
            'local_printer_access_code',
            'spool_id',
            'node_secret',
            'token',
            'authorization',
        ]) {
            expect(serialized).not.toContain(`"${unsafeName}"`);
        }
        for (const unsafeValue of [
            'org-1/merchant-1/files/file-1/part.stl',
            'https://signed.example/download-secret',
            'file-token-secret',
            'whsec_file_secret',
            'idem-secret',
            'slice-provider-secret',
            'adapter-stack-secret',
            'printer-code-secret',
            'spool-secret',
            'https://labels.example/signed-label-secret',
            'shipment-provider-secret',
            'invoice-provider-secret',
            'Bearer webhook-secret',
            'webhook-response-secret',
            'whsec_delivery_secret',
            'adapter-provider-secret',
            'adapter-failure-secret',
            'node-secret',
        ]) {
            expect(serialized).not.toContain(unsafeValue);
        }
    });

    it('rejects unsupported methods and missing merchant ids', async () => {
        const store = {
            listMerchantFiles: vi.fn(),
        };
        const handler = createCloudMerchantV2Handler({ store, adminToken: 'admin-secret' });
        const postRes = createMockResponse();
        const missingMerchantRes = createMockResponse();

        await handler({
            method: 'POST',
            headers: { authorization: 'Bearer admin-secret' },
            query: { merchant_id: 'merchant-1' },
        }, postRes);
        await handler({
            method: 'GET',
            headers: { authorization: 'Bearer admin-secret' },
            query: {},
        }, missingMerchantRes);

        expect(postRes.statusCode).toBe(405);
        expect(postRes.headers.Allow).toBe('GET');
        expect(postRes.body).toMatchObject({ ok: false, error: 'method_not_allowed' });
        expect(missingMerchantRes.statusCode).toBe(400);
        expect(missingMerchantRes.body).toMatchObject({
            ok: false,
            error: 'list_merchant_v2_failed',
            message: 'merchant_id is required',
        });
        expect(store.listMerchantFiles).not.toHaveBeenCalled();
    });
});
