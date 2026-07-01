import crypto from 'node:crypto';
import { createHttpError, merchantScope, publicOk } from './merchantApiV2.js';
import {
    getAuthenticatedMerchant,
    normalizeLimit,
    optionalString,
    redactPublicValue,
    requiredString,
    safeObject,
} from './merchantPublicProjections.js';

const SHIPMENT_STATUSES = new Set(['created', 'label_requested', 'label_created', 'shipped', 'delivered', 'canceled']);

function withHttpStatus(payload, statusCode) {
    Object.defineProperty(payload, '_http_status', {
        value: statusCode,
        enumerable: false,
    });
    return payload;
}

function requiredShipmentId(value) {
    return requiredString(value, 'shipment_id');
}

function requiredOrderId(value) {
    return requiredString(value, 'order_id');
}

function normalizeShipmentStatus(value) {
    const status = optionalString(value);
    if (!status) return null;
    const normalized = status.toLowerCase();
    if (!SHIPMENT_STATUSES.has(normalized)) {
        throw createHttpError(400, 'invalid_payload', 'status must be a valid shipment status');
    }
    return normalized;
}

function normalizePackages(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) {
        throw createHttpError(400, 'invalid_payload', 'packages must be an array');
    }
    return value.map((item) => redactPublicValue(safeObject(item)));
}

function safePublicLabelUrl(value) {
    const url = optionalString(value);
    if (!url) return null;
    return url.startsWith('mock://') ? url : null;
}

function publicLabel(label) {
    const response = {
        label_id: label.label_id,
        shipment_id: label.shipment_id,
        provider: label.provider,
    };
    const publicUrl = safePublicLabelUrl(label.label_url);
    if (publicUrl) response.label_url = publicUrl;
    for (const key of ['tracking_number', 'created_at', 'updated_at']) {
        if (label[key] !== undefined && label[key] !== null) response[key] = label[key];
    }
    const metadata = redactPublicValue(safeObject(label.metadata));
    if (Object.keys(metadata).length > 0) response.metadata = metadata;
    return response;
}

function publicShipment(shipment, label = null) {
    const response = {
        shipment_id: shipment.shipment_id,
        status: shipment.status,
    };
    for (const key of [
        'order_id',
        'carrier',
        'service_level',
        'tracking_number',
        'shipped_at',
        'delivered_at',
        'created_at',
        'updated_at',
    ]) {
        if (shipment[key] !== undefined && shipment[key] !== null) response[key] = shipment[key];
    }
    const shipTo = redactPublicValue(safeObject(shipment.ship_to));
    if (Object.keys(shipTo).length > 0) response.ship_to = shipTo;
    const packages = Array.isArray(shipment.packages) ? redactPublicValue(shipment.packages) : [];
    if (packages.length > 0) response.packages = packages;
    const metadata = redactPublicValue(safeObject(shipment.metadata));
    if (Object.keys(metadata).length > 0) response.metadata = metadata;
    if (label) response.label = publicLabel(label);
    return response;
}

async function requireMerchantOrder(store, merchant, orderId) {
    const order = await store.getMerchantOrder({
        merchantId: merchant.merchant_id,
        orderId,
    });
    if (!order) throw createHttpError(404, 'order_not_found', 'Order not found');
    return order;
}

async function getCurrentShipment(store, merchant, shipmentId) {
    const shipment = await store.getMerchantShipment({
        merchantId: merchant.merchant_id,
        shipmentId,
    });
    if (!shipment) throw createHttpError(404, 'shipment_not_found', 'Shipment not found');
    return shipment;
}

async function recordShipmentEvent({
    store,
    merchant,
    shipment,
    label = null,
    eventType,
    message,
    occurredAt,
}) {
    if (typeof store.recordMerchantJobEvent !== 'function') return;
    await store.recordMerchantJobEvent({
        ...merchantScope(merchant),
        event_id: crypto.randomUUID(),
        job_id: null,
        order_id: shipment.order_id || null,
        event_type: eventType,
        message,
        payload: {
            shipment_id: shipment.shipment_id,
            status: shipment.status,
            carrier: shipment.carrier || null,
            tracking_number: shipment.tracking_number || null,
            label_id: label?.label_id || null,
        },
        occurred_at: occurredAt,
    });
}

async function recordShipmentEventBestEffort(options) {
    try {
        await recordShipmentEvent(options);
    } catch {
        // Durable shipment state should not fail because timeline persistence failed.
    }
}

function labelPayload(adapterLabel = {}) {
    return safeObject(adapterLabel);
}

async function persistAdapterLabel({
    store,
    merchant,
    shipment,
    adapterLabel,
    trackingNumber,
    timestamp,
}) {
    if (!adapterLabel || typeof store.createMerchantShippingLabel !== 'function') return null;
    return store.createMerchantShippingLabel({
        ...merchantScope(merchant),
        label_id: optionalString(adapterLabel.label_id) || crypto.randomUUID(),
        shipment_id: shipment.shipment_id,
        provider: optionalString(adapterLabel.provider) || 'mock',
        label_url: optionalString(adapterLabel.label_url),
        tracking_number: optionalString(adapterLabel.tracking_number) || trackingNumber || null,
        label_payload: labelPayload(adapterLabel),
        metadata: {
            format: optionalString(adapterLabel.format),
        },
        created_at: optionalString(adapterLabel.created_at) || timestamp,
    });
}

