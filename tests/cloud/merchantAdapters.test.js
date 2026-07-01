import { describe, expect, it } from 'vitest';

describe('merchant API v2 mock adapters', () => {
    it('creates deterministic mock adapter outputs', async () => {
        const { createDefaultAdapters } = await import('../../src/cloud/adapters/index.js');
        const adapters = createDefaultAdapters({ now: () => new Date('2026-07-01T05:00:00.000Z') });

        const slice = await adapters.slicer.createSliceJob({
            merchant: { merchant_id: 'm1' },
            sourceFile: { file_id: 'f1', original_name: 'part.stl' },
            profile: { quality: 'standard' },
            requirements: { materials: ['PLA'] },
        });
        expect(slice).toMatchObject({
            provider: 'mock',
            status: 'completed_mock',
            artifact: { original_name: 'part.mock-sliced.gcode.3mf' },
        });

        const shipment = await adapters.shipping.createShipment({
            merchant: { merchant_id: 'm1' },
            order: { order_id: 'o1' },
            address: { country: 'US' },
            packages: [{ weight_grams: 500 }],
        });
        expect(shipment.tracking_number).toMatch(/^mock_track_/);
        expect(shipment.provider).toBe('mock');

        const rateCard = await adapters.billing.getRateCard({ merchant: { merchant_id: 'm1' } });
        expect(rateCard.currency).toBe('USD');
        expect(rateCard.provider).toBe('mock');

        const inspection = await adapters.inspection.getInspection({ job: { job_id: 'j1' } });
        expect(inspection.status).toBe('manual_review');

        const token = await adapters.realtime.createMerchantToken({
            merchant: { merchant_id: 'm1' },
            scopes: ['jobs:read'],
            expiresInSeconds: 300,
        });
        expect(token.token).toMatch(/^pkx_mock_rt_/);
    });
});

describe('merchant API v2 helpers', () => {
    it('formats public responses and merchant scope consistently', async () => {
        const {
            createHttpError,
            createRequestId,
            merchantScope,
            publicError,
            publicOk,
        } = await import('../../src/cloud/merchantApiV2.js');

        expect(createRequestId('quote')).toMatch(/^quote_[0-9a-f-]{36}$/);
        expect(merchantScope({ org_id: 'org-1', merchant_id: 'm1', extra: 'ignored' })).toEqual({
            org_id: 'org-1',
            merchant_id: 'm1',
        });
        expect(publicOk({ result: 'ready' }, 'req-1')).toEqual({
            ok: true,
            request_id: 'req-1',
            result: 'ready',
        });

        const httpError = createHttpError(422, 'invalid_payload', 'Invalid payload');
        expect(httpError).toBeInstanceOf(Error);
        expect(httpError).toMatchObject({
            statusCode: 422,
            code: 'invalid_payload',
            message: 'Invalid payload',
        });
        expect(publicError(httpError, 'req-2')).toEqual({
            ok: false,
            error: 'invalid_payload',
            message: 'Invalid payload',
            request_id: 'req-2',
        });
    });
});
