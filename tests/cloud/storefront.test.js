import AdmZip from 'adm-zip';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryCloudStore } from '../../src/cloud/memoryCloudStore.js';
import {
    analyzePrintUpload,
    computeStlVolumeCm3,
    extractSlicedFilamentGrams,
} from '../../src/cloud/modelAnalysis.js';
import { toStripeForm, verifyStripeSignature } from '../../src/cloud/stripePayments.js';
import {
    computeStorefrontQuote,
    createStorefrontCancelHandler,
    createStorefrontCheckoutHandler,
    createStorefrontOrderStatusHandler,
    createStorefrontQuoteHandler,
    createStorefrontStripeWebhookHandler,
    ensureStorefrontIdentity,
    normalizeStorefrontSettings,
    redactStorefrontSettings,
    signQuoteToken,
    STOREFRONT_ORDERS_KEY,
    STOREFRONT_SETTINGS_KEY,
    sweepStorefrontOrders,
    verifyQuoteToken,
} from '../../src/cloud/storefrontHandlers.js';
import { createCloudStorefrontHandler } from '../../src/cloud/adminHandlers.js';
import crypto from 'node:crypto';

const NOW = () => new Date('2026-07-08T12:00:00.000Z');

// ---------------------------------------------------------------- fixtures

// Binary STL of a closed axis-aligned box (12 triangles), exact volume.
function buildBoxStl(x = 10, y = 10, z = 10) {
    const vertices = [
        [0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0],
        [0, 0, z], [x, 0, z], [x, y, z], [0, y, z],
    ];
    // Outward-wound faces of a cuboid.
    const faces = [
        [0, 2, 1], [0, 3, 2],   // bottom
        [4, 5, 6], [4, 6, 7],   // top
        [0, 1, 5], [0, 5, 4],   // front
        [1, 2, 6], [1, 6, 5],   // right
        [2, 3, 7], [2, 7, 6],   // back
        [3, 0, 4], [3, 4, 7],   // left
    ];
    const buffer = Buffer.alloc(84 + faces.length * 50);
    buffer.write('PrintKinetix box fixture', 0, 'ascii');
    buffer.writeUInt32LE(faces.length, 80);
    let offset = 84;
    for (const face of faces) {
        offset += 12; // normal (zeros are fine)
        for (const vertexIndex of face) {
            const [vx, vy, vz] = vertices[vertexIndex];
            buffer.writeFloatLE(vx, offset);
            buffer.writeFloatLE(vy, offset + 4);
            buffer.writeFloatLE(vz, offset + 8);
            offset += 12;
        }
        offset += 2; // attribute byte count
    }
    return buffer;
}

function buildSlicedThreeMf(grams = 42.5) {
    const zip = new AdmZip();
    zip.addFile('Metadata/plate_1.gcode', Buffer.from(
        `; HEADER_BLOCK_START\n; total filament used [g] : ${grams}\n; HEADER_BLOCK_END\nG28\n`,
    ));
    return zip.toBuffer();
}

function makeRes() {
    return {
        statusCode: 0,
        headers: {},
        body: null,
        setHeader(name, value) { this.headers[name] = value; },
        end(payload) { this.body = payload ? JSON.parse(payload) : null; return this; },
    };
}

async function invoke(handler, req) {
    const res = makeRes();
    await handler(req, res);
    return res;
}

function post(body, headers = {}) {
    return { method: 'POST', body, headers: { host: 'farm.example.com', 'x-forwarded-proto': 'https', ...headers }, query: {} };
}

const BOX_STL = buildBoxStl(20, 20, 20); // 8 cm³
const SLICED_3MF = buildSlicedThreeMf(42.5);

function quoteBody(overrides = {}) {
    return {
        file: { name: 'bracket.stl', base64: BOX_STL.toString('base64') },
        material: 'PLA',
        quantity: 2,
        ...overrides,
    };
}

function shippingFields() {
    return {
        email: 'maker@example.com',
        name: 'Casey Maker',
        shipping_address: {
            line1: '1 Print Lane',
            city: 'Austin',
            region: 'TX',
            postal_code: '78701',
            country: 'us',
        },
    };
}

async function seedSettings(store, settings = {}) {
    await store.upsertPlatformSetting(STOREFRONT_SETTINGS_KEY, settings);
}

// ------------------------------------------------------------------- tests

