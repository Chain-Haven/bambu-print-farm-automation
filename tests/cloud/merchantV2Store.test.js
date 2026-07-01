import { describe, expect, it, vi } from 'vitest';

const requiredMethods = [
    'createMerchantFile',
    'getMerchantFile',
    'updateMerchantFile',
    'deleteMerchantFile',
    'createMerchantSliceJob',
    'getMerchantSliceJob',
    'updateMerchantSliceJob',
    'createMerchantOrder',
    'getMerchantOrder',
    'findMerchantOrderByIdempotencyKey',
    'findMerchantOrderByExternalOrderId',
    'updateMerchantOrder',
    'cancelMerchantOrderIfCancelable',
    'createMerchantOrderItem',
    'createMerchantMaterialReservation',
    'getMerchantMaterialReservation',
    'releaseMerchantMaterialReservation',
    'createMerchantBatch',
    'getMerchantBatch',
    'updateMerchantBatch',
    'updateMerchantBatchIfStatus',
    'createMerchantBatchItem',
    'listMerchantBatchItems',
    'recordMerchantJobEvent',
    'listMerchantJobEvents',
    'createMerchantJobArtifact',
    'listMerchantJobArtifacts',
    'createMerchantInspection',
    'getMerchantInspection',
    'getMerchantInspectionByJob',
    'listMerchantInspections',
    'updateMerchantInspection',
    'createMerchantPostProcessingTask',
    'getMerchantPostProcessingTask',
    'listMerchantPostProcessingTasks',
    'updateMerchantPostProcessingTask',
    'updateMerchantPostProcessingTaskIfStatus',
    'createMerchantShipment',
    'getMerchantShipment',
    'createMerchantShippingLabel',
    'getMerchantRateCard',
    'createMerchantInvoice',
    'listMerchantInvoices',
    'createMerchantInvoiceLine',
    'createMerchantWebhookEndpoint',
    'listMerchantWebhookEndpoints',
    'updateMerchantWebhookEndpoint',
    'deleteMerchantWebhookEndpoint',
    'createMerchantWebhookDelivery',
    'listMerchantWebhookDeliveries',
    'createMerchantRealtimeToken',
    'recordMerchantAdapterEvent',
];

function jsonResponse(payload, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(payload),
    };
}

async function createStore(fetchImpl) {
    const { createSupabaseRestClient } = await import('../../src/cloud/supabaseRest.js');
    return createSupabaseRestClient({
        supabaseUrl: 'https://example.supabase.co',
        serviceRoleKey: 'service_role',
        fetchImpl,
    });
}

