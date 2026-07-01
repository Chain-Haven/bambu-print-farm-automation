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
import { signWebhookPayload } from './webhooks.js';

const WEBHOOK_STATUSES = new Set(['active', 'disabled']);
const DEFAULT_EVENTS = ['job.created'];

function withHttpStatus(payload, statusCode) {
    Object.defineProperty(payload, '_http_status', {
        value: statusCode,
        enumerable: false,
    });
    return payload;
}

function eventId(idGenerator) {
    return `evt_${idGenerator().replaceAll('-', '')}`;
}

function defaultSecretGenerator() {
    return `whsec_${crypto.randomBytes(32).toString('hex')}`;
}

function hashSecret(secret, pepper = '') {
    const input = pepper ? `${pepper}:${secret}` : secret;
    return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function requiredWebhookId(value) {
    return requiredString(value, 'webhook_id');
}

function normalizeUrl(value, { required = true } = {}) {
    const url = optionalString(value);
    if (!url) {
        if (required) throw createHttpError(400, 'invalid_payload', 'url is required');
        return null;
    }
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        throw createHttpError(400, 'invalid_payload', 'url must be a valid HTTPS URL');
    }
    if (parsed.protocol !== 'https:') {
        throw createHttpError(400, 'invalid_payload', 'url must be a valid HTTPS URL');
    }
    return parsed.toString();
}

function normalizeEvents(value, { required = false } = {}) {
    if (value === undefined || value === null) {
        if (required) throw createHttpError(400, 'invalid_payload', 'events must be an array');
        return DEFAULT_EVENTS;
    }
    if (!Array.isArray(value)) {
        throw createHttpError(400, 'invalid_payload', 'events must be an array');
    }
    const events = value
        .map((event) => String(event || '').trim())
        .filter(Boolean);
    if (events.length === 0) {
        throw createHttpError(400, 'invalid_payload', 'events must include at least one event');
    }
    return [...new Set(events)];
}

function normalizeStatus(value, fallback = 'active') {
    const status = optionalString(value) || fallback;
    if (!WEBHOOK_STATUSES.has(status)) {
        throw createHttpError(400, 'invalid_payload', 'status must be active or disabled');
    }
    return status;
}

function publicEndpoint(endpoint) {
    const response = {
        webhook_id: endpoint.webhook_id,
        url: endpoint.url,
        events: Array.isArray(endpoint.events) ? endpoint.events : [],
        status: endpoint.status || 'active',
    };
    for (const key of [
        'description',
        'last_delivery_at',
        'created_at',
        'updated_at',
    ]) {
        if (endpoint[key] !== undefined && endpoint[key] !== null) response[key] = endpoint[key];
    }
    const metadata = redactPublicValue(safeObject(endpoint.metadata));
    if (Object.keys(metadata).length > 0) response.metadata = metadata;
    return response;
}

function publicDelivery(delivery) {
    const response = {
        delivery_id: delivery.delivery_id,
        webhook_id: delivery.webhook_id,
        event_type: delivery.event_type,
        status: delivery.status,
    };
    for (const key of [
        'response_status',
        'response_body',
        'attempt_count',
        'next_retry_at',
        'delivered_at',
        'created_at',
        'updated_at',
    ]) {
        if (delivery[key] !== undefined && delivery[key] !== null) response[key] = delivery[key];
    }
    const metadata = redactPublicValue(safeObject(delivery.metadata));
    if (Object.keys(metadata).length > 0) response.metadata = metadata;
    return response;
}

async function getEndpointForMerchant(store, merchant, webhookId) {
    const endpoints = await store.listMerchantWebhookEndpoints({
        merchantId: merchant.merchant_id,
        limit: 100,
    });
    return endpoints.find((endpoint) => endpoint.webhook_id === webhookId) || null;
}

