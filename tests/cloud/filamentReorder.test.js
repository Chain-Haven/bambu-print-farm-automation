import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryCloudStore } from '../../src/cloud/memoryCloudStore.js';
import { createCloudFilamentOrdersHandler } from '../../src/cloud/adminHandlers.js';
import {
    buildPlaceOrderPayload,
    getLwaAccessToken,
    LWA_TOKEN_URL,
    resolveAmazonBusinessCredentials,
} from '../../src/cloud/amazonBusiness.js';
import {
    approveFilamentReorder,
    buildFilamentStockView,
    collectLiveAmsTrays,
    countUsableSpools,
    countUsableStock,
    denyFilamentReorder,
    estimateTrayGrams,
    evaluateFilamentReorders,
    FILAMENT_REORDER_CONFIG_KEY,
    FILAMENT_REORDER_STATE_KEY,
    getFilamentReorderOverview,
    normalizeReorderConfig,
    normalizeReorderRule,
    redactReorderConfig,
} from '../../src/cloud/filamentReorder.js';

const ADMIN_TOKEN = 'test-admin-token';
const NOW = () => new Date('2026-07-08T12:00:00.000Z');

const CREDENTIALS = {
    client_id: 'amzn1.application-oa2-client.test',
    client_secret: 'lwa-secret',
    refresh_token: 'Atzr|refresh',
};

function baseConfig(overrides = {}) {
    return {
        enabled: true,
        mode: 'approval',
        trial_mode: true,
        region: 'NA',
        user_email: 'purchasing@farm.example',
        credentials: { ...CREDENTIALS },
        rules: [{
            rule_id: 'pla-white',
            material: 'PLA',
            color_hex: '#FFFFFF',
            min_spools: 2,
            order_quantity: 3,
            asin: 'B0TESTASIN',
            max_unit_price_usd: 20,
        }],
        ...overrides,
    };
}

async function seed(store, { config, spools = [], state = null } = {}) {
    if (config) await store.upsertPlatformSetting(FILAMENT_REORDER_CONFIG_KEY, config);
    await store.upsertPlatformSetting('farm_filament_inventory', { spools });
    if (state) await store.upsertPlatformSetting(FILAMENT_REORDER_STATE_KEY, state);
}

// A fetch stub that answers the LWA token exchange and the Ordering API call.
function makeAmazonFetch({ orderStatus = 200, orderBody = null } = {}) {
    const calls = [];
    const impl = vi.fn(async (url, options = {}) => {
        calls.push({ url: String(url), options });
        if (String(url) === LWA_TOKEN_URL) {
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ access_token: 'Atza|access', expires_in: 3600 }),
            };
        }
        return {
            ok: orderStatus >= 200 && orderStatus < 300,
            status: orderStatus,
            text: async () => JSON.stringify(orderBody || {
                orderIdentifier: { orderId: '111-222', externalId: JSON.parse(options.body).externalId },
            }),
        };
    });
    return { impl, calls };
}

beforeEach(() => {
    delete process.env.AB_LWA_CLIENT_ID;
    delete process.env.AB_LWA_CLIENT_SECRET;
    delete process.env.AB_LWA_REFRESH_TOKEN;
});

