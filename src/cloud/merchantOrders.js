import crypto from 'node:crypto';
import { createHttpError, merchantScope, publicOk } from './merchantApiV2.js';
import { createSliceHandlers } from './merchantSlices.js';

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeObject(value) {
    return isPlainObject(value) ? value : {};
}

function optionalString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requiredString(value, name) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw createHttpError(400, 'invalid_payload', `${name} is required`);
    }
    return value.trim();
}

function requiredOrderId(value) {
    return requiredString(value, 'order_id');
}

function normalizeQuantity(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function normalizeAmount(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeItems(value) {
    if (!Array.isArray(value) || value.length === 0) {
        throw createHttpError(400, 'invalid_payload', 'items must contain at least one item');
    }
    return value.map((item, index) => {
        const source = safeObject(item);
        return {
            source,
            index,
            file_id: requiredString(source.file_id, `items[${index}].file_id`),
            sku: optionalString(source.sku),
            name: optionalString(source.name),
            quantity: normalizeQuantity(source.quantity),
            unit_amount: normalizeAmount(source.unit_amount ?? source.unitAmount),
            requirements: safeObject(source.requirements),
            profile: safeObject(source.profile),
            metadata: safeObject(source.metadata),
        };
    });
}

async function getAuthenticatedMerchant(authenticateMerchant, request) {
    if (typeof authenticateMerchant !== 'function') {
        throw new Error('authenticateMerchant is required');
    }
    const context = await authenticateMerchant(request);
    const merchant = context?.merchant || context;
    if (!merchant?.org_id || !merchant?.merchant_id) {
        throw createHttpError(403, 'merchant_scope_missing', 'Merchant scope is unavailable');
    }
    return merchant;
}

function publicOrder(order, itemCount = undefined) {
    const count = Number.isInteger(itemCount)
        ? itemCount
        : Number(order?.item_count ?? order?.metadata?.item_count ?? 0);
    const response = {
        order_id: order.order_id,
        status: order.status,
        item_count: count,
    };
    if (order.external_order_id !== undefined && order.external_order_id !== null) {
        response.merchant_order_id = order.external_order_id;
        response.external_order_id = order.external_order_id;
    }
    for (const key of ['created_at', 'updated_at', 'submitted_at', 'completed_at', 'canceled_at', 'due_at']) {
        if (order[key] !== undefined && order[key] !== null) response[key] = order[key];
    }
    return response;
}

function shouldAutoSlice(orderSource, itemSource) {
    return Boolean(itemSource.auto_slice ?? orderSource.auto_slice);
}

function shouldAutoSubmit(orderSource, itemSource) {
    return Boolean(itemSource.auto_submit ?? orderSource.auto_submit);
}

async function maybeCreateSlice({
    store,
    adapters,
    merchant,
    file,
    item,
    request,
    requestId,
    now,
}) {
    if (file.file_mode !== 'source_model' || !adapters?.slicer) return null;

    const { createSlice } = createSliceHandlers({
        store,
        adapters,
        now,
        authenticateMerchant: async () => ({ merchant }),
    });
    return createSlice({
        file_id: file.file_id,
        profile: item.profile,
        requirements: item.requirements,
    }, request, requestId);
}

async function recordUsage({ store, scope, orderId, item = null, eventType, quantity, createdAt }) {
    if (typeof store.createMerchantUsageEvent !== 'function') return;
    await store.createMerchantUsageEvent({
        ...scope,
        job_id: null,
        file_id: null,
        event_type: eventType,
        quantity,
        metrics: {
            order_id: orderId,
            order_item_id: item?.order_item_id || null,
            merchant_file_id: item?.file_id || null,
            quantity: item?.quantity || quantity,
        },
        created_at: createdAt,
    });
}

async function recordJobEvent({
    store,
    scope,
    orderId,
    item = null,
    eventType,
    message,
    payload = {},
    occurredAt,
}) {
    if (typeof store.recordMerchantJobEvent !== 'function') return;
    await store.recordMerchantJobEvent({
        ...scope,
        event_id: crypto.randomUUID(),
        job_id: item?.job_id || null,
        order_id: orderId,
        slice_job_id: item?.slice_job_id || null,
        file_id: item?.file_id || null,
        event_type: eventType,
        message,
        payload,
        occurred_at: occurredAt,
    });
}

export function createOrderHandlers({
    store,
    authenticateMerchant,
    adapters = {},
    now = () => new Date(),
} = {}) {
    if (!store) throw new Error('store is required');

    async function createOrder(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const scope = merchantScope(merchant);
        const source = safeObject(body);
        const items = normalizeItems(source.items);
        const timestamp = now().toISOString();
        const orderId = crypto.randomUUID();
        const externalOrderId = optionalString(source.merchant_order_id) || optionalString(source.external_order_id);
        const autoSubmitRequested = items.some((item) => shouldAutoSubmit(source, item.source));
        const autoSliceRequested = items.some((item) => shouldAutoSlice(source, item.source));
        const order = await store.createMerchantOrder({
            ...scope,
            order_id: orderId,
            external_order_id: externalOrderId,
            idempotency_key: optionalString(source.idempotency_key),
            status: 'submitted',
            customer: safeObject(source.customer),
            shipping_address: safeObject(source.shipping_address),
            billing_address: safeObject(source.billing_address),
            totals: safeObject(source.totals),
            due_at: optionalString(source.due_at),
            submitted_at: timestamp,
            metadata: {
                ...safeObject(source.metadata),
                item_count: items.length,
                auto_submit_requested: autoSubmitRequested,
                auto_slice_requested: autoSliceRequested,
            },
            created_at: timestamp,
        });

        await recordUsage({
            store,
            scope,
            orderId: order.order_id,
            eventType: 'order.submitted',
            quantity: 1,
            createdAt: timestamp,
        });
        await recordJobEvent({
            store,
            scope,
            orderId: order.order_id,
            eventType: 'order.submitted',
            message: 'Merchant order submitted',
            payload: {
                external_order_id: externalOrderId,
                item_count: items.length,
            },
            occurredAt: timestamp,
        });

        for (const item of items) {
            const file = await store.getMerchantFile({
                merchantId: merchant.merchant_id,
                fileId: item.file_id,
            });
            if (!file) throw createHttpError(404, 'file_not_found', 'File not found');

            const autoSlice = shouldAutoSlice(source, item.source);
            const autoSubmit = shouldAutoSubmit(source, item.source);
            const slice = autoSlice ? await maybeCreateSlice({
                store,
                adapters,
                merchant,
                file,
                item,
                request,
                requestId,
                now,
            }) : null;
            const orderItem = await store.createMerchantOrderItem({
                ...scope,
                order_item_id: crypto.randomUUID(),
                order_id: order.order_id,
                file_id: item.file_id,
                slice_job_id: slice?.slice_id || null,
                job_id: null,
                sku: item.sku,
                name: item.name,
                quantity: item.quantity,
                unit_amount: item.unit_amount,
                requirements: item.requirements,
                metadata: {
                    ...item.metadata,
                    item_index: item.index,
                    file_mode: file.file_mode,
                    auto_submit_requested: autoSubmit,
                    auto_submit_status: autoSubmit ? 'intent_recorded' : 'not_requested',
                    auto_slice_requested: autoSlice,
                    auto_slice_status: autoSlice
                        ? (slice?.slice_id ? 'created' : 'intent_recorded')
                        : 'not_requested',
                    slice_id: slice?.slice_id || null,
                },
            });

            await recordUsage({
                store,
                scope,
                orderId: order.order_id,
                item: orderItem,
                eventType: 'order.item.submitted',
                quantity: orderItem.quantity,
                createdAt: timestamp,
            });
            await recordJobEvent({
                store,
                scope,
                orderId: order.order_id,
                item: orderItem,
                eventType: 'order.item.submitted',
                message: 'Merchant order item submitted',
                payload: {
                    sku: orderItem.sku,
                    quantity: orderItem.quantity,
                    auto_submit_status: orderItem.metadata?.auto_submit_status,
                    auto_slice_status: orderItem.metadata?.auto_slice_status,
                },
                occurredAt: timestamp,
            });
        }

        return publicOk(publicOrder(order, items.length), requestId);
    }

    async function getOrder(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const orderId = requiredOrderId(safeObject(body).order_id);
        const order = await store.getMerchantOrder({
            merchantId: merchant.merchant_id,
            orderId,
        });
        if (!order) throw createHttpError(404, 'order_not_found', 'Order not found');
        return publicOk(publicOrder(order), requestId);
    }

    async function cancelOrder(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const scope = merchantScope(merchant);
        const orderId = requiredOrderId(safeObject(body).order_id);
        const timestamp = now().toISOString();
        const order = await store.updateMerchantOrder({
            merchantId: merchant.merchant_id,
            orderId,
            fields: {
                status: 'canceled',
                canceled_at: timestamp,
            },
        });
        if (!order) throw createHttpError(404, 'order_not_found', 'Order not found');
        await recordJobEvent({
            store,
            scope,
            orderId,
            eventType: 'order.canceled',
            message: 'Merchant order canceled',
            occurredAt: timestamp,
        });
        return publicOk(publicOrder(order), requestId);
    }

    return {
        createOrder,
        getOrder,
        cancelOrder,
    };
}