describe('model analysis', () => {
    it('computes exact mesh volume for a binary STL box', () => {
        expect(computeStlVolumeCm3(buildBoxStl(10, 10, 10))).toBeCloseTo(1, 5);   // 1 cm³
        expect(computeStlVolumeCm3(BOX_STL)).toBeCloseTo(8, 5);                    // 20mm cube
    });

    it('parses ASCII STL as well', () => {
        const ascii = [
            'solid tetra',
            ...[[0, 0, 0], [10, 0, 0], [0, 10, 0]].map((v) => `vertex ${v.join(' ')}`),
            ...[[0, 0, 0], [0, 10, 0], [0, 0, 10]].map((v) => `vertex ${v.join(' ')}`),
            ...[[0, 0, 0], [0, 0, 10], [10, 0, 0]].map((v) => `vertex ${v.join(' ')}`),
            ...[[10, 0, 0], [0, 0, 10], [0, 10, 0]].map((v) => `vertex ${v.join(' ')}`),
            'endsolid tetra',
        ].join('\n');
        // Tetrahedron volume = (10*10*10)/6 mm³ ≈ 0.1667 cm³
        expect(computeStlVolumeCm3(Buffer.from(ascii))).toBeCloseTo(1000 / 6 / 1000, 4);
    });

    it('reads exact grams from sliced .gcode.3mf and .gcode headers', () => {
        expect(extractSlicedFilamentGrams({ fileName: 'part.gcode.3mf', buffer: SLICED_3MF })).toBeCloseTo(42.5);
        const gcode = Buffer.from('; filament used [g] = 12.30,2.20\nG28\n');
        expect(extractSlicedFilamentGrams({ fileName: 'part.gcode', buffer: gcode })).toBeCloseTo(14.5);
    });

    it('prefers slicer grams, then mesh volume, then the labeled size heuristic', () => {
        const sliced = analyzePrintUpload({ fileName: 'p.gcode.3mf', buffer: SLICED_3MF, material: 'PLA' });
        expect(sliced).toMatchObject({ estimated_grams: 43, estimate_basis: 'slicer_metadata' });

        const mesh = analyzePrintUpload({ fileName: 'p.stl', buffer: BOX_STL, material: 'PLA' });
        // 8 cm³ × 1.24 g/cm³ × 0.35 solidity = 3.47g → min clamp 5g
        expect(mesh).toMatchObject({ estimated_grams: 5, estimate_basis: 'mesh_volume', mesh_volume_cm3: 8 });

        const step = analyzePrintUpload({ fileName: 'p.step', buffer: Buffer.alloc(2_000_000), material: 'PLA' });
        expect(step.estimate_basis).toBe('file_size_heuristic');
        expect(step.estimated_grams).toBe(40);
    });
});

describe('quote pricing + tamper-proof tokens', () => {
    it('prices quantity, markup, minimum, and shipping', () => {
        const settings = normalizeStorefrontSettings({ markup_pct: 10, flat_shipping_cents: 900 });
        const quote = computeStorefrontQuote({
            settings,
            analysis: { estimated_grams: 100, estimate_basis: 'mesh_volume', mesh_volume_cm3: 80 },
            material: 'PLA',
            quantity: 3,
            now: NOW,
        });
        // per piece: material 100g*8 = 800, machine ceil((min 30, 100*1.5+0=150)/60*250)=625 → unit 1425
        expect(quote.totals.unit_cents).toBe(1425);
        expect(quote.totals.subtotal_cents).toBe(1425 * 3 + 400);
        expect(quote.totals.markup_cents).toBe(Math.ceil((1425 * 3 + 400) * 0.10));
        expect(quote.totals.total_cents).toBe(quote.totals.subtotal_cents + quote.totals.markup_cents + 900);
    });

    it('quote tokens verify only for the same file/material/quantity/price and expiry', () => {
        const secret = 'sekrit';
        const base = { secret, checksum: 'abc', material: 'PLA', quantity: 2, totalCents: 1234 };
        const token = signQuoteToken({ ...base, expiresAtMs: NOW().getTime() + 1000 });
        expect(verifyQuoteToken({ ...base, token, nowMs: NOW().getTime() })).toBe(true);
        expect(verifyQuoteToken({ ...base, token, totalCents: 999, nowMs: NOW().getTime() })).toBe(false);
        expect(verifyQuoteToken({ ...base, token, material: 'ABS', nowMs: NOW().getTime() })).toBe(false);
        expect(verifyQuoteToken({ ...base, token, nowMs: NOW().getTime() + 5000 })).toBe(false); // expired
    });
});

