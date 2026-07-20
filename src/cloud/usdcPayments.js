// src/cloud/usdcPayments.js — self-custodial USDC payments for agent orders.
//
// Pricing is filament-cost based: USDC total = grams × USDC_PRICE_PER_GRAM ×
// quantity + flat shipping. Payment goes STRAIGHT to the operator's own
// wallet (USDC_WALLET_ADDRESS env var on Vercel) — no processor, no custody,
// no API keys. Verification is a read-only JSON-RPC check of the payer's
// transaction: receipt succeeded, it is a transfer of the chain's USDC token,
// the Transfer log pays OUR wallet at least the owed amount, and it has
// enough confirmations. A transaction hash can settle exactly one order.
//
// Env (Vercel):
//   USDC_WALLET_ADDRESS   0x… (required — enables the whole flow)
//   USDC_CHAIN            base | ethereum | polygon | arbitrum   (default base)
//   USDC_TOKEN_ADDRESS    override the chain's USDC contract (optional)
//   EVM_RPC_URL           override the public RPC endpoint (optional)
//   USDC_PRICE_PER_GRAM   default 0.05 (USDC per gram of filament)
//   USDC_SHIPPING_FLAT    default 8 (USDC per order, tracked shipping)
//   USDC_MIN_CONFIRMATIONS default 2

import crypto from 'node:crypto';

const CHAINS = {
    base: {
        chain_id: 8453,
        rpc_url: 'https://mainnet.base.org',
        usdc_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        explorer_tx: 'https://basescan.org/tx/',
    },
    ethereum: {
        chain_id: 1,
        rpc_url: 'https://cloudflare-eth.com',
        usdc_address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        explorer_tx: 'https://etherscan.io/tx/',
    },
    polygon: {
        chain_id: 137,
        rpc_url: 'https://polygon-rpc.com',
        usdc_address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
        explorer_tx: 'https://polygonscan.com/tx/',
    },
    arbitrum: {
        chain_id: 42161,
        rpc_url: 'https://arb1.arbitrum.io/rpc',
        usdc_address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
        explorer_tx: 'https://arbiscan.io/tx/',
    },
};

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const USDC_DECIMALS = 6n;

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
}

export function resolveUsdcConfig(env = process.env) {
    const chainKey = String(env.USDC_CHAIN || 'base').toLowerCase();
    const chain = CHAINS[chainKey] || CHAINS.base;
    const pricePerGram = Number(env.USDC_PRICE_PER_GRAM);
    const shippingFlat = Number(env.USDC_SHIPPING_FLAT);

    // Per-material rate overrides: USDC_PRICE_PER_GRAM_PETG=0.07 etc.
    const materialRates = {};
    for (const [key, value] of Object.entries(env)) {
        const match = /^USDC_PRICE_PER_GRAM_([A-Z0-9]+)$/.exec(key);
        if (match && Number.isFinite(Number(value)) && Number(value) > 0) {
            materialRates[match[1]] = Number(value);
        }
    }

    return {
        enabled: isNonEmptyString(env.USDC_WALLET_ADDRESS),
        wallet_address: isNonEmptyString(env.USDC_WALLET_ADDRESS) ? env.USDC_WALLET_ADDRESS.trim() : null,
        chain: CHAINS[chainKey] ? chainKey : 'base',
        chain_id: chain.chain_id,
        rpc_url: isNonEmptyString(env.EVM_RPC_URL) ? env.EVM_RPC_URL.trim() : chain.rpc_url,
        token_address: (isNonEmptyString(env.USDC_TOKEN_ADDRESS) ? env.USDC_TOKEN_ADDRESS.trim() : chain.usdc_address).toLowerCase(),
        explorer_tx: chain.explorer_tx,
        price_per_gram: Number.isFinite(pricePerGram) && pricePerGram > 0 ? pricePerGram : 0.05,
        material_rates: materialRates,
        // Single volume break: orders over BREAK grams get PCT off the filament line.
        volume_break_grams: Math.max(0, Number.parseInt(env.USDC_VOLUME_BREAK_GRAMS, 10) || 0),
        volume_discount_pct: Math.max(0, Math.min(Number(env.USDC_VOLUME_DISCOUNT_PCT) || 0, 90)),
        shipping_flat: Number.isFinite(shippingFlat) && shippingFlat >= 0 ? shippingFlat : 8,
        min_confirmations: Math.max(1, Number.parseInt(env.USDC_MIN_CONFIRMATIONS, 10) || 2),
        x402_facilitator_url: isNonEmptyString(env.X402_FACILITATOR_URL) ? env.X402_FACILITATOR_URL.trim().replace(/\/$/, '') : null,
        mock: env.MOCK_MODE === 'true',
    };
}

export function usdcRateForMaterial(config, material) {
    return config.material_rates?.[String(material || '').toUpperCase()] || config.price_per_gram;
}