export function createMerchantWebhooksV2Handlers({
    store,
    authenticateMerchant,
    now = () => new Date(),
    idGenerator = () => crypto.randomUUID(),
    secretGenerator = defaultSecretGenerator,
    secretPepper = process.env.MERCHANT_WEBHOOK_SECRET_PEPPER
        || process.env.MERCHANT_API_KEY_PEPPER
        || process.env.NODE_TOKEN_PEPPER
        || '',
} = {}) {
    if (!store) throw new Error('store is required');

    async function listEndpoints(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const endpoints = await store.listMerchantWebhookEndpoints({
            merchantId: merchant.merchant_id,
            limit: normalizeLimit(safeObject(body).limit, 50, 100),
        });
        return publicOk({ endpoints: endpoints.map(publicEndpoint) }, requestId);
    }

    async function createEndpoint(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const source = safeObject(body);
        const timestamp = now().toISOString();
        const secret = secretGenerator();
        if (!optionalString(secret) || !secret.startsWith('whsec_')) {
            throw new Error('webhook secret generator must return a whsec_ secret');
        }
        const endpoint = await store.createMerchantWebhookEndpoint({
            ...merchantScope(merchant),
            webhook_id: idGenerator(),
            url: normalizeUrl(source.url || source.endpoint_url),
            description: optionalString(source.description),
            events: normalizeEvents(source.events),
            secret_hash: hashSecret(secret, secretPepper),
            status: normalizeStatus(source.status, 'active'),
            last_delivery_at: null,
            metadata: redactPublicValue(safeObject(source.metadata)),
            created_at: timestamp,
            updated_at: timestamp,
        });
        return withHttpStatus(publicOk({
            ...publicEndpoint(endpoint),
            secret,
        }, requestId), 201);
    }

    async function getEndpoint(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const endpoint = await getEndpointForMerchant(store, merchant, requiredWebhookId(safeObject(body).webhook_id));
        if (!endpoint) throw createHttpError(404, 'webhook_not_found', 'Webhook endpoint not found');
        return publicOk(publicEndpoint(endpoint), requestId);
    }

    async function updateEndpoint(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const source = safeObject(body);
        const id = requiredWebhookId(source.webhook_id);
        const current = await getEndpointForMerchant(store, merchant, id);
        if (!current) throw createHttpError(404, 'webhook_not_found', 'Webhook endpoint not found');

        const fields = {
            updated_at: now().toISOString(),
        };
        if (source.url !== undefined || source.endpoint_url !== undefined) {
            fields.url = normalizeUrl(source.url || source.endpoint_url);
        }
        if (source.description !== undefined) {
            fields.description = optionalString(source.description);
        }
        if (source.events !== undefined) {
            fields.events = normalizeEvents(source.events, { required: true });
        }
        if (source.status !== undefined) {
            fields.status = normalizeStatus(source.status, current.status || 'active');
        }
        if (source.metadata !== undefined) {
            fields.metadata = redactPublicValue(safeObject(source.metadata));
        }

        const endpoint = await store.updateMerchantWebhookEndpoint({
            merchantId: merchant.merchant_id,
            webhookId: id,
            fields,
        });
        if (!endpoint) throw createHttpError(404, 'webhook_not_found', 'Webhook endpoint not found');
        return publicOk(publicEndpoint(endpoint), requestId);
    }

    async function deleteEndpoint(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const id = requiredWebhookId(safeObject(body).webhook_id);
        const current = await getEndpointForMerchant(store, merchant, id);
        if (!current) throw createHttpError(404, 'webhook_not_found', 'Webhook endpoint not found');
        const endpoint = await store.deleteMerchantWebhookEndpoint({
            merchantId: merchant.merchant_id,
            webhookId: id,
        });
        if (!endpoint) throw createHttpError(404, 'webhook_not_found', 'Webhook endpoint not found');
        return publicOk(publicEndpoint(endpoint), requestId);
    }

    async function testEndpoint(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const id = requiredWebhookId(safeObject(body).webhook_id);
        const endpoint = await getEndpointForMerchant(store, merchant, id);
        if (!endpoint) throw createHttpError(404, 'webhook_not_found', 'Webhook endpoint not found');
        if ((endpoint.status || 'active') === 'disabled') {
            throw createHttpError(409, 'webhook_disabled', 'Webhook endpoint is disabled');
        }

        const createdAt = now().toISOString();
        const payload = {
            id: eventId(idGenerator),
            type: 'webhook.test',
            created_at: createdAt,
            data: {
                webhook_id: endpoint.webhook_id,
                url: endpoint.url,
            },
        };
        const bodyText = JSON.stringify(payload);
        const timestamp = String(Math.floor(now().getTime() / 1000));
        const signature = signWebhookPayload({
            secret: endpoint.secret_hash,
            timestamp,
            body: bodyText,
        });
        const delivery = await store.createMerchantWebhookDelivery({
            ...merchantScope(merchant),
            delivery_id: idGenerator(),
            webhook_id: endpoint.webhook_id,
            event_type: 'webhook.test',
            status: 'mock_recorded',
            request_payload: payload,
            response_status: null,
            response_body: null,
            attempt_count: 1,
            next_retry_at: null,
            delivered_at: createdAt,
            metadata: {
                signature,
                timestamp,
                endpoint_url: endpoint.url,
            },
            created_at: createdAt,
            updated_at: createdAt,
        });
        await store.updateMerchantWebhookEndpoint({
            merchantId: merchant.merchant_id,
            webhookId: endpoint.webhook_id,
            fields: {
                last_delivery_at: createdAt,
                updated_at: createdAt,
            },
        });
        return publicOk(publicDelivery(delivery), requestId);
    }

    return {
        listEndpoints,
        createEndpoint,
        getEndpoint,
        updateEndpoint,
        deleteEndpoint,
        testEndpoint,
    };
}
