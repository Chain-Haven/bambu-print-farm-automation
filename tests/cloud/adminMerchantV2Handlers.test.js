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
});
