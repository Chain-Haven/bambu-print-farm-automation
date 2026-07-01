import crypto from 'node:crypto';
import { createHttpError, merchantScope, publicOk } from './merchantApiV2.js';
import { createSliceHandlers } from './merchantSlices.js';

const USABLE_FILE_STATUSES = new Set(['uploaded', 'ready', 'processed', 'sliced', 'completed']);
const NON_CANCELABLE_ORDER_STATUSES = new Set([
    'canceled',
    'completed',
    'shipped',
    'failed',
    'in_production',
    'printing',
]);
const CANCELABLE_ORDER_STATUSES = [
    'draft',
    'submitted',
    'partially_routed',
    'awaiting_quality',
    'post_processing',
    'ready_to_ship',
];

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

function normalizeQuantity(value, name) {
    if (value === undefined || value === null || value === '') return 1;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw createHttpError(400, 'invalid_payload', `${name} must be a positive integer`);
    }
    return parsed;
}

function normalizeAmount(value, name) {
    if (value === undefined || value === null || value === '') return 0;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw createHttpError(400, 'invalid_payload', `${name} must be a non-negative number`);
    }
    return parsed;
}

const MAX_ORDER_ITEMS = 200;
const MAX_PLACEMENTS = 20;

// Storefront customization intake: color / case type / design + logo/photo
// placements. Stored verbatim (color/material also feed capability-aware routing).
// The placement geometry is a forward-looking contract for a future compositor;
// nothing downstream is forced to consume it yet, so this is purely additive.
function normalizeCustomization(value) {
    const source = safeObject(value);
    if (Object.keys(source).length === 0) return null;

    const placementsInput = Array.isArray(source.placement) ? source.placement
        : Array.isArray(source.placements) ? source.placements : [];
    const placement = placementsInput.slice(0, MAX_PLACEMENTS).map((p) => {
        const s = safeObject(p);
        return {
            asset_file_id: optionalString(s.asset_file_id ?? s.file_id),
            face: optionalString(s.face),
            x_mm: Number.isFinite(Number(s.x_mm ?? s.x)) ? Number(s.x_mm ?? s.x) : null,
            y_mm: Number.isFinite(Number(s.y_mm ?? s.y)) ? Number(s.y_mm ?? s.y) : null,
            width_mm: Number.isFinite(Number(s.width_mm ?? s.width)) ? Number(s.width_mm ?? s.width) : null,
            rotation_deg: Number.isFinite(Number(s.rotation_deg ?? s.rotation)) ? Number(s.rotation_deg ?? s.rotation) : null,
            mode: optionalString(s.mode), // e.g. 'emboss' | 'engrave' | 'decal'
        };
    });

    const out = {
        case_type: optionalString(source.case_type ?? source.caseType),
        design_id: optionalString(source.design_id ?? source.designId),
        color: optionalString(source.color ?? source.color_hex ?? source.colour),
        material: optionalString(source.material),
        finish: optionalString(source.finish),
        notes: optionalString(source.notes),
        placement,
    };
    // Drop empty keys so the persisted object is clean.
    for (const k of Object.keys(out)) {
        if (out[k] == null || (Array.isArray(out[k]) && out[k].length === 0)) delete out[k];
    }
    return Object.keys(out).length ? out : null;
}

