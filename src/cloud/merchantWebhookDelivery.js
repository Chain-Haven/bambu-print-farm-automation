import crypto from 'node:crypto';
import { createHttpError, merchantScope } from './merchantApiV2.js';
import { optionalString, safeObject } from './merchantPublicProjections.js';
import { signWebhookPayload } from './webhooks.js';
import { assertSafeWebhookUrl } from './urlGuard.js';

// Retry backoff for failed webhook deliveries. On Vercel serverless there is no
// long-running worker, so failed deliveries are recorded with next_retry_at and
// retried lazily — either by the merchant hitting the replay endpoint or by an
// admin retry sweep. We keep an exponential schedule so a sweep can honor it.
const RETRY_DELAYS_MS = [0, 30_000, 120_000, 600_000, 3_600_000];
const MAX_RESPONSE_BODY_LENGTH = 2000;

function eventId(idGenerator) {
    return `evt_${idGenerator().replaceAll('-', '')}`;
}

function defaultIdGenerator() {
    return crypto.randomUUID();
}

function requireSigningSecretEncryptionKey(keyMaterial) {
    const key = optionalString(keyMaterial);
    if (!key) {
        throw createHttpError(
            500,
            'webhook_signing_secret_key_missing',
            'Webhook signing secret encryption key is not configured',
        );
    }
    return key;
}

function encryptionKey(keyMaterial = '') {
    return crypto.createHash('sha256').update(String(keyMaterial), 'utf8').digest();
}

function decryptSigningSecret(encrypted = {}, keyMaterial = '') {
    const key = requireSigningSecretEncryptionKey(keyMaterial);
    if (encrypted.alg !== 'aes-256-gcm' || !encrypted.iv || !encrypted.ciphertext || !encrypted.tag) {
        throw createHttpError(409, 'webhook_secret_unavailable', 'Webhook signing secret is unavailable');
    }
    try {
        const decipher = crypto.createDecipheriv(
            'aes-256-gcm',
            encryptionKey(key),
            Buffer.from(encrypted.iv, 'base64'),
        );
        decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
        return Buffer.concat([
            decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
            decipher.final(),
        ]).toString('utf8');
    } catch {
        throw createHttpError(409, 'webhook_secret_unavailable', 'Webhook signing secret is unavailable');
    }
}

function endpointAcceptsEvent(endpoint, eventType) {
    if ((endpoint.status || 'active') !== 'active') return false;
    const events = Array.isArray(endpoint.events) ? endpoint.events : [];
    if (events.length === 0) return false;
    return events.includes(eventType) || events.includes('*');
}

function truncateResponseBody(body) {
    if (body === null || body === undefined) return null;
    const text = typeof body === 'string' ? body : String(body);
    return text.length > MAX_RESPONSE_BODY_LENGTH ? `${text.slice(0, MAX_RESPONSE_BODY_LENGTH)}…` : text;
}

function nextRetryAt(attemptCount, now) {
    const idx = Math.max(0, Math.min(attemptCount, RETRY_DELAYS_MS.length - 1));
    return new Date(now().getTime() + RETRY_DELAYS_MS[idx]).toISOString();
}

async function deliverOne({ endpoint, secret, eventType, data, fetchImpl, now, idGenerator }) {
    const createdAt = now().toISOString();
    const payload = {
        id: eventId(idGenerator),
        type: eventType,
        created_at: createdAt,
        data,
    };
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(now().getTime() / 1000));
    const signature = signWebhookPayload({ secret, timestamp, body });

    let responseStatus = null;
    let responseBody = null;
    let failureReason = null;

    try {
        const response = await fetchImpl(endpoint.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-PrintKinetix-Event': eventType,
                'X-PrintKinetix-Timestamp': timestamp,
                'X-PrintKinetix-Signature': signature,
            },
            body,
        });
        responseStatus = response.status;
        if (!response.ok) {
            const text = await response.text().catch(() => '');
            responseBody = truncateResponseBody(text);
            failureReason = `HTTP ${response.status}`;
        }
    } catch (error) {
        failureReason = error?.message || 'fetch_failed';
    }

    const delivered = responseStatus !== null && responseStatus >= 200 && responseStatus < 300;
    return {
        payload,
        signature,
        timestamp,
        responseStatus,
        responseBody,
        failureReason,
        delivered,
        createdAt,
    };
}

/**
 * Fan a merchant job-lifecycle event out to every active v2 webhook endpoint
 * subscribed to that event. Each attempt is persisted as a delivery row with
 * the signed payload, HTTP response, attempt count, and (on failure) a
 * next_retry_at. Best-effort: a single bad endpoint never fails the caller.
 */
