// src/cloud/storefrontHandlers.js — the public "anyone can print" funnel.
//
// Flow: upload file → instant server-priced quote (modelAnalysis grams ×
// rate) → checkout with contact + shipping address → Stripe hosted payment →
// on payment the file dispatches through the SAME merchant print pipeline
// (routeAndDispatchJobFile) as B2B orders, under a platform-owned "Walk-in
// Storefront" merchant, so routing / slicing / auto-print / telemetry all
// just work.
//
// Price integrity: quotes carry an HMAC token binding file checksum +
// material + quantity + total. Checkout recomputes the price server-side and
// requires the token to match — the client can never name its own price.
// Orders live in the `storefront_orders` platform setting (capped log, same
// pattern as filament reorders); the artifacts + print jobs live in the real
// commerce tables.
import crypto from 'node:crypto';
import { estimatePrintQuote } from './quoteEstimator.js';
import { analyzePrintUpload } from './modelAnalysis.js';
import { normalizeUpload, routeAndDispatchJobFile, storeUploadedJobFile } from './merchantPrintHandlers.js';
import {
    createStripeCheckoutSession,
    isStripeConfigured,
    resolveStripeConfig,
    retrieveStripeCheckoutSession,
    retrieveStripeEvent,
} from './stripePayments.js';

export const STOREFRONT_SETTINGS_KEY = 'storefront_settings';
export const STOREFRONT_STATE_KEY = 'storefront_state';
export const STOREFRONT_ORDERS_KEY = 'storefront_orders';

const MAX_ORDER_HISTORY = 500;
const QUOTE_TOKEN_TTL_MS = 45 * 60 * 1000;
export const STOREFRONT_MATERIALS = ['PLA', 'PETG', 'ABS', 'ASA', 'TPU'];

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function normalizeString(value, maxLength = 200) {
    return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : null;
}

function positiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function normalizeStorefrontSettings(settings) {
    const source = isPlainObject(settings) ? settings : {};
    const stripe = isPlainObject(source.stripe) ? source.stripe : {};
    return {
        enabled: source.enabled !== false,
        currency: (normalizeString(source.currency, 3) || 'USD').toUpperCase(),
        flat_shipping_cents: nonNegativeInt(source.flat_shipping_cents, 800),
        markup_pct: Math.max(0, Math.min(Number(source.markup_pct) || 0, 200)),
        min_order_cents: nonNegativeInt(source.min_order_cents, 500),
        max_quantity: Math.max(1, Math.min(positiveInt(source.max_quantity, 10), 50)),
        // Accept orders without payment (invoice/pay-on-pickup workflows, and
        // the MOCK_MODE demo loop). Off by default: no silent free prints.
        allow_unpaid_orders: source.allow_unpaid_orders === true,
        materials: asArray(source.materials).map((m) => String(m).toUpperCase()).filter(Boolean).length > 0
            ? asArray(source.materials).map((m) => String(m).toUpperCase())
            : [...STOREFRONT_MATERIALS],
        stripe: {
            secret_key: normalizeString(stripe.secret_key, 200),
            webhook_secret: normalizeString(stripe.webhook_secret, 200),
            mock: stripe.mock === true,
        },
    };
}

export function redactStorefrontSettings(settings) {
    const normalized = normalizeStorefrontSettings(settings);
    return {
        ...normalized,
        stripe: {
            configured: isStripeConfigured(normalized),
            mock: resolveStripeConfig(normalized).mock,
            secret_key_set: Boolean(normalized.stripe.secret_key || process.env.STRIPE_SECRET_KEY),
            webhook_secret_set: Boolean(normalized.stripe.webhook_secret || process.env.STRIPE_WEBHOOK_SECRET),
        },
    };
}