describe('storefront funnel over handlers', () => {
    it('quotes an STL and returns a signed token + payment availability', async () => {
        const store = createMemoryCloudStore();
        const handler = createStorefrontQuoteHandler({ store, now: NOW });
        const res = await invoke(handler, post(quoteBody()));

        expect(res.statusCode).toBe(200);
        expect(res.body.quote.totals.total_cents).toBeGreaterThan(0);
        expect(res.body.quote.estimates.estimate_basis).toBe('mesh_volume');
        expect(res.body.quote_token).toContain('.');
        expect(res.body.file.file_mode).toBe('source_model');
        expect(res.body.payments.configured).toBe(false);
    });

    it('checkout without payments configured is refused unless unpaid orders are allowed', async () => {
        const store = createMemoryCloudStore();
        const quoteRes = await invoke(createStorefrontQuoteHandler({ store, now: NOW }), post(quoteBody()));
        const checkout = createStorefrontCheckoutHandler({ store, now: NOW });

        const refused = await invoke(checkout, post({
            ...quoteBody(),
            ...shippingFields(),
            quote_token: quoteRes.body.quote_token,
        }));
        expect(refused.statusCode).toBe(503);
        expect(refused.body.error).toBe('payments_not_configured');
    });

    it('full offline order: checkout -> paid -> print jobs -> status page', async () => {
        const store = createMemoryCloudStore();
        await seedSettings(store, { allow_unpaid_orders: true });
        const quoteRes = await invoke(createStorefrontQuoteHandler({ store, now: NOW }), post(quoteBody()));

        const checkoutRes = await invoke(createStorefrontCheckoutHandler({ store, now: NOW }), post({
            ...quoteBody(),
            ...shippingFields(),
            quote_token: quoteRes.body.quote_token,
        }));
        expect(checkoutRes.statusCode).toBe(201);
        expect(checkoutRes.body.status).toBe('processing'); // settled + dispatched immediately
        expect(checkoutRes.body.status_url).toContain('https://farm.example.com/order?order_id=');

        // One print job per ordered piece rides the REAL merchant pipeline.
        const state = await store.getPlatformSetting(STOREFRONT_ORDERS_KEY, null);
        expect(state.orders[0].print_job_ids).toHaveLength(2);
        const job = await store.getPrintJobById(state.orders[0].print_job_ids[0]);
        expect(job.status).toBe('waiting_for_capacity'); // no printers online in this test farm
        expect(job.options.storefront_order_id).toBe(checkoutRes.body.order_id);

        // Status page: right token sees everything, wrong token sees nothing.
        const statusHandler = createStorefrontOrderStatusHandler({ store });
        const ok = await invoke(statusHandler, {
            method: 'GET',
            headers: {},
            query: { order_id: checkoutRes.body.order_id, token: checkoutRes.body.order_token },
        });
        expect(ok.statusCode).toBe(200);
        expect(ok.body.order.jobs).toHaveLength(2);
        expect(ok.body.order.shipping_address.country).toBe('US');
        expect(JSON.stringify(ok.body)).not.toContain('access_token');

        const bad = await invoke(statusHandler, {
            method: 'GET',
            headers: {},
            query: { order_id: checkoutRes.body.order_id, token: 'wrong' },
        });
        expect(bad.statusCode).toBe(404);
    });

    it('rejects checkout when the quote token does not match the recomputed price', async () => {
        const store = createMemoryCloudStore();
        await seedSettings(store, { allow_unpaid_orders: true });
        const quoteRes = await invoke(createStorefrontQuoteHandler({ store, now: NOW }), post(quoteBody()));

        const tampered = await invoke(createStorefrontCheckoutHandler({ store, now: NOW }), post({
            ...quoteBody({ quantity: 9 }), // more pieces than were quoted
            ...shippingFields(),
            quote_token: quoteRes.body.quote_token,
        }));
        expect(tampered.statusCode).toBe(409);
        expect(tampered.body.error).toBe('quote_expired_or_changed');
    });

    it('validates contact + address before taking money', async () => {
        const store = createMemoryCloudStore();
        await seedSettings(store, { allow_unpaid_orders: true });
        const quoteRes = await invoke(createStorefrontQuoteHandler({ store, now: NOW }), post(quoteBody()));
        const checkout = createStorefrontCheckoutHandler({ store, now: NOW });

        const noEmail = await invoke(checkout, post({
            ...quoteBody(), ...shippingFields(), email: 'nope', quote_token: quoteRes.body.quote_token,
        }));
        expect(noEmail.body.error).toBe('invalid_email');

        const noAddress = await invoke(checkout, post({
            ...quoteBody(), ...shippingFields(), shipping_address: { line1: 'x' }, quote_token: quoteRes.body.quote_token,
        }));
        expect(noAddress.body.error).toBe('invalid_address');
    });

    it('Stripe path: pending order + hosted checkout, webhook settles and dispatches', async () => {
        const store = createMemoryCloudStore();
        await seedSettings(store, { stripe: { secret_key: 'sk_test_x' } });
        const fetchImpl = vi.fn(async (url, options) => {
            if (String(url).includes('/v1/checkout/sessions')) {
                const form = new URLSearchParams(options.body);
                return {
                    ok: true, status: 200,
                    text: async () => JSON.stringify({
                        id: 'cs_live_123',
                        url: 'https://checkout.stripe.com/pay/cs_live_123',
                        metadata: { storefront_order_id: form.get('metadata[storefront_order_id]') },
                    }),
                };
            }
            if (String(url).includes('/v1/events/evt_1')) {
                return {
                    ok: true, status: 200,
                    text: async () => JSON.stringify({
                        id: 'evt_1',
                        type: 'checkout.session.completed',
                        data: { object: { id: 'cs_live_123', payment_status: 'paid', metadata: { storefront_order_id: orderId } } },
                    }),
                };
            }
            throw new Error(`unexpected fetch ${url}`);
        });

        const quoteRes = await invoke(createStorefrontQuoteHandler({ store, now: NOW }), post(quoteBody()));
        const checkoutRes = await invoke(createStorefrontCheckoutHandler({ store, now: NOW, fetchImpl }), post({
            ...quoteBody(), ...shippingFields(), quote_token: quoteRes.body.quote_token,
        }));
        const orderId = checkoutRes.body.order_id;

        expect(checkoutRes.statusCode).toBe(201);
        expect(checkoutRes.body.status).toBe('pending_payment');
        expect(checkoutRes.body.checkout_url).toBe('https://checkout.stripe.com/pay/cs_live_123');
        let state = await store.getPlatformSetting(STOREFRONT_ORDERS_KEY, null);
        expect(state.orders[0].print_job_ids).toHaveLength(0); // nothing prints before payment

        // Webhook is only a hint: the handler re-fetches evt_1 from Stripe.
        const webhook = createStorefrontStripeWebhookHandler({ store, now: NOW, fetchImpl });
        const hook = await invoke(webhook, post({
            id: 'evt_1',
            type: 'checkout.session.completed',
            data: { object: { id: 'cs_live_123', metadata: { storefront_order_id: orderId } } },
        }));
        expect(hook.statusCode).toBe(200);

        state = await store.getPlatformSetting(STOREFRONT_ORDERS_KEY, null);
        expect(state.orders[0].status).toBe('processing');
        expect(state.orders[0].print_job_ids).toHaveLength(2);

        // Webhook replays stay idempotent — no duplicate jobs.
        await invoke(webhook, post({
            id: 'evt_1', type: 'checkout.session.completed',
            data: { object: { id: 'cs_live_123', metadata: { storefront_order_id: orderId } } },
        }));
        state = await store.getPlatformSetting(STOREFRONT_ORDERS_KEY, null);
        expect(state.orders[0].print_job_ids).toHaveLength(2);
    });

    it('provisions the house merchant once and reuses it', async () => {
        const store = createMemoryCloudStore();
        const first = await ensureStorefrontIdentity(store);
        const second = await ensureStorefrontIdentity(store);
        expect(first.merchant_id).toBe(second.merchant_id);
        expect(first.quote_secret).toBe(second.quote_secret);
        const merchants = await store.listMerchants({});
        expect(merchants.filter((m) => m.company_name === 'Walk-in Storefront')).toHaveLength(1);
    });
});