describe('Amazon Business client', () => {
    it('exchanges the LWA refresh token for an access token', async () => {
        const { impl, calls } = makeAmazonFetch();
        const token = await getLwaAccessToken({ credentials: CREDENTIALS, fetchImpl: impl });
        expect(token).toBe('Atza|access');
        expect(calls[0].url).toBe(LWA_TOKEN_URL);
        expect(calls[0].options.body).toContain('grant_type=refresh_token');
        expect(calls[0].options.body).toContain('refresh_token=Atzr%7Crefresh');
    });

    it('falls back to AB_LWA_* env vars when the stored config has no secrets', () => {
        process.env.AB_LWA_CLIENT_ID = 'env-id';
        process.env.AB_LWA_CLIENT_SECRET = 'env-secret';
        process.env.AB_LWA_REFRESH_TOKEN = 'env-refresh';
        const resolved = resolveAmazonBusinessCredentials({ credentials: {} });
        expect(resolved).toEqual({ client_id: 'env-id', client_secret: 'env-secret', refresh_token: 'env-refresh' });
    });

    it('builds a PlaceOrderRequest with product reference, price guard, and trial mode', () => {
        const payload = buildPlaceOrderPayload({
            rule: { asin: 'B0TESTASIN', max_unit_price_usd: 22.5 },
            config: { trial_mode: true, user_email: 'purchasing@farm.example', country_code: 'US', currency: 'USD' },
            externalId: 'pkx-pla-white-202607-1',
            quantity: 3,
        });

        expect(payload.externalId).toBe('pkx-pla-white-202607-1');
        expect(payload.lineItems).toHaveLength(1);
        expect(payload.lineItems[0].quantity).toBe(3);
        expect(payload.lineItems[0].attributes[0]).toEqual({
            attributeType: 'SelectedProductReference',
            productReference: { productReferenceType: 'ProductIdentifier', id: 'B0TESTASIN' },
        });
        expect(payload.lineItems[0].expectations[0]).toMatchObject({
            expectationType: 'ExpectedUnitPrice',
            amount: { currencyCode: 'USD', amount: 22.5 },
        });
        const types = payload.attributes.map((attribute) => attribute.attributeType);
        expect(types).toContain('Region');
        expect(types).toContain('UserEmail');
        expect(types).toContain('TrialMode'); // safe default until the operator flips it
    });

    it('omits TrialMode only when explicitly disabled', () => {
        const live = buildPlaceOrderPayload({
            rule: { asin: 'B0TESTASIN' },
            config: { trial_mode: false },
            externalId: 'x-1',
            quantity: 1,
        });
        expect(live.attributes.map((attribute) => attribute.attributeType)).not.toContain('TrialMode');
    });
});

