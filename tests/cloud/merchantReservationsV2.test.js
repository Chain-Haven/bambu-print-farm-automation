import { describe, expect, it, vi } from 'vitest';
import { createReservationHandlers } from '../../src/cloud/merchantReservations.js';

const now = () => new Date('2026-07-01T12:00:00.000Z');

function createMockStore(overrides = {}) {
    return {
        createMerchantMaterialReservation: vi.fn().mockImplementation(async (reservation) => ({
            reservation_id: reservation.reservation_id || 'reservation-1',
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            status: 'reserved',
            created_at: '2026-07-01T12:00:00.000Z',
            ...reservation,
        })),
        getMerchantMaterialReservation: vi.fn().mockImplementation(async ({ reservationId }) => (
            reservationId === 'missing-reservation'
                ? null
                : {
                    reservation_id: reservationId,
                    org_id: 'org-1',
                    merchant_id: 'merchant-1',
                    material: 'PLA',
                    color: 'white',
                    grams: 120,
                    status: 'reserved',
                    order_id: 'order-1',
                    batch_id: 'batch-1',
                    file_id: 'file-1',
                    job_id: 'job-1',
                    metadata: {
                        note: 'merchant visible',
                        spool_id: 'spool-secret',
                        storage_path: 'internal/reservation/path',
                    },
                    created_at: '2026-07-01T12:00:00.000Z',
                }
        )),
        releaseMerchantMaterialReservation: vi.fn().mockImplementation(async ({ reservationId, releasedAt }) => (
            reservationId === 'missing-reservation'
                ? null
                : {
                    reservation_id: reservationId,
                    org_id: 'org-1',
                    merchant_id: 'merchant-1',
                    material: 'PLA',
                    grams: 120,
                    status: 'released',
                    released_at: releasedAt,
                    metadata: {
                        note: 'released safely',
                        spool_id: 'spool-secret',
                    },
                }
        )),
        ...overrides,
    };
}

function createHandlers(overrides = {}) {
    const store = createMockStore(overrides.store);
    const authenticateMerchant = vi.fn().mockResolvedValue({
        merchant: {
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            status: 'active',
        },
    });

    return {
        store,
        authenticateMerchant,
        ...createReservationHandlers({
            store,
            authenticateMerchant,
            now,
        }),
    };
}