describe('finishing touches (3D viewer panel)', () => {
    it('scale reprices by volume: 200% = 8x the material grams', () => {
        const at100 = analyzePrintUpload({ fileName: 'p.stl', buffer: buildBoxStl(30, 30, 30), material: 'PLA', scalePercent: 100 });
        const at200 = analyzePrintUpload({ fileName: 'p.stl', buffer: buildBoxStl(30, 30, 30), material: 'PLA', scalePercent: 200 });
        expect(at100.mesh_volume_cm3).toBeCloseTo(27, 3);
        expect(at200.mesh_volume_cm3).toBeCloseTo(216, 3);
        expect(at200.estimated_grams).toBeGreaterThan(at100.estimated_grams * 7); // ceil rounding
        expect(at200.scaled).toBe(true);
        // Sliced files are geometry-frozen: scale is ignored.
        const sliced = analyzePrintUpload({ fileName: 'p.gcode.3mf', buffer: SLICED_3MF, scalePercent: 200 });
        expect(sliced.estimated_grams).toBe(43);
        expect(sliced.scaled).toBe(false);
    });

    it('strength changes solidity and quality changes machine time', async () => {
        const store = createMemoryCloudStore();
        const quoteHandler = createStorefrontQuoteHandler({ store, now: NOW });
        const bigBox = buildBoxStl(60, 60, 60); // big enough to clear the min-grams clamp
        const request = (finish) => post({
            file: { name: 'part.stl', base64: bigBox.toString('base64') },
            material: 'PLA',
            quantity: 1,
            finish,
        });

        const standard = (await invoke(quoteHandler, request({}))).body;
        const strong = (await invoke(quoteHandler, request({ infill: 'strong' }))).body;
        const fine = (await invoke(quoteHandler, request({ quality: 'fine' }))).body;

        expect(strong.quote.estimates.grams_per_piece).toBeGreaterThan(standard.quote.estimates.grams_per_piece);
        expect(fine.quote.totals.total_cents).toBeGreaterThan(standard.quote.totals.total_cents);
        expect(fine.quote.estimates.print_minutes_per_piece).toBeGreaterThan(standard.quote.estimates.print_minutes_per_piece);
        expect(standard.quote.finish).toMatchObject({ scale_percent: 100, infill: 'standard', quality: 'standard' });
    });

    it('finish rides the paid order into routing requirements and slicer settings', async () => {
        const store = createMemoryCloudStore();
        await seedSettings(store, { allow_unpaid_orders: true });
        const finish = { scale_percent: 150, color_hex: '#1976D2', infill: 'strong', quality: 'fine' };
        const body = { ...quoteBody({ quantity: 1 }), finish };
        const quoteRes = await invoke(createStorefrontQuoteHandler({ store, now: NOW }), post(body));

        const checkoutRes = await invoke(createStorefrontCheckoutHandler({ store, now: NOW }), post({
            ...body, ...shippingFields(), quote_token: quoteRes.body.quote_token,
        }));
        expect(checkoutRes.statusCode).toBe(201);

        const state = await store.getPlatformSetting(STOREFRONT_ORDERS_KEY, null);
        const job = await store.getPrintJobById(state.orders[0].print_job_ids[0]);
        expect(job.options.finish).toMatchObject(finish);
        expect(job.options.slice_settings).toEqual({
            layer_height_mm: 0.12,
            infill_percent: 25,
            scale_percent: 150,
        });
        expect(job.routing_summary).toBeTruthy(); // went through the real router
    });

    it('changing finish between quote and checkout invalidates the price token', async () => {
        const store = createMemoryCloudStore();
        await seedSettings(store, { allow_unpaid_orders: true });
        const quoted = await invoke(createStorefrontQuoteHandler({ store, now: NOW }), post({
            ...quoteBody(), finish: { scale_percent: 100 },
        }));
        const sneaky = await invoke(createStorefrontCheckoutHandler({ store, now: NOW }), post({
            ...quoteBody(), finish: { scale_percent: 300 }, ...shippingFields(),
            quote_token: quoted.body.quote_token,
        }));
        expect(sneaky.statusCode).toBe(409);
        expect(sneaky.body.error).toBe('quote_expired_or_changed');
    });
});

