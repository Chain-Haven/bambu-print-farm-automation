// src/cloud/orderPickup.js — heartbeat sweep that turns unprinted commerce
// records into print jobs. Two sources:
//
//   1. Merchant v2 order items (Supabase `merchant_order_items`): rows with a
//      file but `job_id: null`. Until now an `auto_submit` request only
//      recorded an intent — nothing ever produced the part. The sweep feeds
//      each unprinted item through the SAME routed pipeline as direct
//      print-job submissions (one job per unit), links the jobs back onto the
//      item, and moves the order to in_production.
//   2. Storefront orders: see storefrontHandlers.sweepStorefrontOrders
//      (missed Stripe webhooks + crashed dispatches), called alongside this
//      from the heartbeat path.
//
// Gating: with the farm policy `auto_print_submitted_orders` (default ON),
// every submitted/paid order item is picked up; switched off, only items
// whose creation explicitly requested auto_submit are. Strictly best-effort:
// a failure must never break a heartbeat, and a permanently broken item is
// marked `pickup_failed` so it cannot loop.
import { routeAndDispatchJobFile } from './merchantPrintHandlers.js';

export const ORDER_PICKUP_STATE_KEY = 'order_pickup_state';
const SWEEP_MIN_INTERVAL_MS = 5 * 60 * 1000;
const MAX_UNITS_PER_ITEM = 20;
// Live production states. in_production/printing stay eligible so the
// remaining items of a multi-item order (the first item flips the order to
// in_production) are still picked up on this and later sweeps.
const PICKUP_ORDER_STATUSES = new Set([
    'submitted',
    'paid',
    'accepted',
    'partially_routed',
    'in_production',
    'printing',
]);
const FARM_AUTOMATION_POLICY_KEY = 'farm_automation_policy';

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function storeSupportsPickup(store) {
    return typeof store?.listUnprintedMerchantOrderItems === 'function'
        && typeof store?.updateMerchantOrderItem === 'function'
        && typeof store?.getMerchantOrder === 'function'
        && typeof store?.getMerchantFile === 'function'
        && typeof store?.getPlatformSetting === 'function'
        && typeof store?.upsertPlatformSetting === 'function';
}

function itemWantsAutoSubmit(item) {
    return item?.metadata?.auto_submit_requested === true;
}

function itemAlreadyFailedPickup(item) {
    return item?.metadata?.auto_submit_status === 'pickup_failed';
}

async function dispatchOrderItem({ store, item, file, now }) {
    const merchant = { org_id: item.org_id, merchant_id: item.merchant_id };
    const upload = {
        name: item.name || file.original_name,
        requirements: isPlainObject(item.requirements) ? item.requirements : {},
        options: {
            source: 'order_pickup',
            order_id: item.order_id,
            order_item_id: item.order_item_id,
            ...(item.sku ? { sku: item.sku } : {}),
        },
    };
    const units = Math.max(1, Math.min(Number.parseInt(item.quantity, 10) || 1, MAX_UNITS_PER_ITEM));
    const jobIds = [];
    for (let unit = 0; unit < units; unit += 1) {
        const { job } = await routeAndDispatchJobFile({ store, merchant, upload, file, now });
        jobIds.push(job.job_id);
    }
    return jobIds;
}

/**
 * One bounded pickup pass. Returns { checked, dispatched_items, jobs_created }.
 * Internally throttled; safe (and cheap) to call on every heartbeat.
 */
export async function pickupUnprintedOrderItems({
    store,
    now = () => new Date(),
    limit = 5,
    force = false,
} = {}) {
    if (!storeSupportsPickup(store)) {
        return { skipped: 'store_unsupported', checked: 0, dispatched_items: 0, jobs_created: 0 };
    }

    const nowMs = now().getTime();
    const state = await store.getPlatformSetting(ORDER_PICKUP_STATE_KEY, null) || {};
    if (!force && state.last_swept_at) {
        const lastMs = new Date(state.last_swept_at).getTime();
        if (Number.isFinite(lastMs) && nowMs - lastMs < SWEEP_MIN_INTERVAL_MS) {
            return { skipped: 'recently_swept', checked: 0, dispatched_items: 0, jobs_created: 0 };
        }
    }
    await store.upsertPlatformSetting(ORDER_PICKUP_STATE_KEY, { ...state, last_swept_at: now().toISOString() });

    const policy = await store.getPlatformSetting(FARM_AUTOMATION_POLICY_KEY, null);
    // Default ON: a submitted order means "produce this".
    const pickupEverything = !policy || policy.auto_print_submitted_orders !== false;

    let items = [];
    try {
        items = asArray(await store.listUnprintedMerchantOrderItems({ limit }));
    } catch {
        return { skipped: 'list_failed', checked: 0, dispatched_items: 0, jobs_created: 0 };
    }

    let dispatchedItems = 0;
    let jobsCreated = 0;
    const orderStatusCache = new Map();

    for (const item of items) {
        try {
            if (!item?.file_id || item?.job_id || itemAlreadyFailedPickup(item)) continue;
            if (!pickupEverything && !itemWantsAutoSubmit(item)) continue;

            // Only produce orders that are actually live.
            const orderKey = `${item.merchant_id}:${item.order_id}`;
            if (!orderStatusCache.has(orderKey)) {
                const order = await store.getMerchantOrder({ merchantId: item.merchant_id, orderId: item.order_id });
                orderStatusCache.set(orderKey, String(order?.status || '').toLowerCase());
            }
            if (!PICKUP_ORDER_STATUSES.has(orderStatusCache.get(orderKey))) continue;

            const file = await store.getMerchantFile({ merchantId: item.merchant_id, fileId: item.file_id });
            if (!file || !file.storage_path) {
                await store.updateMerchantOrderItem({
                    merchantId: item.merchant_id,
                    orderItemId: item.order_item_id,
                    fields: {
                        metadata: {
                            ...(isPlainObject(item.metadata) ? item.metadata : {}),
                            auto_submit_status: 'pickup_failed',
                            pickup_error: 'file_missing_or_incomplete',
                            pickup_attempted_at: now().toISOString(),
                        },
                    },
                });
                continue;
            }

            const jobIds = await dispatchOrderItem({ store, item, file, now });
            await store.updateMerchantOrderItem({
                merchantId: item.merchant_id,
                orderItemId: item.order_item_id,
                fields: {
                    job_id: jobIds[0],
                    metadata: {
                        ...(isPlainObject(item.metadata) ? item.metadata : {}),
                        auto_submit_status: 'submitted',
                        job_ids: jobIds,
                        picked_up_at: now().toISOString(),
                    },
                },
            });
            if (typeof store.updateMerchantOrder === 'function') {
                try {
                    await store.updateMerchantOrder({
                        merchantId: item.merchant_id,
                        orderId: item.order_id,
                        fields: { status: 'in_production' },
                    });
                    orderStatusCache.set(orderKey, 'in_production');
                } catch { /* order status is cosmetic next to the jobs */ }
            }
            dispatchedItems += 1;
            jobsCreated += jobIds.length;
        } catch { /* per-item isolation: one bad item must not stall the rest */ }
    }

    return { checked: items.length, dispatched_items: dispatchedItems, jobs_created: jobsCreated };
}
