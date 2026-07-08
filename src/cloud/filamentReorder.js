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
    // Bambu live tray colors are 8-char RGBA ("00AE42FF") — drop the alpha so
    // AMS trays, inventory spools, and rules all compare as #RRGGBB.
    const rgb = expanded.slice(0, 6);
    return /^[0-9A-F]{6}$/.test(rgb) ? `#${rgb}` : null;
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
    const ruleDefaults = isPlainObject(source.rule_defaults) ? source.rule_defaults : {};
    return {
        enabled: source.enabled === true,
        vendor: 'amazon_business',
        // 'approval' = park every reorder for a human click; 'auto' = place
        // within the caps below without asking.
        mode: source.mode === 'auto' ? 'auto' : 'approval',
        trial_mode: source.trial_mode !== false,
        // Count filament loaded in AMS units (live_remaining telemetry from
        // heartbeats) as stock, so ordering works with zero manual inventory.
        count_ams_trays: source.count_ams_trays !== false,
        // Prefills for tagging a newly-detected filament in the console.
        rule_defaults: {
            min_spools: positiveInt(ruleDefaults.min_spools, 2),
            order_quantity: positiveInt(ruleDefaults.order_quantity, 2),
            max_unit_price_usd: positiveNumber(ruleDefaults.max_unit_price_usd, 30),
            grams_per_spool: positiveInt(ruleDefaults.grams_per_spool, 1000),
        },
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

// ---------------------------------------------------------------------------
// Live AMS stock (per-tray filament levels mirrored by node heartbeats)
// ---------------------------------------------------------------------------

// Printers that stopped heartbeating must not count as stock.
const STALE_PRINTER_MS = 24 * 60 * 60 * 1000;

function isFreshPrinter(printer, nowMs) {
    const lastSeen = printer?.last_seen_at ? new Date(printer.last_seen_at).getTime() : null;
    return !Number.isFinite(lastSeen) || nowMs - lastSeen < STALE_PRINTER_MS;
}

// Flatten every fresh printer's mirrored AMS view into normalized trays.
// Shape source: localPrinterSnapshot.collectAmsTrays → capabilities.ams_trays
// [{ ams_id, tray_id, material, material_base, color_hex, live_remaining }].
export function collectLiveAmsTrays(printers, nowMs = Date.now()) {
    const trays = [];
    for (const printer of asArray(printers)) {
        if (!isFreshPrinter(printer, nowMs)) continue;
        const source = asArray(printer?.capabilities?.ams_trays).length > 0
            ? printer.capabilities.ams_trays
            : asArray(printer?.capabilities?.trays);
        for (const tray of source) {
            const material = normalizeMaterial(tray?.material);
            const colorHex = normalizeColorHex(tray?.color_hex || tray?.color);
            if (!material && !colorHex) continue;
            trays.push({
                printer_id: printer.printer_id || null,
                local_printer_id: printer.local_printer_id || null,
                ams_id: tray?.ams_id ?? null,
                tray_id: tray?.tray_id ?? null,
                material,
                material_base: normalizeMaterial(tray?.material_base),
                color_hex: colorHex,
                color_name: normalizeString(tray?.color_name),
                // Bambu `remain` percent (0-100); null/negative = unknown
                // (third-party spool without RFID).
                live_remaining: Number.isFinite(Number(tray?.live_remaining)) ? Number(tray.live_remaining) : null,
            });
        }
    }
    return trays;
}

function trayMatchesRule(tray, rule) {
    if (tray.material !== rule.material && tray.material_base !== rule.material) return false;
    if (rule.color_hex && tray.color_hex !== rule.color_hex) return false;
    return true;
}

// Estimated grams left in a tray. Unknown levels (no RFID telemetry) count as
// a full spool: the tray is physically loaded, and guessing "empty" would
// trigger orders for filament the operator can see on the shelf.
export function estimateTrayGrams(tray, gramsPerSpool) {
    if (tray.live_remaining === null || tray.live_remaining < 0) return gramsPerSpool;
    return Math.round((Math.min(tray.live_remaining, 100) / 100) * gramsPerSpool);
}

/**
 * Usable stock for one rule = loaded AMS trays with enough filament left
 * (live levels) + shelf spools from the inventory. When AMS counting is on,
 * inventory spools assigned to a printer are skipped — they ARE the loaded
 * trays and would double count.
 */
export function countUsableStock({ spools, trays, rule, config }) {
    const minGrams = config.min_usable_grams;
    let trayCount = 0;
    let estGrams = 0;

    if (config.count_ams_trays) {
        for (const tray of asArray(trays)) {
            if (!trayMatchesRule(tray, rule)) continue;
            const grams = estimateTrayGrams(tray, rule.grams_per_spool);
            estGrams += grams;
            if (grams >= minGrams) trayCount += 1;
        }
    }

    const shelfSpools = asArray(spools).filter((spool) => (
        !config.count_ams_trays || (!spool?.printer_id && !spool?.local_printer_id)
    ));
    const spoolCount = countUsableSpools(shelfSpools, rule, minGrams);
    estGrams += shelfSpools
        .filter((spool) => normalizeMaterial(spool?.material) === rule.material
            && (!rule.color_hex || normalizeColorHex(spool?.color_hex) === rule.color_hex))
        .reduce((sum, spool) => sum + (Number(spool?.grams_remaining) || 0), 0);

    return {
        usable: trayCount + spoolCount,
        tray_count: trayCount,
        spool_count: spoolCount,
        est_grams: Math.round(estGrams),
    };
}

// Rule lookup for a detected filament: an exact color match wins over a
// material-wide (color-less) rule.
function findRuleForFilament(rules, material, colorHex) {
    return rules.find((rule) => rule.material === material && rule.color_hex === colorHex)
        || rules.find((rule) => rule.material === material && !rule.color_hex)
        || null;
}

/**
 * Everything the farm can see about its filament, aggregated per
 * material+color — the console's tagging table. Each entry reports where the
 * stock lives (AMS trays vs shelf spools), the estimated grams, and the rule
 * (Amazon product tag) covering it, if any.
 */
export function buildFilamentStockView({ config, spools = [], printers = [], now = () => new Date() } = {}) {
    const normalized = normalizeReorderConfig(config);
    const trays = collectLiveAmsTrays(printers, now().getTime());
    const byKey = new Map();

    const entryFor = (material, colorHex, colorName = null) => {
        const key = `${material}|${colorHex || ''}`;
        if (!byKey.has(key)) {
            byKey.set(key, {
                material,
                color_hex: colorHex,
                color_name: colorName,
                ams_tray_count: 0,
                inventory_spool_count: 0,
                est_grams: 0,
            });
        }
        const entry = byKey.get(key);
        if (!entry.color_name && colorName) entry.color_name = colorName;
        return entry;
    };

    for (const tray of trays) {
        if (!tray.material) continue;
        const entry = entryFor(tray.material, tray.color_hex, tray.color_name);
        entry.ams_tray_count += 1;
        const rule = findRuleForFilament(normalized.rules, tray.material, tray.color_hex);
        entry.est_grams += estimateTrayGrams(tray, rule?.grams_per_spool || normalized.rule_defaults.grams_per_spool);
    }
    for (const spool of asArray(spools)) {
        const material = normalizeMaterial(spool?.material);
        if (!material) continue;
        const entry = entryFor(material, normalizeColorHex(spool?.color_hex), normalizeString(spool?.color_name));
        entry.inventory_spool_count += 1;
        entry.est_grams += Number(spool?.grams_remaining) || 0;
    }
    // Rules for filament the farm has run out of entirely still need a row —
    // that is exactly when auto-ordering matters most.
    for (const rule of normalized.rules) {
        entryFor(rule.material, rule.color_hex, rule.color_name);
    }

    return [...byKey.values()]
        .map((entry) => {
            const rule = findRuleForFilament(normalized.rules, entry.material, entry.color_hex);
            const stock = countUsableStock({
                spools,
                trays,
                rule: rule || normalizeReorderRule({
                    material: entry.material,
                    color_hex: entry.color_hex,
                    ...normalized.rule_defaults,
                }),
                config: normalized,
            });
            return {
                ...entry,
                est_grams: Math.round(entry.est_grams),
                usable_spools: stock.usable,
                tagged: Boolean(rule?.asin),
                rule: rule ? {
                    rule_id: rule.rule_id,
                    enabled: rule.enabled,
                    asin: rule.asin,
                    min_spools: rule.min_spools,
                    order_quantity: rule.order_quantity,
                    max_unit_price_usd: rule.max_unit_price_usd,
                    grams_per_spool: rule.grams_per_spool,
                } : null,
            };
        })
        .sort((a, b) => a.material.localeCompare(b.material) || String(a.color_hex || '').localeCompare(String(b.color_hex || '')));
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
    // Live AMS levels: loaded trays mirrored from heartbeats count as stock,
    // so restocking works with zero manual inventory bookkeeping.
    let printers = [];
    if (config.count_ams_trays && typeof store.getCloudOverview === 'function') {
        try {
            printers = asArray((await store.getCloudOverview({ limit: 200 }))?.printers);
        } catch { printers = []; }
    }
    const trays = collectLiveAmsTrays(printers, nowMs);
    const month = monthKey(nowDate);
    const cooldownMs = config.cooldown_hours * 60 * 60 * 1000;
    const credentialsReady = hasAmazonBusinessCredentials(config);

    const newOrders = [];
    let placed = 0;
    let spend = monthlySpendUsd(state.orders, month);

    for (const rule of rules) {
        const stock = countUsableStock({ spools, trays, rule, config });
        if (stock.usable >= rule.min_spools) continue;
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
            usable_spools: stock.usable,
            ams_tray_count: stock.tray_count,
            shelf_spool_count: stock.spool_count,
            est_grams_left: stock.est_grams,
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
    const [rawConfig, state, inventory] = await Promise.all([
        store.getPlatformSetting(FILAMENT_REORDER_CONFIG_KEY, null),
        loadState(store),
        store.getPlatformSetting(FARM_FILAMENT_INVENTORY_KEY, { spools: [] }),
    ]);
    let printers = [];
    if (typeof store.getCloudOverview === 'function') {
        try {
            printers = asArray((await store.getCloudOverview({ limit: 200 }))?.printers);
        } catch { printers = []; }
    }
    const month = monthKey(now());
    return {
        config: redactReorderConfig(rawConfig),
        orders: state.orders,
        last_evaluated_at: state.last_evaluated_at,
        month,
        monthly_spend_usd: monthlySpendUsd(state.orders, month),
        // Tagging table: every filament the farm can see (AMS + shelf),
        // with live stock and the Amazon product tag covering it (if any).
        detected_filaments: buildFilamentStockView({
            config: rawConfig,
            spools: asArray(isPlainObject(inventory) ? inventory.spools : []),
            printers,
            now,
        }),
    };
}