describe('storefront recovery sweep (heartbeat path)', () => {
    async function checkoutPendingStripeOrder(store) {
        await seedSettings(store, { stripe: { secret_key: 'sk_test_x' } });
        const fetchImpl = vi.fn(async (url, options) => {
            if (String(url).includes('/v1/checkout/sessions')) {
                const form = new URLSearchParams(options.body);
                return {
                    ok: true, status: 200,
                    text: async () => JSON.stringify({
                        id: 'cs_live_777',
                        url: 'https://checkout.stripe.com/pay/cs_live_777',
                        metadata: { storefront_order_id: form.get('metadata[storefront_order_id]') },
                    }),
                };
            }
            throw new Error(`unexpected fetch ${url}`);
        });
        const quoteRes = await invoke(createStorefrontQuoteHandler({ store, now: NOW }), post(quoteBody()));
        const checkoutRes = await invoke(createStorefrontCheckoutHandler({ store, now: NOW, fetchImpl }), post({
            ...quoteBody(), ...shippingFields(), quote_token: quoteRes.body.quote_token,
        }));
        expect(checkoutRes.body.status).toBe('pending_payment');
        return checkoutRes.body.order_id;
    }

    it('recovers a paid order whose webhook never arrived by asking Stripe directly', async () => {
        const store = createMemoryCloudStore();
        const orderId = await checkoutPendingStripeOrder(store);

        const sweepFetch = vi.fn(async (url) => {
            if (String(url).includes('/v1/checkout/sessions/cs_live_777')) {
                return {
                    ok: true, status: 200,
                    text: async () => JSON.stringify({
                        id: 'cs_live_777', status: 'complete', payment_status: 'paid',
                        metadata: { storefront_order_id: orderId },
                    }),
                };
            }
            throw new Error(`unexpected fetch ${url}`);
        });
        const result = await sweepStorefrontOrders({ store, now: NOW, fetchImpl: sweepFetch, force: true });

        expect(result.settled).toBe(1);
        const state = await store.getPlatformSetting(STOREFRONT_ORDERS_KEY, null);
        expect(state.orders[0].status).toBe('processing');
        expect(state.orders[0].print_job_ids).toHaveLength(2);
    });

    it('marks orders with expired Stripe sessions as payment_expired', async () => {
        const store = createMemoryCloudStore();
        await checkoutPendingStripeOrder(store);
        const sweepFetch = vi.fn(async () => ({
            ok: true, status: 200,
            text: async () => JSON.stringify({ id: 'cs_live_777', status: 'expired', payment_status: 'unpaid' }),
        }));
        const result = await sweepStorefrontOrders({ store, now: NOW, fetchImpl: sweepFetch, force: true });
        expect(result.expired).toBe(1);
        const state = await store.getPlatformSetting(STOREFRONT_ORDERS_KEY, null);
        expect(state.orders[0].status).toBe('payment_expired');
    });

    it('re-dispatches a paid order whose job creation crashed', async () => {
        const store = createMemoryCloudStore();
        await seedSettings(store, { allow_unpaid_orders: true });
        const quoteRes = await invoke(createStorefrontQuoteHandler({ store, now: NOW }), post(quoteBody()));
        await invoke(createStorefrontCheckoutHandler({ store, now: NOW }), post({
            ...quoteBody(), ...shippingFields(), quote_token: quoteRes.body.quote_token,
        }));
        // Simulate the crash: order paid, but its jobs were never created.
        const state = await store.getPlatformSetting(STOREFRONT_ORDERS_KEY, null);
        state.orders[0].status = 'paid';
        state.orders[0].print_job_ids = [];
        await store.upsertPlatformSetting(STOREFRONT_ORDERS_KEY, state);

        const result = await sweepStorefrontOrders({ store, now: NOW, force: true });
        expect(result.dispatched).toBe(1);
        const after = await store.getPlatformSetting(STOREFRONT_ORDERS_KEY, null);
        expect(after.orders[0].status).toBe('processing');
        expect(after.orders[0].print_job_ids).toHaveLength(2);
    });

    it('ships a fully-printed order: label bought, tracking emailed, status shipped', async () => {
        const store = createMemoryCloudStore();
        await seedSettings(store, { allow_unpaid_orders: true, shipping: { mock: true } });
        const quoteRes = await invoke(createStorefrontQuoteHandler({ store, now: NOW }), post(quoteBody()));
        const sent = [];
        const mailer = { send: async (message) => { sent.push(message); } };
        await invoke(createStorefrontCheckoutHandler({ store, now: NOW, mailer }), post({
            ...quoteBody(), ...shippingFields(), quote_token: quoteRes.body.quote_token,
        }));
        expect(sent.some((message) => message.subject.includes('Order confirmed'))).toBe(true);

        // Mark every job completed (what the node's lifecycle events do).
        let state = await store.getPlatformSetting(STOREFRONT_ORDERS_KEY, null);
        for (const jobId of state.orders[0].print_job_ids) {
            await store.updatePrintJob(jobId, { status: 'completed' });
        }

        const result = await sweepStorefrontOrders({ store, now: NOW, mailer, force: true });
        expect(result.shipped).toBe(1);

        state = await store.getPlatformSetting(STOREFRONT_ORDERS_KEY, null);
        expect(state.orders[0].status).toBe('shipped');
        expect(state.orders[0].shipment.tracking_code).toContain('MOCKTRACK');
        expect(sent.some((message) => message.subject.includes('shipped'))).toBe(true);

        // Idempotent: a second sweep does not re-ship.
        const again = await sweepStorefrontOrders({ store, now: () => new Date('2026-07-08T13:00:00.000Z'), mailer, force: true });
        expect(again.shipped).toBe(0);
    });

    it('parks printed orders at ready_to_ship when no carrier is configured', async () => {
        const store = createMemoryCloudStore();
        await seedSettings(store, { allow_unpaid_orders: true });
        const quoteRes = await invoke(createStorefrontQuoteHandler({ store, now: NOW }), post(quoteBody()));
        await invoke(createStorefrontCheckoutHandler({ store, now: NOW }), post({
            ...quoteBody(), ...shippingFields(), quote_token: quoteRes.body.quote_token,
        }));
        let state = await store.getPlatformSetting(STOREFRONT_ORDERS_KEY, null);
        for (const jobId of state.orders[0].print_job_ids) {
            await store.updatePrintJob(jobId, { status: 'completed' });
        }
        await sweepStorefrontOrders({ store, now: NOW, force: true });
        state = await store.getPlatformSetting(STOREFRONT_ORDERS_KEY, null);
        expect(state.orders[0].status).toBe('ready_to_ship');
    });

    it('customer cancel before printing: jobs canceled, Stripe refunded, emails sent', async () => {
        const store = createMemoryCloudStore();
        await seedSettings(store, { allow_unpaid_orders: true, stripe: { secret_key: 'sk_test_x', mock: true } });
        const quoteRes = await invoke(createStorefrontQuoteHandler({ store, now: NOW }), post(quoteBody()));
        const checkoutRes = await invoke(createStorefrontCheckoutHandler({ store, now: NOW }), post({
            ...quoteBody(), ...shippingFields(), quote_token: quoteRes.body.quote_token,
        }));
        // Give the settled order a payment intent as a real webhook would.
        let state = await store.getPlatformSetting(STOREFRONT_ORDERS_KEY, null);
        state.orders[0].payment.provider = 'stripe';
        state.orders[0].payment.payment_intent = 'pi_mock_1';
        await store.upsertPlatformSetting(STOREFRONT_ORDERS_KEY, state);

        const sent = [];
        const cancel = createStorefrontCancelHandler({ store, now: NOW, mailer: { send: async (m) => sent.push(m) } });
        const res = await invoke(cancel, post({ order_id: checkoutRes.body.order_id, token: checkoutRes.body.order_token }));

        expect(res.statusCode).toBe(200);
        expect(res.body.order.status).toBe('refunded');
        state = await store.getPlatformSetting(STOREFRONT_ORDERS_KEY, null);
        expect(state.orders[0].payment.refund_id).toContain('re_mock');
        for (const jobId of state.orders[0].print_job_ids) {
            expect((await store.getPrintJobById(jobId)).status).toBe('canceled');
        }
        expect(sent.some((message) => message.subject.includes('refund'))).toBe(true);

        // Cancel again -> conflict; wrong token -> not found.
        const again = await invoke(cancel, post({ order_id: checkoutRes.body.order_id, token: checkoutRes.body.order_token }));
        expect(again.statusCode).toBe(409);
    });

    it('refuses cancellation once printing started', async () => {
        const store = createMemoryCloudStore();
        await seedSettings(store, { allow_unpaid_orders: true });
        const quoteRes = await invoke(createStorefrontQuoteHandler({ store, now: NOW }), post(quoteBody()));
        const checkoutRes = await invoke(createStorefrontCheckoutHandler({ store, now: NOW }), post({
            ...quoteBody(), ...shippingFields(), quote_token: quoteRes.body.quote_token,
        }));
        const state = await store.getPlatformSetting(STOREFRONT_ORDERS_KEY, null);
        await store.updatePrintJob(state.orders[0].print_job_ids[0], { status: 'printing' });

        const cancel = createStorefrontCancelHandler({ store, now: NOW });
        const res = await invoke(cancel, post({ order_id: checkoutRes.body.order_id, token: checkoutRes.body.order_token }));
        expect(res.statusCode).toBe(409);
        expect(res.body.error).toBe('printing_already_started');
    });

    it('throttles between sweeps', async () => {
        const store = createMemoryCloudStore();
        await seedSettings(store, { allow_unpaid_orders: true });
        const quoteRes = await invoke(createStorefrontQuoteHandler({ store, now: NOW }), post(quoteBody()));
        await invoke(createStorefrontCheckoutHandler({ store, now: NOW }), post({
            ...quoteBody(), ...shippingFields(), quote_token: quoteRes.body.quote_token,
        }));
        await sweepStorefrontOrders({ store, now: NOW, force: true });
        const throttled = await sweepStorefrontOrders({ store, now: () => new Date('2026-07-08T12:02:00.000Z') });
        expect(throttled.skipped).toBe('recently_swept');
    });
});

