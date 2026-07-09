// src/cloud/stripePayments.js — minimal Stripe client for storefront checkout.
//
// No SDK: Stripe's REST API is form-encoded HTTPS, which keeps the serverless
// bundle lean. Secrets come from the storefront settings (write-only in the
// admin API) or STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET env vars.
//
// Webhook trust model: plain Vercel functions hand us a parsed JSON body, not
// the raw bytes Stripe signed, so instead of HMAC-verifying the payload we
// treat the delivered event as a HINT and re-fetch the event by id from
// Stripe's API with our secret key (retrieveStripeEvent). A forged webhook can
// then only reference events that genuinely exist in OUR account, which makes
// forgery useless. When the raw body IS available (self-hosted express), the
// HMAC check in verifyStripeSignature is applied first as well.
import crypto from 'node:crypto';

const STRIPE_API_BASE = 'https://api.stripe.com';

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
}

export function resolveStripeConfig(settings = {}) {
    const stripe = (settings && typeof settings.stripe === 'object' && settings.stripe) || {};
    return {
        secret_key: isNonEmptyString(stripe.secret_key) ? stripe.secret_key.trim() : (process.env.STRIPE_SECRET_KEY || null),
        webhook_secret: isNonEmptyString(stripe.webhook_secret) ? stripe.webhook_secret.trim() : (process.env.STRIPE_WEBHOOK_SECRET || null),
        mock: stripe.mock === true || process.env.MOCK_MODE === 'true',
    };
}

export function isStripeConfigured(settings = {}) {
    const config = resolveStripeConfig(settings);
    return config.mock || Boolean(config.secret_key);
}

// Flatten { a: { b: 1 }, c: [x] } to Stripe's form encoding a[b]=1&c[0]=x.
export function toStripeForm(params, prefix = '', out = new URLSearchParams()) {
    for (const [key, value] of Object.entries(params)) {
        if (value === null || value === undefined) continue;
        const name = prefix ? `${prefix}[${key}]` : key;
        if (Array.isArray(value)) {
            value.forEach((item, index) => {
                if (item && typeof item === 'object') toStripeForm(item, `${name}[${index}]`, out);
                else out.append(`${name}[${index}]`, String(item));
            });
        } else if (typeof value === 'object') {
            toStripeForm(value, name, out);
        } else {
            out.append(name, String(value));
        }
    }
    return out;
}

async function stripeRequest({ config, method, path, params = null, fetchImpl = fetch }) {
    if (!config.secret_key) throw new Error('stripe_not_configured');
    const response = await fetchImpl(`${STRIPE_API_BASE}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${config.secret_key}`,
            ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
        ...(params ? { body: toStripeForm(params).toString() } : {}),
    });
    const text = await response.text();
    let parsed;
    try {
        parsed = text ? JSON.parse(text) : {};
    } catch {
        parsed = { raw: text };
    }
    if (!response.ok) {
        const message = parsed?.error?.message || text.slice(0, 300);
        throw new Error(`stripe_request_failed: ${method} ${path} HTTP ${response.status} ${message}`);
    }
    return parsed;
}

/**
 * Hosted Stripe Checkout session for one storefront order. In mock mode the
 * "session" is a local success URL so the whole funnel runs offline.
 */
export async function createStripeCheckoutSession({
    settings,
    orderId,
    amountCents,
    currency = 'USD',
    productName,
    customerEmail = null,
    successUrl,
    cancelUrl,
    automaticTax = false,
    fetchImpl = fetch,
}) {
    const config = resolveStripeConfig(settings);
    if (config.mock) {
        const join = successUrl.includes('?') ? '&' : '?';
        return {
            id: `cs_mock_${orderId}`,
            url: `${successUrl}${join}mock_checkout=1`,
            mock: true,
        };
    }
    return stripeRequest({
        config,
        method: 'POST',
        path: '/v1/checkout/sessions',
        fetchImpl,
        params: {
            mode: 'payment',
            success_url: successUrl,
            cancel_url: cancelUrl,
            ...(customerEmail ? { customer_email: customerEmail } : {}),
            // Stripe Tax computes and collects sales tax on top of the quote
            // (requires Tax enabled on the Stripe account).
            ...(automaticTax ? { automatic_tax: { enabled: 'true' } } : {}),
            line_items: [{
                quantity: 1,
                price_data: {
                    currency: currency.toLowerCase(),
                    unit_amount: amountCents,
                    product_data: { name: productName },
                },
            }],
            metadata: { storefront_order_id: orderId },
            payment_intent_data: { metadata: { storefront_order_id: orderId } },
        },
    });
}

// Full refund of a paid checkout (customer canceled before printing began).
export async function createStripeRefund({ settings, paymentIntentId, fetchImpl = fetch }) {
    const config = resolveStripeConfig(settings);
    if (config.mock) {
        return { id: `re_mock_${paymentIntentId || 'none'}`, status: 'succeeded', mock: true };
    }
    if (!paymentIntentId) throw new Error('payment_intent_required');
    return stripeRequest({
        config,
        method: 'POST',
        path: '/v1/refunds',
        fetchImpl,
        params: { payment_intent: paymentIntentId },
    });
}

// Authoritative copy of a webhook event, fetched with OUR key.
export async function retrieveStripeEvent({ settings, eventId, fetchImpl = fetch }) {
    const config = resolveStripeConfig(settings);
    return stripeRequest({ config, method: 'GET', path: `/v1/events/${encodeURIComponent(eventId)}`, fetchImpl });
}

export async function retrieveStripeCheckoutSession({ settings, sessionId, fetchImpl = fetch }) {
    const config = resolveStripeConfig(settings);
    return stripeRequest({ config, method: 'GET', path: `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, fetchImpl });
}

/**
 * Raw-body HMAC verification (Stripe-Signature: t=...,v1=...). Only usable
 * when the transport preserved the exact bytes (self-hosted express);
 * returns false rather than throwing so callers can fall back to the
 * fetch-the-event-by-id check.
 */
export function verifyStripeSignature({ settings, rawBody, signatureHeader, toleranceSeconds = 300, now = () => new Date() }) {
    const config = resolveStripeConfig(settings);
    if (!config.webhook_secret || !rawBody || !isNonEmptyString(signatureHeader)) return false;
    const parts = Object.fromEntries(
        signatureHeader.split(',').map((piece) => piece.split('=').map((s) => s.trim())).filter((pair) => pair.length === 2),
    );
    const timestamp = Number.parseInt(parts.t, 10);
    if (!Number.isFinite(timestamp) || !isNonEmptyString(parts.v1)) return false;
    if (Math.abs(now().getTime() / 1000 - timestamp) > toleranceSeconds) return false;
    const expected = crypto
        .createHmac('sha256', config.webhook_secret)
        .update(`${timestamp}.${typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8')}`)
        .digest('hex');
    try {
        return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(parts.v1, 'hex'));
    } catch {
        return false;
    }
}
