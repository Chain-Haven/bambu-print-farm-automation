// src/cloud/mcpServer.js — remote MCP server so AI AGENTS can buy prints.
//
// Any MCP-capable agent (Claude, or anything speaking Streamable HTTP) points
// at POST /api/mcp and gets five tools:
//   farm_info     → materials, USDC pricing, chain + wallet, limits
//   print_quote   → file (URL or base64) → grams + USDC price + quote token
//   print_order   → quote + shipping address → order awaiting payment
//   print_pay     → USDC tx hash → on-chain verify → print + ship kicks off
//   print_status  → live order/job/shipment state
//
// Payment is filament-cost-based USDC straight to the operator's wallet
// (usdcPayments.js): the agent transfers on-chain, submits the tx hash, we
// verify the Transfer log read-only via public RPC. One tx settles one order.
// Orders ride the SAME storefront machinery as human orders — routing,
// slicing, auto-print, auto-retry, label purchase, tracking.
//
// Transport: stateless Streamable HTTP (JSON-RPC 2.0 over POST, JSON
// responses; GET/DELETE → 405). No sessions, no SSE — every request is
// self-contained, which is exactly what serverless wants.
import crypto from 'node:crypto';
import { analyzePrintUpload } from './modelAnalysis.js';
import { normalizeUpload, storeUploadedJobFile } from './merchantPrintHandlers.js';
import {
    ensureStorefrontIdentity,
    finishSolidity,
    markStorefrontOrderPaid,
    normalizeFinishOptions,
    normalizeStorefrontSettings,
    signQuoteToken,
    STOREFRONT_ORDERS_KEY,
    STOREFRONT_SETTINGS_KEY,
    verifyQuoteToken,
} from './storefrontHandlers.js';
import { computeUsdcPrice, resolveUsdcConfig, verifyUsdcPayment } from './usdcPayments.js';

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'printkinetix-print-farm', version: '1.0.0' };
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_ORDER_HISTORY = 500;
const QUOTE_TTL_MS = 45 * 60 * 1000;

const INSTRUCTIONS = [
    'This server sells real 3D printing: upload a model, pay USDC on-chain, and the farm prints and ships it.',
    'Flow: (1) farm_info for pricing/chain, (2) print_quote with your file, (3) print_order with shipping address,',
    '(4) transfer the exact USDC amount to the wallet, (5) print_pay with the transaction hash,',
    '(6) poll print_status for job progress and the shipping tracking number.',
].join(' ');

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
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

// ------------------------------------------------------------------- files

const PRIVATE_HOST_PATTERN = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1)/i;

