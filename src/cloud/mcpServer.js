// src/cloud/mcpServer.js — remote MCP server so AI AGENTS can buy prints.
//
// Any MCP-capable agent (Claude, or anything speaking Streamable HTTP) points
// at POST /api/mcp and gets a full commerce surface:
//   farm_info       materials, USDC pricing (per-material + volume break),
//                   chain/wallet, x402 availability, limits
//   farm_capacity   LIVE printers online, queue depth, lead time, and the
//                   filament colors physically loaded in AMS units right now
//   print_preview   shaded render of the uploaded mesh (image content) so the
//                   agent can visually confirm the file BEFORE paying
//   generate_model  OpenSCAD source → STL compiled on a farm node (agents
//                   write parametric CAD as text)
//   print_quote     one file or items[] → grams + binding USDC price + token
//   print_order     quote + shipping address → order with a UNIQUE payment
//                   amount (hands-free chain matching), EIP-681 URI, and
//                   x402 requirements
//   print_pay       settle with a tx hash OR an x402 payment payload —
//                   optional: the heartbeat sweep also auto-settles by
//                   scanning the chain for the unique amount
//   print_snapshot  live camera frame of the printer running the order's job
//   print_status    payment / per-piece jobs / tracking
//   cancel_order    abandon an unpaid order
//   request_refund  file a refund request on a paid order (operator-approved)
//
// Two auth tiers: anonymous (pay-per-order USDC) and merchant — send the
// merchant API key as the Authorization bearer and orders bill to the
// merchant account (no USDC step; dispatch is immediate).
//
// Transport: stateless Streamable HTTP (JSON-RPC 2.0 over POST, JSON
// responses; GET/DELETE → 405), per-IP token-bucket rate limiting.
import crypto from 'node:crypto';
import { analyzePrintUpload } from './modelAnalysis.js';
import { renderMeshSvg } from './meshPreview.js';
import { normalizeUpload, storeUploadedJobFile } from './merchantPrintHandlers.js';
import { resolveMerchantAuth } from './merchantHandlers.js';
import { createRateLimiter } from '../utils/rateLimiter.js';
import {
    ensureStorefrontIdentity,
    finishSolidity,
    markStorefrontOrderPaid,
    normalizeFinishOptions,
    normalizeStorefrontSettings,
    requestStorefrontRefund,
    signQuoteToken,
    STOREFRONT_ORDERS_KEY,
    STOREFRONT_SETTINGS_KEY,
    verifyQuoteToken,
} from './storefrontHandlers.js';
import {
    buildEip681Uri,
    buildX402Requirements,
    computeUsdcPrice,
    resolveUsdcConfig,
    settleX402Payment,
    uniquePaymentBaseUnits,
    usdcRateForMaterial,
    verifyUsdcPayment,
} from './usdcPayments.js';
import { buildFilamentStockView, FILAMENT_REORDER_CONFIG_KEY } from './filamentReorder.js';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'printkinetix-print-farm', version: '2.0.0' };
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_ORDER_HISTORY = 500;
const QUOTE_TTL_MS = 45 * 60 * 1000;
const MAX_ITEMS = 10;
const COMMAND_WAIT_MS = 8000;
const GENERATE_WAIT_MS = 20000;
const FRESH_NODE_MS = 10 * 60 * 1000;

const INSTRUCTIONS = [
    'This server sells real 3D printing: upload (or generate) a model, pay USDC on-chain, and the farm prints and ships it.',
    'Flow: farm_info → farm_capacity (pick a loaded color for fastest routing) → print_preview (visual check) →',
    'print_quote → print_order → pay the EXACT unique USDC amount (or print_pay with x402) → print_status until shipped.',
    'Payment usually settles hands-free within minutes of the transfer; print_pay with the tx hash settles instantly.',
].join(' ');

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function sleep(ms) {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// ---------------------------------------------------------------- transport

function sendJson(res, statusCode, payload) {
    res.statusCode = statusCode;
    if (typeof res.setHeader === 'function') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
    }
    return res.end(JSON.stringify(payload));
}

function rpcResult(id, result) {
    return { jsonrpc: '2.0', id, result };
}

function rpcError(id, code, message) {
    return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function clientIp(req) {
    const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
    return forwarded || req.socket?.remoteAddress || 'unknown';
}

// ------------------------------------------------------------------- files

const PRIVATE_HOST_PATTERN = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1)/i;

async function resolveFileInput(item, fetchImpl) {
    const name = typeof item.file_name === 'string' && item.file_name.trim() ? item.file_name.trim() : null;
    if (typeof item.file_base64 === 'string' && item.file_base64.trim()) {
        if (!name) throw new Error('file_name is required with file_base64');
        return { name, base64: item.file_base64.trim() };
    }
    if (typeof item.file_url === 'string' && item.file_url.trim()) {
        const url = new URL(item.file_url.trim());
        if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('file_url must be http(s)');
        if (PRIVATE_HOST_PATTERN.test(url.hostname)) throw new Error('file_url host is not allowed');
        const response = await fetchImpl(url.toString(), { redirect: 'follow' });
        if (!response.ok) throw new Error(`file_url fetch failed: HTTP ${response.status}`);
        const declared = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) throw new Error('file exceeds the 25 MB limit');
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > MAX_FILE_BYTES) throw new Error('file exceeds the 25 MB limit');
        const urlName = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || '');
        return { name: name || urlName || 'model.stl', base64: buffer.toString('base64') };
    }
    throw new Error('Provide file_url, or file_base64 + file_name');
}

// ------------------------------------------------------------------ orders

