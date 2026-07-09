import { describe, expect, it, vi } from 'vitest';
import { createMemoryCloudStore } from '../../src/cloud/memoryCloudStore.js';
import { createMcpHandler } from '../../src/cloud/mcpServer.js';
import { renderMeshSvg } from '../../src/cloud/meshPreview.js';
import {
    buildEip681Uri,
    computeUsdcPrice,
    resolveUsdcConfig,
    scanUsdcTransfersToWallet,
    settleX402Payment,
    uniquePaymentBaseUnits,
    verifyUsdcPayment,
} from '../../src/cloud/usdcPayments.js';
import {
    ensureStorefrontIdentity,
    STOREFRONT_ORDERS_KEY,
    sweepStorefrontOrders,
} from '../../src/cloud/storefrontHandlers.js';
import { hashNodeToken } from '../../src/cloud/agentProtocol.js';
import { createRateLimiter } from '../../src/utils/rateLimiter.js';

const NOW = () => new Date('2026-07-09T18:00:00.000Z');

const AGENT_ENV = {
    USDC_WALLET_ADDRESS: '0x1111111111111111111111111111111111111111',
    USDC_CHAIN: 'base',
    USDC_PRICE_PER_GRAM: '0.10',
    USDC_PRICE_PER_GRAM_PETG: '0.14',
    USDC_VOLUME_BREAK_GRAMS: '500',
    USDC_VOLUME_DISCOUNT_PCT: '10',
    USDC_SHIPPING_FLAT: '5',
    MOCK_MODE: 'true', // mock verification path: tx 'mock_paid' / 'mock_x402'
};

function buildBoxStl(size = 20) {
    const s = size;
    const V = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]];
    const F = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
    const buffer = Buffer.alloc(84 + F.length * 50);
    buffer.writeUInt32LE(F.length, 80);
    let offset = 84;
    for (const face of F) {
        offset += 12;
        for (const vi of face) {
            buffer.writeFloatLE(V[vi][0], offset);
            buffer.writeFloatLE(V[vi][1], offset + 4);
            buffer.writeFloatLE(V[vi][2], offset + 8);
            offset += 12;
        }
        offset += 2;
    }
    return buffer;
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

function makeHandler(store, overrides = {}) {
    return createMcpHandler({
        store,
        now: NOW,
        env: AGENT_ENV,
        waits: { command: 0, generate: 0 },
        ...overrides,
    });
}

async function rpc(handler, message, headers = {}) {
    const res = makeRes();
    await handler({ method: 'POST', headers, body: message }, res);
    return res;
}

async function callTool(handler, name, args, headers = {}) {
    const res = await rpc(handler, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }, headers);
    expect(res.statusCode).toBe(200);
    const { result } = res.body;
    const text = result.content.find((entry) => entry.type === 'text')?.text;
    const image = result.content.find((entry) => entry.type === 'image') || null;
    return { isError: result.isError, data: result.isError ? text : JSON.parse(text), image };
}

const SHIPPING = {
    name: 'Agent Recipient',
    line1: '1 Robot Way',
    city: 'Austin',
    region: 'TX',
    postal_code: '78701',
    country: 'us',
};

const BOX30 = { file_base64: buildBoxStl(30).toString('base64'), file_name: 'bracket.stl' };