function normalizeItems(value) {
    if (!Array.isArray(value) || value.length === 0) {
        throw createHttpError(400, 'invalid_payload', 'items must contain at least one item');
    }
    if (value.length > MAX_ORDER_ITEMS) {
        throw createHttpError(400, 'invalid_payload', `items must not exceed ${MAX_ORDER_ITEMS} entries`);
    }
    return value.map((item, index) => {
        const source = safeObject(item);
        const customization = normalizeCustomization(source.customization);
        const requirements = safeObject(source.requirements);
        // Let a customization color/material choice drive capability-aware routing
        // when the caller didn't already specify one explicitly.
        if (customization) {
            if (customization.color && requirements.color === undefined && requirements.colors === undefined) {
                requirements.color = customization.color;
            }
            if (customization.material && requirements.material === undefined && requirements.materials === undefined) {
                requirements.material = customization.material;
            }
        }
        return {
            source,
            index,
            file_id: requiredString(source.file_id, `items[${index}].file_id`),
            sku: optionalString(source.sku),
            name: optionalString(source.name),
            quantity: normalizeQuantity(source.quantity, `items[${index}].quantity`),
            unit_amount: normalizeAmount(source.unit_amount ?? source.unitAmount, `items[${index}].unit_amount`),
            requirements,
            profile: safeObject(source.profile),
            metadata: safeObject(source.metadata),
            ...(customization ? { customization } : {}),
        };
    });
}

function getHeader(headers = {}, name) {
    const lowerName = name.toLowerCase();
    for (const [key, value] of Object.entries(headers || {})) {
        if (String(key).toLowerCase() === lowerName) return value;
    }
    return null;
}