async function loadOrders(store) {
    const raw = await store.getPlatformSetting(STOREFRONT_ORDERS_KEY, null);
    return asArray(isPlainObject(raw) ? raw.orders : []);
}

async function saveOrders(store, orders) {
    await store.upsertPlatformSetting(STOREFRONT_ORDERS_KEY, { orders: orders.slice(0, MAX_ORDER_HISTORY) });
}

async function updateOrder(store, orderId, mutate) {
    const orders = await loadOrders(store);
    const index = orders.findIndex((order) => order.order_id === orderId);
    if (index === -1) return null;
    orders[index] = mutate({ ...orders[index] }) || orders[index];
    await saveOrders(store, orders);
    return orders[index];
}

function findAuthorizedOrder(orders, orderId, token) {
    const order = orders.find((entry) => entry.order_id === orderId);
    if (!order) return null;
    const matches = crypto.timingSafeEqual(
        Buffer.from(String(order.access_token || '').padEnd(64, '0')),
        Buffer.from(String(token || '').padEnd(64, '0')),
    );
    return matches ? order : null;
}

function normalizeAgentAddress(source) {
    const address = isPlainObject(source) ? source : {};
    const clean = (value, max = 120) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);
    const required = {
        name: clean(address.name),
        line1: clean(address.line1),
        city: clean(address.city),
        postal_code: clean(address.postal_code, 20),
        country: (clean(address.country, 2) || '').toUpperCase() || null,
    };
    if (Object.values(required).some((value) => !value)) return null;
    return {
        line1: required.line1,
        line2: clean(address.line2),
        city: required.city,
        region: clean(address.region || address.state),
        postal_code: required.postal_code,
        country: required.country,
        _name: required.name,
    };
}

function agentOrderView(order, jobs) {
    return {
        order_id: order.order_id,
        status: order.status,
        created_at: order.created_at,
        items: asArray(order.items).length > 0
            ? order.items.map((item) => ({
                file_name: item.file_name,
                material: item.material,
                quantity: item.quantity,
                grams_per_piece: item.grams_per_piece,
            }))
            : [{ file_name: order.file_name, material: order.material, quantity: order.quantity }],
        payment: {
            provider: order.payment?.provider || 'usdc',
            status: order.paid_at ? 'paid' : (order.status === 'pending_payment' ? 'awaiting_payment' : order.payment?.status || null),
            amount_usdc: order.payment?.amount_usdc,
            amount_base_units: order.payment?.amount_base_units,
            chain: order.payment?.chain,
            pay_to: order.payment?.pay_to,
            tx_hash: order.payment?.tx_hash || null,
            refund_request: order.payment?.refund_request || null,
        },
        jobs: jobs.map((job) => ({ job_id: job.job_id, status: job.status })),
        shipment: order.shipment ? {
            carrier: order.shipment.carrier,
            service: order.shipment.service,
            tracking_code: order.shipment.tracking_code,
        } : null,
        shipping_address: order.shipping_address,
    };
}

async function waitForNodeCommand(store, commandId, timeoutMs) {
    const startedAt = Date.now();
    for (;;) {
        const command = await store.getNodeCommandById(commandId);
        const status = String(command?.status || '').toLowerCase();
        if (status === 'succeeded' || status === 'failed') return command;
        if (Date.now() - startedAt >= timeoutMs) return command || null;
        await sleep(1000);
    }
}

// ------------------------------------------------------------------- tools

const FILE_PROPS = {
    file_url: { type: 'string', description: 'Public http(s) URL of the model file (≤25 MB)' },
    file_base64: { type: 'string', description: 'Base64 file content (alternative to file_url)' },
    file_name: { type: 'string', description: 'File name incl. extension (required with file_base64)' },
    material: { type: 'string', description: 'PLA (default), PETG, ABS, ASA, or TPU' },
    quantity: { type: 'integer', minimum: 1, maximum: 20 },
    color_hex: { type: 'string', description: 'Preferred filament color, e.g. #1976D2' },
    scale_percent: { type: 'integer', minimum: 25, maximum: 400 },
    infill: { type: 'string', enum: ['light', 'standard', 'strong'] },
    quality: { type: 'string', enum: ['draft', 'standard', 'fine'] },
};
const ITEMS_PROP = {
    items: {
        type: 'array',
        maxItems: MAX_ITEMS,
        description: 'Multiple parts in ONE order/shipment (each: file + options). Alternative to the top-level single-file fields.',
        items: { type: 'object', properties: { ...FILE_PROPS }, additionalProperties: false },
    },
};

