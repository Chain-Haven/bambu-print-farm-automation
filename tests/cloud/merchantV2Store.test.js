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
    'findMerchantOrderItemByJobAndOrder',
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
    'updateMerchantInspectionIfDecisionOpen',
    'createMerchantPostProcessingTask',
    'getMerchantPostProcessingTask',
    'findMerchantPostProcessingTaskByIdempotencyKey',
    'listMerchantPostProcessingTasks',
    'updateMerchantPostProcessingTask',
    'updateMerchantPostProcessingTaskIfStatus',
    'createMerchantShipment',
    'findMerchantShipmentByIdempotencyKey',
    'listMerchantShipments',
    'getMerchantShipment',
    'updateMerchantShipmentStatus',
    'createMerchantShippingLabel',
    'updateMerchantShippingLabel',
    'updateMerchantShippingLabelIfClaimStatus',
    'listMerchantShippingLabels',
    'getMerchantShippingLabelByShipment',
    'getMerchantRateCard',
    'createMerchantInvoice',
    'listMerchantInvoices',
    'getMerchantInvoice',
    'createMerchantInvoiceLine',
    'listMerchantInvoiceLines',
    'createMerchantWebhookEndpoint',
    'listMerchantWebhookEndpoints',
    'updateMerchantWebhookEndpoint',
    'deleteMerchantWebhookEndpoint',
    'createMerchantWebhookDelivery',
    'listMerchantWebhookDeliveries',
    'createMerchantRealtimeToken',
    'listMerchantRealtimeTokens',
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

    it('lists shipments, labels, and label lookups with merchant-scoped filters', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(jsonResponse([{ shipment_id: 's1', merchant_id: 'm1' }]))
            .mockResolvedValueOnce(jsonResponse([{ shipment_id: 's2', metadata: { idempotency_key: 'idem-ship' } }]))
            .mockResolvedValueOnce(jsonResponse([{ label_id: 'l1', shipment_id: 's1' }]))
            .mockResolvedValueOnce(jsonResponse([{ label_id: 'l2', shipment_id: 's1' }]))
            .mockResolvedValueOnce(jsonResponse([{ shipment_id: 's1', status: 'shipped' }]));
        const store = await createStore(fetchImpl);

        await store.listMerchantShipments({
            merchantId: 'm1',
            orderId: 'o1',
            status: 'label_created',
            limit: 2,
        });
        await store.findMerchantShipmentByIdempotencyKey({ merchantId: 'm1', idempotencyKey: 'idem-ship' });
        await store.listMerchantShippingLabels({ merchantId: 'm1', shipmentId: 's1', limit: 3 });
        await store.getMerchantShippingLabelByShipment({ merchantId: 'm1', shipmentId: 's1' });
        await store.updateMerchantShipmentStatus({
            merchantId: 'm1',
            shipmentId: 's1',
            status: 'shipped',
            shippedAt: '2026-07-01T12:10:00.000Z',
        });

        const shipmentsUrl = new URL(fetchImpl.mock.calls[0][0]);
        expect(shipmentsUrl.pathname).toBe('/rest/v1/merchant_shipments');
        expect(shipmentsUrl.searchParams.get('merchant_id')).toBe('eq.m1');
        expect(shipmentsUrl.searchParams.get('order_id')).toBe('eq.o1');
        expect(shipmentsUrl.searchParams.get('status')).toBe('eq.label_created');
        expect(shipmentsUrl.searchParams.get('order')).toBe('created_at.desc');
        expect(shipmentsUrl.searchParams.get('limit')).toBe('2');

        const idempotencyUrl = new URL(fetchImpl.mock.calls[1][0]);
        expect(idempotencyUrl.pathname).toBe('/rest/v1/merchant_shipments');
        expect(idempotencyUrl.searchParams.get('merchant_id')).toBe('eq.m1');
        expect(idempotencyUrl.searchParams.get('idempotency_key')).toBe('eq.idem-ship');
        expect(idempotencyUrl.searchParams.get('limit')).toBe('1');

        const labelsUrl = new URL(fetchImpl.mock.calls[2][0]);
        expect(labelsUrl.pathname).toBe('/rest/v1/merchant_shipping_labels');
        expect(labelsUrl.searchParams.get('merchant_id')).toBe('eq.m1');
        expect(labelsUrl.searchParams.get('shipment_id')).toBe('eq.s1');
        expect(labelsUrl.searchParams.get('limit')).toBe('3');

        const labelLookupUrl = new URL(fetchImpl.mock.calls[3][0]);
        expect(labelLookupUrl.pathname).toBe('/rest/v1/merchant_shipping_labels');
        expect(labelLookupUrl.searchParams.get('merchant_id')).toBe('eq.m1');
        expect(labelLookupUrl.searchParams.get('shipment_id')).toBe('eq.s1');
        expect(labelLookupUrl.searchParams.get('limit')).toBe('1');

        const [updateUrl, updateInit] = fetchImpl.mock.calls[4];
        const shipmentUpdateUrl = new URL(updateUrl);
        expect(shipmentUpdateUrl.pathname).toBe('/rest/v1/merchant_shipments');
        expect(shipmentUpdateUrl.searchParams.get('merchant_id')).toBe('eq.m1');
        expect(shipmentUpdateUrl.searchParams.get('shipment_id')).toBe('eq.s1');
        expect(updateInit).toMatchObject({
            method: 'PATCH',
            body: JSON.stringify({
                status: 'shipped',
                shipped_at: '2026-07-01T12:10:00.000Z',
            }),
        });
    });

    it('filters usage, invoices, invoice lines, and realtime token metadata', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(jsonResponse([{ usage_event_id: 'u1', merchant_id: 'm1' }]))
            .mockResolvedValueOnce(jsonResponse([{ invoice_id: 'i1', merchant_id: 'm1' }]))
            .mockResolvedValueOnce(jsonResponse([{ invoice_id: 'i1', merchant_id: 'm1' }]))
            .mockResolvedValueOnce(jsonResponse([{ invoice_line_id: 'il1', invoice_id: 'i1' }]))
            .mockResolvedValueOnce(jsonResponse([{ token_id: 't1', token_prefix: 'pkx_mock_rt_' }]));
        const store = await createStore(fetchImpl);

        await store.listMerchantUsageEvents({
            merchantId: 'm1',
            jobId: 'j1',
            orderId: 'o1',
            fileId: 'f1',
            createdFrom: '2026-07-01T00:00:00.000Z',
            createdTo: '2026-07-02T00:00:00.000Z',
            limit: 4,
        });
        await store.listMerchantInvoices({ merchantId: 'm1', status: 'issued', limit: 5 });
        await store.getMerchantInvoice({ merchantId: 'm1', invoiceId: 'i1' });
        await store.listMerchantInvoiceLines({ merchantId: 'm1', invoiceId: 'i1', limit: 6 });
        await store.listMerchantRealtimeTokens({ merchantId: 'm1', limit: 7 });

        const usageUrl = new URL(fetchImpl.mock.calls[0][0]);
        expect(usageUrl.pathname).toBe('/rest/v1/merchant_usage_events');
        expect(usageUrl.searchParams.get('merchant_id')).toBe('eq.m1');
        expect(usageUrl.searchParams.get('job_id')).toBe('eq.j1');
        expect(usageUrl.searchParams.get('file_id')).toBe('eq.f1');
        expect(usageUrl.searchParams.get('metrics->>order_id')).toBe('eq.o1');
        expect(usageUrl.searchParams.get('created_at')).toBe('gte.2026-07-01T00:00:00.000Z');
        expect(usageUrl.toString()).toContain('created_at=lt.2026-07-02T00%3A00%3A00.000Z');
        expect(usageUrl.searchParams.get('order')).toBe('created_at.desc');
        expect(usageUrl.searchParams.get('limit')).toBe('4');

        const invoicesUrl = new URL(fetchImpl.mock.calls[1][0]);
        expect(invoicesUrl.pathname).toBe('/rest/v1/merchant_invoices');
        expect(invoicesUrl.searchParams.get('merchant_id')).toBe('eq.m1');
        expect(invoicesUrl.searchParams.get('status')).toBe('eq.issued');
        expect(invoicesUrl.searchParams.get('limit')).toBe('5');

        const invoiceUrl = new URL(fetchImpl.mock.calls[2][0]);
        expect(invoiceUrl.pathname).toBe('/rest/v1/merchant_invoices');
        expect(invoiceUrl.searchParams.get('merchant_id')).toBe('eq.m1');
        expect(invoiceUrl.searchParams.get('invoice_id')).toBe('eq.i1');
        expect(invoiceUrl.searchParams.get('limit')).toBe('1');

        const linesUrl = new URL(fetchImpl.mock.calls[3][0]);
        expect(linesUrl.pathname).toBe('/rest/v1/merchant_invoice_lines');
        expect(linesUrl.searchParams.get('merchant_id')).toBe('eq.m1');
        expect(linesUrl.searchParams.get('invoice_id')).toBe('eq.i1');
        expect(linesUrl.searchParams.get('limit')).toBe('6');

        const tokensUrl = new URL(fetchImpl.mock.calls[4][0]);
        expect(tokensUrl.pathname).toBe('/rest/v1/merchant_realtime_tokens');
        expect(tokensUrl.searchParams.get('merchant_id')).toBe('eq.m1');
        expect(tokensUrl.searchParams.get('revoked_at')).toBe('is.null');
        expect(tokensUrl.searchParams.get('expires_at')).toMatch(/^gt\./);
        expect(tokensUrl.searchParams.get('select')).not.toContain('token_hash');
        expect(tokensUrl.searchParams.get('limit')).toBe('7');
    });

    it('updates claimed shipping labels through a merchant-scoped PATCH', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ label_id: 'l1', label_url: 'mock://label' }]));
        const store = await createStore(fetchImpl);

        await store.updateMerchantShippingLabel({
            merchantId: 'm1',
            labelId: 'l1',
            fields: {
                label_url: 'mock://label',
                tracking_number: 'track-1',
                metadata: { label_claim_status: 'completed' },
            },
        });

        const [url, init] = fetchImpl.mock.calls[0];
        const requestUrl = new URL(url);
        expect(requestUrl.pathname).toBe('/rest/v1/merchant_shipping_labels');
        expect(requestUrl.searchParams.get('merchant_id')).toBe('eq.m1');
        expect(requestUrl.searchParams.get('label_id')).toBe('eq.l1');
        expect(init).toMatchObject({
            method: 'PATCH',
            headers: expect.objectContaining({ Prefer: 'return=representation' }),
            body: JSON.stringify({
                label_url: 'mock://label',
                tracking_number: 'track-1',
                metadata: { label_claim_status: 'completed' },
            }),
        });
    });

    it('conditionally reclaims failed shipping labels by metadata claim status', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ label_id: 'l1', metadata: { label_claim_status: 'pending' } }]));
        const store = await createStore(fetchImpl);

        await store.updateMerchantShippingLabelIfClaimStatus({
            merchantId: 'm1',
            labelId: 'l1',
            allowedStatuses: ['failed'],
            fields: {
                metadata: { label_claim_status: 'pending' },
            },
        });

        const [url, init] = fetchImpl.mock.calls[0];
        const requestUrl = new URL(url);
        expect(requestUrl.pathname).toBe('/rest/v1/merchant_shipping_labels');
        expect(requestUrl.searchParams.get('merchant_id')).toBe('eq.m1');
        expect(requestUrl.searchParams.get('label_id')).toBe('eq.l1');
        expect(requestUrl.searchParams.get('metadata->>label_claim_status')).toBe('in.(failed)');
        expect(init).toMatchObject({
            method: 'PATCH',
            headers: expect.objectContaining({ Prefer: 'return=representation' }),
            body: JSON.stringify({
                metadata: { label_claim_status: 'pending' },
            }),
        });
    });
});