describe('filament reorder engine', () => {
    it('counts only matching spools with enough filament left', () => {
        const rule = { material: 'PLA', color_hex: '#FFFFFF' };
        const spools = [
            { material: 'PLA', color_hex: '#FFFFFF', grams_remaining: 900 },
            { material: 'PLA', color_hex: '#FFFFFF', grams_remaining: 40 },   // nearly empty
            { material: 'PLA', color_hex: '#000000', grams_remaining: 900 },  // wrong color
            { material: 'PETG', color_hex: '#FFFFFF', grams_remaining: 900 }, // wrong material
        ];
        expect(countUsableSpools(spools, rule, 150)).toBe(1);
        // A rule without a color covers every color of the material.
        expect(countUsableSpools(spools, { material: 'PLA', color_hex: null }, 150)).toBe(2);
    });

    it('parks a reorder for approval when stock drops below the threshold', async () => {
        const store = createMemoryCloudStore();
        await seed(store, {
            config: baseConfig(),
            spools: [{ material: 'PLA', color_hex: '#FFFFFF', grams_remaining: 800 }], // 1 usable < min 2
        });

        const result = await evaluateFilamentReorders({ store, now: NOW, force: true });

        expect(result.created).toBe(1);
        expect(result.placed).toBe(0);
        expect(result.orders[0]).toMatchObject({
            status: 'awaiting_approval',
            reason: 'approval_mode',
            material: 'PLA',
            quantity: 3,
            asin: 'B0TESTASIN',
            est_total_usd: 60,
            external_id: 'pkx-pla-white-202607-1',
        });
    });

    it('does nothing when stock is at or above the threshold', async () => {
        const store = createMemoryCloudStore();
        await seed(store, {
            config: baseConfig(),
            spools: [
                { material: 'PLA', color_hex: '#FFFFFF', grams_remaining: 800 },
                { material: 'PLA', color_hex: '#FFFFFF', grams_remaining: 900 },
            ],
        });
        const result = await evaluateFilamentReorders({ store, now: NOW, force: true });
        expect(result.created).toBe(0);
    });

    it('auto mode places the order through the Amazon Business Ordering API', async () => {
        const store = createMemoryCloudStore();
        const { impl, calls } = makeAmazonFetch();
        await seed(store, { config: baseConfig({ mode: 'auto' }), spools: [] });

        const result = await evaluateFilamentReorders({ store, now: NOW, force: true, fetchImpl: impl });

        expect(result.created).toBe(1);
        expect(result.placed).toBe(1);
        expect(result.orders[0].status).toBe('trial_placed'); // trial_mode default stays on
        const orderCall = calls.find((call) => call.url.includes('/ordering/2022-10-30/orders'));
        expect(orderCall).toBeTruthy();
        expect(orderCall.url).toBe('https://na.business-api.amazon.com/ordering/2022-10-30/orders');
        expect(orderCall.options.headers['x-amz-access-token']).toBe('Atza|access');
        expect(orderCall.options.headers['x-amz-user-email']).toBe('purchasing@farm.example');
        const body = JSON.parse(orderCall.options.body);
        expect(body.externalId).toBe('pkx-pla-white-202607-1');
        expect(body.lineItems[0].quantity).toBe(3);
    });

    it('auto mode without credentials parks for approval instead of failing', async () => {
        const store = createMemoryCloudStore();
        await seed(store, { config: baseConfig({ mode: 'auto', credentials: {} }), spools: [] });
        const result = await evaluateFilamentReorders({ store, now: NOW, force: true });
        expect(result.orders[0]).toMatchObject({ status: 'awaiting_approval', reason: 'missing_credentials' });
    });

    it('enforces the monthly budget and per-order caps in auto mode', async () => {
        const store = createMemoryCloudStore();
        // est_total = 20 * 3 = 60 > max_order 50 → parked.
        await seed(store, { config: baseConfig({ mode: 'auto', max_order_usd: 50 }), spools: [] });
        let result = await evaluateFilamentReorders({ store, now: NOW, force: true });
        expect(result.orders[0]).toMatchObject({ status: 'awaiting_approval', reason: 'max_order_exceeded' });

        // Monthly budget nearly exhausted by an already-placed order this month.
        const store2 = createMemoryCloudStore();
        await seed(store2, {
            config: baseConfig({ mode: 'auto', monthly_budget_usd: 100 }),
            spools: [],
            state: {
                orders: [{
                    order_id: 'fro_prior', rule_id: 'other-rule', month: '2026-07',
                    status: 'placed', est_total_usd: 80, created_at: '2026-07-01T00:00:00.000Z',
                }],
            },
        });
        result = await evaluateFilamentReorders({ store: store2, now: NOW, force: true });
        expect(result.orders[0]).toMatchObject({ status: 'awaiting_approval', reason: 'monthly_budget_exceeded' });
    });

    it('never double-orders: open approvals and cooldown block re-creation', async () => {
        const store = createMemoryCloudStore();
        await seed(store, { config: baseConfig(), spools: [] });

        const first = await evaluateFilamentReorders({ store, now: NOW, force: true });
        expect(first.created).toBe(1);

        // Same shortage, second sweep → the open approval blocks a duplicate.
        const second = await evaluateFilamentReorders({ store, now: NOW, force: true });
        expect(second.created).toBe(0);

        // Deny it, evaluate again inside the 24h cooldown → still blocked.
        await denyFilamentReorder({ store, orderId: first.orders[0].order_id, now: NOW });
        const third = await evaluateFilamentReorders({
            store,
            now: () => new Date('2026-07-08T13:00:00.000Z'),
            force: true,
        });
        expect(third.created).toBe(0);

        // After the cooldown the rule may order again — with a NEW externalId.
        const fourth = await evaluateFilamentReorders({
            store,
            now: () => new Date('2026-07-09T13:00:00.000Z'),
            force: true,
        });
        expect(fourth.created).toBe(1);
        expect(fourth.orders[0].external_id).toBe('pkx-pla-white-202607-2');
    });

    it('throttles heartbeat-driven evaluation to the internal interval', async () => {
        const store = createMemoryCloudStore();
        await seed(store, { config: baseConfig(), spools: [] });
        await evaluateFilamentReorders({ store, now: NOW, force: true });

        const throttled = await evaluateFilamentReorders({ store, now: () => new Date('2026-07-08T12:02:00.000Z') });
        expect(throttled.skipped).toBe('recently_evaluated');
    });

    it('approve places the parked order; failures are recorded on the entry', async () => {
        const store = createMemoryCloudStore();
        await seed(store, { config: baseConfig(), spools: [] });
        const { orders } = await evaluateFilamentReorders({ store, now: NOW, force: true });

        const { impl } = makeAmazonFetch();
        const placedOrder = await approveFilamentReorder({ store, orderId: orders[0].order_id, now: NOW, fetchImpl: impl });
        expect(placedOrder.status).toBe('trial_placed');
        expect(placedOrder.approved_at).toBe('2026-07-08T12:00:00.000Z');

        // Approving a non-open order is rejected.
        await expect(approveFilamentReorder({ store, orderId: orders[0].order_id, now: NOW, fetchImpl: impl }))
            .rejects.toThrow('reorder_not_awaiting_approval');
    });

    it('records a failed vendor call and does not lose the order entry', async () => {
        const store = createMemoryCloudStore();
        const { impl } = makeAmazonFetch({ orderStatus: 422, orderBody: { errors: [{ code: 'INVALID_ASIN' }] } });
        await seed(store, { config: baseConfig({ mode: 'auto' }), spools: [] });

        const result = await evaluateFilamentReorders({ store, now: NOW, force: true, fetchImpl: impl });
        expect(result.orders[0].status).toBe('failed');
        expect(result.orders[0].error).toContain('HTTP 422');

        const overview = await getFilamentReorderOverview({ store, now: NOW });
        expect(overview.orders).toHaveLength(1);
    });

    it('redacts LWA secrets but reports whether they are set', () => {
        const redacted = redactReorderConfig(baseConfig());
        expect(redacted.credentials.client_id).toBe(CREDENTIALS.client_id);
        expect(redacted.credentials.client_secret_set).toBe(true);
        expect(redacted.credentials.refresh_token_set).toBe(true);
        expect(JSON.stringify(redacted)).not.toContain(CREDENTIALS.client_secret);
        expect(JSON.stringify(redacted)).not.toContain(CREDENTIALS.refresh_token);
    });
});

