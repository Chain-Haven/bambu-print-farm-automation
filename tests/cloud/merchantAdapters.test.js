import { describe, expect, it } from 'vitest';

describe('merchant API v2 mock adapters', () => {
    it('creates deterministic mock adapter outputs', async () => {
        const { createDefaultAdapters } = await import('../../src/cloud/adapters/index.js');
        const timestamp = '2026-07-01T05:00:00.000Z';
        const adapters = createDefaultAdapters({ now: () => new Date(timestamp) });

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
        expect(slice).toMatchObject({
            created_at: timestamp,
            updated_at: timestamp,
            completed_at: timestamp,
            artifact: { created_at: timestamp },
        });

        const shipment = await adapters.shipping.createShipment({
            merchant: { merchant_id: 'm1' },
            order: { order_id: 'o1' },
            address: { country: 'US' },
            packages: [{ weight_grams: 500 }],
        });
        expect(shipment).toMatchObject({
            provider: 'mock',
            status: 'label_created',
            service_level: 'mock_ground',
            ship_to: { country: 'US' },
            created_at: timestamp,
            updated_at: timestamp,
            label: {
                provider: 'mock',
                label_url: `mock://shipments/${shipment.shipment_id}/label.pdf`,
                created_at: timestamp,
            },
        });
        expect(shipment.tracking_number).toBe(`mock_track_${shipment.shipment_id.slice(0, 8)}`);

        const rateCard = await adapters.billing.getRateCard({ merchant: { merchant_id: 'm1' } });
        expect(rateCard.currency).toBe('USD');
        expect(rateCard.provider).toBe('mock');
        expect(rateCard).toMatchObject({
            created_at: timestamp,
            updated_at: timestamp,
        });

        const inspection = await adapters.inspection.getInspection({ job: { job_id: 'j1' } });
        expect(inspection.status).toBe('manual_review');
        expect(inspection).toMatchObject({
            created_at: timestamp,
            updated_at: timestamp,
        });

        const token = await adapters.realtime.createMerchantToken({
            merchant: { merchant_id: 'm1' },
            scopes: ['jobs:read'],
            expiresInSeconds: 300,
        });
        expect(token.token).toMatch(/^pkx_mock_rt_/);
        expect(token).toMatchObject({
            issued_at: timestamp,
            expires_at: '2026-07-01T05:05:00.000Z',
        });
        expect(token.token).not.toBe(`pkx_mock_rt_${token.token_id.replaceAll('-', '')}`);
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
        expect(publicOk({ ok: false, request_id: 'spoofed', result: 'ready' }, 'req-1')).toEqual({
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

        expect(publicError(new Error('database password leaked'), 'req-3')).toEqual({
            ok: false,
            error: 'internal_error',
            message: 'Unexpected server error',
            request_id: 'req-3',
        });
        expect(publicError('plain string failure', 'req-4')).toEqual({
            ok: false,
            error: 'internal_error',
            message: 'Unexpected server error',
            request_id: 'req-4',
        });
        expect(publicError({
            statusCode: '404',
            code: 'not_found',
            message: 'String status should not expose',
        }, 'req-5')).toEqual({
            ok: false,
            error: 'internal_error',
            message: 'Unexpected server error',
            request_id: 'req-5',
        });
        expect(publicError({
            statusCode: 400,
            code: 'bad_request',
            message: 'internal secret detail',
        }, 'req-6')).toEqual({
            ok: false,
            error: 'internal_error',
            message: 'Unexpected server error',
            request_id: 'req-6',
        });
        const spoofedPublicSafeError = new Proxy({}, {
            get(_target, property) {
                if (typeof property === 'symbol') return true;
                if (property === 'statusCode') return 400;
                if (property === 'code') return 'bad_request';
                if (property === 'message') return 'proxy secret detail';
                return undefined;
            },
        });
        expect(publicError(spoofedPublicSafeError, 'req-7')).toEqual({
            ok: false,
            error: 'internal_error',
            message: 'Unexpected server error',
            request_id: 'req-7',
        });
    });
});