// The storefront prints under a platform-owned merchant so every existing
// pipeline (routing, slicing, dispatch, telemetry, webhooks) applies as-is.
export async function ensureStorefrontIdentity(store) {
    const state = await store.getPlatformSetting(STOREFRONT_STATE_KEY, null) || {};
    if (state.merchant_id && state.org_id && state.quote_secret) return state;

    const next = { ...state };
    if (!next.org_id || !next.merchant_id) {
        const organization = await store.createOrganization({ name: 'Public Storefront' });
        const merchant = await store.createMerchant({
            org_id: organization.org_id,
            company_name: 'Walk-in Storefront',
            contact_email: 'storefront@printkinetix.local',
            contact_name: 'Storefront Checkout',
            status: 'active',
            approval_mode: 'full_auto',
            approved_at: new Date().toISOString(),
            metadata: { signup_source: 'storefront_builtin' },
        });
        next.org_id = organization.org_id;
        next.merchant_id = merchant.merchant_id;
    }
    if (!next.quote_secret) next.quote_secret = crypto.randomBytes(32).toString('hex');
    await store.upsertPlatformSetting(STOREFRONT_STATE_KEY, next);
    return next;
}

// ---------------------------------------------------------------------------
// Finishing touches (the /order 3D-viewer panel) — every option maps to a
// real effect: scale reprices by volume (scale³) and rides to the slicer;
// color becomes a routing requirement so the job lands on a printer with
// that filament loaded; strength/quality change the material estimate,
// machine time, and the slicer settings used on the node.
// ---------------------------------------------------------------------------

const INFILL_SOLIDITY = { light: 0.28, standard: 0.35, strong: 0.48 };
const INFILL_PERCENT = { light: 10, standard: 15, strong: 25 };
const QUALITY_TIME_MULTIPLIER = { draft: 0.8, standard: 1, fine: 1.35 };
const QUALITY_LAYER_HEIGHT_MM = { draft: 0.28, standard: 0.2, fine: 0.12 };