// Filament-cost pricing. Returns integer USDC base units (6 decimals) plus a
// human breakdown, so on-chain comparison is exact. Supports per-material
// rates and a single volume break.
export function computeUsdcPrice({ gramsPerPiece, quantity, config, material = null }) {
    const rate = usdcRateForMaterial(config, material);
    const grams = Math.max(1, Math.ceil(Number(gramsPerPiece) || 0)) * Math.max(1, quantity);
    let filamentUsdc = grams * rate;
    let discountPct = 0;
    if (config.volume_break_grams > 0 && grams >= config.volume_break_grams && config.volume_discount_pct > 0) {
        discountPct = config.volume_discount_pct;
        filamentUsdc *= 1 - discountPct / 100;
    }
    const totalUsdc = Math.ceil((filamentUsdc + config.shipping_flat) * 100) / 100;
    return {
        grams_total: grams,
        price_per_gram_usdc: rate,
        volume_discount_pct: discountPct,
        filament_usdc: Math.ceil(filamentUsdc * 100) / 100,
        shipping_usdc: config.shipping_flat,
        total_usdc: totalUsdc,
        total_base_units: String(BigInt(Math.round(totalUsdc * 100)) * 10n ** (USDC_DECIMALS - 2n)),
    };
}

// Payment matching without tx-hash submission: every order gets a UNIQUE amount by
// adding a sub-cent dither (< 0.01 USDC) derived from the order id, bumped
// until it collides with no other open order. The chain scanner can then map
// an incoming Transfer to its order by exact amount alone.
export function uniquePaymentBaseUnits({ baseUnits, orderId, takenAmounts = new Set() }) {
    const base = BigInt(baseUnits);
    const seed = crypto.createHash('sha256').update(String(orderId)).digest();
    let dither = BigInt(seed.readUInt16BE(0) % 9000) + 1n; // 0.000001–0.009 USDC
    let candidate = base + dither;
    let attempts = 0;
    while (takenAmounts.has(candidate.toString()) && attempts < 10000) {
        dither = (dither % 9999n) + 1n;
        candidate = base + dither;
        attempts += 1;
    }
    return candidate.toString();
}

// EIP-681 payment URI — wallet-integrated agents can pay with one parse.
export function buildEip681Uri({ config, baseUnits }) {
    if (!config.wallet_address) return null;
    return `ethereum:${config.token_address}@${config.chain_id}/transfer?address=${config.wallet_address}&uint256=${baseUnits}`;
}

async function rpcCall({ rpcUrl, method, params, fetchImpl }) {
    const response = await fetchImpl(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const payload = await response.json();
    if (payload.error) throw new Error(`rpc_error: ${payload.error.message || payload.error.code}`);
    return payload.result;
}

function topicToAddress(topic) {
    return `0x${String(topic || '').slice(-40)}`.toLowerCase();
}

/**
 * Verify one USDC payment transaction against an owed amount.
 * Returns { verified, reason?, paid_base_units?, confirmations?, from? }.
 * Read-only; needs no keys. Mock config accepts the literal tx 'mock_paid'.
 */
export async function verifyUsdcPayment({
    config,
    txHash,
    requiredBaseUnits,
    fetchImpl = fetch,
}) {
    if (config.mock && txHash === 'mock_paid') {
        return { verified: true, paid_base_units: String(requiredBaseUnits), confirmations: 99, from: '0xmockpayer', mock: true };
    }
    if (!config.enabled) return { verified: false, reason: 'usdc_not_configured' };
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(txHash || ''))) {
        return { verified: false, reason: 'invalid_tx_hash' };
    }

    const receipt = await rpcCall({ rpcUrl: config.rpc_url, method: 'eth_getTransactionReceipt', params: [txHash], fetchImpl });
    if (!receipt) return { verified: false, reason: 'tx_not_found_or_pending' };
    if (receipt.status !== '0x1') return { verified: false, reason: 'tx_reverted' };

    const wallet = config.wallet_address.toLowerCase();
    const required = BigInt(requiredBaseUnits);
    let paid = 0n;
    let from = null;
    for (const log of receipt.logs || []) {
        if (String(log.address || '').toLowerCase() !== config.token_address) continue;
        if (!Array.isArray(log.topics) || log.topics[0] !== TRANSFER_TOPIC) continue;
        if (topicToAddress(log.topics[2]) !== wallet) continue;
        paid += BigInt(log.data);
        from = from || topicToAddress(log.topics[1]);
    }
    if (paid === 0n) return { verified: false, reason: 'no_usdc_transfer_to_wallet' };
    if (paid < required) {
        return { verified: false, reason: 'underpaid', paid_base_units: paid.toString() };
    }

    const headHex = await rpcCall({ rpcUrl: config.rpc_url, method: 'eth_blockNumber', params: [], fetchImpl });
    const confirmations = Number(BigInt(headHex) - BigInt(receipt.blockNumber)) + 1;
    if (confirmations < config.min_confirmations) {
        return { verified: false, reason: 'awaiting_confirmations', confirmations, paid_base_units: paid.toString() };
    }

    return { verified: true, paid_base_units: paid.toString(), confirmations, from };
}