describe('storefront admin + stripe utilities', () => {
    it('admin GET redacts Stripe secrets and hides order tokens', async () => {
        const store = createMemoryCloudStore();
        // mock:true keeps checkout off the network while the stored secret
        // still exercises redaction.
        await seedSettings(store, { allow_unpaid_orders: true, stripe: { secret_key: 'sk_live_secret', mock: true } });
        const quoteRes = await invoke(createStorefrontQuoteHandler({ store, now: NOW }), post(quoteBody()));
        await invoke(createStorefrontCheckoutHandler({ store, now: NOW }), post({
            ...quoteBody(), ...shippingFields(), quote_token: quoteRes.body.quote_token,
        }));

        const admin = createCloudStorefrontHandler({ store, adminToken: 'admin-tok', now: NOW });
        const res = await invoke(admin, { method: 'GET', headers: { authorization: 'Bearer admin-tok' }, query: {} });
        expect(res.statusCode).toBe(200);
        expect(res.body.settings.stripe.secret_key_set).toBe(true);
        expect(JSON.stringify(res.body)).not.toContain('sk_live_secret');
        expect(JSON.stringify(res.body)).not.toContain('access_token');
        expect(res.body.orders).toHaveLength(1);
    });

    it('admin PATCH keeps stored secrets when fields are blank', async () => {
        const store = createMemoryCloudStore();
        await seedSettings(store, { stripe: { secret_key: 'sk_live_secret' } });
        const admin = createCloudStorefrontHandler({ store, adminToken: 'admin-tok', now: NOW });
        const res = await invoke(admin, {
            method: 'PATCH',
            headers: { authorization: 'Bearer admin-tok' },
            body: { settings: { flat_shipping_cents: 1200, stripe: { secret_key: '' } } },
            query: {},
        });
        expect(res.statusCode).toBe(200);
        expect(res.body.settings.flat_shipping_cents).toBe(1200);
        const stored = await store.getPlatformSetting(STOREFRONT_SETTINGS_KEY, null);
        expect(stored.stripe.secret_key).toBe('sk_live_secret');
    });

    it('redaction reports configuration without leaking, and form encoding nests correctly', () => {
        const redacted = redactStorefrontSettings({ stripe: { secret_key: 'sk_x', webhook_secret: 'whsec_y' } });
        expect(redacted.stripe).toMatchObject({ configured: true, secret_key_set: true, webhook_secret_set: true });
        expect(JSON.stringify(redacted)).not.toContain('sk_x');

        const form = toStripeForm({
            mode: 'payment',
            line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: 500 } }],
            metadata: { storefront_order_id: 'sfo_1' },
        });
        expect(form.get('line_items[0][price_data][unit_amount]')).toBe('500');
        expect(form.get('metadata[storefront_order_id]')).toBe('sfo_1');
    });

    it('verifies raw-body Stripe signatures when available', () => {
        const settings = { stripe: { webhook_secret: 'whsec_test' } };
        const rawBody = JSON.stringify({ id: 'evt_9' });
        const timestamp = Math.floor(NOW().getTime() / 1000);
        const signature = crypto.createHmac('sha256', 'whsec_test').update(`${timestamp}.${rawBody}`).digest('hex');
        const header = `t=${timestamp},v1=${signature}`;
        expect(verifyStripeSignature({ settings, rawBody, signatureHeader: header, now: NOW })).toBe(true);
        expect(verifyStripeSignature({ settings, rawBody: rawBody + 'x', signatureHeader: header, now: NOW })).toBe(false);
    });
});