function createScopedBody(body) {
    return Object.defineProperties({ ...body }, {
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

async function importReservationIndexRoute(store = createMockStore()) {
    vi.resetModules();
    vi.doMock('../../src/cloud/supabaseRest.js', () => ({
        createSupabaseRestClient: vi.fn(() => store),
    }));
    const route = await import('../../api/public/material-reservations/index.js');
    vi.doUnmock('../../src/cloud/supabaseRest.js');
    return route.default;
}

async function importReservationDetailRoute(store = createMockStore()) {
    vi.resetModules();
    vi.doMock('../../src/cloud/supabaseRest.js', () => ({
        createSupabaseRestClient: vi.fn(() => store),
    }));
    const route = await import('../../api/public/material-reservations/[reservation_id].js');
    vi.doUnmock('../../src/cloud/supabaseRest.js');
    return route.default;
}

async function importReservationReleaseRoute(store = createMockStore()) {
    vi.resetModules();
    vi.doMock('../../src/cloud/supabaseRest.js', () => ({
        createSupabaseRestClient: vi.fn(() => store),
    }));
    const route = await import('../../api/public/material-reservations/[reservation_id]/release.js');
    vi.doUnmock('../../src/cloud/supabaseRest.js');
    return route.default;
}

describe('merchant material reservations v2 handlers', () => {
    it('creates, reads, and releases merchant-scoped reservations with safe public projections', async () => {
        const {
            createReservation,
            getReservation,
            releaseReservation,
            store,
        } = createHandlers();

        const created = await createReservation(createScopedBody({
            material: 'PLA',
            color: 'white',
            grams: 120.5,
            order_id: 'body-order',
            batch_id: 'body-batch',
            file_id: 'body-file',
            job_id: 'body-job',
            expires_at: '2026-07-02T12:00:00.000Z',
            metadata: {
                note: 'merchant visible',
                spool_id: 'spool-secret',
                storage_path: 'internal/reservation/path',
            },
        }));
        const fetched = await getReservation({ reservation_id: created.reservation_id });
        const released = await releaseReservation({ reservation_id: created.reservation_id });

        expect(created).toMatchObject({
            ok: true,
            reservation_id: expect.any(String),
            material: 'PLA',
            color: 'white',
            grams: 120.5,
            status: 'reserved',
            order_id: 'body-order',
            batch_id: 'body-batch',
            file_id: 'body-file',
            job_id: 'body-job',
            metadata: { note: 'merchant visible' },
        });
        expect(fetched).toMatchObject({
            ok: true,
            reservation_id: created.reservation_id,
            material: 'PLA',
            status: 'reserved',
            metadata: { note: 'merchant visible' },
        });
        expect(released).toMatchObject({
            ok: true,
            reservation_id: created.reservation_id,
            status: 'released',
            released_at: '2026-07-01T12:00:00.000Z',
        });
        expect(JSON.stringify({ created, fetched, released })).not.toContain('org-1');
        expect(JSON.stringify({ created, fetched, released })).not.toContain('merchant-1');
        expect(JSON.stringify({ created, fetched, released })).not.toContain('spool-secret');
        expect(JSON.stringify({ created, fetched, released })).not.toContain('storage_path');
        expect(JSON.stringify({ created, fetched, released })).not.toContain('internal/reservation/path');

        expect(store.createMerchantMaterialReservation).toHaveBeenCalledWith(expect.objectContaining({
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            material: 'PLA',
            grams: 120.5,
            status: 'reserved',
        }));
        expect(store.getMerchantMaterialReservation).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            reservationId: created.reservation_id,
        });
        expect(store.releaseMerchantMaterialReservation).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            reservationId: created.reservation_id,
            releasedAt: '2026-07-01T12:00:00.000Z',
        });
    });

    it('rejects invalid reservation payloads and missing reservations with public-safe errors', async () => {
        const { createReservation, getReservation, releaseReservation } = createHandlers();

        await expect(createReservation({ material: '', grams: 1 })).rejects.toMatchObject({
            statusCode: 400,
            code: 'invalid_payload',
        });
        await expect(createReservation({ material: 'PLA', grams: -0.1 })).rejects.toMatchObject({
            statusCode: 400,
            code: 'invalid_payload',
        });
        await expect(createReservation({ material: 'PLA', expires_at: 'not-a-date' })).rejects.toMatchObject({
            statusCode: 400,
            code: 'invalid_payload',
        });
        await expect(getReservation({ reservation_id: 'missing-reservation' })).rejects.toMatchObject({
            statusCode: 404,
            code: 'reservation_not_found',
        });
        await expect(releaseReservation({ reservation_id: 'missing-reservation' })).rejects.toMatchObject({
            statusCode: 404,
            code: 'reservation_not_found',
        });
    });
});

describe('merchant material reservations v2 public routes', () => {
    it('imports route handlers and returns v2 method envelopes', async () => {
        const indexHandler = await importReservationIndexRoute();
        const detailHandler = await importReservationDetailRoute();
        const releaseHandler = await importReservationReleaseRoute();
        const indexRes = createMockResponse();
        const detailRes = createMockResponse();
        const releaseRes = createMockResponse();

        await indexHandler({ method: 'GET', headers: {} }, indexRes);
        await detailHandler({ method: 'POST', headers: {}, query: { reservation_id: 'reservation-1' } }, detailRes);
        await releaseHandler({ method: 'GET', headers: {}, query: { reservation_id: 'reservation-1' } }, releaseRes);

        expect(indexRes.statusCode).toBe(405);
        expect(indexRes.headers.Allow).toBe('POST');
        expect(indexRes.body).toMatchObject({ ok: false, error: 'method_not_allowed' });
        expect(detailRes.statusCode).toBe(405);
        expect(detailRes.headers.Allow).toBe('GET');
        expect(detailRes.body).toMatchObject({ ok: false, error: 'method_not_allowed' });
        expect(releaseRes.statusCode).toBe(405);
        expect(releaseRes.headers.Allow).toBe('POST');
        expect(releaseRes.body).toMatchObject({ ok: false, error: 'method_not_allowed' });
    });
});
