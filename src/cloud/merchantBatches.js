import crypto from 'node:crypto';
import { createHttpError, merchantScope, publicOk } from './merchantApiV2.js';
import {
    getAuthenticatedMerchant,
    optionalString,
    redactPublicValue,
    requiredString,
    safeObject,
} from './merchantPublicProjections.js';

const CREATE_STATUSES = new Set(['queued', 'running', 'paused', 'canceled']);
const TERMINAL_STATUSES = new Set(['completed', 'canceled', 'failed']);

function requiredBatchId(value) {
    return requiredString(value, 'batch_id');
}

function normalizeStatus(value) {
    const status = optionalString(value) || 'queued';
    if (!CREATE_STATUSES.has(status)) {
        throw createHttpError(400, 'invalid_payload', 'status must be queued, running, paused, or canceled');
    }
    return status;
}

function normalizeQuantity(value, name) {
    if (value === undefined || value === null || value === '') return 1;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw createHttpError(400, 'invalid_payload', `${name} must be a positive integer`);
    }
    return parsed;
}

function normalizeItems(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
        throw createHttpError(400, 'invalid_payload', 'items must be an array');
    }
    return value.map((item, index) => {
        const source = safeObject(item);
        return {
            order_id: optionalString(source.order_id),
            order_item_id: optionalString(source.order_item_id),
            file_id: optionalString(source.file_id),
            job_id: optionalString(source.job_id),
            quantity: normalizeQuantity(source.quantity, `items[${index}].quantity`),
            metadata: safeObject(source.metadata),
        };
    });
}

function publicBatch(batch, itemCount = undefined) {
    const response = {
        batch_id: batch.batch_id,
        status: batch.status,
        item_count: Number.isInteger(itemCount)
            ? itemCount
            : Number(batch.item_count ?? batch.metadata?.item_count ?? 0),
    };
    for (const key of [
        'name',
        'strategy',
        'created_at',
        'updated_at',
        'started_at',
        'paused_at',
        'completed_at',
        'canceled_at',
    ]) {
        if (batch[key] !== undefined && batch[key] !== null) response[key] = batch[key];
    }
    const settings = redactPublicValue(safeObject(batch.settings));
    if (Object.keys(settings).length > 0) response.settings = settings;
    const metadata = redactPublicValue(safeObject(batch.metadata));
    if (Object.keys(metadata).length > 0) response.metadata = metadata;
    return response;
}

function transitionRejected() {
    throw createHttpError(409, 'batch_transition_invalid', 'Batch cannot transition from its current status');
}

async function countBatchItems(store, merchantId, batchId, fallback = 0) {
    if (typeof store.listMerchantBatchItems !== 'function') return fallback;
    const items = await store.listMerchantBatchItems({ merchantId, batchId, limit: 100 });
    return Array.isArray(items) ? items.length : fallback;
}

export function createBatchHandlers({
    store,
    authenticateMerchant,
    now = () => new Date(),
} = {}) {
    if (!store) throw new Error('store is required');

    async function createBatch(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const source = safeObject(body);
        const items = normalizeItems(source.items);
        const batchId = crypto.randomUUID();
        const timestamp = now().toISOString();
        const batch = await store.createMerchantBatch({
            ...merchantScope(merchant),
            batch_id: batchId,
            name: optionalString(source.name) || 'Batch',
            strategy: optionalString(source.strategy) || 'batch_by_material',
            status: normalizeStatus(source.status),
            settings: safeObject(source.settings),
            metadata: {
                ...safeObject(source.metadata),
                item_count: items.length,
            },
            created_at: timestamp,
        });

        for (const [index, item] of items.entries()) {
            await store.createMerchantBatchItem({
                ...merchantScope(merchant),
                batch_item_id: crypto.randomUUID(),
                batch_id: batch.batch_id,
                order_id: item.order_id,
                order_item_id: item.order_item_id,
                file_id: item.file_id,
                job_id: item.job_id,
                quantity: item.quantity,
                metadata: {
                    ...item.metadata,
                    item_index: index,
                },
            });
        }

        return publicOk(publicBatch(batch, items.length), requestId);
    }

    async function getBatch(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const batchId = requiredBatchId(safeObject(body).batch_id);
        const batch = await store.getMerchantBatch({
            merchantId: merchant.merchant_id,
            batchId,
        });
        if (!batch) throw createHttpError(404, 'batch_not_found', 'Batch not found');
        const itemCount = await countBatchItems(
            store,
            merchant.merchant_id,
            batchId,
            Number(batch.metadata?.item_count ?? 0),
        );
        return publicOk(publicBatch(batch, itemCount), requestId);
    }

    async function pauseBatch(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const batchId = requiredBatchId(safeObject(body).batch_id);
        const current = await store.getMerchantBatch({ merchantId: merchant.merchant_id, batchId });
        if (!current) throw createHttpError(404, 'batch_not_found', 'Batch not found');
        const status = String(current.status || '').toLowerCase();
        if (!['queued', 'running'].includes(status)) transitionRejected();
        const batch = await store.updateMerchantBatch({
            merchantId: merchant.merchant_id,
            batchId,
            fields: {
                status: 'paused',
                paused_at: now().toISOString(),
            },
        });
        if (!batch) throw createHttpError(404, 'batch_not_found', 'Batch not found');
        const itemCount = await countBatchItems(store, merchant.merchant_id, batchId, Number(current.metadata?.item_count ?? 0));
        return publicOk(publicBatch(batch, itemCount), requestId);
    }

    async function resumeBatch(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const batchId = requiredBatchId(safeObject(body).batch_id);
        const current = await store.getMerchantBatch({ merchantId: merchant.merchant_id, batchId });
        if (!current) throw createHttpError(404, 'batch_not_found', 'Batch not found');
        const status = String(current.status || '').toLowerCase();
        if (status !== 'paused') transitionRejected();
        const batch = await store.updateMerchantBatch({
            merchantId: merchant.merchant_id,
            batchId,
            fields: {
                status: 'running',
                started_at: current.started_at || now().toISOString(),
                paused_at: null,
            },
        });
        if (!batch) throw createHttpError(404, 'batch_not_found', 'Batch not found');
        const itemCount = await countBatchItems(store, merchant.merchant_id, batchId, Number(current.metadata?.item_count ?? 0));
        return publicOk(publicBatch(batch, itemCount), requestId);
    }

    async function cancelBatch(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const batchId = requiredBatchId(safeObject(body).batch_id);
        const current = await store.getMerchantBatch({ merchantId: merchant.merchant_id, batchId });
        if (!current) throw createHttpError(404, 'batch_not_found', 'Batch not found');
        const status = String(current.status || '').toLowerCase();
        if (!['queued', 'running', 'paused'].includes(status)) transitionRejected();
        const batch = await store.updateMerchantBatch({
            merchantId: merchant.merchant_id,
            batchId,
            fields: {
                status: 'canceled',
                canceled_at: now().toISOString(),
            },
        });
        if (!batch) throw createHttpError(404, 'batch_not_found', 'Batch not found');
        const itemCount = await countBatchItems(store, merchant.merchant_id, batchId, Number(current.metadata?.item_count ?? 0));
        return publicOk(publicBatch(batch, itemCount), requestId);
    }

    return {
        createBatch,
        getBatch,
        pauseBatch,
        resumeBatch,
        cancelBatch,
    };
}