describe('AMS-level stock tracking', () => {
    // Mirrored printer rows as upsertCloudPrinters stores them (heartbeat path):
    // merged AMS view under capabilities.ams_trays, live_remaining = Bambu
    // `remain` percent, live colors 8-char RGBA without '#'.
    function printerWith(trays, { lastSeenAt = '2026-07-08T11:55:00.000Z', id = 'p1' } = {}) {
        return {
            printer_id: id,
            local_printer_id: `local-${id}`,
            last_seen_at: lastSeenAt,
            capabilities: { ams_trays: trays },
        };
    }

    it('collects live trays, normalizes RGBA colors, and skips stale printers', () => {
        const trays = collectLiveAmsTrays([
            printerWith([
                { ams_id: 0, tray_id: 0, material: 'PLA', material_base: 'PLA', color_hex: 'FFFFFFFF', live_remaining: 80 },
                { ams_id: 0, tray_id: 1, material: 'PLA Silk', material_base: 'PLA', color_hex: '00AE42FF', live_remaining: -1 },
            ]),
            printerWith(
                [{ ams_id: 0, tray_id: 0, material: 'PETG', color_hex: '000000FF', live_remaining: 90 }],
                { lastSeenAt: '2026-07-05T00:00:00.000Z', id: 'stale' }, // 3 days silent
            ),
        ], new Date('2026-07-08T12:00:00.000Z').getTime());

        expect(trays).toHaveLength(2); // stale printer contributes nothing
        expect(trays[0]).toMatchObject({ material: 'PLA', color_hex: '#FFFFFF', live_remaining: 80 });
        expect(trays[1]).toMatchObject({ material: 'PLA SILK', material_base: 'PLA', color_hex: '#00AE42' });
    });

    it('estimates tray grams from Bambu remain percent; unknown counts as full', () => {
        expect(estimateTrayGrams({ live_remaining: 80 }, 1000)).toBe(800);
        expect(estimateTrayGrams({ live_remaining: 5 }, 1000)).toBe(50);
        expect(estimateTrayGrams({ live_remaining: null }, 1000)).toBe(1000); // no RFID telemetry
        expect(estimateTrayGrams({ live_remaining: -1 }, 1000)).toBe(1000);
        expect(estimateTrayGrams({ live_remaining: 250 }, 1000)).toBe(1000);  // clamped
    });

    it('counts AMS trays + shelf spools without double-counting loaded spools', () => {
        const config = normalizeReorderConfig(baseConfig());
        const rule = config.rules[0]; // PLA #FFFFFF, grams_per_spool 1000
        const trays = collectLiveAmsTrays([
            printerWith([
                { material: 'PLA', color_hex: 'FFFFFFFF', live_remaining: 70 },  // 700g usable
                { material: 'PLA', color_hex: 'FFFFFFFF', live_remaining: 5 },   // 50g — nearly empty
            ]),
        ], new Date('2026-07-08T12:00:00.000Z').getTime());
        const spools = [
            { material: 'PLA', color_hex: '#FFFFFF', grams_remaining: 900 },                      // shelf spool
            { material: 'PLA', color_hex: '#FFFFFF', grams_remaining: 800, printer_id: 'p1' },    // loaded — IS a tray
        ];

        const stock = countUsableStock({ spools, trays, rule, config });
        expect(stock).toMatchObject({ usable: 2, tray_count: 1, spool_count: 1 });

        // With AMS counting off, only inventory counts — including loaded spools.
        const offConfig = normalizeReorderConfig(baseConfig({ count_ams_trays: false }));
        const offStock = countUsableStock({ spools, trays, rule: offConfig.rules[0], config: offConfig });
        expect(offStock).toMatchObject({ usable: 2, tray_count: 0, spool_count: 2 });
    });

    it('live AMS levels drive ordering with zero manual inventory', async () => {
        const store = createMemoryCloudStore();
        const nodeLike = { node_id: 'n1', org_id: 'o1' };
        await seed(store, { config: baseConfig(), spools: [] });

        // Two healthy white-PLA trays → above threshold, nothing ordered.
        await store.upsertCloudPrinters(nodeLike, [{
            local_printer_id: 'a1',
            capabilities: {
                ams_trays: [
                    { material: 'PLA', color_hex: 'FFFFFFFF', live_remaining: 90 },
                    { material: 'PLA', color_hex: 'FFFFFFFF', live_remaining: 60 },
                ],
            },
        }], NOW().toISOString());
        let result = await evaluateFilamentReorders({ store, now: NOW, force: true });
        expect(result.created).toBe(0);

        // Both trays running out → order created, with the AMS breakdown on it.
        await store.upsertCloudPrinters(nodeLike, [{
            local_printer_id: 'a1',
            capabilities: {
                ams_trays: [
                    { material: 'PLA', color_hex: 'FFFFFFFF', live_remaining: 8 },
                    { material: 'PLA', color_hex: 'FFFFFFFF', live_remaining: 3 },
                ],
            },
        }], NOW().toISOString());
        result = await evaluateFilamentReorders({ store, now: NOW, force: true });
        expect(result.created).toBe(1);
        expect(result.orders[0]).toMatchObject({
            usable_spools: 0,
            ams_tray_count: 0,
            shelf_spool_count: 0,
        });
        expect(result.orders[0].est_grams_left).toBe(110); // 80g + 30g still loaded
    });

    it('builds the tagging view: aggregates AMS + shelf stock and attaches rules', () => {
        const config = baseConfig(); // rule covers PLA #FFFFFF
        const printers = [printerWith([
            { material: 'PLA', color_hex: 'FFFFFFFF', color_name: 'Jade White', live_remaining: 70 },
            { material: 'PETG', color_hex: '000000FF', live_remaining: 40 },
        ])];
        const spools = [{ material: 'PLA', color_hex: '#FFFFFF', grams_remaining: 900 }];

        const view = buildFilamentStockView({ config, spools, printers, now: NOW });

        const white = view.find((entry) => entry.material === 'PLA' && entry.color_hex === '#FFFFFF');
        expect(white).toMatchObject({
            ams_tray_count: 1,
            inventory_spool_count: 1,
            usable_spools: 2,
            tagged: true,
            color_name: 'Jade White',
        });
        expect(white.rule).toMatchObject({ asin: 'B0TESTASIN', min_spools: 2 });
        expect(white.est_grams).toBe(1600); // 700g tray + 900g shelf spool

        const petg = view.find((entry) => entry.material === 'PETG');
        expect(petg).toMatchObject({ tagged: false, rule: null, ams_tray_count: 1 });
    });

    it('keeps a row for tagged filament the farm has fully run out of', () => {
        const view = buildFilamentStockView({ config: baseConfig(), spools: [], printers: [], now: NOW });
        expect(view).toHaveLength(1);
        expect(view[0]).toMatchObject({ material: 'PLA', color_hex: '#FFFFFF', usable_spools: 0, tagged: true });
    });

    it('defaults: AMS counting on, rule_defaults populated, rules normalize RGBA colors', () => {
        const config = normalizeReorderConfig({});
        expect(config.count_ams_trays).toBe(true);
        expect(config.rule_defaults).toEqual({
            min_spools: 2,
            order_quantity: 2,
            max_unit_price_usd: 30,
            grams_per_spool: 1000,
        });
        expect(normalizeReorderRule({ material: 'pla', color_hex: '00AE42FF' }).color_hex).toBe('#00AE42');
    });
});