async function resolveFileInput(args, fetchImpl) {
    const name = typeof args.file_name === 'string' && args.file_name.trim() ? args.file_name.trim() : null;
    if (typeof args.file_base64 === 'string' && args.file_base64.trim()) {
        if (!name) throw new Error('file_name is required with file_base64');
        return { name, base64: args.file_base64.trim() };
    }
    if (typeof args.file_url === 'string' && args.file_url.trim()) {
        const url = new URL(args.file_url.trim());
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
        material: order.material,
        quantity: order.quantity,
        file_name: order.file_name,
        payment: {
            provider: 'usdc',
            status: order.paid_at ? 'paid' : 'awaiting_payment',
            amount_usdc: order.payment?.amount_usdc,
            amount_base_units: order.payment?.amount_base_units,
            chain: order.payment?.chain,
            token_address: order.payment?.token_address,
            pay_to: order.payment?.pay_to,
            tx_hash: order.payment?.tx_hash || null,
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

// ------------------------------------------------------------------- tools

const TOOLS = [
    {
        name: 'farm_info',
        description: 'Capabilities and pricing of this 3D print farm: materials, USDC price per gram of filament, flat shipping, payment chain/token/wallet, and file limits. Call this first.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'print_quote',
        description: 'Get a binding price quote for printing a 3D model. Provide the file by URL (file_url) or inline (file_base64 + file_name). Formats: STL, OBJ, STEP, 3MF, gcode.3mf. Price = filament grams × USDC rate + flat shipping. Returns a quote_token needed by print_order.',
        inputSchema: {
            type: 'object',
            properties: {
                file_url: { type: 'string', description: 'Public http(s) URL of the model file (≤25 MB)' },
                file_base64: { type: 'string', description: 'Base64 file content (alternative to file_url)' },
                file_name: { type: 'string', description: 'File name incl. extension (required with file_base64)' },
                material: { type: 'string', description: 'PLA (default), PETG, ABS, ASA, or TPU' },
                quantity: { type: 'integer', minimum: 1, maximum: 20, description: 'Copies to print (default 1)' },
                color_hex: { type: 'string', description: 'Preferred filament color, e.g. #1976D2 (optional)' },
                scale_percent: { type: 'integer', minimum: 25, maximum: 400, description: 'Uniform scale (default 100)' },
                infill: { type: 'string', enum: ['light', 'standard', 'strong'] },
                quality: { type: 'string', enum: ['draft', 'standard', 'fine'] },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'print_order',
        description: 'Create the order from a quote (same file + options + quote_token) with the recipient shipping address. Returns the exact USDC amount, chain, token contract, and wallet address to pay, plus the order_id/order_token for print_pay and print_status.',
        inputSchema: {
            type: 'object',
            properties: {
                file_url: { type: 'string' },
                file_base64: { type: 'string' },
                file_name: { type: 'string' },
                material: { type: 'string' },
                quantity: { type: 'integer', minimum: 1, maximum: 20 },
                color_hex: { type: 'string' },
                scale_percent: { type: 'integer', minimum: 25, maximum: 400 },
                infill: { type: 'string', enum: ['light', 'standard', 'strong'] },
                quality: { type: 'string', enum: ['draft', 'standard', 'fine'] },
                quote_token: { type: 'string', description: 'From print_quote' },
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
        description: 'Settle an order with the USDC payment transaction hash. The transfer must pay the exact (or greater) amount to the wallet from print_order. On verification the farm immediately starts printing; shipping is automatic.',
        inputSchema: {
            type: 'object',
            properties: {
                order_id: { type: 'string' },
                order_token: { type: 'string' },
                tx_hash: { type: 'string', description: '0x… transaction hash of the USDC transfer' },
            },
            required: ['order_id', 'order_token', 'tx_hash'],
            additionalProperties: false,
        },
    },
    {
        name: 'print_status',
        description: 'Live status of an order: payment state, per-piece print job progress, and the shipping tracking number once shipped.',
        inputSchema: {
            type: 'object',
            properties: {
                order_id: { type: 'string' },
                order_token: { type: 'string' },
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
}) {
    if (!store) throw new Error('store is required');

    async function loadStorefrontSettings() {
        return normalizeStorefrontSettings(await store.getPlatformSetting(STOREFRONT_SETTINGS_KEY, null));
    }

    async function analyzeArgs(args) {
        const usdc = resolveUsdcConfig(env);
        if (!usdc.enabled && !usdc.mock) {
            throw new Error('USDC payments are not configured on this farm (operator must set USDC_WALLET_ADDRESS).');
        }
        const settings = await loadStorefrontSettings();
        const file = await resolveFileInput(args, fetchImpl);
        const upload = normalizeUpload({ file: { name: file.name, base64: file.base64 } });
        const material = settings.materials.includes(String(args.material || '').toUpperCase())
            ? String(args.material).toUpperCase()
            : settings.materials[0];
        const quantity = Math.max(1, Math.min(Number.parseInt(args.quantity, 10) || 1, 20));
        const finish = normalizeFinishOptions(args);
        const analysis = analyzePrintUpload({
            fileName: upload.file.originalName,
            buffer: upload.file.buffer,
            material,
            solidity: finishSolidity(finish),
            scalePercent: finish.scale_percent,
        });
        const price = computeUsdcPrice({ gramsPerPiece: analysis.estimated_grams, quantity, config: usdc });
        return { usdc, settings, upload, material, quantity, finish, analysis, price };
    }

    const toolHandlers = {
        async farm_info() {
            const usdc = resolveUsdcConfig(env);
            const settings = await loadStorefrontSettings();
            return {
                service: 'PrintKinetix automated Bambu Lab print farm',
                materials: settings.materials,
                pricing: {
                    model: 'filament_cost',
                    usdc_per_gram: usdc.price_per_gram,
                    shipping_flat_usdc: usdc.shipping_flat,
                },
                payment: usdc.enabled || usdc.mock ? {
                    currency: 'USDC',
                    chain: usdc.chain,
                    chain_id: usdc.chain_id,
                    token_address: usdc.token_address,
                    pay_to: usdc.wallet_address,
                    min_confirmations: usdc.min_confirmations,
                } : { configured: false },
                limits: { max_file_mb: 25, max_quantity: 20, quote_ttl_minutes: 45 },
                file_formats: ['stl', 'obj', 'step', '3mf', 'gcode.3mf', 'gcode'],
                flow: ['print_quote', 'print_order', 'transfer USDC', 'print_pay', 'print_status'],
            };
        },

        async print_quote(args) {
            const { usdc, upload, material, quantity, finish, analysis, price } = await analyzeArgs(args);
            const identity = await ensureStorefrontIdentity(store);
            const expiresAtMs = now().getTime() + QUOTE_TTL_MS;
            const quoteToken = signQuoteToken({
                secret: identity.quote_secret,
                checksum: upload.file.checksum,
                material,
                quantity,
                totalCents: Number(price.total_base_units),
                expiresAtMs,
            });
            return {
                file: { name: upload.file.originalName, mode: upload.file.fileMode, checksum_sha256: upload.file.checksum },
                material,
                quantity,
                finish,
                estimates: {
                    grams_per_piece: analysis.estimated_grams,
                    grams_total: price.grams_total,
                    estimate_basis: analysis.estimate_basis,
                },
                price: {
                    currency: 'USDC',
                    per_gram: price.price_per_gram_usdc,
                    filament_usdc: price.filament_usdc,
                    shipping_usdc: price.shipping_usdc,
                    total_usdc: price.total_usdc,
                    total_base_units: price.total_base_units,
                },
                payment_preview: { chain: usdc.chain, token_address: usdc.token_address, pay_to: usdc.wallet_address },
                quote_token: quoteToken,
                quote_expires_at: new Date(expiresAtMs).toISOString(),
                next_step: 'Call print_order with the same file + options, this quote_token, and the shipping address.',
            };
        },

        async print_order(args) {
            const { usdc, upload, material, quantity, finish, analysis, price } = await analyzeArgs(args);
            const identity = await ensureStorefrontIdentity(store);
            const tokenOk = verifyQuoteToken({
                secret: identity.quote_secret,
                token: args.quote_token,
                checksum: upload.file.checksum,
                material,
                quantity,
                totalCents: Number(price.total_base_units),
                nowMs: now().getTime(),
            });
            if (!tokenOk) throw new Error('quote_expired_or_changed — request a fresh print_quote for this exact file and options.');

            const address = normalizeAgentAddress(args.shipping_address);
            if (!address) throw new Error('shipping_address needs name, line1, city, postal_code, and 2-letter country.');
            const email = typeof args.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(args.email.trim())
                ? args.email.trim()
                : null;

            const merchant = { org_id: identity.org_id, merchant_id: identity.merchant_id };
            const fileRecord = await storeUploadedJobFile({ store, merchant, upload, now });

            const orderId = `sfo_${crypto.randomUUID()}`;
            const accessToken = crypto.randomBytes(16).toString('hex');
            const { _name: recipientName, ...shippingAddress } = address;
            const order = {
                order_id: orderId,
                access_token: accessToken,
                created_at: now().toISOString(),
                status: 'pending_payment',
                source: 'mcp_agent',
                email,
                customer_name: recipientName,
                shipping_address: shippingAddress,
                material,
                quantity,
                finish,
                quote: {
                    currency: 'USDC',
                    estimates: { grams_per_piece: analysis.estimated_grams, estimate_basis: analysis.estimate_basis },
                    totals: { total_cents: Math.round(price.total_usdc * 100) },
                    usdc: price,
                },
                file_name: upload.file.originalName,
                checksum_sha256: upload.file.checksum,
                file_record: fileRecord,
                print_job_ids: [],
                payment: {
                    provider: 'usdc',
                    status: 'awaiting_transfer',
                    chain: usdc.chain,
                    chain_id: usdc.chain_id,
                    token_address: usdc.token_address,
                    pay_to: usdc.wallet_address,
                    amount_usdc: price.total_usdc,
                    amount_base_units: price.total_base_units,
                    tx_hash: null,
                },
            };
            const orders = await loadOrders(store);
            await saveOrders(store, [order, ...orders]);

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
                    amount_usdc: price.total_usdc,
                    amount_base_units: price.total_base_units,
                    min_confirmations: usdc.min_confirmations,
                },
                next_step: `Transfer exactly ${price.total_usdc} USDC (${price.total_base_units} base units) on ${usdc.chain} to ${usdc.wallet_address}, then call print_pay with the transaction hash. Printing starts the moment the transfer verifies.`,
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
            const txHash = String(args.tx_hash || '').trim();
            // One transaction settles exactly one order — reject reuse.
            if (orders.some((entry) => entry.order_id !== order.order_id && entry.payment?.tx_hash === txHash)) {
                throw new Error('tx_already_used_for_another_order');
            }

            const verification = await verifyUsdcPayment({
                config: usdc,
                txHash,
                requiredBaseUnits: order.payment.amount_base_units,
                fetchImpl,
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

            // Record the settling tx, then run the shared paid pipeline
            // (dispatch → print → auto-ship → emails/alerts).
            const withTx = orders.map((entry) => (entry.order_id === order.order_id
                ? { ...entry, payment: { ...entry.payment, tx_hash: txHash, payer: verification.from || null } }
                : entry));
            await saveOrders(store, withTx);
            const paid = await markStorefrontOrderPaid({
                store,
                orderId: order.order_id,
                paymentStatus: 'paid_usdc',
                now,
                mailer,
                fetchImpl,
            });
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
    };

    async function handleMessage(message) {
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
                try {
                    const result = await handler(isPlainObject(params?.arguments) ? params.arguments : {});
                    return rpcResult(id, {
                        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                        isError: false,
                    });
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
        let body = req.body;
        if (typeof body === 'string') {
            try {
                body = JSON.parse(body);
            } catch {
                return sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
            }
        }
        if (Array.isArray(body)) {
            const responses = (await Promise.all(body.map(handleMessage))).filter(Boolean);
            if (responses.length === 0) return sendJson(res, 202, {});
            return sendJson(res, 200, responses);
        }
        const response = await handleMessage(body);
        if (response === null) return sendJson(res, 202, {});
        return sendJson(res, 200, response);
    };
}