/**
 * Scan recent USDC Transfer logs paying OUR wallet (eth_getLogs, read-only).
 * Powers hands-free settlement: pending orders are matched by their unique
 * amount, no tx-hash submission needed. Returns
 * { transfers: [{ tx_hash, amount_base_units, from, block }], head_block }.
 */
export async function scanUsdcTransfersToWallet({
    config,
    fromBlock = null,
    lookbackBlocks = 5000,
    fetchImpl = fetch,
}) {
    if (!config.enabled) return { transfers: [], head_block: null };
    const headHex = await rpcCall({ rpcUrl: config.rpc_url, method: 'eth_blockNumber', params: [], fetchImpl });
    const head = BigInt(headHex);
    const start = fromBlock !== null && BigInt(fromBlock) > 0n && BigInt(fromBlock) <= head
        ? BigInt(fromBlock)
        : (head > BigInt(lookbackBlocks) ? head - BigInt(lookbackBlocks) : 0n);

    const walletTopic = `0x000000000000000000000000${config.wallet_address.slice(2).toLowerCase()}`;
    const logs = await rpcCall({
        rpcUrl: config.rpc_url,
        method: 'eth_getLogs',
        params: [{
            fromBlock: `0x${start.toString(16)}`,
            toBlock: headHex,
            address: config.token_address,
            topics: [TRANSFER_TOPIC, null, walletTopic],
        }],
        fetchImpl,
    });

    return {
        head_block: head.toString(),
        transfers: (Array.isArray(logs) ? logs : []).map((log) => ({
            tx_hash: log.transactionHash,
            amount_base_units: BigInt(log.data).toString(),
            from: topicToAddress(log.topics?.[1]),
            block: log.blockNumber ? BigInt(log.blockNumber).toString() : null,
            confirmations: log.blockNumber ? Number(head - BigInt(log.blockNumber)) + 1 : 0,
        })),
    };
}

/**
 * x402 settlement: the agent hands us its signed payment payload (the value it
 * would put in the X-PAYMENT header) and we verify + settle through an x402
 * facilitator (X402_FACILITATOR_URL, e.g. https://x402.org/facilitator). The
 * facilitator broadcasts the EIP-3009 transferWithAuthorization — funds still
 * land directly in OUR wallet; we never hold keys. Field names tolerate the
 * minor spelling drift between facilitator versions.
 */
export function buildX402Requirements({ config, baseUnits, resource }) {
    return {
        scheme: 'exact',
        network: config.chain === 'base' ? 'base' : config.chain,
        maxAmountRequired: String(baseUnits),
        asset: config.token_address,
        payTo: config.wallet_address,
        resource: resource || 'https://printkinetix/print-order',
        description: 'PrintKinetix 3D print order',
        mimeType: 'application/json',
        maxTimeoutSeconds: 300,
        extra: { name: 'USD Coin', version: '2' },
    };
}

export async function settleX402Payment({ config, paymentPayload, requirements, fetchImpl = fetch }) {
    if (config.mock && paymentPayload === 'mock_x402') {
        return { settled: true, tx_hash: 'mock_x402_tx', mock: true };
    }
    if (!config.x402_facilitator_url) {
        return { settled: false, reason: 'x402_not_configured', hint: 'Operator must set X402_FACILITATOR_URL (e.g. https://x402.org/facilitator), or use print_pay with a transaction hash.' };
    }
    const call = async (path) => {
        const response = await fetchImpl(`${config.x402_facilitator_url}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                x402Version: 1,
                paymentPayload,
                paymentHeader: paymentPayload,
                paymentRequirements: requirements,
            }),
        });
        const text = await response.text();
        let parsed;
        try {
            parsed = text ? JSON.parse(text) : {};
        } catch {
            parsed = {};
        }
        if (!response.ok) throw new Error(`facilitator ${path} HTTP ${response.status}: ${text.slice(0, 200)}`);
        return parsed;
    };

    const verification = await call('/verify');
    if (verification.isValid === false || verification.valid === false) {
        return { settled: false, reason: 'x402_invalid_payment', detail: verification.invalidReason || verification.error || null };
    }
    const settlement = await call('/settle');
    const ok = settlement.success === true || settlement.settled === true;
    return ok
        ? { settled: true, tx_hash: settlement.txHash || settlement.transaction || null, network: settlement.networkId || null }
        : { settled: false, reason: 'x402_settle_failed', detail: settlement.errorReason || settlement.error || null };
}