const TOOLS = [
    {
        name: 'farm_info',
        description: 'Capabilities and pricing of this 3D print farm: materials, USDC price per gram (per-material rates + volume discount), payment chain/token/wallet, x402 support, and limits. Call this first.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'farm_capacity',
        description: 'LIVE farm state: printers online/printing, queue depth, estimated lead time, and which filament materials/colors are physically loaded in AMS units right now (picking a loaded color routes fastest).',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'print_preview',
        description: 'Shaded isometric render of an uploaded STL/OBJ (returned as an image) plus exact dimensions — visually confirm it is the right part BEFORE quoting/paying.',
        inputSchema: {
            type: 'object',
            properties: {
                file_url: FILE_PROPS.file_url,
                file_base64: FILE_PROPS.file_base64,
                file_name: FILE_PROPS.file_name,
                color_hex: FILE_PROPS.color_hex,
            },
            additionalProperties: false,
        },
    },
    {
        name: 'generate_model',
        description: 'Compile OpenSCAD source code into an STL on a farm node — write parametric CAD as text, then feed the returned STL to print_preview / print_quote. If the result says "generating", call again with the generation_id.',
        inputSchema: {
            type: 'object',
            properties: {
                scad_source: { type: 'string', description: 'OpenSCAD program (≤200 KB)' },
                file_name: { type: 'string', description: 'Name for the generated STL (default generated.stl)' },
                generation_id: { type: 'string', description: 'Poll a previous generation instead of starting a new one' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'print_quote',
        description: 'Binding price quote. Single file (top-level fields) or up to 10 items in one order. Price = filament grams × USDC rate (per-material, volume discount) + one flat shipping. Returns quote_token for print_order.',
        inputSchema: { type: 'object', properties: { ...FILE_PROPS, ...ITEMS_PROP }, additionalProperties: false },
    },
    {
        name: 'print_order',
        description: 'Create the order from a quote (same files/options + quote_token) with the recipient shipping address. Returns a UNIQUE USDC amount (pay it and settlement is automatic — no further calls strictly needed), an EIP-681 payment URI, and x402 requirements. With merchant-key auth, the order bills the merchant account and prints immediately.',
        inputSchema: {
            type: 'object',
            properties: {
                ...FILE_PROPS,
                ...ITEMS_PROP,
                quote_token: { type: 'string' },
                email: { type: 'string', description: 'Optional email for receipts + tracking' },
                shipping_address: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        line1: { type: 'string' },
                        line2: { type: 'string' },
                        city: { type: 'string' },
                        region: { type: 'string' },
                        postal_code: { type: 'string' },
                        country: { type: 'string', description: '2-letter code, e.g. US' },
                    },
                    required: ['name', 'line1', 'city', 'postal_code', 'country'],
                },
            },
            required: ['quote_token', 'shipping_address'],
            additionalProperties: false,
        },
    },
    {
        name: 'print_pay',
        description: 'Settle an order explicitly: pass tx_hash (USDC transfer) OR x402_payment (signed x402 payload). Paying the unique amount on-chain also settles automatically within minutes without calling this.',
        inputSchema: {
            type: 'object',
            properties: {
                order_id: { type: 'string' },
                order_token: { type: 'string' },
                tx_hash: { type: 'string', description: '0x… transaction hash of the USDC transfer' },
                x402_payment: { type: 'string', description: 'x402 payment payload (X-PAYMENT header value)' },
            },
            required: ['order_id', 'order_token'],
            additionalProperties: false,
        },
    },
    {
        name: 'print_snapshot',
        description: 'Live camera photo (image) of the printer currently running one of this order\'s jobs. If it returns pending, call again with the snapshot_command_id.',
        inputSchema: {
            type: 'object',
            properties: {
                order_id: { type: 'string' },
                order_token: { type: 'string' },
                snapshot_command_id: { type: 'string', description: 'Poll a previous snapshot request' },
            },
            required: ['order_id', 'order_token'],
            additionalProperties: false,
        },
    },
    {
        name: 'print_status',
        description: 'Live status of an order: payment state, per-piece print job progress, and the shipping tracking number once shipped.',
        inputSchema: {
            type: 'object',
            properties: { order_id: { type: 'string' }, order_token: { type: 'string' } },
            required: ['order_id', 'order_token'],
            additionalProperties: false,
        },
    },
    {
        name: 'cancel_order',
        description: 'Cancel an UNPAID order (frees its unique payment amount). Paid orders use request_refund instead.',
        inputSchema: {
            type: 'object',
            properties: { order_id: { type: 'string' }, order_token: { type: 'string' } },
            required: ['order_id', 'order_token'],
            additionalProperties: false,
        },
    },
    {
        name: 'request_refund',
        description: 'File a refund request on a PAID order. USDC refunds are operator-approved (a human sends the funds back); the request is queued and the operator alerted.',
        inputSchema: {
            type: 'object',
            properties: {
                order_id: { type: 'string' },
                order_token: { type: 'string' },
                reason: { type: 'string' },
            },
            required: ['order_id', 'order_token'],
            additionalProperties: false,
        },
    },
];

export function createMcpHandler({
    store,
    now = () => new Date(),
    fetchImpl = fetch,
    mailer = null,
    env = process.env,
    pepper = process.env.MERCHANT_API_KEY_PEPPER || process.env.NODE_TOKEN_PEPPER,
    rateLimiter = createRateLimiter({ capacity: 120, refillPerSec: 2 }),
    waits = { command: COMMAND_WAIT_MS, generate: GENERATE_WAIT_MS },
}) {
    if (!store) throw new Error('store is required');

    async function loadStorefrontSettings() {
        return normalizeStorefrontSettings(await store.getPlatformSetting(STOREFRONT_SETTINGS_KEY, null));
    }

    async function freshOverview() {
        return store.getCloudOverview({ orgId: null, limit: 100 });
    }

    // One item (file + options) → parsed upload + analysis + per-item price
    // (shipping excluded; added once at the order level).
    async function analyzeItem(raw, usdc, settings) {
        const file = await resolveFileInput(raw, fetchImpl);
        const upload = normalizeUpload({ file: { name: file.name, base64: file.base64 } });
        const material = settings.materials.includes(String(raw.material || '').toUpperCase())
            ? String(raw.material).toUpperCase()
            : settings.materials[0];
        const quantity = Math.max(1, Math.min(Number.parseInt(raw.quantity, 10) || 1, 20));
        const finish = normalizeFinishOptions(raw);
        const analysis = analyzePrintUpload({
            fileName: upload.file.originalName,
            buffer: upload.file.buffer,
            material,
            solidity: finishSolidity(finish),
            scalePercent: finish.scale_percent,
        });
        const price = computeUsdcPrice({
            gramsPerPiece: analysis.estimated_grams,
            quantity,
            config: { ...usdc, shipping_flat: 0 },
            material,
        });
        return { upload, material, quantity, finish, analysis, price };
    }

    async function analyzeArgs(args) {
        const usdc = resolveUsdcConfig(env);
        if (!usdc.enabled && !usdc.mock) {
            throw new Error('USDC payments are not configured on this farm (operator must set USDC_WALLET_ADDRESS).');
        }
        const settings = await loadStorefrontSettings();
        const rawItems = asArray(args.items).length > 0 ? args.items.slice(0, MAX_ITEMS) : [args];
        const items = [];
        for (const raw of rawItems) {
            items.push(await analyzeItem(isPlainObject(raw) ? raw : {}, usdc, settings));
        }
        const filamentUsdc = items.reduce((sum, item) => sum + item.price.filament_usdc, 0);
        const totalUsdc = Math.ceil((filamentUsdc + usdc.shipping_flat) * 100) / 100;
        const totalBaseUnits = String(BigInt(Math.round(totalUsdc * 100)) * 10000n);
        // Token binds every file+option through one combined digest.
        const combinedChecksum = crypto.createHash('sha256').update(items.map((item) => [
            item.upload.file.checksum, item.material, item.quantity,
            item.finish.scale_percent, item.finish.infill, item.finish.quality,
        ].join('|')).join('+')).digest('hex');

        return {
            usdc,
            settings,
            items,
            combinedChecksum,
            totals: {
                filament_usdc: Math.ceil(filamentUsdc * 100) / 100,
                shipping_usdc: usdc.shipping_flat,
                total_usdc: totalUsdc,
                total_base_units: totalBaseUnits,
                grams_total: items.reduce((sum, item) => sum + item.price.grams_total, 0),
            },
        };
    }

    async function settleOrder({ order, txHash, verification }) {
        const orders = await loadOrders(store);
        const withTx = orders.map((entry) => (entry.order_id === order.order_id
            ? { ...entry, payment: { ...entry.payment, tx_hash: txHash, payer: verification?.from || null } }
            : entry));
        await saveOrders(store, withTx);
        return markStorefrontOrderPaid({
            store, orderId: order.order_id, paymentStatus: 'paid_usdc', now, mailer, fetchImpl,
        });
    }

    const toolHandlers = {
        async farm_info(_args, context) {
            const usdc = resolveUsdcConfig(env);
            const settings = await loadStorefrontSettings();
            return {
                service: 'PrintKinetix automated Bambu Lab print farm',
                materials: settings.materials,
                pricing: {
                    model: 'filament_cost',
                    usdc_per_gram: usdc.price_per_gram,
                    material_rates: Object.fromEntries(
                        settings.materials.map((material) => [material, usdcRateForMaterial(usdc, material)]),
                    ),
                    volume_discount: usdc.volume_break_grams > 0
                        ? { over_grams: usdc.volume_break_grams, percent_off: usdc.volume_discount_pct }
                        : null,
                    shipping_flat_usdc: usdc.shipping_flat,
                },
                payment: usdc.enabled || usdc.mock ? {
                    currency: 'USDC',
                    chain: usdc.chain,
                    chain_id: usdc.chain_id,
                    token_address: usdc.token_address,
                    pay_to: usdc.wallet_address,
                    min_confirmations: usdc.min_confirmations,
                    auto_settlement: 'Pay the unique order amount and the farm detects it on-chain automatically.',
                    x402: Boolean(usdc.x402_facilitator_url || usdc.mock),
                } : { configured: false },
                account_tier: context.merchant
                    ? { type: 'merchant', merchant_id: context.merchant.merchant_id, billing: 'merchant_account (no per-order USDC needed)' }
                    : { type: 'anonymous', billing: 'usdc_per_order' },
                limits: { max_file_mb: 25, max_items_per_order: MAX_ITEMS, max_quantity: 20, quote_ttl_minutes: 45 },
                file_formats: ['stl', 'obj', 'step', '3mf', 'gcode.3mf', 'gcode'],
                flow: ['farm_capacity', 'print_preview', 'print_quote', 'print_order', 'pay (auto-settles) or print_pay', 'print_snapshot', 'print_status'],
            };
        },

        async farm_capacity() {
            const overview = await freshOverview();
            const nowMs = now().getTime();
            const printers = asArray(overview.printers).filter((printer) => {
                const lastSeen = printer.last_seen_at ? new Date(printer.last_seen_at).getTime() : 0;
                return nowMs - lastSeen < FRESH_NODE_MS;
            });
            const printing = printers.filter((printer) => /run|print/i.test(String(printer.status || ''))).length;
            const queued = asArray(overview.jobs).filter((job) => ['queued', 'waiting_for_capacity', 'assigned'].includes(String(job.status || '').toLowerCase())).length;
            const idle = Math.max(printers.length - printing, 0);

            const [reorderConfig, inventory] = await Promise.all([
                store.getPlatformSetting(FILAMENT_REORDER_CONFIG_KEY, null),
                store.getPlatformSetting('farm_filament_inventory', { spools: [] }),
            ]);
            const stock = buildFilamentStockView({
                config: reorderConfig,
                spools: asArray(inventory?.spools),
                printers: asArray(overview.printers),
                now,
            });
            const loaded = stock
                .filter((entry) => entry.ams_tray_count > 0)
                .map((entry) => ({
                    material: entry.material,
                    color_hex: entry.color_hex,
                    color_name: entry.color_name,
                    trays_loaded: entry.ams_tray_count,
                    est_grams_available: entry.est_grams,
                }));

            const leadHours = printers.length === 0
                ? null
                : Math.round((queued / Math.max(printers.length, 1)) * 0.75 * 10) / 10 + 12;
            return {
                printers_online: printers.length,
                printers_printing: printing,
                printers_idle: idle,
                jobs_in_queue: queued,
                estimated_lead_time_hours: leadHours,
                lead_time_note: leadHours === null
                    ? 'No printers are online right now — orders will queue until the farm reconnects.'
                    : 'Estimate: queue drain + handling. Picking a loaded color below routes fastest.',
                filament_loaded_now: loaded,
            };
        },

        async print_preview(args) {
            const file = await resolveFileInput(args, fetchImpl);
            const buffer = Buffer.from(file.base64, 'base64');
            const rendered = renderMeshSvg({
                fileName: file.name,
                buffer,
                colorHex: typeof args.color_hex === 'string' ? args.color_hex : '#0F766E',
            });
            if (!rendered) {
                throw new Error('No mesh preview for this format (STL and OBJ render; sliced/STEP files do not).');
            }
            return {
                _image: { data: Buffer.from(rendered.svg, 'utf8').toString('base64'), mimeType: 'image/svg+xml' },
                file_name: file.name,
                triangle_count: rendered.triangle_count,
                dimensions_mm: rendered.bounds.size.map((value) => Math.round(value * 10) / 10),
            };
        },

        async generate_model(args) {
            const overview = await freshOverview();
            if (typeof args.generation_id === 'string' && args.generation_id.trim()) {
                const command = await store.getNodeCommandById(args.generation_id.trim());
                if (!command) throw new Error('generation_not_found');
                const status = String(command.status || '').toLowerCase();
                if (status === 'succeeded') {
                    return {
                        status: 'done',
                        file_name: command.result?.file_name,
                        file_base64: command.result?.stl_base64,
                        byte_size: command.result?.byte_size,
                        next_step: 'Feed file_base64 + file_name to print_preview or print_quote.',
                    };
                }
                if (status === 'failed') throw new Error(`generation_failed: ${command.error || 'unknown'}`);
                return { status: 'generating', generation_id: command.command_id, hint: 'Call generate_model again with this generation_id.' };
            }

            const scadSource = String(args.scad_source || '');
            if (!scadSource.trim()) throw new Error('scad_source is required');
            if (scadSource.length > 200_000) throw new Error('scad_source exceeds the 200 KB limit');
            const nowMs = now().getTime();
            const nodes = asArray(overview.nodes).filter((node) => {
                const lastSeen = node.last_seen_at ? new Date(node.last_seen_at).getTime() : 0;
                return nowMs - lastSeen < FRESH_NODE_MS;
            });
            const capable = nodes.find((node) => node.capabilities?.can_generate_models === true) || nodes[0];
            if (!capable) throw new Error('No farm node is online to run OpenSCAD right now — try again shortly.');

            const command = await store.createNodeCommand({
                org_id: capable.org_id || capable.organization_id,
                node_id: capable.node_id,
                command_type: 'cloud.model.generate',
                payload: {
                    scad_source: scadSource,
                    file_name: typeof args.file_name === 'string' ? args.file_name : 'generated.stl',
                    source: 'mcp_agent',
                },
            });
            const finished = await waitForNodeCommand(store, command.command_id, waits.generate);
            const status = String(finished?.status || '').toLowerCase();
            if (status === 'succeeded') {
                return {
                    status: 'done',
                    file_name: finished.result?.file_name,
                    file_base64: finished.result?.stl_base64,
                    byte_size: finished.result?.byte_size,
                    next_step: 'Feed file_base64 + file_name to print_preview or print_quote.',
                };
            }
            if (status === 'failed') throw new Error(`generation_failed: ${finished.error || 'unknown'}`);
            return { status: 'generating', generation_id: command.command_id, hint: 'The node is compiling; call generate_model again with this generation_id.' };
        },

        async print_quote(args) {
            const { usdc, items, combinedChecksum, totals } = await analyzeArgs(args);
            const identity = await ensureStorefrontIdentity(store);
            const expiresAtMs = now().getTime() + QUOTE_TTL_MS;
            const quoteToken = signQuoteToken({
                secret: identity.quote_secret,
                checksum: combinedChecksum,
                material: 'ORDER',
                quantity: items.length,
                totalCents: Number(totals.total_base_units),
                expiresAtMs,
            });
            return {
                items: items.map((item) => ({
                    file: { name: item.upload.file.originalName, mode: item.upload.file.fileMode, checksum_sha256: item.upload.file.checksum },
                    material: item.material,
                    quantity: item.quantity,
                    finish: item.finish,
                    grams_per_piece: item.analysis.estimated_grams,
                    estimate_basis: item.analysis.estimate_basis,
                    usdc_rate_per_gram: item.price.price_per_gram_usdc,
                    filament_usdc: item.price.filament_usdc,
                })),
                totals: { ...totals, currency: 'USDC' },
                payment_preview: { chain: usdc.chain, token_address: usdc.token_address, pay_to: usdc.wallet_address },
                quote_token: quoteToken,
                quote_expires_at: new Date(expiresAtMs).toISOString(),
                next_step: 'Call print_order with the same files + options, this quote_token, and the shipping address.',
            };
        },

        async print_order(args, context) {
            const { usdc, items, combinedChecksum, totals } = await analyzeArgs(args);
            const identity = await ensureStorefrontIdentity(store);
            const tokenOk = verifyQuoteToken({
                secret: identity.quote_secret,
                token: args.quote_token,
                checksum: combinedChecksum,
                material: 'ORDER',
                quantity: items.length,
                totalCents: Number(totals.total_base_units),
                nowMs: now().getTime(),
            });
            if (!tokenOk) throw new Error('quote_expired_or_changed — request a fresh print_quote for these exact files and options.');

            const address = normalizeAgentAddress(args.shipping_address);
            if (!address) throw new Error('shipping_address needs name, line1, city, postal_code, and 2-letter country.');
            const email = typeof args.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.email.trim())
                ? args.email.trim() : null;

            // Merchant tier bills the merchant account and prints immediately.
            const merchantTier = Boolean(context.merchant);
            const merchant = merchantTier
                ? { org_id: context.merchant.org_id, merchant_id: context.merchant.merchant_id }
                : { org_id: identity.org_id, merchant_id: identity.merchant_id };

            const orderItems = [];
            for (const item of items) {
                const fileRecord = await storeUploadedJobFile({ store, merchant, upload: item.upload, now });
                orderItems.push({
                    file_record: fileRecord,
                    file_name: item.upload.file.originalName,
                    checksum_sha256: item.upload.file.checksum,
                    material: item.material,
                    quantity: item.quantity,
                    finish: item.finish,
                    grams_per_piece: item.analysis.estimated_grams,
                    filament_usdc: item.price.filament_usdc,
                });
            }

            const orderId = `sfo_${crypto.randomUUID()}`;
            const accessToken = crypto.randomBytes(16).toString('hex');
            const { _name: recipientName, ...shippingAddress } = address;

            // Unique payable amount → hands-free on-chain matching.
            const openOrders = await loadOrders(store);
            const taken = new Set(openOrders
                .filter((entry) => entry.status === 'pending_payment' && entry.payment?.amount_base_units)
                .map((entry) => entry.payment.amount_base_units));
            const payBaseUnits = merchantTier
                ? totals.total_base_units
                : uniquePaymentBaseUnits({ baseUnits: totals.total_base_units, orderId, takenAmounts: taken });
            const payUsdc = (Number(payBaseUnits) / 1e6).toFixed(6);

            const order = {
                order_id: orderId,
                access_token: accessToken,
                created_at: now().toISOString(),
                status: 'pending_payment',
                source: merchantTier ? 'mcp_merchant' : 'mcp_agent',
                email,
                customer_name: recipientName,
                shipping_address: shippingAddress,
                material: orderItems[0].material,
                quantity: orderItems[0].quantity,
                finish: orderItems[0].finish,
                file_name: orderItems.length > 1 ? `${orderItems.length} items` : orderItems[0].file_name,
                checksum_sha256: orderItems[0].checksum_sha256,
                items: orderItems,
                quote: {
                    currency: 'USDC',
                    estimates: { grams_per_piece: orderItems[0].grams_per_piece, estimate_basis: items[0].analysis.estimate_basis },
                    totals: { total_cents: Math.round(totals.total_usdc * 100) },
                    usdc: totals,
                },
                print_job_ids: [],
                payment: merchantTier ? {
                    provider: 'merchant_account',
                    status: 'billed_to_merchant',
                    merchant_id: merchant.merchant_id,
                    amount_usdc: totals.total_usdc,
                    amount_base_units: totals.total_base_units,
                } : {
                    provider: 'usdc',
                    status: 'awaiting_transfer',
                    chain: usdc.chain,
                    chain_id: usdc.chain_id,
                    token_address: usdc.token_address,
                    pay_to: usdc.wallet_address,
                    amount_usdc: Number(payUsdc),
                    amount_base_units: payBaseUnits,
                    tx_hash: null,
                },
            };
            await saveOrders(store, [order, ...openOrders]);

            if (merchantTier) {
                const paid = await markStorefrontOrderPaid({
                    store, orderId, paymentStatus: 'billed_to_merchant', now, mailer, fetchImpl,
                });
                return {
                    order_id: orderId,
                    order_token: accessToken,
                    status: paid?.status || 'processing',
                    billing: 'merchant_account',
                    jobs_created: asArray(paid?.print_job_ids).length,
                    next_step: 'Printing started — poll print_status (and print_snapshot) for progress.',
                };
            }

            return {
                order_id: orderId,
                order_token: accessToken,
                status: 'pending_payment',
                pay: {
                    currency: 'USDC',
                    chain: usdc.chain,
                    chain_id: usdc.chain_id,
                    token_address: usdc.token_address,
                    pay_to: usdc.wallet_address,
                    amount_usdc: payUsdc,
                    amount_base_units: payBaseUnits,
                    min_confirmations: usdc.min_confirmations,
                    eip681_uri: buildEip681Uri({ config: usdc, baseUnits: payBaseUnits }),
                    x402: (usdc.x402_facilitator_url || usdc.mock)
                        ? { supported: true, requirements: buildX402Requirements({ config: usdc, baseUnits: payBaseUnits, resource: `printkinetix:order:${orderId}` }) }
                        : { supported: false },
                },
                next_step: `Transfer EXACTLY ${payUsdc} USDC on ${usdc.chain} to ${usdc.wallet_address} — the unique amount is how the farm matches your payment automatically (settles within ~5 min of confirmation). For instant settlement call print_pay with the tx hash, or pass x402_payment.`,
            };
        },

        async print_pay(args) {
            const usdc = resolveUsdcConfig(env);
            const orders = await loadOrders(store);
            const order = findAuthorizedOrder(orders, String(args.order_id || ''), String(args.order_token || ''));
            if (!order) throw new Error('order_not_found');
            if (order.paid_at) {
                return { order_id: order.order_id, status: order.status, note: 'Order is already paid.' };
            }

            // x402 path: facilitator verifies + broadcasts the signed transfer.
            if (typeof args.x402_payment === 'string' && args.x402_payment.trim()) {
                const requirements = buildX402Requirements({
                    config: usdc,
                    baseUnits: order.payment.amount_base_units,
                    resource: `printkinetix:order:${order.order_id}`,
                });
                const settlement = await settleX402Payment({
                    config: usdc, paymentPayload: args.x402_payment.trim(), requirements, fetchImpl,
                });
                if (!settlement.settled) {
                    return { order_id: order.order_id, status: 'pending_payment', verified: false, reason: settlement.reason, detail: settlement.detail || settlement.hint || null };
                }
                const paid = await settleOrder({ order, txHash: settlement.tx_hash || `x402_${order.order_id}`, verification: null });
                return {
                    order_id: order.order_id,
                    status: paid?.status || 'paid',
                    verified: true,
                    via: 'x402',
                    jobs_created: asArray(paid?.print_job_ids).length,
                    next_step: 'Printing has started. Poll print_status for progress and tracking.',
                };
            }

            const txHash = String(args.tx_hash || '').trim();
            if (!txHash) throw new Error('Provide tx_hash or x402_payment.');
            if (orders.some((entry) => entry.order_id !== order.order_id && entry.payment?.tx_hash === txHash)) {
                throw new Error('tx_already_used_for_another_order');
            }
            const verification = await verifyUsdcPayment({
                config: usdc, txHash, requiredBaseUnits: order.payment.amount_base_units, fetchImpl,
            });
            if (!verification.verified) {
                return {
                    order_id: order.order_id,
                    status: 'pending_payment',
                    verified: false,
                    reason: verification.reason,
                    ...(verification.confirmations !== undefined ? { confirmations: verification.confirmations } : {}),
                    hint: verification.reason === 'awaiting_confirmations'
                        ? 'Call print_pay again in a minute.'
                        : 'Check the transaction pays the exact wallet, token, and amount from print_order.',
                };
            }
            const paid = await settleOrder({ order, txHash, verification });
            return {
                order_id: order.order_id,
                status: paid?.status || 'paid',
                verified: true,
                confirmations: verification.confirmations,
                jobs_created: asArray(paid?.print_job_ids).length,
                explorer: `${usdc.explorer_tx}${txHash}`,
                next_step: 'Printing has started. Poll print_status for progress and the tracking number.',
            };
        },

        async print_snapshot(args) {
            const orders = await loadOrders(store);
            const order = findAuthorizedOrder(orders, String(args.order_id || ''), String(args.order_token || ''));
            if (!order) throw new Error('order_not_found');

            if (typeof args.snapshot_command_id === 'string' && args.snapshot_command_id.trim()) {
                const command = await store.getNodeCommandById(args.snapshot_command_id.trim());
                if (!command) throw new Error('snapshot_not_found');
                const status = String(command.status || '').toLowerCase();
                if (status === 'succeeded' && command.result?.image_base64) {
                    return {
                        _image: { data: command.result.image_base64, mimeType: command.result.content_type || 'image/jpeg' },
                        captured_at: command.result.captured_at || null,
                    };
                }
                if (status === 'failed') throw new Error(`snapshot_failed: ${command.error || 'camera unavailable'}`);
                return { status: 'pending', snapshot_command_id: command.command_id, hint: 'Call again in a few seconds.' };
            }

            // Find a job of this order that is on a printer right now.
            let activeJob = null;
            for (const jobId of asArray(order.print_job_ids)) {
                const job = await store.getPrintJobById(jobId);
                if (job && ['printing', 'assigned', 'queued'].includes(String(job.status || '').toLowerCase()) && job.printer_id) {
                    activeJob = job;
                    if (String(job.status).toLowerCase() === 'printing') break;
                }
            }
            if (!activeJob) {
                throw new Error(order.status === 'shipped'
                    ? 'Order already shipped — nothing is on a printer.'
                    : 'No job from this order is on a printer yet (still queued or awaiting payment).');
            }
            const overview = await freshOverview();
            const printer = asArray(overview.printers).find((entry) => entry.printer_id === activeJob.printer_id);
            if (!printer?.local_printer_id || !printer?.node_id) {
                throw new Error('The assigned printer is not reporting — snapshot unavailable right now.');
            }
            const command = await store.createNodeCommand({
                org_id: printer.org_id,
                node_id: printer.node_id,
                printer_id: printer.printer_id,
                command_type: 'printer.camera.snapshot',
                payload: { local_printer_id: printer.local_printer_id, source: 'mcp_agent' },
            });
            const finished = await waitForNodeCommand(store, command.command_id, waits.command);
            const status = String(finished?.status || '').toLowerCase();
            if (status === 'succeeded' && finished.result?.image_base64) {
                return {
                    _image: { data: finished.result.image_base64, mimeType: finished.result.content_type || 'image/jpeg' },
                    captured_at: finished.result.captured_at || null,
                    printer: printer.name || printer.local_printer_id,
                    job_id: activeJob.job_id,
                };
            }
            if (status === 'failed') throw new Error(`snapshot_failed: ${finished.error || 'camera unavailable'}`);
            return { status: 'pending', snapshot_command_id: command.command_id, hint: 'The node is fetching the frame — call print_snapshot again with this snapshot_command_id.' };
        },

        async print_status(args) {
            const orders = await loadOrders(store);
            const order = findAuthorizedOrder(orders, String(args.order_id || ''), String(args.order_token || ''));
            if (!order) throw new Error('order_not_found');
            const jobs = [];
            for (const jobId of asArray(order.print_job_ids)) {
                try {
                    const job = typeof store.getPrintJobById === 'function' ? await store.getPrintJobById(jobId) : null;
                    if (job) jobs.push(job);
                } catch { /* best-effort */ }
            }
            return agentOrderView(order, jobs);
        },

        async cancel_order(args) {
            const orders = await loadOrders(store);
            const order = findAuthorizedOrder(orders, String(args.order_id || ''), String(args.order_token || ''));
            if (!order) throw new Error('order_not_found');
            if (order.paid_at) throw new Error('order_already_paid — use request_refund instead.');
            if (order.status !== 'pending_payment') throw new Error(`order_not_cancelable (status ${order.status})`);
            const updated = await updateOrder(store, order.order_id, (entry) => ({
                ...entry,
                status: 'canceled',
                canceled_at: now().toISOString(),
            }));
            return { order_id: order.order_id, status: updated.status };
        },

        async request_refund(args) {
            const orders = await loadOrders(store);
            const order = findAuthorizedOrder(orders, String(args.order_id || ''), String(args.order_token || ''));
            if (!order) throw new Error('order_not_found');
            const result = await requestStorefrontRefund({
                store,
                orderId: order.order_id,
                token: String(args.order_token || ''),
                reason: typeof args.reason === 'string' ? args.reason : null,
                now,
                fetchImpl,
                mailer,
            });
            return {
                ...result,
                note: 'USDC refunds are sent manually by the operator; the request is queued and the operator has been alerted.',
            };
        },
    };

    async function resolveContext(req) {
        const header = String(req.headers?.authorization || '');
        if (!header.startsWith('Bearer pkx_')) return { merchant: null, authError: null };
        try {
            const auth = await resolveMerchantAuth(req, { store, pepper, now });
            return { merchant: auth?.merchant || null, authError: null };
        } catch (error) {
            return { merchant: null, authError: String(error.message || 'invalid_merchant_credentials') };
        }
    }

    async function handleMessage(message, context) {
        if (!isPlainObject(message) || message.jsonrpc !== '2.0') {
            return rpcError(message?.id, -32600, 'Invalid JSON-RPC request');
        }
        const { id, method, params } = message;
        const isNotification = id === undefined || id === null;

        try {
            if (method === 'initialize') {
                const requested = params?.protocolVersion;
                return rpcResult(id, {
                    protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : '2025-03-26',
                    capabilities: { tools: { listChanged: false } },
                    serverInfo: SERVER_INFO,
                    instructions: INSTRUCTIONS,
                });
            }
            if (typeof method === 'string' && method.startsWith('notifications/')) {
                return null; // acknowledged, no body
            }
            if (method === 'ping') return rpcResult(id, {});
            if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });
            if (method === 'tools/call') {
                const toolName = params?.name;
                const handler = toolHandlers[toolName];
                if (!handler) return rpcError(id, -32602, `Unknown tool: ${toolName}`);
                if (context.authError) {
                    return rpcResult(id, {
                        content: [{ type: 'text', text: `Error: merchant credentials rejected (${context.authError}). Remove the Authorization header for anonymous USDC ordering.` }],
                        isError: true,
                    });
                }
                try {
                    const result = await handler(isPlainObject(params?.arguments) ? params.arguments : {}, context);
                    const { _image, ...textPayload } = isPlainObject(result) ? result : { value: result };
                    const content = [];
                    if (_image) content.push({ type: 'image', data: _image.data, mimeType: _image.mimeType });
                    content.push({ type: 'text', text: JSON.stringify(textPayload, null, 2) });
                    return rpcResult(id, { content, isError: false });
                } catch (error) {
                    return rpcResult(id, {
                        content: [{ type: 'text', text: `Error: ${error.message}` }],
                        isError: true,
                    });
                }
            }
            if (isNotification) return null;
            return rpcError(id, -32601, `Method not found: ${method}`);
        } catch (error) {
            return rpcError(id, -32603, `Internal error: ${error.message}`);
        }
    }

    return async function mcpHandler(req, res) {
        if (req.method !== 'POST') {
            return sendJson(res, 405, {
                ok: false,
                error: 'method_not_allowed',
                message: 'This is a Streamable HTTP MCP endpoint: POST JSON-RPC messages here. Connect your agent to this URL as a remote MCP server.',
                server: SERVER_INFO,
            });
        }

        const verdict = rateLimiter.check(clientIp(req), 1);
        if (!verdict.allowed) {
            if (typeof res.setHeader === 'function') res.setHeader('Retry-After', String(Math.ceil(verdict.retryAfterMs / 1000)));
            return sendJson(res, 429, rpcError(null, -32000, 'Rate limited — slow down and retry.'));
        }

        let body = req.body;
        if (typeof body === 'string') {
            try {
                body = JSON.parse(body);
            } catch {
                return sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
            }
        }
        const context = await resolveContext(req);
        if (Array.isArray(body)) {
            const responses = (await Promise.all(body.map((message) => handleMessage(message, context)))).filter(Boolean);
            if (responses.length === 0) return sendJson(res, 202, {});
            return sendJson(res, 200, responses);
        }
        const response = await handleMessage(body, context);
        if (response === null) return sendJson(res, 202, {});
        return sendJson(res, 200, response);
    };
}