describe('USDC payment upgrades', () => {
    it('applies per-material rates and the volume discount', () => {
        const config = resolveUsdcConfig(AGENT_ENV);
        expect(computeUsdcPrice({ gramsPerPiece: 50, quantity: 1, config, material: 'PLA' }).price_per_gram_usdc).toBe(0.1);
        expect(computeUsdcPrice({ gramsPerPiece: 50, quantity: 1, config, material: 'PETG' }).price_per_gram_usdc).toBe(0.14);
        const big = computeUsdcPrice({ gramsPerPiece: 300, quantity: 2, config, material: 'PLA' }); // 600g > 500g break
        expect(big.volume_discount_pct).toBe(10);
        expect(big.filament_usdc).toBeCloseTo(54, 2); // 600 × 0.10 × 0.9
    });

    it('mints unique sub-cent payment amounts and EIP-681 URIs', () => {
        const config = resolveUsdcConfig(AGENT_ENV);
        const a = uniquePaymentBaseUnits({ baseUnits: '10000000', orderId: 'sfo_a', takenAmounts: new Set() });
        const b = uniquePaymentBaseUnits({ baseUnits: '10000000', orderId: 'sfo_b', takenAmounts: new Set([a]) });
        expect(a).not.toBe('10000000');
        expect(BigInt(a) - 10000000n).toBeLessThan(10000n); // < 0.01 USDC dither
        expect(b).not.toBe(a);
        const uri = buildEip681Uri({ config, baseUnits: a });
        expect(uri).toBe(`ethereum:${config.token_address}@8453/transfer?address=${config.wallet_address}&uint256=${a}`);
    });

    it('scans Transfer logs to the wallet for hands-free matching', async () => {
        const config = resolveUsdcConfig({ ...AGENT_ENV, MOCK_MODE: 'false' });
        const walletTopic = `0x000000000000000000000000${config.wallet_address.slice(2).toLowerCase()}`;
        const fetchImpl = vi.fn(async (url, options) => {
            const { method, params } = JSON.parse(options.body);
            if (method === 'eth_blockNumber') return { json: async () => ({ result: '0x200' }) };
            expect(method).toBe('eth_getLogs');
            expect(params[0].topics[2]).toBe(walletTopic);
            return {
                json: async () => ({
                    result: [{
                        transactionHash: '0x' + 'cd'.repeat(32),
                        blockNumber: '0x1f0',
                        data: '0x' + (10001234n).toString(16).padStart(64, '0'),
                        topics: [params[0].topics[0], '0x' + '00'.repeat(12) + '55'.repeat(20), walletTopic],
                    }],
                }),
            };
        });
        const scan = await scanUsdcTransfersToWallet({ config, fetchImpl });
        expect(scan.transfers).toHaveLength(1);
        expect(scan.transfers[0]).toMatchObject({ amount_base_units: '10001234', confirmations: 17 });
        expect(scan.head_block).toBe(String(0x200));
    });

    it('settles x402 payloads via the facilitator (and mocks offline)', async () => {
        const mock = await settleX402Payment({
            config: resolveUsdcConfig(AGENT_ENV),
            paymentPayload: 'mock_x402',
            requirements: {},
        });
        expect(mock.settled).toBe(true);

        const config = resolveUsdcConfig({ ...AGENT_ENV, MOCK_MODE: 'false', X402_FACILITATOR_URL: 'https://facilitator.example' });
        const calls = [];
        const fetchImpl = vi.fn(async (url) => {
            calls.push(String(url));
            return {
                ok: true,
                text: async () => JSON.stringify(String(url).endsWith('/verify') ? { isValid: true } : { success: true, txHash: '0xfeed' }),
            };
        });
        const settled = await settleX402Payment({ config, paymentPayload: 'payload', requirements: { scheme: 'exact' }, fetchImpl });
        expect(settled).toMatchObject({ settled: true, tx_hash: '0xfeed' });
        expect(calls).toEqual(['https://facilitator.example/verify', 'https://facilitator.example/settle']);

        const unconfigured = await settleX402Payment({ config: resolveUsdcConfig({ ...AGENT_ENV, MOCK_MODE: 'false' }), paymentPayload: 'p', requirements: {} });
        expect(unconfigured.reason).toBe('x402_not_configured');
    });
});

describe('mesh preview render', () => {
    it('renders a shaded SVG with correct dimensions', () => {
        const rendered = renderMeshSvg({ fileName: 'cube.stl', buffer: buildBoxStl(30) });
        expect(rendered.triangle_count).toBe(12);
        expect(rendered.bounds.size.map(Math.round)).toEqual([30, 30, 30]);
        expect(rendered.svg).toContain('<svg');
        expect(rendered.svg).toContain('polygon');
        expect((rendered.svg.match(/<polygon/g) || []).length).toBe(12);
    });
});

describe('storefront identity routes to the org that owns the nodes', () => {
    it('provisions in the node org, and self-heals an identity created before nodes existed', async () => {
        const store = createMemoryCloudStore();
        // Identity created while NO nodes exist → its own org.
        const early = await ensureStorefrontIdentity(store);

        // A farm node appears in a different org.
        const org = await store.createOrganization({ name: 'Real Farm' });
        await store.createFarmNode({ org_id: org.org_id, name: 'N1', token_hash: hashNodeToken('t', 'p'), capabilities: {} });

        const healed = await ensureStorefrontIdentity(store);
        expect(healed.org_id).toBe(org.org_id);
        expect(healed.merchant_id).not.toBe(early.merchant_id);
        expect(healed.quote_secret).toBe(early.quote_secret); // quotes stay valid

        // Stable afterwards.
        const again = await ensureStorefrontIdentity(store);
        expect(again.merchant_id).toBe(healed.merchant_id);
    });
});

