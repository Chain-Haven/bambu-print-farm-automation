import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createMemoryCloudStore } from '../../src/cloud/memoryCloudStore.js';
import { ORDER_PICKUP_STATE_KEY, pickupUnprintedOrderItems } from '../../src/cloud/orderPickup.js';

const NOW = () => new Date('2026-07-09T12:00:00.000Z');

// The v2 commerce tables live in Supabase; for the sweep we extend the memory
// store with the same method surface the Supabase REST client implements.
function withV2Commerce(store) {
    const db = { orders: [], items: [], files: [] };
    const clone = (value) => JSON.parse(JSON.stringify(value));
    return Object.assign(store, {
        _v2: db,
        async listUnprintedMerchantOrderItems({ limit = 10 } = {}) {
            return db.items.filter((item) => !item.job_id && item.file_id).slice(0, limit).map(clone);
        },
        async updateMerchantOrderItem({ merchantId, orderItemId, fields = {} }) {
            const row = db.items.find((item) => item.order_item_id === orderItemId && item.merchant_id === merchantId);
            if (!row) return null;
            Object.assign(row, clone(fields));
            return clone(row);
        },
        async getMerchantOrder({ merchantId, orderId }) {
            const row = db.orders.find((order) => order.order_id === orderId && order.merchant_id === merchantId);
            return row ? clone(row) : null;
        },
        async updateMerchantOrder({ merchantId, orderId, fields = {} }) {
            const row = db.orders.find((order) => order.order_id === orderId && order.merchant_id === merchantId);
            if (!row) return null;
            Object.assign(row, clone(fields));
            return clone(row);
        },
        async getMerchantFile({ merchantId, fileId }) {
            const row = db.files.find((file) => file.file_id === fileId && file.merchant_id === merchantId);
            return row ? clone(row) : null;
        },
    });
}

async function makeFarm() {
    const store = withV2Commerce(createMemoryCloudStore());
    const org = await store.createOrganization({ name: 'Pickup Farm' });
    const merchant = await store.createMerchant({
        org_id: org.org_id,
        company_name: 'SKU Seller',
        status: 'active',
    });
    return { store, orgId: org.org_id, merchantId: merchant.merchant_id };
}

function seedOrderWithItem(store, { orgId, merchantId }, {
    status = 'submitted',
    quantity = 1,
    autoSubmit = false,
    withFile = true,
    sku = 'SKU-WIDGET-1',
} = {}) {
    const orderId = crypto.randomUUID();
    const fileId = withFile ? crypto.randomUUID() : null;
    store._v2.orders.push({ order_id: orderId, merchant_id: merchantId, org_id: orgId, status });
    if (withFile) {
        store._v2.files.push({
            file_id: fileId,
            merchant_id: merchantId,
            org_id: orgId,
            original_name: 'widget.gcode.3mf',
            content_type: 'application/octet-stream',
            byte_size: 1234,
            checksum_sha256: 'abc',
            file_mode: 'ready_to_print',
            storage_path: `${orgId}/${merchantId}/files/${fileId}/widget.gcode.3mf`,
        });
    }
    const item = {
        order_item_id: crypto.randomUUID(),
        order_id: orderId,
        merchant_id: merchantId,
        org_id: orgId,
        file_id: fileId,
        job_id: null,
        sku,
        name: 'Widget',
        quantity,
        requirements: { material: 'PLA' },
        metadata: { auto_submit_requested: autoSubmit, auto_submit_status: autoSubmit ? 'intent_recorded' : 'not_requested' },
        created_at: NOW().toISOString(),
    };
    store._v2.items.push(item);
    return { orderId, item };
}