export function createShippingHandlers({
    store,
    authenticateMerchant,
    adapters = {},
    now = () => new Date(),
} = {}) {
    if (!store) throw new Error('store is required');

    async function listShipments(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const source = safeObject(body);
        const shipments = await store.listMerchantShipments({
            merchantId: merchant.merchant_id,
            orderId: optionalString(source.order_id),
            status: normalizeShipmentStatus(source.status),
            limit: normalizeLimit(source.limit, 50, 100),
        });
        return publicOk({ shipments: shipments.map((shipment) => publicShipment(shipment)) }, requestId);
    }

    async function createShipment(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const source = safeObject(body);
        const orderId = requiredOrderId(source.order_id);
        const order = await requireMerchantOrder(store, merchant, orderId);
        if (!adapters?.shipping || typeof adapters.shipping.createShipment !== 'function') {
            throw new Error('shipping adapter is required');
        }

        const timestamp = now().toISOString();
        const packages = normalizePackages(source.packages);
        const shipTo = redactPublicValue(
            Object.keys(safeObject(source.ship_to)).length > 0
                ? safeObject(source.ship_to)
                : safeObject(order.shipping_address),
        );
        const adapterShipment = await adapters.shipping.createShipment({
            merchant,
            order,
            address: shipTo,
            packages,
            serviceLevel: optionalString(source.service_level),
        });
        const shipment = await store.createMerchantShipment({
            ...merchantScope(merchant),
            shipment_id: optionalString(adapterShipment.shipment_id) || crypto.randomUUID(),
            order_id: order.order_id,
            status: normalizeShipmentStatus(adapterShipment.status) || 'label_requested',
            carrier: optionalString(adapterShipment.carrier),
            service_level: optionalString(adapterShipment.service_level) || optionalString(source.service_level),
            tracking_number: optionalString(adapterShipment.tracking_number),
            ship_to: redactPublicValue(safeObject(adapterShipment.ship_to || shipTo)),
            packages: Array.isArray(adapterShipment.packages)
                ? redactPublicValue(adapterShipment.packages)
                : packages,
            shipped_at: null,
            delivered_at: null,
            metadata: {
                ...redactPublicValue(safeObject(source.metadata)),
                provider: optionalString(adapterShipment.provider) || 'mock',
            },
            created_at: optionalString(adapterShipment.created_at) || timestamp,
        });
        const label = await persistAdapterLabel({
            store,
            merchant,
            shipment,
            adapterLabel: adapterShipment.label,
            trackingNumber: shipment.tracking_number,
            timestamp,
        });
        await recordShipmentEventBestEffort({
            store,
            merchant,
            shipment,
            label,
            eventType: 'shipment.created',
            message: 'Merchant shipment created',
            occurredAt: timestamp,
        });
        return withHttpStatus(publicOk(publicShipment(shipment, label), requestId), 201);
    }

    async function getShipment(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const shipmentId = requiredShipmentId(safeObject(body).shipment_id);
        const shipment = await getCurrentShipment(store, merchant, shipmentId);
        return publicOk(publicShipment(shipment), requestId);
    }

    async function createLabel(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const shipmentId = requiredShipmentId(safeObject(body).shipment_id);
        const shipment = await getCurrentShipment(store, merchant, shipmentId);
        const existingLabel = typeof store.getMerchantShippingLabelByShipment === 'function'
            ? await store.getMerchantShippingLabelByShipment({
                merchantId: merchant.merchant_id,
                shipmentId,
            })
            : null;
        if (existingLabel) return publicOk({ label: publicLabel(existingLabel) }, requestId);
        if (!adapters?.shipping || typeof adapters.shipping.createShipment !== 'function') {
            throw new Error('shipping adapter is required');
        }

        const order = shipment.order_id
            ? await store.getMerchantOrder({ merchantId: merchant.merchant_id, orderId: shipment.order_id })
            : null;
        const timestamp = now().toISOString();
        const adapterShipment = await adapters.shipping.createShipment({
            merchant,
            order: order || { order_id: shipment.order_id },
            address: safeObject(shipment.ship_to),
            packages: Array.isArray(shipment.packages) ? shipment.packages : [],
        });
        const label = await persistAdapterLabel({
            store,
            merchant,
            shipment,
            adapterLabel: adapterShipment.label,
            trackingNumber: optionalString(adapterShipment.tracking_number) || shipment.tracking_number,
            timestamp,
        });
        if (!label) throw createHttpError(502, 'label_unavailable', 'Shipping label could not be created');
        const updatedShipment = typeof store.updateMerchantShipmentStatus === 'function'
            ? await store.updateMerchantShipmentStatus({
                merchantId: merchant.merchant_id,
                shipmentId,
                status: 'label_created',
                fields: {
                    tracking_number: label.tracking_number || shipment.tracking_number || null,
                },
            }) || shipment
            : shipment;
        await recordShipmentEventBestEffort({
            store,
            merchant,
            shipment: updatedShipment,
            label,
            eventType: 'shipment.label_created',
            message: 'Merchant shipment label created',
            occurredAt: timestamp,
        });
        return withHttpStatus(publicOk({ label: publicLabel(label) }, requestId), 201);
    }

    return {
        listShipments,
        createShipment,
        getShipment,
        createLabel,
    };
}
