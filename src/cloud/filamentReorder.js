// src/cloud/filamentReorder.js — automatic filament restocking.
//
// Watches the farm's spool inventory (the same platform-setting inventory the
// smart queue and AMS sync maintain) and, when the number of usable spools for
// a material/color drops below a per-rule threshold, creates a reorder — either
// parked for one-click approval in the console, or placed automatically
// through the Amazon Business Ordering API (amazonBusiness.js).
//
// Safety rails, in order:
//   1. trial_mode defaults ON — Amazon treats orders as tests until the
//      operator flips it off after a successful trial round-trip.
//   2. approval mode by default — nothing is purchased without a human click.
//   3. monthly budget + per-order caps — anything over parks for approval.
//   4. per-rule cooldown + open-order dedupe — one shortage, one order.
//   5. Amazon-side idempotency via externalId — even a racing double
//      evaluation (two heartbeats) cannot double-order.
//
// Evaluation runs from the node heartbeat path (the cloud's only periodic
// entry point — same pattern as auto-eject), throttled to once per
// EVALUATION_MIN_INTERVAL_MS, and manually via the console's "Check stock now".

import crypto from 'node:crypto';
import {
    buildPlaceOrderPayload,
    hasAmazonBusinessCredentials,
    placeAmazonBusinessOrder,
} from './amazonBusiness.js';

export const FILAMENT_REORDER_CONFIG_KEY = 'farm_filament_reorder';
export const FILAMENT_REORDER_STATE_KEY = 'farm_filament_reorder_state';
const FARM_FILAMENT_INVENTORY_KEY = 'farm_filament_inventory';

const EVALUATION_MIN_INTERVAL_MS = 5 * 60 * 1000;
const MAX_ORDER_HISTORY = 200;
const OPEN_STATUSES = new Set(['awaiting_approval']);
const SPEND_STATUSES = new Set(['placed', 'trial_placed']);

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeMaterial(value) {
    const material = normalizeString(value);
    return material ? material.toUpperCase() : null;
}