describe('unprinted order item pickup', () => {
    it('turns a submitted order item into routed print jobs and links them back', async () => {
        const farm = await makeFarm();
        const { orderId, item } = seedOrderWithItem(farm.store, farm, { quantity: 3 });

        const result = await pickupUnprintedOrderItems({ store: farm.store, now: NOW, force: true });

        expect(result).toMatchObject({ checked: 1, dispatched_items: 1, jobs_created: 3 });
        const updated = farm.store._v2.items.find((entry) => entry.order_item_id === item.order_item_id);
        expect(updated.job_id).toBeTruthy();
        expect(updated.metadata.job_ids).toHaveLength(3);
        expect(updated.metadata.auto_submit_status).toBe('submitted');
        // One real print job per unit, carrying the order/SKU linkage.
        const job = await farm.store.getPrintJobById(updated.job_id);
        expect(job.status).toBe('waiting_for_capacity'); // no printers online here
        expect(job.options).toMatchObject({ source: 'order_pickup', order_id: orderId, sku: 'SKU-WIDGET-1' });
        // Order moves into production.
        expect(farm.store._v2.orders[0].status).toBe('in_production');
    });

    it('keeps picking up the remaining items of an order already in production', async () => {
        const farm = await makeFarm();
        const first = seedOrderWithItem(farm.store, farm);
        // Second item on the SAME order.
        const second = {
            ...first.item,
            order_item_id: crypto.randomUUID(),
            sku: 'SKU-WIDGET-2',
        };
        farm.store._v2.items.push(second);

        const result = await pickupUnprintedOrderItems({ store: farm.store, now: NOW, force: true });
        expect(result.dispatched_items).toBe(2);
        expect(farm.store._v2.items.every((entry) => entry.job_id)).toBe(true);
    });

    it('never prints canceled orders', async () => {
        const farm = await makeFarm();
        seedOrderWithItem(farm.store, farm, { status: 'canceled' });
        const result = await pickupUnprintedOrderItems({ store: farm.store, now: NOW, force: true });
        expect(result.dispatched_items).toBe(0);
        expect(farm.store._v2.items[0].job_id).toBeNull();
    });

    it('policy off: only items that explicitly requested auto_submit are picked up', async () => {
        const farm = await makeFarm();
        await farm.store.upsertPlatformSetting('farm_automation_policy', { auto_print_submitted_orders: false });
        seedOrderWithItem(farm.store, farm, { autoSubmit: false, sku: 'MANUAL' });
        seedOrderWithItem(farm.store, farm, { autoSubmit: true, sku: 'AUTO' });

        const result = await pickupUnprintedOrderItems({ store: farm.store, now: NOW, force: true });

        expect(result.dispatched_items).toBe(1);
        const bySku = Object.fromEntries(farm.store._v2.items.map((entry) => [entry.sku, entry]));
        expect(bySku.MANUAL.job_id).toBeNull();
        expect(bySku.AUTO.job_id).toBeTruthy();
    });

    it('marks items with a missing file as pickup_failed and does not loop on them', async () => {
        const farm = await makeFarm();
        const { item } = seedOrderWithItem(farm.store, farm);
        // File record vanished (deleted upload).
        farm.store._v2.files.length = 0;

        const first = await pickupUnprintedOrderItems({ store: farm.store, now: NOW, force: true });
        expect(first.dispatched_items).toBe(0);
        const updated = farm.store._v2.items.find((entry) => entry.order_item_id === item.order_item_id);
        expect(updated.metadata.auto_submit_status).toBe('pickup_failed');
        expect(updated.metadata.pickup_error).toBe('file_missing_or_incomplete');

        const second = await pickupUnprintedOrderItems({ store: farm.store, now: NOW, force: true });
        expect(second.dispatched_items).toBe(0); // still listed, but skipped
    });

    it('throttles between sweeps and skips stores without the v2 surface', async () => {
        const farm = await makeFarm();
        seedOrderWithItem(farm.store, farm);
        await pickupUnprintedOrderItems({ store: farm.store, now: NOW, force: true });
        const throttled = await pickupUnprintedOrderItems({
            store: farm.store,
            now: () => new Date('2026-07-09T12:02:00.000Z'),
        });
        expect(throttled.skipped).toBe('recently_swept');
        const state = await farm.store.getPlatformSetting(ORDER_PICKUP_STATE_KEY, null);
        expect(state.last_swept_at).toBe('2026-07-09T12:00:00.000Z');

        const plain = createMemoryCloudStore();
        const unsupported = await pickupUnprintedOrderItems({ store: plain, now: NOW, force: true });
        expect(unsupported.skipped).toBe('store_unsupported');
    });
});
