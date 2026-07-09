import { describe, expect, it, vi } from 'vitest';
import { createMemoryCloudStore } from '../../src/cloud/memoryCloudStore.js';
import { createMcpHandler } from '../../src/cloud/mcpServer.js';
import { computeUsdcPrice, resolveUsdcConfig, verifyUsdcPayment } from '../../src/cloud/usdcPayments.js';
import { STOREFRONT_ORDERS_KEY } from '../../src/cloud/storefrontHandlers.js';

const NOW = () => new Date('2026-07-09T18:00:00.000Z');

const AGENT_ENV = {
    USDC_WALLET_ADDRESS: '0x1111111111111111111111111111111111111111',
    USDC_CHAIN: 'base',
    USDC_PRICE_PER_GRAM: '0.10',
    USDC_SHIPPING_FLAT: '5',
    MOCK_MODE: 'true', // mock verification path: tx 'mock_paid'
};

// 20mm binary STL cube (12 triangles) — same fixture math as storefront tests.
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

async function rpc(handler, message) {
    const res = makeRes();
    await handler({ method: 'POST', headers: {}, body: message }, res);
    return res;
}

async function callTool(handler, name, args) {
    const res = await rpc(handler, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } });
    expect(res.statusCode).toBe(200);
    const { result } = res.body;
    return { isError: result.isError, data: result.isError ? result.content[0].text : JSON.parse(result.content[0].text) };
}

const SHIPPING = {
    name: 'Agent Recipient',
    line1: '1 Robot Way',
    city: 'Austin',
    region: 'TX',
    postal_code: '78701',
    country: 'us',
};