function idempotencyKeyFrom({ source, request }) {
    return optionalString(getHeader(request?.headers || {}, 'idempotency-key'))
        || optionalString(source.idempotency_key);
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

function withHttpStatus(payload, statusCode) {
    Object.defineProperty(payload, '_http_status', {
        value: statusCode,
        enumerable: false,
    });
    return payload;
}

function publicReplay(order, requestId) {
    return withHttpStatus(publicOk(publicOrder(order), requestId), 200);
}

function existingOrderReplay(order, requestId) {
    const status = String(order?.status || '').toLowerCase();
    const creationStatus = String(order?.metadata?.creation_status || '').toLowerCase();
    if (status === 'draft' || status === 'creating' || creationStatus === 'creating') {
        throw createHttpError(409, 'order_creation_in_progress', 'Order creation is still in progress');
    }
    if (status === 'failed') {
        throw createHttpError(409, 'order_creation_failed', 'Previous order creation failed');
    }
    return publicReplay(order, requestId);
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

function validateUsableFile(file) {
    const status = String(file?.status || '').trim().toLowerCase();
    if (!USABLE_FILE_STATUSES.has(status)) {
        throw createHttpError(422, 'file_not_usable', 'File is not usable for order creation');
    }
}

async function prevalidateFiles({ store, merchant, items }) {
    const validated = [];
    for (const item of items) {
        const file = await store.getMerchantFile({
            merchantId: merchant.merchant_id,
            fileId: item.file_id,
        });
        if (!file) throw createHttpError(404, 'file_not_found', 'File not found');
        validateUsableFile(file);
        validated.push({ ...item, file });
    }
    return validated;
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

async function recordJobEventBestEffort(options) {
    try {
        await recordJobEvent(options);
    } catch {
        // Order state changes should not surface as 500s when only audit-event persistence fails.
    }
}

async function recordUsageBestEffort(options) {
    try {
        await recordUsage(options);
    } catch {
        // Usage metering must not fail an otherwise durable order submission.
    }
}

async function findExistingOrderMatches({ store, merchantId, idempotencyKey, externalOrderId }) {
    const matches = {
        byIdempotencyKey: null,
        byExternalOrderId: null,
    };
    if (idempotencyKey && typeof store.findMerchantOrderByIdempotencyKey === 'function') {
        matches.byIdempotencyKey = await store.findMerchantOrderByIdempotencyKey({ merchantId, idempotencyKey });
    }
    if (externalOrderId && typeof store.findMerchantOrderByExternalOrderId === 'function') {
        matches.byExternalOrderId = await store.findMerchantOrderByExternalOrderId({ merchantId, externalOrderId });
    }
    return matches;
}

function sameOrder(left, right) {
    if (!left || !right) return true;
    return String(left.order_id || '') === String(right.order_id || '');
}

function resolveExistingOrderReplay({
    byIdempotencyKey,
    byExternalOrderId,
    idempotencyKey,
    externalOrderId,
    requestId,
}) {
    if (byIdempotencyKey && byExternalOrderId && !sameOrder(byIdempotencyKey, byExternalOrderId)) {
        throw createHttpError(409, 'idempotency_conflict', 'Idempotency key and external order id refer to different orders');
    }

    if (
        byIdempotencyKey
        && externalOrderId
        && optionalString(byIdempotencyKey.external_order_id) !== externalOrderId
    ) {
        throw createHttpError(409, 'idempotency_conflict', 'Idempotency key was already used for a different external order id');
    }

    if (
        byExternalOrderId
        && idempotencyKey
        && optionalString(byExternalOrderId.idempotency_key)
        && optionalString(byExternalOrderId.idempotency_key) !== idempotencyKey
    ) {
        throw createHttpError(409, 'idempotency_conflict', 'External order id was already used with a different idempotency key');
    }

    const existingOrder = byIdempotencyKey || byExternalOrderId;
    return existingOrder ? existingOrderReplay(existingOrder, requestId) : null;
}

async function markOrderFailed({
    store,
    scope,
    merchant,
    order,
    metadata,
    stage,
    occurredAt,
}) {
    const failurePayload = {
        failure_code: 'order_creation_failed',
        failure_stage: stage,
    };
    try {
        await store.updateMerchantOrder({
            merchantId: merchant.merchant_id,
            orderId: order.order_id,
            fields: {
                status: 'failed',
                metadata: {
                    ...metadata,
                    ...failurePayload,
                    failed_at: occurredAt,
                },
            },
        });
    } catch {
        // The caller receives a safe failure even if compensation persistence fails.
    }
    await recordJobEventBestEffort({
        store,
        scope,
        orderId: order.order_id,
        eventType: 'order.failed',
        message: 'Merchant order failed during creation',
        payload: failurePayload,
        occurredAt,
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
        const idempotencyKey = idempotencyKeyFrom({ source, request });
        const existingMatches = await findExistingOrderMatches({
            store,
            merchantId: merchant.merchant_id,
            idempotencyKey,
            externalOrderId,
        });
        const existingReplay = resolveExistingOrderReplay({
            ...existingMatches,
            idempotencyKey,
            externalOrderId,
            requestId,
        });
        if (existingReplay) return existingReplay;

        const validatedItems = await prevalidateFiles({ store, merchant, items });
        const autoSubmitRequested = items.some((item) => shouldAutoSubmit(source, item.source));
        const autoSliceRequested = items.some((item) => shouldAutoSlice(source, item.source));
        const orderMetadata = {
            ...safeObject(source.metadata),
            item_count: items.length,
            auto_submit_requested: autoSubmitRequested,
            auto_slice_requested: autoSliceRequested,
        };
        let order;
        try {
            order = await store.createMerchantOrder({
                ...scope,
                order_id: orderId,
                external_order_id: externalOrderId,
                idempotency_key: idempotencyKey,
                status: 'draft',
                customer: safeObject(source.customer),
                shipping_address: safeObject(source.shipping_address),
                billing_address: safeObject(source.billing_address),
                totals: safeObject(source.totals),
                due_at: optionalString(source.due_at),
                submitted_at: null,
                metadata: {
                    ...orderMetadata,
                    creation_status: 'creating',
                },
                created_at: timestamp,
            });
        } catch (error) {
            const replayMatches = await findExistingOrderMatches({
                store,
                merchantId: merchant.merchant_id,
                idempotencyKey,
                externalOrderId,
            });
            const replay = resolveExistingOrderReplay({
                ...replayMatches,
                idempotencyKey,
                externalOrderId,
                requestId,
            });
            if (replay) return replay;
            throw error;
        }

        let orderItems = [];
        try {
            for (const item of validatedItems) {
                const autoSlice = shouldAutoSlice(source, item.source);
                const autoSubmit = shouldAutoSubmit(source, item.source);
                const slice = autoSlice ? await maybeCreateSlice({
                    store,
                    adapters,
                    merchant,
                    file: item.file,
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
                        ...(item.customization ? { customization: item.customization } : {}),
                        item_index: item.index,
                        file_mode: item.file.file_mode,
                        auto_submit_requested: autoSubmit,
                        auto_submit_status: autoSubmit ? 'intent_recorded' : 'not_requested',
                        auto_slice_requested: autoSlice,
                        auto_slice_status: autoSlice
                            ? (slice?.slice_id ? 'created' : 'intent_recorded')
                            : 'not_requested',
                        slice_id: slice?.slice_id || null,
                    },
                });
                orderItems.push(orderItem);
            }
            order = await store.updateMerchantOrder({
                merchantId: merchant.merchant_id,
                orderId: order.order_id,
                fields: {
                    status: 'submitted',
                    submitted_at: timestamp,
                    metadata: {
                        ...orderMetadata,
                        creation_status: 'submitted',
                    },
                },
            });
            if (!order) throw new Error('order finalization returned no row');
        } catch {
            await markOrderFailed({
                store,
                scope,
                merchant,
                order,
                metadata: orderMetadata,
                stage: 'create_items',
                occurredAt: timestamp,
            });
            throw createHttpError(500, 'order_creation_failed', 'Order could not be created');
        }

        await recordUsageBestEffort({
            store,
            scope,
            orderId: order.order_id,
            eventType: 'order.submitted',
            quantity: 1,
            createdAt: timestamp,
        });
        await recordJobEventBestEffort({
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

        for (const orderItem of orderItems) {
            await recordUsageBestEffort({
                store,
                scope,
                orderId: order.order_id,
                item: orderItem,
                eventType: 'order.item.submitted',
                quantity: orderItem.quantity,
                createdAt: timestamp,
            });
            await recordJobEventBestEffort({
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
        if (typeof store.cancelMerchantOrderIfCancelable === 'function') {
            const order = await store.cancelMerchantOrderIfCancelable({
                merchantId: merchant.merchant_id,
                orderId,
                canceledAt: timestamp,
                cancelableStatuses: CANCELABLE_ORDER_STATUSES,
            });
            if (order) {
                await recordJobEventBestEffort({
                    store,
                    scope,
                    orderId,
                    eventType: 'order.canceled',
                    message: 'Merchant order canceled',
                    occurredAt: timestamp,
                });
                return publicOk(publicOrder(order), requestId);
            }
            const current = await store.getMerchantOrder({
                merchantId: merchant.merchant_id,
                orderId,
            });
            if (!current) throw createHttpError(404, 'order_not_found', 'Order not found');
            if (NON_CANCELABLE_ORDER_STATUSES.has(String(current.status || '').toLowerCase())) {
                throw createHttpError(409, 'order_not_cancelable', 'Order cannot be canceled in its current status');
            }
            throw createHttpError(409, 'order_cancel_conflict', 'Order could not be canceled because its status changed');
        }
        const existingOrder = await store.getMerchantOrder({
            merchantId: merchant.merchant_id,
            orderId,
        });
        if (!existingOrder) throw createHttpError(404, 'order_not_found', 'Order not found');
        if (NON_CANCELABLE_ORDER_STATUSES.has(String(existingOrder.status || '').toLowerCase())) {
            throw createHttpError(409, 'order_not_cancelable', 'Order cannot be canceled in its current status');
        }
        const order = await store.updateMerchantOrder({
            merchantId: merchant.merchant_id,
            orderId,
            fields: {
                status: 'canceled',
                canceled_at: timestamp,
            },
        });
        if (!order) throw createHttpError(404, 'order_not_found', 'Order not found');
        await recordJobEventBestEffort({
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