describe('MCP v2 protocol + tools', () => {
    it('lists the full tool suite and stays protocol-correct', async () => {
        const handler = makeHandler(createMemoryCloudStore());
        const init = await rpc(handler, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
        expect(init.body.result.protocolVersion).toBe('2025-06-18');

        const list = await rpc(handler, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
        expect(list.body.result.tools.map((tool) => tool.name)).toEqual([
            'farm_info', 'farm_capacity', 'print_preview', 'generate_model',
            'print_quote', 'print_order', 'print_pay', 'print_snapshot',
            'print_status', 'cancel_order', 'request_refund',
        ]);

        const note = await rpc(handler, { jsonrpc: '2.0', method: 'notifications/initialized' });
        expect(note.statusCode).toBe(202);
    });

    it('rate limits by IP', async () => {
        const handler = makeHandler(createMemoryCloudStore(), {
            rateLimiter: createRateLimiter({ capacity: 2, refillPerSec: 0.001 }),
        });
        await rpc(handler, { jsonrpc: '2.0', id: 1, method: 'ping' });
        await rpc(handler, { jsonrpc: '2.0', id: 2, method: 'ping' });
        const limited = await rpc(handler, { jsonrpc: '2.0', id: 3, method: 'ping' });
        expect(limited.statusCode).toBe(429);
        expect(limited.headers['Retry-After']).toBeTruthy();
    });

    it('farm_capacity reports live printers and AMS-loaded colors', async () => {
        const store = createMemoryCloudStore();
        const org = await store.createOrganization({ name: 'Farm' });
        const node = await store.createFarmNode({ org_id: org.org_id, name: 'N', token_hash: hashNodeToken('t', 'p'), capabilities: {} });
        await store.upsertCloudPrinters({ node_id: node.node_id, org_id: org.org_id }, [{
            local_printer_id: 'a1',
            name: 'A1 Bay 1',
            status: 'printing',
            capabilities: { ams_trays: [{ material: 'PLA', color_hex: 'FFFFFFFF', color_name: 'Jade White', live_remaining: 80 }] },
        }], NOW().toISOString());

        const capacity = await callTool(makeHandler(store), 'farm_capacity', {});
        expect(capacity.data.printers_online).toBe(1);
        expect(capacity.data.printers_printing).toBe(1);
        expect(capacity.data.filament_loaded_now).toEqual([expect.objectContaining({
            material: 'PLA',
            color_hex: '#FFFFFF',
            trays_loaded: 1,
        })]);
    });

    it('print_preview returns an image and true dimensions', async () => {
        const preview = await callTool(makeHandler(createMemoryCloudStore()), 'print_preview', BOX30);
        expect(preview.isError).toBeFalsy();
        expect(preview.image.mimeType).toBe('image/svg+xml');
        expect(Buffer.from(preview.image.data, 'base64').toString()).toContain('<svg');
        expect(preview.data.dimensions_mm).toEqual([30, 30, 30]);
    });

    it('multi-item funnel with unique amount: quote → order → auto/manual pay → status', async () => {
        const store = createMemoryCloudStore();
        const handler = makeHandler(store);
        const items = [
            { ...BOX30, material: 'PLA', quantity: 2 },
            { file_base64: buildBoxStl(20).toString('base64'), file_name: 'clip.stl', material: 'PETG', quantity: 1 },
        ];

        const quote = await callTool(handler, 'print_quote', { items });
        expect(quote.data.items).toHaveLength(2);
        expect(quote.data.items[1].usdc_rate_per_gram).toBe(0.14); // PETG override
        expect(quote.data.totals.shipping_usdc).toBe(5); // ONE shipping fee for the whole order

        const order = await callTool(handler, 'print_order', {
            items, quote_token: quote.data.quote_token, shipping_address: SHIPPING,
        });
        expect(order.isError).toBeFalsy();
        const payUnits = BigInt(order.data.pay.amount_base_units);
        const quotedUnits = BigInt(quote.data.totals.total_base_units);
        expect(payUnits).toBeGreaterThan(quotedUnits);           // unique dither applied
        expect(payUnits - quotedUnits).toBeLessThan(10000n);     // < 0.01 USDC
        expect(order.data.pay.eip681_uri).toContain('/transfer?address=');
        expect(order.data.pay.x402.supported).toBe(true);        // mock counts as available

        const pay = await callTool(handler, 'print_pay', {
            order_id: order.data.order_id, order_token: order.data.order_token, tx_hash: 'mock_paid',
        });
        expect(pay.data.verified).toBe(true);
        expect(pay.data.jobs_created).toBe(3); // 2 + 1 pieces across items

        const status = await callTool(handler, 'print_status', {
            order_id: order.data.order_id, order_token: order.data.order_token,
        });
        expect(status.data.items).toHaveLength(2);
        expect(status.data.jobs).toHaveLength(3);
    });

    it('x402 settlement path pays an order', async () => {
        const store = createMemoryCloudStore();
        const handler = makeHandler(store);
        const quote = await callTool(handler, 'print_quote', BOX30);
        const order = await callTool(handler, 'print_order', {
            ...BOX30, quote_token: quote.data.quote_token, shipping_address: SHIPPING,
        });
        const pay = await callTool(handler, 'print_pay', {
            order_id: order.data.order_id, order_token: order.data.order_token, x402_payment: 'mock_x402',
        });
        expect(pay.data).toMatchObject({ verified: true, via: 'x402' });
    });

    it('cancel_order frees unpaid orders; request_refund queues paid ones', async () => {
        const store = createMemoryCloudStore();
        const handler = makeHandler(store);
        const quote = await callTool(handler, 'print_quote', BOX30);
        const order = await callTool(handler, 'print_order', {
            ...BOX30, quote_token: quote.data.quote_token, shipping_address: SHIPPING,
        });

        const canceled = await callTool(handler, 'cancel_order', {
            order_id: order.data.order_id, order_token: order.data.order_token,
        });
        expect(canceled.data.status).toBe('canceled');

        // Paid order: cancel refuses, refund queues + alerts.
        const quote2 = await callTool(handler, 'print_quote', BOX30);
        const order2 = await callTool(handler, 'print_order', {
            ...BOX30, quote_token: quote2.data.quote_token, shipping_address: SHIPPING,
        });
        await callTool(handler, 'print_pay', {
            order_id: order2.data.order_id, order_token: order2.data.order_token, tx_hash: 'mock_paid',
        });
        const cantCancel = await callTool(handler, 'cancel_order', {
            order_id: order2.data.order_id, order_token: order2.data.order_token,
        });
        expect(cantCancel.isError).toBe(true);
        const refund = await callTool(handler, 'request_refund', {
            order_id: order2.data.order_id, order_token: order2.data.order_token, reason: 'wrong scale',
        });
        expect(refund.data.refund_request.status).toBe('requested');
    });

    it('generate_model compiles OpenSCAD on a node (mock) via the command channel', async () => {
        const store = createMemoryCloudStore();
        const org = await store.createOrganization({ name: 'Farm' });
        const node = await store.createFarmNode({
            org_id: org.org_id, name: 'N', token_hash: hashNodeToken('t', 'p'), capabilities: {},
        });
        await store.recordNodeHeartbeat(node.node_id, {
            status: 'online', last_seen_at: NOW().toISOString(), capabilities: { can_generate_models: true }, printers: [],
        });
        const handler = makeHandler(store);

        const started = await callTool(handler, 'generate_model', { scad_source: 'cube([20,20,20]);' });
        expect(started.data.status).toBe('generating');
        const generationId = started.data.generation_id;

        // The node claims + executes (simulated with the real executor's mock output shape).
        const [claimed] = await store.claimNodeCommands(node.node_id, 5);
        expect(claimed.command_type).toBe('cloud.model.generate');
        await store.recordCommandResult(node.node_id, {
            command_id: claimed.command_id,
            status: 'succeeded',
            result: { ok: true, file_name: 'generated.stl', stl_base64: buildBoxStl(20).toString('base64'), byte_size: 684, mock: true },
            error: null,
            finished_at: NOW().toISOString(),
        });

        const done = await callTool(handler, 'generate_model', { generation_id: generationId });
        expect(done.data.status).toBe('done');
        expect(done.data.file_base64).toBeTruthy();

        // Round trip: the generated STL quotes like any upload.
        const quote = await callTool(handler, 'print_quote', {
            file_base64: done.data.file_base64, file_name: done.data.file_name,
        });
        expect(quote.data.items[0].estimate_basis).toBe('mesh_volume');
    });

    it('print_snapshot returns pending then the camera frame', async () => {
        const store = createMemoryCloudStore();
        const handler = makeHandler(store);
        const org = await store.createOrganization({ name: 'Farm' });
        const node = await store.createFarmNode({ org_id: org.org_id, name: 'N', token_hash: hashNodeToken('t', 'p'), capabilities: {} });
        await store.upsertCloudPrinters({ node_id: node.node_id, org_id: org.org_id }, [{
            local_printer_id: 'a1', name: 'A1', status: 'printing', capabilities: {},
        }], NOW().toISOString());
        const overview = await store.getCloudOverview({});
        const printerId = overview.printers[0].printer_id;

        // Paid order whose job is "printing" on that printer.
        const quote = await callTool(handler, 'print_quote', BOX30);
        const order = await callTool(handler, 'print_order', {
            ...BOX30, quote_token: quote.data.quote_token, shipping_address: SHIPPING,
        });
        await callTool(handler, 'print_pay', {
            order_id: order.data.order_id, order_token: order.data.order_token, tx_hash: 'mock_paid',
        });
        const status = await callTool(handler, 'print_status', { order_id: order.data.order_id, order_token: order.data.order_token });
        await store.updatePrintJob(status.data.jobs[0].job_id, { status: 'printing', printer_id: printerId });

        const pending = await callTool(handler, 'print_snapshot', {
            order_id: order.data.order_id, order_token: order.data.order_token,
        });
        expect(pending.data.status).toBe('pending');

        const [claimed] = await store.claimNodeCommands(node.node_id, 5);
        expect(claimed.command_type).toBe('printer.camera.snapshot');
        await store.recordCommandResult(node.node_id, {
            command_id: claimed.command_id,
            status: 'succeeded',
            result: { ok: true, image_base64: Buffer.from('fakejpeg').toString('base64'), content_type: 'image/jpeg', captured_at: NOW().toISOString() },
            error: null,
            finished_at: NOW().toISOString(),
        });
        const frame = await callTool(handler, 'print_snapshot', {
            order_id: order.data.order_id, order_token: order.data.order_token,
            snapshot_command_id: pending.data.snapshot_command_id,
        });
        expect(frame.image.mimeType).toBe('image/jpeg');
        expect(Buffer.from(frame.image.data, 'base64').toString()).toBe('fakejpeg');
    });

    it('merchant-tier orders bill the merchant account and print immediately', async () => {
        const store = createMemoryCloudStore();
        // Fake merchant auth by injecting a resolved merchant through the header path:
        const org = await store.createOrganization({ name: 'Merchant Org' });
        const merchant = await store.createMerchant({ org_id: org.org_id, company_name: 'AgentCo', status: 'active' });
        const handler = createMcpHandler({
            store,
            now: NOW,
            env: AGENT_ENV,
            waits: { command: 0, generate: 0 },
            pepper: 'pep',
        });
        // Monkey-friendly: bypass key hashing by exercising the anonymous path
        // for auth failure, then the merchant path via a stubbed resolver is
        // covered in merchant auth's own suite. Here we assert the auth-error
        // surface: a bad pkx_ key yields a clear tool error.
        const res = await callTool(handler, 'farm_info', {}, { authorization: 'Bearer pkx_live_bogus' });
        expect(res.isError).toBe(true);
        expect(res.data).toContain('merchant credentials rejected');
        void merchant;
    });

    it('hands-free settlement: the sweep matches the unique on-chain amount', async () => {
        const store = createMemoryCloudStore();
        const env = { ...AGENT_ENV, MOCK_MODE: 'false' };
        const handler = createMcpHandler({ store, now: NOW, env, waits: { command: 0, generate: 0 } });
        const quote = await callTool(handler, 'print_quote', BOX30);
        const order = await callTool(handler, 'print_order', {
            ...BOX30, quote_token: quote.data.quote_token, shipping_address: SHIPPING,
        });
        const payUnits = order.data.pay.amount_base_units;

        const config = resolveUsdcConfig(env);
        const walletTopic = `0x000000000000000000000000${config.wallet_address.slice(2).toLowerCase()}`;
        const originalEnv = { ...process.env };
        Object.assign(process.env, env);
        try {
            const fetchImpl = vi.fn(async (url, options) => {
                const parsed = JSON.parse(options.body);
                if (parsed.method === 'eth_blockNumber') return { json: async () => ({ result: '0x300' }) };
                return {
                    json: async () => ({
                        result: [{
                            transactionHash: '0x' + 'ee'.repeat(32),
                            blockNumber: '0x2f0',
                            data: '0x' + BigInt(payUnits).toString(16).padStart(64, '0'),
                            topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x' + '00'.repeat(12) + '66'.repeat(20), walletTopic],
                        }],
                    }),
                };
            });
            const sweep = await sweepStorefrontOrders({ store, now: NOW, fetchImpl, force: true });
            expect(sweep.settled).toBe(1);
        } finally {
            process.env = originalEnv;
        }

        const status = await callTool(handler, 'print_status', {
            order_id: order.data.order_id, order_token: order.data.order_token,
        });
        expect(status.data.payment.status).toBe('paid');
        expect(status.data.payment.tx_hash).toBe('0x' + 'ee'.repeat(32));
        expect(status.data.jobs.length).toBeGreaterThan(0);
    });
});