describe('merchant API v2 store surface', () => {
    it('exposes every v2 store method required by the public API backbone', async () => {
        const store = await createStore(async () => ({ ok: true, status: 200, text: async () => '[]' }));

        for (const method of requiredMethods) {
            expect(typeof store[method], method).toBe('function');
        }
    });

    it('creates merchant files with representation returned', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ file_id: 'f1', merchant_id: 'm1' }], 201));
        const store = await createStore(fetchImpl);

        const result = await store.createMerchantFile({ merchant_id: 'm1', org_id: 'o1', original_name: 'part.stl' });

        expect(result).toEqual({ file_id: 'f1', merchant_id: 'm1' });
        const [url, init] = fetchImpl.mock.calls[0];
        const requestUrl = new URL(url);
        expect(requestUrl.pathname).toBe('/rest/v1/merchant_files');
        expect(requestUrl.searchParams.get('select')).toBe('*');
        expect(init).toMatchObject({
            method: 'POST',
            headers: expect.objectContaining({ Prefer: 'return=representation' }),
            body: JSON.stringify({ merchant_id: 'm1', org_id: 'o1', original_name: 'part.stl' }),
        });
    });

    it('reads merchant files through merchant and file filters', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ file_id: 'f1', merchant_id: 'm1' }]));
        const store = await createStore(fetchImpl);

        await store.getMerchantFile({ merchantId: 'm1', fileId: 'f1' });

        const requestUrl = new URL(fetchImpl.mock.calls[0][0]);
        expect(requestUrl.pathname).toBe('/rest/v1/merchant_files');
        expect(requestUrl.searchParams.get('merchant_id')).toBe('eq.m1');
        expect(requestUrl.searchParams.get('file_id')).toBe('eq.f1');
        expect(requestUrl.searchParams.get('limit')).toBe('1');
    });

    it('updates merchant files through a merchant-scoped PATCH', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ file_id: 'f1', status: 'completed' }]));
        const store = await createStore(fetchImpl);

        await store.updateMerchantFile({ merchantId: 'm1', fileId: 'f1', fields: { status: 'completed' } });

        const [url, init] = fetchImpl.mock.calls[0];
        const requestUrl = new URL(url);
        expect(requestUrl.searchParams.get('merchant_id')).toBe('eq.m1');
        expect(requestUrl.searchParams.get('file_id')).toBe('eq.f1');
        expect(init).toMatchObject({
            method: 'PATCH',
            headers: expect.objectContaining({ Prefer: 'return=representation' }),
            body: JSON.stringify({ status: 'completed' }),
        });
    });

    it('soft-deletes merchant files through a merchant-scoped status and audit timestamp patch', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ file_id: 'f1', status: 'deleted' }]));
        const store = await createStore(fetchImpl);

        await store.deleteMerchantFile({
            merchantId: 'm1',
            fileId: 'f1',
            deletedAt: '2026-07-01T12:00:00.000Z',
        });

        const [url, init] = fetchImpl.mock.calls[0];
        const requestUrl = new URL(url);
        expect(requestUrl.searchParams.get('merchant_id')).toBe('eq.m1');
        expect(requestUrl.searchParams.get('file_id')).toBe('eq.f1');
        expect(init).toMatchObject({
            method: 'PATCH',
            body: JSON.stringify({
                status: 'deleted',
                deleted_at: '2026-07-01T12:00:00.000Z',
            }),
        });
    });

    it('lists merchant job events by merchant, job, and newest event first', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ event_id: 'e1', merchant_id: 'm1' }]));
        const store = await createStore(fetchImpl);

        await store.listMerchantJobEvents({ merchantId: 'm1', jobId: 'j1' });

        const requestUrl = new URL(fetchImpl.mock.calls[0][0]);
        expect(requestUrl.pathname).toBe('/rest/v1/merchant_job_events');
        expect(requestUrl.searchParams.get('merchant_id')).toBe('eq.m1');
        expect(requestUrl.searchParams.get('job_id')).toBe('eq.j1');
        expect(requestUrl.searchParams.get('order')).toBe('occurred_at.desc,event_id.desc');
    });

    it('finds merchant orders by idempotency key or external order id', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(jsonResponse([{ order_id: 'o1', idempotency_key: 'idem-1' }]))
            .mockResolvedValueOnce(jsonResponse([{ order_id: 'o2', external_order_id: '1001' }]));
        const store = await createStore(fetchImpl);

        await expect(store.findMerchantOrderByIdempotencyKey({
            merchantId: 'm1',
            idempotencyKey: 'idem-1',
        })).resolves.toEqual({ order_id: 'o1', idempotency_key: 'idem-1' });
        await expect(store.findMerchantOrderByExternalOrderId({
            merchantId: 'm1',
            externalOrderId: '1001',
        })).resolves.toEqual({ order_id: 'o2', external_order_id: '1001' });

        const idempotencyUrl = new URL(fetchImpl.mock.calls[0][0]);
        const externalUrl = new URL(fetchImpl.mock.calls[1][0]);
        expect(idempotencyUrl.pathname).toBe('/rest/v1/merchant_orders');
        expect(idempotencyUrl.searchParams.get('merchant_id')).toBe('eq.m1');
        expect(idempotencyUrl.searchParams.get('idempotency_key')).toBe('eq.idem-1');
        expect(idempotencyUrl.searchParams.get('limit')).toBe('1');
        expect(externalUrl.pathname).toBe('/rest/v1/merchant_orders');
        expect(externalUrl.searchParams.get('merchant_id')).toBe('eq.m1');
        expect(externalUrl.searchParams.get('external_order_id')).toBe('eq.1001');
        expect(externalUrl.searchParams.get('limit')).toBe('1');
    });

    it('conditionally cancels merchant orders only from cancelable statuses', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ order_id: 'o1', status: 'canceled' }]));
        const store = await createStore(fetchImpl);

        await store.cancelMerchantOrderIfCancelable({
            merchantId: 'm1',
            orderId: 'o1',
            canceledAt: '2026-07-01T12:00:00.000Z',
            cancelableStatuses: ['draft', 'submitted'],
        });

        const [url, init] = fetchImpl.mock.calls[0];
        const requestUrl = new URL(url);
        expect(requestUrl.pathname).toBe('/rest/v1/merchant_orders');
        expect(requestUrl.searchParams.get('merchant_id')).toBe('eq.m1');
        expect(requestUrl.searchParams.get('order_id')).toBe('eq.o1');
        expect(requestUrl.searchParams.get('status')).toBe('in.(draft,submitted)');
        expect(init).toMatchObject({
            method: 'PATCH',
            body: JSON.stringify({
                status: 'canceled',
                canceled_at: '2026-07-01T12:00:00.000Z',
            }),
        });
    });

    it('releases material reservations through a merchant-scoped status and audit timestamp patch', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ reservation_id: 'r1', status: 'released' }]));
        const store = await createStore(fetchImpl);

        await store.releaseMerchantMaterialReservation({
            merchantId: 'm1',
            reservationId: 'r1',
            releasedAt: '2026-07-01T12:05:00.000Z',
        });

        const [url, init] = fetchImpl.mock.calls[0];
        const requestUrl = new URL(url);
        expect(requestUrl.pathname).toBe('/rest/v1/merchant_material_reservations');
        expect(requestUrl.searchParams.get('merchant_id')).toBe('eq.m1');
        expect(requestUrl.searchParams.get('reservation_id')).toBe('eq.r1');
        expect(requestUrl.searchParams.get('status')).toBe('eq.reserved');
        expect(init).toMatchObject({
            method: 'PATCH',
            body: JSON.stringify({
                status: 'released',
                released_at: '2026-07-01T12:05:00.000Z',
            }),
        });
    });
});
