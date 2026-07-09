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
    return {
        enabled: isNonEmptyString(env.USDC_WALLET_ADDRESS),
        wallet_address: isNonEmptyString(env.USDC_WALLET_ADDRESS) ? env.USDC_WALLET_ADDRESS.trim() : null,
        chain: CHAINS[chainKey] ? chainKey : 'base',
        chain_id: chain.chain_id,
        rpc_url: isNonEmptyString(env.EVM_RPC_URL) ? env.EVM_RPC_URL.trim() : chain.rpc_url,
        token_address: (isNonEmptyString(env.USDC_TOKEN_ADDRESS) ? env.USDC_TOKEN_ADDRESS.trim() : chain.usdc_address).toLowerCase(),
        explorer_tx: chain.explorer_tx,
        price_per_gram: Number.isFinite(pricePerGram) && pricePerGram > 0 ? pricePerGram : 0.05,
        shipping_flat: Number.isFinite(shippingFlat) && shippingFlat >= 0 ? shippingFlat : 8,
        min_confirmations: Math.max(1, Number.parseInt(env.USDC_MIN_CONFIRMATIONS, 10) || 2),
        mock: env.MOCK_MODE === 'true',
    };
}

// Filament-cost pricing. Returns integer USDC base units (6 decimals) plus a
// human breakdown, so on-chain comparison is exact.
export function computeUsdcPrice({ gramsPerPiece, quantity, config }) {
    const grams = Math.max(1, Math.ceil(Number(gramsPerPiece) || 0)) * Math.max(1, quantity);
    const filamentUsdc = grams * config.price_per_gram;
    const totalUsdc = Math.ceil((filamentUsdc + config.shipping_flat) * 100) / 100;
    return {
        grams_total: grams,
        price_per_gram_usdc: config.price_per_gram,
        filament_usdc: Math.ceil(filamentUsdc * 100) / 100,
        shipping_usdc: config.shipping_flat,
        total_usdc: totalUsdc,
        total_base_units: String(BigInt(Math.round(totalUsdc * 100)) * 10n ** (USDC_DECIMALS - 2n)),
    };
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