describe('filament orders admin handler', () => {
    function makeRes() {
        return {
            statusCode: 0,
            headers: {},
            body: null,
            setHeader(name, value) { this.headers[name] = value; },
            end(payload) { this.body = payload ? JSON.parse(payload) : null; return this; },
        };
    }

    function makeReq({ method = 'GET', body = null, query = {} } = {}) {
        return {
            method,
            body,
            query,
            headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        };
    }

    async function invoke(handler, request) {
        const res = makeRes();
        await handler(request, res);
        return res;
    }

    it('GET returns redacted config, orders, monthly spend, and detected filaments', async () => {
        const store = createMemoryCloudStore();
        await seed(store, { config: baseConfig(), spools: [{ material: 'PLA', color_hex: '#FFFFFF', grams_remaining: 500 }] });
        await evaluateFilamentReorders({ store, now: NOW, force: true });

        const handler = createCloudFilamentOrdersHandler({ store, adminToken: ADMIN_TOKEN, now: NOW });
        const res = await invoke(handler, makeReq());

        expect(res.statusCode).toBe(200);
        expect(res.body.config.credentials.client_secret_set).toBe(true);
        expect(JSON.stringify(res.body)).not.toContain(CREDENTIALS.client_secret);
        expect(res.body.orders).toHaveLength(1);
        expect(res.body.month).toBe('2026-07');
        expect(res.body.detected_filaments).toHaveLength(1);
        expect(res.body.detected_filaments[0]).toMatchObject({ material: 'PLA', tagged: true, inventory_spool_count: 1 });
    });

    it('PATCH merges config and keeps stored secrets when fields are blank', async () => {
        const store = createMemoryCloudStore();
        await seed(store, { config: baseConfig(), spools: [] });
        const handler = createCloudFilamentOrdersHandler({ store, adminToken: ADMIN_TOKEN, now: NOW });

        const res = await invoke(handler, makeReq({
            method: 'PATCH',
            body: { config: { mode: 'auto', credentials: { client_secret: '' } } },
        }));
        expect(res.statusCode).toBe(200);
        expect(res.body.config.mode).toBe('auto');

        const stored = await store.getPlatformSetting(FILAMENT_REORDER_CONFIG_KEY, null);
        expect(stored.credentials.client_secret).toBe(CREDENTIALS.client_secret); // blank field ≠ delete
        expect(stored.rules).toHaveLength(1); // untouched sections survive the merge
    });

    it('POST approve/deny drives the approval queue end to end', async () => {
        const store = createMemoryCloudStore();
        await seed(store, { config: baseConfig(), spools: [] });
        await evaluateFilamentReorders({ store, now: NOW, force: true });
        const { impl } = makeAmazonFetch();
        const handler = createCloudFilamentOrdersHandler({ store, adminToken: ADMIN_TOKEN, fetchImpl: impl, now: NOW });

        const overview = await invoke(handler, makeReq());
        const orderId = overview.body.orders[0].order_id;

        const approved = await invoke(handler, makeReq({ method: 'POST', body: { action: 'approve', order_id: orderId } }));
        expect(approved.statusCode).toBe(200);
        expect(approved.body.order.status).toBe('trial_placed');

        const again = await invoke(handler, makeReq({ method: 'POST', body: { action: 'approve', order_id: orderId } }));
        expect(again.statusCode).toBe(409);

        const missing = await invoke(handler, makeReq({ method: 'POST', body: { action: 'deny', order_id: 'fro_nope' } }));
        expect(missing.statusCode).toBe(404);
    });

    it('POST evaluate runs a forced stock check', async () => {
        const store = createMemoryCloudStore();
        await seed(store, { config: baseConfig(), spools: [] });
        const handler = createCloudFilamentOrdersHandler({ store, adminToken: ADMIN_TOKEN, now: NOW });

        const res = await invoke(handler, makeReq({ method: 'POST', body: { action: 'evaluate' } }));
        expect(res.statusCode).toBe(200);
        expect(res.body.result.created).toBe(1);
        expect(res.body.orders).toHaveLength(1);
    });

    it('rejects requests without the admin token', async () => {
        const store = createMemoryCloudStore();
        const handler = createCloudFilamentOrdersHandler({ store, adminToken: ADMIN_TOKEN, now: NOW });
        const res = await invoke(handler, { method: 'GET', headers: {}, query: {} });
        expect(res.statusCode).toBe(401);
    });
});

