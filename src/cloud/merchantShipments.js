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

function getHeader(headers = {}, name) {
    const expected = name.toLowerCase();
    for (const [key, value] of Object.entries(headers || {})) {
        if (String(key).toLowerCase() !== expected) continue;
        return Array.isArray(value) ? value[0] : value;
    }
    return null;
}

function stableJsonValue(value) {
    if (Array.isArray(value)) return value.map(stableJsonValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, child]) => [key, stableJsonValue(child)]),
        );
    }
    return value;
}

function stableJsonString(value) {
    return JSON.stringify(stableJsonValue(value));
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

function shipmentIdempotencyKey(source, request) {
    return optionalString(getHeader(request?.headers, 'idempotency-key'))
        || optionalString(source.idempotency_key);
}

function normalizedShipmentRequest({ orderId, source, order }) {
    return {
        order_id: orderId,
        service_level: optionalString(source.service_level),
        ship_to: redactPublicValue(
            Object.keys(safeObject(source.ship_to)).length > 0
                ? safeObject(source.ship_to)
                : safeObject(order.shipping_address),
        ),
        packages: normalizePackages(source.packages),
    };
}

function idempotencyConflict() {
    throw createHttpError(
        409,
        'idempotency_conflict',
        'Idempotency key was already used with different shipment details',
    );
}

function assertIdempotentShipmentMatches(shipment, expectedRequest) {
    const storedRequest = safeObject(shipment?.metadata).idempotency_request;
    if (!storedRequest || stableJsonString(storedRequest) !== stableJsonString(expectedRequest)) {
        idempotencyConflict();
    }
}

function shipmentClaimPayload({
    merchant,
    source,
    order,
    idempotencyKey,
    expectedRequest,
    timestamp,
}) {
    return {
        ...merchantScope(merchant),
        shipment_id: crypto.randomUUID(),
        order_id: order.order_id,
        idempotency_key: idempotencyKey,
        status: 'label_requested',
        carrier: null,
        service_level: expectedRequest.service_level,
        tracking_number: null,
        ship_to: expectedRequest.ship_to,
        packages: expectedRequest.packages,
        shipped_at: null,
        delivered_at: null,
        metadata: {
            ...redactPublicValue(safeObject(source.metadata)),
            provider: 'pending',
            idempotency_request: expectedRequest,
        },
        created_at: timestamp,
    };
}

function shipmentFinalFields({
    shipment,
    source,
    adapterShipment,
    expectedRequest,
}) {
    return {
        carrier: optionalString(adapterShipment.carrier),
        service_level: optionalString(adapterShipment.service_level) || optionalString(source.service_level),
        tracking_number: optionalString(adapterShipment.tracking_number),
        ship_to: redactPublicValue(safeObject(adapterShipment.ship_to || expectedRequest.ship_to)),
        packages: Array.isArray(adapterShipment.packages)
            ? redactPublicValue(adapterShipment.packages)
            : expectedRequest.packages,
        metadata: {
            ...safeObject(shipment.metadata),
            provider: optionalString(adapterShipment.provider) || 'mock',
        },
    };
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

async function getExistingShipmentLabel(store, merchant, shipmentId) {
    if (typeof store.getMerchantShippingLabelByShipment !== 'function') return null;
    return store.getMerchantShippingLabelByShipment({
        merchantId: merchant.merchant_id,
        shipmentId,
    });
}

async function replayIdempotentShipment({
    store,
    merchant,
    shipment,
    expectedRequest,
    requestId,
}) {
    assertIdempotentShipmentMatches(shipment, expectedRequest);
    const label = await getExistingShipmentLabel(store, merchant, shipment.shipment_id);
    return withHttpStatus(publicOk(publicShipment(shipment, label), requestId), 200);
}

async function findShipmentByIdempotencyKey(store, merchant, idempotencyKey) {
    if (!idempotencyKey || typeof store.findMerchantShipmentByIdempotencyKey !== 'function') return null;
    return store.findMerchantShipmentByIdempotencyKey({
        merchantId: merchant.merchant_id,
        idempotencyKey,
    });
}

async function claimIdempotentShipment({
    store,
    merchant,
    source,
    order,
    idempotencyKey,
    expectedRequest,
    timestamp,
    requestId,
}) {
    const existingShipment = await findShipmentByIdempotencyKey(store, merchant, idempotencyKey);
    if (existingShipment) {
        return {
            shipment: null,
            replay: await replayIdempotentShipment({
                store,
                merchant,
                shipment: existingShipment,
                expectedRequest,
                requestId,
            }),
        };
    }

    try {
        return {
            shipment: await store.createMerchantShipment(shipmentClaimPayload({
                merchant,
                source,
                order,
                idempotencyKey,
                expectedRequest,
                timestamp,
            })),
            replay: null,
        };
    } catch (error) {
        const replayShipment = await findShipmentByIdempotencyKey(store, merchant, idempotencyKey);
        if (replayShipment) {
            return {
                shipment: null,
                replay: await replayIdempotentShipment({
                    store,
                    merchant,
                    shipment: replayShipment,
                    expectedRequest,
                    requestId,
                }),
            };
        }
        throw error;
    }
}

async function markShipmentAdapterFailure({ store, merchant, shipment, error, timestamp }) {
    if (typeof store.updateMerchantShipmentStatus !== 'function') return;
    try {
        await store.updateMerchantShipmentStatus({
            merchantId: merchant.merchant_id,
            shipmentId: shipment.shipment_id,
            status: 'label_requested',
            fields: {
                metadata: {
                    ...safeObject(shipment.metadata),
                    provider: safeObject(shipment.metadata).provider || 'pending',
                    adapter_failure: {
                        message: error instanceof Error ? error.message : 'Shipping adapter failed',
                        failed_at: timestamp,
                    },
                },
            },
        });
    } catch {
        // The idempotency claim is already durable; failure metadata is best-effort.
    }
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
    const payload = {
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
    };
    try {
        return await store.createMerchantShippingLabel(payload);
    } catch (error) {
        const existingLabel = await getExistingShipmentLabel(store, merchant, shipment.shipment_id);
        if (existingLabel) return existingLabel;
        throw error;
    }
}

async function claimShipmentLabel({ store, merchant, shipment, timestamp }) {
    const existingLabel = await getExistingShipmentLabel(store, merchant, shipment.shipment_id);
    if (existingLabel) return { label: null, existingLabel };
    try {
        return {
            label: await store.createMerchantShippingLabel({
                ...merchantScope(merchant),
                label_id: crypto.randomUUID(),
                shipment_id: shipment.shipment_id,
                provider: 'mock',
                label_url: null,
                tracking_number: null,
                label_payload: {},
                metadata: {
                    label_claim_status: 'pending',
                },
                created_at: timestamp,
            }),
            existingLabel: null,
        };
    } catch (error) {
        const racedLabel = await getExistingShipmentLabel(store, merchant, shipment.shipment_id);
        if (racedLabel) return { label: null, existingLabel: racedLabel };
        throw error;
    }
}

async function finalizeClaimedLabel({
    store,
    merchant,
    claimedLabel,
    adapterLabel,
    trackingNumber,
}) {
    if (!adapterLabel || typeof store.updateMerchantShippingLabel !== 'function') return null;
    const fields = {
        provider: optionalString(adapterLabel.provider) || claimedLabel.provider || 'mock',
        label_url: optionalString(adapterLabel.label_url),
        tracking_number: optionalString(adapterLabel.tracking_number) || trackingNumber || null,
        label_payload: labelPayload(adapterLabel),
        metadata: {
            ...safeObject(claimedLabel.metadata),
            label_claim_status: 'completed',
            format: optionalString(adapterLabel.format),
        },
    };
    try {
        const updatedLabel = await store.updateMerchantShippingLabel({
            merchantId: merchant.merchant_id,
            labelId: claimedLabel.label_id,
            fields,
        });
        return updatedLabel
            ? { ...claimedLabel, ...updatedLabel, shipment_id: claimedLabel.shipment_id }
            : { ...claimedLabel, ...fields };
    } catch (error) {
        const existingLabel = await getExistingShipmentLabel(store, merchant, claimedLabel.shipment_id);
        if (existingLabel) return existingLabel;
        throw error;
    }
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
        const idempotencyKey = shipmentIdempotencyKey(source, request);
        const expectedRequest = normalizedShipmentRequest({ orderId, source, order });
        const timestamp = now().toISOString();
        let shipment = null;
        if (idempotencyKey) {
            const claim = await claimIdempotentShipment({
                store,
                merchant,
                source,
                order,
                idempotencyKey,
                expectedRequest,
                timestamp,
                requestId,
            });
            if (claim.replay) return claim.replay;
            shipment = claim.shipment;
        }
        if (!adapters?.shipping || typeof adapters.shipping.createShipment !== 'function') {
            throw new Error('shipping adapter is required');
        }

        let adapterShipment;
        try {
            adapterShipment = await adapters.shipping.createShipment({
                merchant,
                order,
                address: expectedRequest.ship_to,
                packages: expectedRequest.packages,
                serviceLevel: expectedRequest.service_level,
            });
        } catch (error) {
            if (shipment) {
                await markShipmentAdapterFailure({
                    store,
                    merchant,
                    shipment,
                    error,
                    timestamp,
                });
            }
            throw error;
        }
        const finalStatus = normalizeShipmentStatus(adapterShipment.status) || 'label_requested';
        if (shipment) {
            const fields = shipmentFinalFields({
                shipment,
                source,
                adapterShipment,
                expectedRequest,
            });
            shipment = await store.updateMerchantShipmentStatus({
                merchantId: merchant.merchant_id,
                shipmentId: shipment.shipment_id,
                status: finalStatus,
                fields,
            }) || { ...shipment, status: finalStatus, ...fields };
        } else {
            shipment = await store.createMerchantShipment({
                ...merchantScope(merchant),
                shipment_id: optionalString(adapterShipment.shipment_id) || crypto.randomUUID(),
                order_id: order.order_id,
                idempotency_key: null,
                status: finalStatus,
                shipped_at: null,
                delivered_at: null,
                created_at: optionalString(adapterShipment.created_at) || timestamp,
                ...shipmentFinalFields({
                    shipment: { metadata: redactPublicValue(safeObject(source.metadata)) },
                    source,
                    adapterShipment,
                    expectedRequest,
                }),
            });
        }
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
        if (!adapters?.shipping || typeof adapters.shipping.createShipment !== 'function') {
            throw new Error('shipping adapter is required');
        }

        // The placeholder row is a durable per-shipment label claim. If another request
        // already owns the claim, replay it and do not call the provider again.
        const timestamp = now().toISOString();
        const labelClaim = await claimShipmentLabel({ store, merchant, shipment, timestamp });
        if (labelClaim.existingLabel) return publicOk({ label: publicLabel(labelClaim.existingLabel) }, requestId);
        const order = shipment.order_id
            ? await store.getMerchantOrder({ merchantId: merchant.merchant_id, orderId: shipment.order_id })
            : null;
        const adapterShipment = await adapters.shipping.createShipment({
            merchant,
            order: order || { order_id: shipment.order_id },
            address: safeObject(shipment.ship_to),
            packages: Array.isArray(shipment.packages) ? shipment.packages : [],
        });
        const label = await finalizeClaimedLabel({
            store,
            merchant,
            claimedLabel: labelClaim.label,
            adapterLabel: adapterShipment.label,
            trackingNumber: optionalString(adapterShipment.tracking_number) || shipment.tracking_number,
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