export async function deliverMerchantWebhookEvent({
    store,
    merchant,
    eventType,
    data = {},
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
    idGenerator = defaultIdGenerator,
    signingSecretEncryptionKey = process.env.MERCHANT_WEBHOOK_SIGNING_SECRET_KEY,
} = {}) {
    if (!store || typeof store.listMerchantWebhookEndpoints !== 'function') return { delivered: 0 };
    if (!merchant?.merchant_id) return { delivered: 0 };

    let endpoints;
    try {
        endpoints = await store.listMerchantWebhookEndpoints({ merchantId: merchant.merchant_id, limit: 100 });
    } catch {
        return { delivered: 0 };
    }
    const targets = (Array.isArray(endpoints) ? endpoints : []).filter((e) => endpointAcceptsEvent(e, eventType));
    if (targets.length === 0) return { delivered: 0, skipped: true };

    let delivered = 0;
    for (const endpoint of targets) {
        try {
            let secret;
            try {
                secret = decryptSigningSecret(safeObject(endpoint.metadata).webhook_signing_secret, signingSecretEncryptionKey);
            } catch {
                continue;
            }
            const attempt = await deliverOne({ endpoint, secret, eventType, data, fetchImpl, now, idGenerator });
            const status = attempt.delivered ? 'delivered' : 'failed';
            await store.createMerchantWebhookDelivery({
                ...merchantScope(merchant),
                delivery_id: idGenerator(),
                webhook_id: endpoint.webhook_id,
                event_type: eventType,
                status,
                request_payload: attempt.payload,
                response_status: attempt.responseStatus,
                response_body: attempt.responseBody,
                attempt_count: 1,
                next_retry_at: attempt.delivered ? null : nextRetryAt(1, now),
                delivered_at: attempt.delivered ? attempt.createdAt : null,
                metadata: {
                    signature: attempt.signature,
                    timestamp: attempt.timestamp,
                    endpoint_url: endpoint.url,
                    ...(attempt.failureReason ? { failure_reason: attempt.failureReason } : {}),
                },
                created_at: attempt.createdAt,
                updated_at: attempt.createdAt,
            });
            await store.updateMerchantWebhookEndpoint({
                merchantId: merchant.merchant_id,
                webhookId: endpoint.webhook_id,
                fields: { last_delivery_at: attempt.createdAt, updated_at: attempt.createdAt },
            }).catch(() => {});
            if (attempt.delivered) delivered += 1;
        } catch {
            /* per-endpoint isolation */
        }
    }
    return { delivered, attempted: targets.length };
}

/**
 * Re-attempt a previously recorded delivery to its endpoint. Increments the
 * attempt count, updates the response, and clears/advances next_retry_at.
 */
export async function replayMerchantWebhookDelivery({
    store,
    merchant,
    deliveryId,
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
    idGenerator = defaultIdGenerator,
    signingSecretEncryptionKey = process.env.MERCHANT_WEBHOOK_SIGNING_SECRET_KEY,
} = {}) {
    if (!store?.getMerchantWebhookDelivery) throw createHttpError(500, 'internal_error', 'Store does not support webhook deliveries');
    const delivery = await store.getMerchantWebhookDelivery({ merchantId: merchant.merchant_id, deliveryId });
    if (!delivery) throw createHttpError(404, 'delivery_not_found', 'Webhook delivery not found');
    const endpoint = await store.getMerchantWebhookEndpoint({ merchantId: merchant.merchant_id, webhookId: delivery.webhook_id });
    if (!endpoint) throw createHttpError(404, 'webhook_not_found', 'Webhook endpoint not found');
    if ((endpoint.status || 'active') === 'disabled') {
        throw createHttpError(409, 'webhook_disabled', 'Webhook endpoint is disabled');
    }

    const secret = decryptSigningSecret(safeObject(endpoint.metadata).webhook_signing_secret, signingSecretEncryptionKey);
    const data = safeObject(safeObject(delivery.request_payload).data);
    const eventType = delivery.event_type;
    const attempt = await deliverOne({ endpoint, secret, eventType, data, fetchImpl, now, idGenerator });

    const attemptCount = (Number.parseInt(delivery.attempt_count, 10) || 1) + 1;
    const updated = await store.updateMerchantWebhookDelivery({
        merchantId: merchant.merchant_id,
        deliveryId,
        fields: {
            status: attempt.delivered ? 'delivered' : 'failed',
            response_status: attempt.responseStatus,
            response_body: attempt.responseBody,
            attempt_count: attemptCount,
            next_retry_at: attempt.delivered ? null : nextRetryAt(attemptCount, now),
            delivered_at: attempt.delivered ? attempt.createdAt : delivery.delivered_at || null,
            metadata: {
                ...safeObject(delivery.metadata),
                signature: attempt.signature,
                timestamp: attempt.timestamp,
                endpoint_url: endpoint.url,
                last_replay_at: attempt.createdAt,
                ...(attempt.failureReason ? { failure_reason: attempt.failureReason } : {}),
            },
            updated_at: attempt.createdAt,
        },
    });
    await store.updateMerchantWebhookEndpoint({
        merchantId: merchant.merchant_id,
        webhookId: endpoint.webhook_id,
        fields: { last_delivery_at: attempt.createdAt, updated_at: attempt.createdAt },
    }).catch(() => {});
    return updated;
}

export { assertSafeWebhookUrl, decryptSigningSecret, deliverOne, nextRetryAt };