function normalizeColorHex(value) {
    const raw = normalizeString(value);
    if (!raw) return null;
    const hex = raw.replace(/^#/, '').toUpperCase();
    const expanded = hex.length === 3 ? hex.split('').map((c) => `${c}${c}`).join('') : hex;
    return /^[0-9A-F]{6}$/.test(expanded) ? `#${expanded}` : null;
}

function positiveNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function normalizeReorderRule(rule, index = 0) {
    const source = isPlainObject(rule) ? rule : {};
    return {
        rule_id: normalizeString(source.rule_id) || `rule-${index + 1}`,
        enabled: source.enabled !== false,
        material: normalizeMaterial(source.material) || 'PLA',
        color_hex: normalizeColorHex(source.color_hex || source.color),   // null = any color of this material
        color_name: normalizeString(source.color_name),
        asin: normalizeString(source.asin),
        min_spools: positiveInt(source.min_spools, 2),
        order_quantity: positiveInt(source.order_quantity, 2),
        max_unit_price_usd: positiveNumber(source.max_unit_price_usd, 30),
        grams_per_spool: positiveInt(source.grams_per_spool, 1000),
        note: normalizeString(source.note),
    };
}

export function normalizeReorderConfig(config) {
    const source = isPlainObject(config) ? config : {};
    const credentials = isPlainObject(source.credentials) ? source.credentials : {};
    return {
        enabled: source.enabled === true,
        vendor: 'amazon_business',
        // 'approval' = park every reorder for a human click; 'auto' = place
        // within the caps below without asking.
        mode: source.mode === 'auto' ? 'auto' : 'approval',
        trial_mode: source.trial_mode !== false,
        region: ['NA', 'EU', 'FE'].includes(String(source.region || '').toUpperCase())
            ? String(source.region).toUpperCase()
            : 'NA',
        country_code: normalizeString(source.country_code)?.toUpperCase() || 'US',
        currency: normalizeString(source.currency)?.toUpperCase() || 'USD',
        user_email: normalizeString(source.user_email),
        purchase_order_number: normalizeString(source.purchase_order_number),
        monthly_budget_usd: positiveNumber(source.monthly_budget_usd, 250),
        max_order_usd: positiveNumber(source.max_order_usd, 150),
        cooldown_hours: positiveNumber(source.cooldown_hours, 24),
        min_usable_grams: positiveNumber(source.min_usable_grams, 150),
        mock: source.mock === true,
        credentials: {
            client_id: normalizeString(credentials.client_id),
            client_secret: normalizeString(credentials.client_secret),
            refresh_token: normalizeString(credentials.refresh_token),
        },
        rules: asArray(source.rules).map(normalizeReorderRule),
    };
}

// Console/API view of the config: never echo LWA secrets back out.
export function redactReorderConfig(config) {
    const normalized = normalizeReorderConfig(config);
    return {
        ...normalized,
        credentials: {
            client_id: normalized.credentials.client_id,
            client_secret_set: Boolean(normalized.credentials.client_secret || process.env.AB_LWA_CLIENT_SECRET),
            refresh_token_set: Boolean(normalized.credentials.refresh_token || process.env.AB_LWA_REFRESH_TOKEN),
        },
    };
}

export function monthKey(date) {
    return date.toISOString().slice(0, 7); // YYYY-MM
}

// A spool "counts" toward a rule when material matches, color matches (rules
// without a color cover every color of the material), and enough filament
// remains to be worth loading.
export function countUsableSpools(spools, rule, minUsableGrams) {
    return asArray(spools).filter((spool) => {
        if (normalizeMaterial(spool?.material) !== rule.material) return false;
        if (rule.color_hex && normalizeColorHex(spool?.color_hex) !== rule.color_hex) return false;
        return Number(spool?.grams_remaining) >= minUsableGrams;
    }).length;
}

export function monthlySpendUsd(orders, month) {
    return asArray(orders)
        .filter((order) => order.month === month && SPEND_STATUSES.has(order.status))
        .reduce((sum, order) => sum + (Number(order.est_total_usd) || 0), 0);
}

function ruleHasOpenOrRecentOrder(orders, rule, nowMs, cooldownMs) {
    return asArray(orders).some((order) => {
        if (order.rule_id !== rule.rule_id) return false;
        if (OPEN_STATUSES.has(order.status)) return true;
        const createdMs = order.created_at ? new Date(order.created_at).getTime() : 0;
        // Cooldown covers placed AND failed orders: a broken config must not
        // retry on every heartbeat, and a fresh order needs time to arrive.
        return Number.isFinite(createdMs) && nowMs - createdMs < cooldownMs;
    });
}

async function loadState(store) {
    const state = await store.getPlatformSetting(FILAMENT_REORDER_STATE_KEY, null);
    return {
        orders: asArray(isPlainObject(state) ? state.orders : []),
        last_evaluated_at: isPlainObject(state) ? state.last_evaluated_at || null : null,
    };
}

async function saveState(store, state) {
    await store.upsertPlatformSetting(FILAMENT_REORDER_STATE_KEY, {
        orders: state.orders.slice(0, MAX_ORDER_HISTORY),
        last_evaluated_at: state.last_evaluated_at,
    });
}

// Amazon-side idempotency: one externalId per rule per shortage sequence. Two
// racing evaluations compute the same sequence number -> same externalId ->
// Amazon dedupes the second placeOrder instead of double-shipping.
function buildExternalId(rule, month, orders) {
    const priorForRule = asArray(orders).filter((order) => order.rule_id === rule.rule_id && order.month === month).length;
    return `pkx-${rule.rule_id}-${month.replace('-', '')}-${priorForRule + 1}`;
}

async function placeOrderForEntry({ config, order, fetchImpl, now }) {
    const payload = buildPlaceOrderPayload({
        rule: {
            asin: order.asin,
            max_unit_price_usd: order.max_unit_price_usd,
        },
        config,
        externalId: order.external_id,
        quantity: order.quantity,
    });
    const result = await placeAmazonBusinessOrder({ config, payload, fetchImpl });
    return {
        ...order,
        status: config.trial_mode !== false ? 'trial_placed' : 'placed',
        placed_at: now().toISOString(),
        vendor_result: {
            mock: result?.mock === true,
            order_identifier: result?.orderIdentifier || result?.orderIdentifiers || null,
        },
        error: null,
    };
}

/**
 * Core loop: compare usable spools per rule against thresholds and create
 * (and in auto mode, place) reorders. Best-effort by design — callers on the
 * heartbeat path must never fail a heartbeat over restocking.
 */
export async function evaluateFilamentReorders({
    store,
    now = () => new Date(),
    fetchImpl = fetch,
    force = false,
} = {}) {
    if (!store || typeof store.getPlatformSetting !== 'function' || typeof store.upsertPlatformSetting !== 'function') {
        return { skipped: 'store_unsupported', created: 0, placed: 0 };
    }

    const config = normalizeReorderConfig(await store.getPlatformSetting(FILAMENT_REORDER_CONFIG_KEY, null));
    if (!config.enabled) return { skipped: 'disabled', created: 0, placed: 0 };
    const rules = config.rules.filter((rule) => rule.enabled && rule.asin);
    if (rules.length === 0) return { skipped: 'no_rules', created: 0, placed: 0 };

    const state = await loadState(store);
    const nowDate = now();
    const nowMs = nowDate.getTime();
    if (!force && state.last_evaluated_at) {
        const lastMs = new Date(state.last_evaluated_at).getTime();
        if (Number.isFinite(lastMs) && nowMs - lastMs < EVALUATION_MIN_INTERVAL_MS) {
            return { skipped: 'recently_evaluated', created: 0, placed: 0 };
        }
    }

    const inventory = await store.getPlatformSetting(FARM_FILAMENT_INVENTORY_KEY, { spools: [] });
    const spools = asArray(isPlainObject(inventory) ? inventory.spools : []);
    const month = monthKey(nowDate);
    const cooldownMs = config.cooldown_hours * 60 * 60 * 1000;
    const credentialsReady = hasAmazonBusinessCredentials(config);

    const newOrders = [];
    let placed = 0;
    let spend = monthlySpendUsd(state.orders, month);

    for (const rule of rules) {
        const usable = countUsableSpools(spools, rule, config.min_usable_grams);
        if (usable >= rule.min_spools) continue;
        if (ruleHasOpenOrRecentOrder([...state.orders, ...newOrders], rule, nowMs, cooldownMs)) continue;

        const estTotal = rule.max_unit_price_usd * rule.order_quantity;
        const overMonthlyBudget = spend + estTotal > config.monthly_budget_usd;
        const overOrderCap = estTotal > config.max_order_usd;

        let order = {
            order_id: `fro_${crypto.randomUUID()}`,
            external_id: buildExternalId(rule, month, [...state.orders, ...newOrders]),
            created_at: nowDate.toISOString(),
            month,
            rule_id: rule.rule_id,
            vendor: config.vendor,
            material: rule.material,
            color_hex: rule.color_hex,
            color_name: rule.color_name,
            asin: rule.asin,
            quantity: rule.order_quantity,
            max_unit_price_usd: rule.max_unit_price_usd,
            est_total_usd: estTotal,
            usable_spools: usable,
            min_spools: rule.min_spools,
            trial_mode: config.trial_mode !== false,
            status: 'awaiting_approval',
            reason: null,
            placed_at: null,
            error: null,
        };

        if (config.mode !== 'auto') {
            order.reason = 'approval_mode';
        } else if (!credentialsReady && !config.mock && process.env.MOCK_MODE !== 'true') {
            order.reason = 'missing_credentials';
        } else if (overMonthlyBudget) {
            order.reason = 'monthly_budget_exceeded';
        } else if (overOrderCap) {
            order.reason = 'max_order_exceeded';
        } else {
            try {
                order = await placeOrderForEntry({ config, order, fetchImpl, now });
                placed += 1;
                spend += estTotal;
            } catch (error) {
                order.status = 'failed';
                order.error = String(error.message || error).slice(0, 500);
            }
        }

        newOrders.push(order);
    }

    state.orders = [...newOrders, ...state.orders];
    state.last_evaluated_at = nowDate.toISOString();
    await saveState(store, state);

    return {
        created: newOrders.length,
        placed,
        awaiting: newOrders.filter((order) => order.status === 'awaiting_approval').length,
        orders: newOrders,
    };
}

export async function approveFilamentReorder({ store, orderId, now = () => new Date(), fetchImpl = fetch }) {
    const config = normalizeReorderConfig(await store.getPlatformSetting(FILAMENT_REORDER_CONFIG_KEY, null));
    const state = await loadState(store);
    const index = state.orders.findIndex((order) => order.order_id === orderId);
    if (index === -1) throw new Error('reorder_not_found');
    if (state.orders[index].status !== 'awaiting_approval') throw new Error('reorder_not_awaiting_approval');

    let updated;
    try {
        updated = await placeOrderForEntry({ config, order: state.orders[index], fetchImpl, now });
        updated.approved_at = now().toISOString();
    } catch (error) {
        updated = {
            ...state.orders[index],
            status: 'failed',
            approved_at: now().toISOString(),
            error: String(error.message || error).slice(0, 500),
        };
    }
    state.orders[index] = updated;
    await saveState(store, state);
    return updated;
}

export async function denyFilamentReorder({ store, orderId, now = () => new Date() }) {
    const state = await loadState(store);
    const index = state.orders.findIndex((order) => order.order_id === orderId);
    if (index === -1) throw new Error('reorder_not_found');
    if (state.orders[index].status !== 'awaiting_approval') throw new Error('reorder_not_awaiting_approval');

    state.orders[index] = { ...state.orders[index], status: 'denied', denied_at: now().toISOString() };
    await saveState(store, state);
    return state.orders[index];
}

export async function getFilamentReorderOverview({ store, now = () => new Date() }) {
    const [rawConfig, state] = await Promise.all([
        store.getPlatformSetting(FILAMENT_REORDER_CONFIG_KEY, null),
        loadState(store),
    ]);
    const month = monthKey(now());
    return {
        config: redactReorderConfig(rawConfig),
        orders: state.orders,
        last_evaluated_at: state.last_evaluated_at,
        month,
        monthly_spend_usd: monthlySpendUsd(state.orders, month),
    };
}
