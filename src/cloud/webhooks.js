import { createHmac, createHash, randomBytes } from 'node:crypto';
import { assertSafeWebhookUrl } from './urlGuard.js';

export const SUPPORTED_WEBHOOK_EVENTS = [
    'job.accepted',
    'job.needs_approval',
    'job.approved',
    'job.canceled',
    'job.reprint_requested',
    'job.failed',
    'job.completed',
    'job.shipped',
    'filament.unavailable',
];

export function normalizeWebhookConfig(input = {}, current = {}) {
    // Validate only a newly-provided URL (SSRF guard); an unchanged stored URL is
    // preserved as-is so config edits that don't touch the URL keep working.
    const endpointUrl = typeof input.endpoint_url === 'string' && input.endpoint_url.trim()
        ? assertSafeWebhookUrl(input.endpoint_url.trim())
        : current.endpoint_url || null;
    const events = Array.isArray(input.events)
        ? input.events.filter((event) => SUPPORTED_WEBHOOK_EVENTS.includes(event))
        : (Array.isArray(current.events) ? current.events : ['job.accepted', 'job.completed', 'job.failed']);
    const secret = typeof input.secret === 'string' && input.secret.trim()
        ? input.secret.trim()
        : (current.secret || `whsec_${randomBytes(24).toString('hex')}`);

    return {
        endpoint_url: endpointUrl,
        enabled: typeof input.enabled === 'boolean' ? input.enabled : current.enabled === true,
        secret,
        events: [...new Set(events)],
    };
}

export function redactWebhookConfig(config = {}) {
    return {
        endpoint_url: config.endpoint_url || null,
        enabled: config.enabled === true,
        events: Array.isArray(config.events) ? config.events : [],
        has_secret: typeof config.secret === 'string' && config.secret.length > 0,
    };
}

export function signWebhookPayload({ secret, timestamp, body }) {
    const digest = createHmac('sha256', secret)
        .update(`${timestamp}.${body}`)
        .digest('hex');
    return `v1=${digest}`;
}

function buildEventId(eventType, createdAt, data) {
    const hash = createHash('sha256')
        .update(`${eventType}.${createdAt}.${JSON.stringify(data || {})}`)
        .digest('hex')
        .slice(0, 18);
    return `evt_${hash}`;
}

export async function deliverMerchantWebhook({
    merchant,
    eventType,
    data = {},
    fetchImpl = globalThis.fetch,
    now = () => new Date(),
} = {}) {
    const config = merchant?.metadata?.webhook || {};
    if (config.enabled !== true || !config.endpoint_url) return { status: 'skipped', reason: 'webhook_disabled' };
    if (Array.isArray(config.events) && !config.events.includes(eventType)) return { status: 'skipped', reason: 'event_not_enabled' };
    if (typeof fetchImpl !== 'function') return { status: 'skipped', reason: 'fetch_unavailable' };
    if (!config.secret) return { status: 'skipped', reason: 'secret_missing' };

    const createdAt = now().toISOString();
    const payload = {
        id: buildEventId(eventType, createdAt, data),
        type: eventType,
        created_at: createdAt,
        data,
    };
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(now().getTime() / 1000));
    const signature = signWebhookPayload({
        secret: config.secret,
        timestamp,
        body,
    });

    let response;
    try {
        response = await fetchImpl(config.endpoint_url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-PrintKinetix-Event': eventType,
                'X-PrintKinetix-Timestamp': timestamp,
                'X-PrintKinetix-Signature': signature,
            },
            body,
        });
    } catch (error) {
        return {
            status: 'failed',
            error: error.message,
            event_id: payload.id,
        };
    }

    return {
        status: response.ok ? 'delivered' : 'failed',
        http_status: response.status,
        event_id: payload.id,
    };
}

export function getSupportedIntegrations() {
    return [
        { type: 'shopify', category: 'ecommerce', status: 'supported', events: ['order.created', 'fulfillment.created'] },
        { type: 'woocommerce', category: 'ecommerce', status: 'supported', events: ['order.created'] },
        { type: 'etsy', category: 'marketplace', status: 'planned', events: ['order.created'] },
        { type: 'shipstation', category: 'shipping', status: 'supported', events: ['label.created', 'shipment.updated'] },
        { type: 'slack', category: 'alerts', status: 'supported', events: ['job.failed', 'filament.unavailable'] },
        { type: 'zapier', category: 'automation', status: 'supported', events: SUPPORTED_WEBHOOK_EVENTS },
        { type: 'make', category: 'automation', status: 'supported', events: SUPPORTED_WEBHOOK_EVENTS },
        { type: 'webhooks', category: 'developer', status: 'supported', events: SUPPORTED_WEBHOOK_EVENTS },
    ];
}
