import { describe, expect, it } from 'vitest';

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
    'updateMerchantOrder',
    'createMerchantOrderItem',
    'createMerchantMaterialReservation',
    'getMerchantMaterialReservation',
    'releaseMerchantMaterialReservation',
    'createMerchantBatch',
    'getMerchantBatch',
    'updateMerchantBatch',
    'createMerchantBatchItem',
    'recordMerchantJobEvent',
    'listMerchantJobEvents',
    'createMerchantJobArtifact',
    'listMerchantJobArtifacts',
    'createMerchantInspection',
    'getMerchantInspectionByJob',
    'updateMerchantInspection',
    'createMerchantPostProcessingTask',
    'listMerchantPostProcessingTasks',
    'updateMerchantPostProcessingTask',
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

describe('merchant API v2 store surface', () => {
    it('exposes every v2 store method required by the public API backbone', async () => {
        const { createSupabaseRestClient } = await import('../../src/cloud/supabaseRest.js');
        const store = createSupabaseRestClient({
            supabaseUrl: 'https://example.supabase.co',
            serviceRoleKey: 'service_role',
            fetchImpl: async () => ({ ok: true, status: 200, text: async () => '[]' }),
        });

        for (const method of requiredMethods) {
            expect(typeof store[method], method).toBe('function');
        }
    });
});