describe('USDC payments', () => {
    it('prices by filament cost: grams × rate + flat shipping, in exact base units', () => {
        const config = resolveUsdcConfig(AGENT_ENV);
        const price = computeUsdcPrice({ gramsPerPiece: 43, quantity: 2, config });
        expect(price.grams_total).toBe(86);
        expect(price.filament_usdc).toBeCloseTo(8.6, 2);
        expect(price.total_usdc).toBeCloseTo(13.6, 2);
        expect(price.total_base_units).toBe('13600000'); // 13.60 USDC @ 6 decimals
    });

    it('verifies a real transfer via RPC: recipient, token, amount, confirmations', async () => {
        const config = resolveUsdcConfig({ ...AGENT_ENV, MOCK_MODE: 'false', USDC_MIN_CONFIRMATIONS: '2' });
        const wallet = '0x000000000000000000000000' + config.wallet_address.slice(2);
        const makeRpc = (logs, head = '0x100') => vi.fn(async (url, options) => {
            const { method } = JSON.parse(options.body);
            const result = method === 'eth_getTransactionReceipt'
                ? { status: '0x1', blockNumber: '0xf0', logs }
                : head;
            return { json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
        });
        const goodLog = {
            address: config.token_address,
            topics: [
                '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
                '0x000000000000000000000000' + '22'.repeat(20),
                wallet.toLowerCase(),
            ],
            data: '0x' + (13600000n).toString(16).padStart(64, '0'),
        };
        const txHash = '0x' + 'ab'.repeat(32);

        const ok = await verifyUsdcPayment({
            config, txHash, requiredBaseUnits: '13600000', fetchImpl: makeRpc([goodLog]),
        });
        expect(ok.verified).toBe(true);
        expect(ok.confirmations).toBe(17);

        const wrongWallet = { ...goodLog, topics: [goodLog.topics[0], goodLog.topics[1], '0x' + '00'.repeat(12) + '33'.repeat(20)] };
        expect((await verifyUsdcPayment({ config, txHash, requiredBaseUnits: '13600000', fetchImpl: makeRpc([wrongWallet]) })).reason)
            .toBe('no_usdc_transfer_to_wallet');

        const underpaid = { ...goodLog, data: '0x' + (1000000n).toString(16).padStart(64, '0') };
        expect((await verifyUsdcPayment({ config, txHash, requiredBaseUnits: '13600000', fetchImpl: makeRpc([underpaid]) })).reason)
            .toBe('underpaid');

        expect((await verifyUsdcPayment({ config, txHash, requiredBaseUnits: '13600000', fetchImpl: makeRpc([goodLog], '0xf0') })).reason)
            .toBe('awaiting_confirmations');

        expect((await verifyUsdcPayment({ config, txHash: 'nope', requiredBaseUnits: '1' })).reason).toBe('invalid_tx_hash');
    });
});

describe('MCP protocol', () => {
    it('initializes, lists tools, acknowledges notifications, rejects unknown methods', async () => {
        const handler = createMcpHandler({ store: createMemoryCloudStore(), now: NOW, env: AGENT_ENV });

        const init = await rpc(handler, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
        expect(init.body.result.protocolVersion).toBe('2025-06-18');
        expect(init.body.result.capabilities.tools).toBeTruthy();
        expect(init.body.result.serverInfo.name).toBe('printkinetix-print-farm');

        const note = await rpc(handler, { jsonrpc: '2.0', method: 'notifications/initialized' });
        expect(note.statusCode).toBe(202);

        const list = await rpc(handler, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
        const names = list.body.result.tools.map((tool) => tool.name);
        expect(names).toEqual(['farm_info', 'print_quote', 'print_order', 'print_pay', 'print_status']);
        expect(list.body.result.tools.every((tool) => tool.inputSchema.type === 'object')).toBe(true);

        const unknown = await rpc(handler, { jsonrpc: '2.0', id: 3, method: 'resources/list' });
        expect(unknown.body.error.code).toBe(-32601);

        const get = makeRes();
        await handler({ method: 'GET', headers: {} }, get);
        expect(get.statusCode).toBe(405);
    });

    it('full agent funnel: quote → order → pay (mock chain) → printing → status', async () => {
        const store = createMemoryCloudStore();
        const handler = createMcpHandler({ store, now: NOW, env: AGENT_ENV });
        const filePayload = { file_base64: buildBoxStl(30).toString('base64'), file_name: 'bracket.stl', material: 'PETG', quantity: 2 };

        const info = await callTool(handler, 'farm_info', {});
        expect(info.data.pricing.usdc_per_gram).toBe(0.1);
        expect(info.data.payment.pay_to).toBe(AGENT_ENV.USDC_WALLET_ADDRESS);

        const quote = await callTool(handler, 'print_quote', filePayload);
        expect(quote.isError).toBeFalsy();
        expect(quote.data.estimates.estimate_basis).toBe('mesh_volume');
        expect(quote.data.price.total_usdc).toBeGreaterThan(5);
        expect(quote.data.quote_token).toContain('.');

        const order = await callTool(handler, 'print_order', {
            ...filePayload,
            quote_token: quote.data.quote_token,
            shipping_address: SHIPPING,
        });
        expect(order.isError).toBeFalsy();
        expect(order.data.status).toBe('pending_payment');
        expect(order.data.pay.amount_base_units).toBe(quote.data.price.total_base_units);

        // Not paid yet: no jobs exist.
        let status = await callTool(handler, 'print_status', {
            order_id: order.data.order_id, order_token: order.data.order_token,
        });
        expect(status.data.jobs).toHaveLength(0);
        expect(status.data.payment.status).toBe('awaiting_payment');

        const pay = await callTool(handler, 'print_pay', {
            order_id: order.data.order_id, order_token: order.data.order_token, tx_hash: 'mock_paid',
        });
        expect(pay.isError).toBeFalsy();
        expect(pay.data.verified).toBe(true);
        expect(pay.data.jobs_created).toBe(2); // one per piece

        status = await callTool(handler, 'print_status', {
            order_id: order.data.order_id, order_token: order.data.order_token,
        });
        expect(status.data.status).toBe('processing');
        expect(status.data.payment.status).toBe('paid');
        expect(status.data.payment.tx_hash).toBe('mock_paid');
        expect(status.data.jobs).toHaveLength(2);
        expect(status.data.shipping_address.city).toBe('Austin');

        // The shared storefront machinery owns the order (sweep will ship it).
        const state = await store.getPlatformSetting(STOREFRONT_ORDERS_KEY, null);
        expect(state.orders[0].source).toBe('mcp_agent');
        expect(state.orders[0].payment.provider).toBe('usdc');
    });

    it('enforces payment integrity: tampered options, reused tx, wrong token', async () => {
        const store = createMemoryCloudStore();
        const handler = createMcpHandler({ store, now: NOW, env: AGENT_ENV });
        const filePayload = { file_base64: buildBoxStl(30).toString('base64'), file_name: 'bracket.stl' };

        const quote = await callTool(handler, 'print_quote', filePayload);
        // Quantity changed after quoting → price would differ → refused.
        const tampered = await callTool(handler, 'print_order', {
            ...filePayload, quantity: 5, quote_token: quote.data.quote_token, shipping_address: SHIPPING,
        });
        expect(tampered.isError).toBe(true);
        expect(tampered.data).toContain('quote_expired_or_changed');

        // Two orders cannot settle with the same transaction hash.
        const orderA = await callTool(handler, 'print_order', {
            ...filePayload, quote_token: quote.data.quote_token, shipping_address: SHIPPING,
        });
        const quoteB = await callTool(handler, 'print_quote', filePayload);
        const orderB = await callTool(handler, 'print_order', {
            ...filePayload, quote_token: quoteB.data.quote_token, shipping_address: SHIPPING,
        });
        await callTool(handler, 'print_pay', { order_id: orderA.data.order_id, order_token: orderA.data.order_token, tx_hash: 'mock_paid' });
        const reused = await callTool(handler, 'print_pay', { order_id: orderB.data.order_id, order_token: orderB.data.order_token, tx_hash: 'mock_paid' });
        expect(reused.isError).toBe(true);
        expect(reused.data).toContain('tx_already_used');

        // Wrong order token → not found.
        const stolen = await callTool(handler, 'print_status', { order_id: orderA.data.order_id, order_token: 'wrong' });
        expect(stolen.isError).toBe(true);
        expect(stolen.data).toContain('order_not_found');
    });

    it('refuses to quote when the wallet is not configured, and blocks private file URLs', async () => {
        const store = createMemoryCloudStore();
        const disabled = createMcpHandler({ store, now: NOW, env: { MOCK_MODE: 'false' } });
        const quote = await callTool(disabled, 'print_quote', {
            file_base64: buildBoxStl(10).toString('base64'), file_name: 'x.stl',
        });
        expect(quote.isError).toBe(true);
        expect(quote.data).toContain('USDC_WALLET_ADDRESS');

        const handler = createMcpHandler({ store, now: NOW, env: AGENT_ENV });
        const ssrf = await callTool(handler, 'print_quote', { file_url: 'http://169.254.169.254/latest/meta-data' });
        expect(ssrf.isError).toBe(true);
        expect(ssrf.data).toContain('not allowed');
    });
});