describe('heartbeat integration', () => {
    it('a node heartbeat triggers a reorder sweep (best-effort)', async () => {
        const store = createMemoryCloudStore();
        await seed(store, { config: baseConfig(), spools: [] });

        const { createHeartbeatHandler } = await import('../../src/cloud/agentHandlers.js');
        const { hashNodeToken } = await import('../../src/cloud/agentProtocol.js');
        const pepper = 'test-pepper';
        const token = 'pkx_node_testtoken';
        const org = await store.createOrganization({ name: 'Test Farm' });
        const node = await store.createFarmNode({
            org_id: org.org_id,
            name: 'Test Node',
            token_hash: hashNodeToken(token, pepper),
            capabilities: {},
        });
        expect(node.node_id).toBeTruthy();

        const handler = createHeartbeatHandler({ store, pepper, now: NOW });
        const res = {
            statusCode: 0,
            headers: {},
            body: null,
            setHeader(name, value) { this.headers[name] = value; },
            end(payload) { this.body = payload ? JSON.parse(payload) : null; return this; },
        };
        await handler({
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
            body: { status: 'online', printers: [] },
        }, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.filament_reorders_created).toBe(1);

        const state = await store.getPlatformSetting(FILAMENT_REORDER_STATE_KEY, null);
        expect(state.orders).toHaveLength(1);
        expect(state.orders[0].status).toBe('awaiting_approval');
    });
});
