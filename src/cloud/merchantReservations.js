import crypto from 'node:crypto';
import { createHttpError, merchantScope, publicOk } from './merchantApiV2.js';
import {
    getAuthenticatedMerchant,
    normalizeOptionalTimestamp,
    optionalString,
    redactPublicValue,
    requiredString,
    safeObject,
} from './merchantPublicProjections.js';

function requiredReservationId(value) {
    return requiredString(value, 'reservation_id');
}

function normalizeGrams(value) {
    if (value === undefined || value === null || value === '') return 0;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw createHttpError(400, 'invalid_payload', 'grams must be a non-negative number');
    }
    return parsed;
}

function publicReservation(reservation) {
    const response = {
        reservation_id: reservation.reservation_id,
        material: reservation.material,
        grams: Number(reservation.grams ?? 0),
        status: reservation.status,
    };
    for (const key of [
        'color',
        'order_id',
        'batch_id',
        'file_id',
        'job_id',
        'expires_at',
        'released_at',
        'consumed_at',
        'created_at',
        'updated_at',
    ]) {
        if (reservation[key] !== undefined && reservation[key] !== null) response[key] = reservation[key];
    }
    const metadata = redactPublicValue(safeObject(reservation.metadata));
    if (Object.keys(metadata).length > 0) response.metadata = metadata;
    return response;
}

export function createReservationHandlers({
    store,
    authenticateMerchant,
    now = () => new Date(),
} = {}) {
    if (!store) throw new Error('store is required');

    async function createReservation(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const source = safeObject(body);
        const reservation = await store.createMerchantMaterialReservation({
            ...merchantScope(merchant),
            reservation_id: crypto.randomUUID(),
            order_id: optionalString(source.order_id),
            batch_id: optionalString(source.batch_id),
            file_id: optionalString(source.file_id),
            job_id: optionalString(source.job_id),
            material: requiredString(source.material, 'material'),
            color: optionalString(source.color),
            grams: normalizeGrams(source.grams),
            status: 'reserved',
            expires_at: normalizeOptionalTimestamp(source.expires_at, 'expires_at'),
            released_at: null,
            consumed_at: null,
            metadata: safeObject(source.metadata),
            created_at: now().toISOString(),
        });
        return publicOk(publicReservation(reservation), requestId);
    }

    async function getReservation(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const reservationId = requiredReservationId(safeObject(body).reservation_id);
        const reservation = await store.getMerchantMaterialReservation({
            merchantId: merchant.merchant_id,
            reservationId,
        });
        if (!reservation) throw createHttpError(404, 'reservation_not_found', 'Reservation not found');
        return publicOk(publicReservation(reservation), requestId);
    }

    async function releaseReservation(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const reservationId = requiredReservationId(safeObject(body).reservation_id);
        const releasedAt = now().toISOString();
        const reservation = await store.releaseMerchantMaterialReservation({
            merchantId: merchant.merchant_id,
            reservationId,
            releasedAt,
        });
        if (!reservation) throw createHttpError(404, 'reservation_not_found', 'Reservation not found');
        return publicOk(publicReservation(reservation), requestId);
    }

    return {
        createReservation,
        getReservation,
        releaseReservation,
    };
}