function normalizeColorChoice(value) {
    const raw = normalizeString(value, 9);
    if (!raw) return null;
    const hex = raw.replace(/^#/, '').toUpperCase().slice(0, 6);
    return /^[0-9A-F]{6}$/.test(hex) ? `#${hex}` : null;
}

export function normalizeFinishOptions(source) {
    const finish = isPlainObject(source) ? source : {};
    const scale = Number(finish.scale_percent);
    return {
        scale_percent: Number.isFinite(scale) ? Math.round(Math.min(Math.max(scale, 25), 400)) : 100,
        color_hex: normalizeColorChoice(finish.color_hex || finish.color),
        infill: Object.hasOwn(INFILL_SOLIDITY, finish.infill) ? finish.infill : 'standard',
        quality: Object.hasOwn(QUALITY_TIME_MULTIPLIER, finish.quality) ? finish.quality : 'standard',
    };
}

export function finishSolidity(finish) {
    return INFILL_SOLIDITY[finish?.infill] || INFILL_SOLIDITY.standard;
}

// What the farm node's slicer receives for source models (OrcaSlicer CLI).
export function finishSliceSettings(finish) {
    return {
        layer_height_mm: QUALITY_LAYER_HEIGHT_MM[finish?.quality] || QUALITY_LAYER_HEIGHT_MM.standard,
        infill_percent: INFILL_PERCENT[finish?.infill] || INFILL_PERCENT.standard,
        scale_percent: finish?.scale_percent || 100,
    };
}

// ---------------------------------------------------------------------------
// Quote math + tamper-proof quote tokens
// ---------------------------------------------------------------------------

export function computeStorefrontQuote({ settings, analysis, material, quantity, finish = null, now = () => new Date() }) {
    const perPiece = estimatePrintQuote({
        requirements: { material, estimated_grams: analysis.estimated_grams },
        now,
    });
    const qualityMultiplier = QUALITY_TIME_MULTIPLIER[finish?.quality] || 1;
    const machineCents = Math.ceil(perPiece.totals.machine_cents * qualityMultiplier);
    const unitCents = perPiece.totals.material_cents + machineCents;
    const setupCents = perPiece.totals.setup_cents;
    const subtotal = unitCents * quantity + setupCents;
    const markupCents = Math.ceil(subtotal * (settings.markup_pct / 100));
    const preShipping = Math.max(subtotal + markupCents, settings.min_order_cents);
    const totalCents = preShipping + settings.flat_shipping_cents;

    return {
        currency: settings.currency,
        quantity,
        material,
        ...(finish ? { finish } : {}),
        estimates: {
            grams_per_piece: analysis.estimated_grams,
            estimate_basis: analysis.estimate_basis,
            mesh_volume_cm3: analysis.mesh_volume_cm3,
            print_minutes_per_piece: Math.ceil(perPiece.estimates.print_minutes * qualityMultiplier),
        },
        totals: {
            unit_cents: unitCents,
            setup_cents: setupCents,
            subtotal_cents: subtotal,
            markup_cents: markupCents,
            shipping_cents: settings.flat_shipping_cents,
            total_cents: totalCents,
        },
        lead_time: perPiece.lead_time,
    };
}

function quoteTokenPayload({ checksum, material, quantity, totalCents, expiresAtMs }) {
    return `${checksum}|${material}|${quantity}|${totalCents}|${expiresAtMs}`;
}

export function signQuoteToken({ secret, checksum, material, quantity, totalCents, expiresAtMs }) {
    const payload = quoteTokenPayload({ checksum, material, quantity, totalCents, expiresAtMs });
    const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    return `${Buffer.from(payload).toString('base64url')}.${signature}`;
}

export function verifyQuoteToken({ secret, token, checksum, material, quantity, totalCents, nowMs }) {
    if (typeof token !== 'string' || !token.includes('.')) return false;
    const [payloadPart, signature] = token.split('.');
    let payload;
    try {
        payload = Buffer.from(payloadPart, 'base64url').toString('utf8');
    } catch {
        return false;
    }
    const [tokenChecksum, tokenMaterial, tokenQuantity, tokenTotal, tokenExpires] = payload.split('|');
    if (tokenChecksum !== checksum || tokenMaterial !== material) return false;
    if (Number(tokenQuantity) !== quantity || Number(tokenTotal) !== totalCents) return false;
    if (!Number.isFinite(Number(tokenExpires)) || Number(tokenExpires) < nowMs) return false;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
    try {
        return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Order log (platform setting, capped)
// ---------------------------------------------------------------------------

async function loadOrders(store) {
    const state = await store.getPlatformSetting(STOREFRONT_ORDERS_KEY, null);
    return asArray(isPlainObject(state) ? state.orders : []);
}

async function saveOrders(store, orders) {
    await store.upsertPlatformSetting(STOREFRONT_ORDERS_KEY, {
        orders: orders.slice(0, MAX_ORDER_HISTORY),
    });
}

async function updateOrder(store, orderId, mutate) {
    const orders = await loadOrders(store);
    const index = orders.findIndex((order) => order.order_id === orderId);
    if (index === -1) return null;
    orders[index] = mutate({ ...orders[index] }) || orders[index];
    await saveOrders(store, orders);
    return orders[index];
}

function normalizeAddress(source) {
    const address = isPlainObject(source) ? source : {};
    const required = {
        line1: normalizeString(address.line1),
        city: normalizeString(address.city),
        postal_code: normalizeString(address.postal_code, 20),
        country: (normalizeString(address.country, 2) || '').toUpperCase() || null,
    };
    if (Object.values(required).some((value) => !value)) return null;
    return {
        ...required,
        line2: normalizeString(address.line2),
        region: normalizeString(address.region || address.state),
    };
}

function publicOrderView(order, jobs = []) {
    return {
        order_id: order.order_id,
        status: order.status,
        created_at: order.created_at,
        paid_at: order.paid_at || null,
        material: order.material,
        quantity: order.quantity,
        file_name: order.file_name,
        quote: order.quote,
        payment: {
            provider: order.payment?.provider || null,
            status: order.status === 'pending_payment' ? 'awaiting_payment' : (order.paid_at ? 'paid' : order.payment?.status || null),
        },
        shipping_address: order.shipping_address,
        jobs: jobs.map((job) => ({
            job_id: job.job_id,
            status: job.status,
            printer_id: job.printer_id || null,
        })),
    };
}

// Dispatch a PAID order into the merchant print pipeline: one print job per
// ordered piece (capacity parking + heartbeat redispatch handle overflow).
export async function dispatchStorefrontOrder({ store, order, now = () => new Date() }) {
    if (asArray(order.print_job_ids).length > 0) return order; // idempotent (webhook retries)
    const identity = await ensureStorefrontIdentity(store);
    const merchant = { org_id: identity.org_id, merchant_id: identity.merchant_id };
    const finish = normalizeFinishOptions(order.finish);
    const upload = {
        name: `${order.file_name} (storefront ${order.order_id.slice(-6)})`,
        requirements: {
            material: order.material,
            estimated_grams: order.quote?.estimates?.grams_per_piece,
            // The customer's color pick becomes a routing requirement: the job
            // lands on a printer with that filament loaded when one exists.
            ...(finish.color_hex ? { colors: [finish.color_hex] } : {}),
        },
        options: {
            source: 'storefront',
            storefront_order_id: order.order_id,
            finish,
            // Honored by the slicer-capable node for source models.
            slice_settings: finishSliceSettings(finish),
        },
    };
    const jobIds = [];
    for (let piece = 0; piece < order.quantity; piece += 1) {
        const { job } = await routeAndDispatchJobFile({
            store,
            merchant,
            upload,
            file: order.file_record,
            now,
        });
        jobIds.push(job.job_id);
    }
    return {
        ...order,
        status: 'processing',
        print_job_ids: jobIds,
    };
}

export async function markStorefrontOrderPaid({ store, orderId, paymentStatus = 'paid', sessionId = null, now = () => new Date() }) {
    let dispatched = null;
    const updated = await updateOrder(store, orderId, (order) => {
        if (order.paid_at) return order; // already handled
        return {
            ...order,
            status: 'paid',
            paid_at: now().toISOString(),
            payment: { ...(order.payment || {}), status: paymentStatus, session_id: sessionId || order.payment?.session_id || null },
        };
    });
    if (!updated) return null;
    if (asArray(updated.print_job_ids).length === 0) {
        dispatched = await dispatchStorefrontOrder({ store, order: updated, now });
        await updateOrder(store, orderId, () => dispatched);
    }
    return dispatched || updated;
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

function sendJson(res, statusCode, payload) {
    res.statusCode = statusCode;
    if (typeof res.setHeader === 'function') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
    }
    return res.end(JSON.stringify(payload));
}

function parseBody(body) {
    if (isPlainObject(body)) return body;
    if (typeof body === 'string' && body.trim()) {
        try {
            return JSON.parse(body);
        } catch {
            return {};
        }
    }
    return {};
}

function failure(res, error, fallbackCode) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 400;
    return sendJson(res, status, {
        ok: false,
        error: error?.code || fallbackCode,
        message: error?.message || 'Request failed',
    });
}

function requestOrigin(req) {
    const headers = req.headers || {};
    const proto = String(headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
    const host = String(headers['x-forwarded-host'] || headers.host || '').split(',')[0].trim();
    return host ? `${proto}://${host}` : '';
}

async function loadSettings(store) {
    return normalizeStorefrontSettings(await store.getPlatformSetting(STOREFRONT_SETTINGS_KEY, null));
}

function clampQuantity(value, settings) {
    return Math.max(1, Math.min(positiveInt(value, 1), settings.max_quantity));
}

function normalizeMaterialChoice(value, settings) {
    const material = (normalizeString(value, 20) || 'PLA').toUpperCase();
    return settings.materials.includes(material) ? material : settings.materials[0];
}

export function createStorefrontQuoteHandler({ store, now = () => new Date() }) {
    if (!store) throw new Error('store is required');
    return async function storefrontQuoteHandler(req, res) {
        if (req.method && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
        try {
            const settings = await loadSettings(store);
            if (!settings.enabled) return sendJson(res, 503, { ok: false, error: 'storefront_disabled' });

            const body = parseBody(req.body);
            const upload = normalizeUpload(body);
            const material = normalizeMaterialChoice(body.material, settings);
            const quantity = clampQuantity(body.quantity, settings);
            const finish = normalizeFinishOptions(body.finish);

            const analysis = analyzePrintUpload({
                fileName: upload.file.originalName,
                buffer: upload.file.buffer,
                material,
                solidity: finishSolidity(finish),
                scalePercent: finish.scale_percent,
            });
            const quote = computeStorefrontQuote({ settings, analysis, material, quantity, finish, now });
            const identity = await ensureStorefrontIdentity(store);
            const expiresAtMs = now().getTime() + QUOTE_TOKEN_TTL_MS;
            const quoteToken = signQuoteToken({
                secret: identity.quote_secret,
                checksum: upload.file.checksum,
                material,
                quantity,
                totalCents: quote.totals.total_cents,
                expiresAtMs,
            });

            return sendJson(res, 200, {
                ok: true,
                quote,
                quote_token: quoteToken,
                quote_expires_at: new Date(expiresAtMs).toISOString(),
                file: {
                    name: upload.file.originalName,
                    checksum_sha256: upload.file.checksum,
                    byte_size: upload.file.byteSize,
                    file_mode: upload.file.fileMode,
                },
                payments: {
                    configured: isStripeConfigured(settings),
                    unpaid_orders_allowed: settings.allow_unpaid_orders || process.env.MOCK_MODE === 'true',
                },
                materials: settings.materials,
            });
        } catch (error) {
            return failure(res, error, 'storefront_quote_failed');
        }
    };
}

export function createStorefrontCheckoutHandler({ store, now = () => new Date(), fetchImpl = fetch }) {
    if (!store) throw new Error('store is required');
    return async function storefrontCheckoutHandler(req, res) {
        if (req.method && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
        try {
            const settings = await loadSettings(store);
            if (!settings.enabled) return sendJson(res, 503, { ok: false, error: 'storefront_disabled' });

            const body = parseBody(req.body);
            const upload = normalizeUpload(body);
            const material = normalizeMaterialChoice(body.material, settings);
            const quantity = clampQuantity(body.quantity, settings);
            const email = normalizeString(body.email);
            const customerName = normalizeString(body.name || body.customer_name);
            const address = normalizeAddress(body.shipping_address || body.address);
            if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                return sendJson(res, 400, { ok: false, error: 'invalid_email', message: 'A valid email is required' });
            }
            if (!customerName) return sendJson(res, 400, { ok: false, error: 'invalid_name', message: 'Name is required' });
            if (!address) {
                return sendJson(res, 400, { ok: false, error: 'invalid_address', message: 'shipping_address needs line1, city, postal_code, and country' });
            }

            // Server-side price recomputation + HMAC token: the client cannot
            // alter grams, material, quantity, scale, or price between quote
            // and pay (finishing options change the total, which the token binds).
            const finish = normalizeFinishOptions(body.finish);
            const analysis = analyzePrintUpload({
                fileName: upload.file.originalName,
                buffer: upload.file.buffer,
                material,
                solidity: finishSolidity(finish),
                scalePercent: finish.scale_percent,
            });
            const quote = computeStorefrontQuote({ settings, analysis, material, quantity, finish, now });
            const identity = await ensureStorefrontIdentity(store);
            const tokenOk = verifyQuoteToken({
                secret: identity.quote_secret,
                token: body.quote_token,
                checksum: upload.file.checksum,
                material,
                quantity,
                totalCents: quote.totals.total_cents,
                nowMs: now().getTime(),
            });
            if (!tokenOk) {
                return sendJson(res, 409, {
                    ok: false,
                    error: 'quote_expired_or_changed',
                    message: 'The quote is stale or the file/options changed — request a fresh quote.',
                });
            }

            // Persist the artifact + job_files record now; dispatch after payment.
            const merchant = { org_id: identity.org_id, merchant_id: identity.merchant_id };
            const fileRecord = await storeUploadedJobFile({ store, merchant, upload, now });

            const orderId = `sfo_${crypto.randomUUID()}`;
            const accessToken = crypto.randomBytes(16).toString('hex');
            let order = {
                order_id: orderId,
                access_token: accessToken,
                created_at: now().toISOString(),
                status: 'pending_payment',
                email,
                customer_name: customerName,
                shipping_address: address,
                material,
                quantity,
                finish,
                quote,
                file_name: upload.file.originalName,
                checksum_sha256: upload.file.checksum,
                file_record: fileRecord,
                print_job_ids: [],
                payment: { provider: 'stripe', status: 'pending', session_id: null },
            };

            const origin = requestOrigin(req);
            const statusUrl = `${origin}/order?order_id=${orderId}&token=${accessToken}`;
            let checkoutUrl = null;

            if (isStripeConfigured(settings)) {
                const session = await createStripeCheckoutSession({
                    settings,
                    orderId,
                    amountCents: quote.totals.total_cents,
                    currency: settings.currency,
                    productName: `3D print: ${upload.file.originalName} ×${quantity} (${material})`,
                    customerEmail: email,
                    successUrl: `${statusUrl}&paid=1`,
                    cancelUrl: `${statusUrl}&canceled=1`,
                    fetchImpl,
                });
                order.payment.session_id = session.id;
                checkoutUrl = session.url;
                if (session.mock) {
                    // Offline demo loop: no real payment page exists, settle now.
                    order.payment.provider = 'mock';
                }
            } else if (settings.allow_unpaid_orders || process.env.MOCK_MODE === 'true') {
                order.payment = { provider: 'offline', status: 'not_required', session_id: null };
            } else {
                return sendJson(res, 503, {
                    ok: false,
                    error: 'payments_not_configured',
                    message: 'Online payment is not configured yet. Set the Stripe secret key in the operator console (or allow unpaid orders).',
                });
            }

            const orders = await loadOrders(store);
            await saveOrders(store, [order, ...orders]);

            // Settle immediately for mock-Stripe and offline orders.
            if (order.payment.provider === 'mock' || order.payment.provider === 'offline') {
                order = await markStorefrontOrderPaid({
                    store,
                    orderId,
                    paymentStatus: order.payment.provider === 'mock' ? 'paid_mock' : 'not_required',
                    sessionId: order.payment.session_id,
                    now,
                }) || order;
            }

            return sendJson(res, 201, {
                ok: true,
                order_id: orderId,
                order_token: accessToken,
                status: order.status,
                status_url: statusUrl,
                checkout_url: checkoutUrl,
                total_cents: quote.totals.total_cents,
                currency: settings.currency,
            });
        } catch (error) {
            return failure(res, error, 'storefront_checkout_failed');
        }
    };
}

export function createStorefrontOrderStatusHandler({ store }) {
    if (!store) throw new Error('store is required');
    return async function storefrontOrderStatusHandler(req, res) {
        if (req.method && req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
        try {
            const query = req.query || {};
            const orderId = normalizeString(query.order_id);
            const token = normalizeString(query.token);
            if (!orderId || !token) return sendJson(res, 400, { ok: false, error: 'order_id_and_token_required' });

            const orders = await loadOrders(store);
            const order = orders.find((entry) => entry.order_id === orderId);
            const tokenMatches = order && crypto.timingSafeEqual(
                Buffer.from(String(order.access_token || '').padEnd(64, '0')),
                Buffer.from(String(token).padEnd(64, '0')),
            );
            if (!order || !tokenMatches) return sendJson(res, 404, { ok: false, error: 'order_not_found' });

            const jobs = [];
            for (const jobId of asArray(order.print_job_ids)) {
                try {
                    const job = typeof store.getPrintJobById === 'function' ? await store.getPrintJobById(jobId) : null;
                    if (job) jobs.push(job);
                } catch { /* job lookups are best-effort for the status page */ }
            }
            return sendJson(res, 200, { ok: true, order: publicOrderView(order, jobs) });
        } catch (error) {
            return failure(res, error, 'storefront_status_failed');
        }
    };
}

// Stripe webhook: the delivered payload is only a hint — the event is
// re-fetched from Stripe by id with our secret key before any state changes
// (see stripePayments.js for why). Mock sessions settle at checkout, so a
// mock webhook is a no-op.
export function createStorefrontStripeWebhookHandler({ store, now = () => new Date(), fetchImpl = fetch }) {
    if (!store) throw new Error('store is required');
    return async function storefrontStripeWebhookHandler(req, res) {
        if (req.method && req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
        try {
            const settings = await loadSettings(store);
            const hint = parseBody(req.body);
            const eventId = normalizeString(hint.id);
            const hintType = normalizeString(hint.type, 100) || '';
            if (!eventId || !hintType.startsWith('checkout.session.')) {
                return sendJson(res, 200, { ok: true, received: true, ignored: true });
            }

            const stripeConfig = resolveStripeConfig(settings);
            let event = hint;
            if (!stripeConfig.mock) {
                event = await retrieveStripeEvent({ settings, eventId, fetchImpl });
            }
            const session = event?.data?.object || {};
            const orderId = normalizeString(session?.metadata?.storefront_order_id);
            if (!orderId) return sendJson(res, 200, { ok: true, received: true, ignored: true });

            if (event.type === 'checkout.session.completed' && (session.payment_status === 'paid' || stripeConfig.mock)) {
                await markStorefrontOrderPaid({ store, orderId, paymentStatus: 'paid', sessionId: session.id, now });
            } else if (event.type === 'checkout.session.expired') {
                await updateOrder(store, orderId, (order) => (
                    order.paid_at ? order : { ...order, status: 'payment_expired' }
                ));
            }
            return sendJson(res, 200, { ok: true, received: true });
        } catch (error) {
            // Non-2xx makes Stripe retry — do that only for transient errors.
            return sendJson(res, 500, { ok: false, error: 'webhook_processing_failed', message: error.message });
        }
    };
}

// ---------------------------------------------------------------------------
// Recovery sweep — runs from the heartbeat path so orders stranded in
// Supabase are picked up automatically:
//   • pending_payment orders whose Stripe webhook never arrived: ask Stripe
//     for the session's real state (paid → settle + dispatch; expired →
//     mark expired). The delivered webhook was always just a hint anyway.
//   • paid/processing orders with zero print jobs (dispatch crashed between
//     payment and job creation): dispatch now (idempotent).
// Bounded per pass and internally throttled; never throws.
// ---------------------------------------------------------------------------
const SWEEP_MIN_INTERVAL_MS = 5 * 60 * 1000;
const SWEEP_MAX_STRIPE_LOOKUPS = 8;
export const STOREFRONT_SWEEP_STATE_KEY = 'storefront_sweep_state';

export async function sweepStorefrontOrders({ store, now = () => new Date(), fetchImpl = fetch, force = false } = {}) {
    if (typeof store?.getPlatformSetting !== 'function' || typeof store?.upsertPlatformSetting !== 'function') {
        return { skipped: 'store_unsupported', settled: 0, dispatched: 0, expired: 0 };
    }
    const orders = await loadOrders(store);
    if (orders.length === 0) return { skipped: 'no_orders', settled: 0, dispatched: 0, expired: 0 };

    const nowMs = now().getTime();
    // Throttle state lives in its own key: order writes must not reset it.
    const sweepState = await store.getPlatformSetting(STOREFRONT_SWEEP_STATE_KEY, null) || {};
    const lastSweptMs = sweepState.last_swept_at ? new Date(sweepState.last_swept_at).getTime() : null;
    if (!force && Number.isFinite(lastSweptMs) && nowMs - lastSweptMs < SWEEP_MIN_INTERVAL_MS) {
        return { skipped: 'recently_swept', settled: 0, dispatched: 0, expired: 0 };
    }
    await store.upsertPlatformSetting(STOREFRONT_SWEEP_STATE_KEY, { last_swept_at: now().toISOString() });

    const settings = await loadSettings(store);
    const stripeConfig = resolveStripeConfig(settings);
    let settled = 0;
    let dispatched = 0;
    let expired = 0;

    // 1) Paid but never dispatched (crash between payment and job creation).
    for (const order of orders) {
        if ((order.status === 'paid' || order.status === 'processing') && asArray(order.print_job_ids).length === 0) {
            try {
                const updated = await markStorefrontOrderPaid({ store, orderId: order.order_id, now });
                if (asArray(updated?.print_job_ids).length > 0) dispatched += 1;
            } catch { /* keep sweeping */ }
        }
    }

    // 2) Awaiting a webhook that may never have arrived: ask Stripe directly.
    if (stripeConfig.secret_key && !stripeConfig.mock) {
        const pending = orders
            .filter((order) => order.status === 'pending_payment' && order.payment?.session_id)
            .slice(0, SWEEP_MAX_STRIPE_LOOKUPS);
        for (const order of pending) {
            try {
                const session = await retrieveStripeCheckoutSession({
                    settings,
                    sessionId: order.payment.session_id,
                    fetchImpl,
                });
                if (session.payment_status === 'paid') {
                    await markStorefrontOrderPaid({ store, orderId: order.order_id, sessionId: session.id, now });
                    settled += 1;
                } else if (session.status === 'expired') {
                    await updateOrder(store, order.order_id, (entry) => (
                        entry.paid_at ? entry : { ...entry, status: 'payment_expired' }
                    ));
                    expired += 1;
                }
            } catch { /* Stripe hiccups: next sweep retries */ }
        }
    }

    return { settled, dispatched, expired };
}

// Admin surface: GET settings + recent orders, PATCH settings (Stripe secrets
// write-only). Mounted behind the same admin auth as every /api/cloud route.
export function createStorefrontAdminOverview({ store, now = () => new Date() }) {
    return {
        async getOverview() {
            const [settings, orders] = await Promise.all([
                store.getPlatformSetting(STOREFRONT_SETTINGS_KEY, null),
                loadOrders(store),
            ]);
            return {
                settings: redactStorefrontSettings(settings),
                orders: orders.map((order) => {
                    const { access_token: _token, file_record: _file, ...rest } = order;
                    return rest;
                }),
                generated_at: now().toISOString(),
            };
        },
        async patchSettings(incoming) {
            const current = normalizeStorefrontSettings(await store.getPlatformSetting(STOREFRONT_SETTINGS_KEY, null));
            const patch = isPlainObject(incoming) ? incoming : {};
            const incomingStripe = isPlainObject(patch.stripe) ? patch.stripe : {};
            const keepUnlessProvided = (nextValue, currentValue) => (
                typeof nextValue === 'string' && nextValue.trim() ? nextValue.trim() : currentValue
            );
            const next = normalizeStorefrontSettings({
                ...current,
                ...patch,
                stripe: {
                    secret_key: keepUnlessProvided(incomingStripe.secret_key, current.stripe.secret_key),
                    webhook_secret: keepUnlessProvided(incomingStripe.webhook_secret, current.stripe.webhook_secret),
                    mock: incomingStripe.mock === undefined ? current.stripe.mock : incomingStripe.mock === true,
                },
            });
            await store.upsertPlatformSetting(STOREFRONT_SETTINGS_KEY, next);
            return redactStorefrontSettings(next);
        },
    };
}
