# Merchant API v2 Adapter Backbone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete adapter-first Merchant API v2 automation backbone for files, slicing, orders, routing, timelines, reservations, batches, QA, post-processing, shipping, billing, webhooks, realtime, admin visibility, and public docs.

**Architecture:** Extend the existing Vercel/Supabase cloud control plane without replacing Merchant API v1. Add focused `src/cloud/merchant*` workflow modules, thin `api/public` and `api/cloud` route files, Supabase migration-backed resource tables, deterministic mock adapters, and docs/OpenAPI coverage. Keep v1 stable and publish v2 through a separate OpenAPI spec.

**Tech Stack:** Node ESM Vercel functions, Supabase REST/Storage through `src/cloud/supabaseRest.js`, existing merchant bearer auth, Vitest, static HTML/OpenAPI docs, Windows node command loop for physical printer execution.

---

## File Structure

Create or modify these units. Keep route files thin and put workflow logic in `src/cloud`.

Schema and store:

- Create: `supabase/migrations/20260701050000_merchant_api_v2_adapter_backbone.sql`
- Modify: `src/cloud/supabaseRest.js`
- Test: `tests/cloud/merchantV2Store.test.js`
- Test: `tests/cloud/supabaseMigrations.test.js`

Shared helpers and adapters:

- Create: `src/cloud/merchantApiV2.js`
- Create: `src/cloud/adapters/index.js`
- Create: `src/cloud/adapters/mockSlicerAdapter.js`
- Create: `src/cloud/adapters/mockShippingAdapter.js`
- Create: `src/cloud/adapters/mockBillingAdapter.js`
- Create: `src/cloud/adapters/mockInspectionAdapter.js`
- Create: `src/cloud/adapters/mockRealtimeAdapter.js`
- Test: `tests/cloud/merchantAdapters.test.js`

Public merchant resources:

- Create: `src/cloud/merchantFiles.js`
- Create: `src/cloud/merchantSlices.js`
- Create: `src/cloud/merchantOrders.js`
- Create: `src/cloud/merchantRoutingV2.js`
- Create: `src/cloud/merchantTimeline.js`
- Create: `src/cloud/merchantReservations.js`
- Create: `src/cloud/merchantBatches.js`
- Create: `src/cloud/merchantInspection.js`
- Create: `src/cloud/merchantPostProcessing.js`
- Create: `src/cloud/merchantShipping.js`
- Create: `src/cloud/merchantBilling.js`
- Create: `src/cloud/merchantWebhooksV2.js`
- Create: `src/cloud/merchantRealtime.js`
- Test: `tests/cloud/merchantFiles.test.js`
- Test: `tests/cloud/merchantSlices.test.js`
- Test: `tests/cloud/merchantOrders.test.js`
- Test: `tests/cloud/merchantRoutingV2.test.js`
- Test: `tests/cloud/merchantTimeline.test.js`
- Test: `tests/cloud/merchantReservationsV2.test.js`
- Test: `tests/cloud/merchantBatches.test.js`
- Test: `tests/cloud/merchantInspection.test.js`
- Test: `tests/cloud/merchantPostProcessing.test.js`
- Test: `tests/cloud/merchantShipping.test.js`
- Test: `tests/cloud/merchantBilling.test.js`
- Test: `tests/cloud/merchantWebhooksV2.test.js`
- Test: `tests/cloud/merchantRealtime.test.js`

Public Vercel routes:

- Create: `api/public/files/index.js`
- Create: `api/public/files/[file_id].js`
- Create: `api/public/files/[file_id]/complete.js`
- Create: `api/public/slices/index.js`
- Create: `api/public/slices/[slice_id].js`
- Create: `api/public/slices/[slice_id]/cancel.js`
- Create: `api/public/orders/index.js`
- Create: `api/public/orders/[order_id].js`
- Create: `api/public/orders/[order_id]/cancel.js`
- Create: `api/public/routing/estimate.js`
- Create: `api/public/routing/options.js`
- Create: `api/public/print-jobs/[job_id]/events.js`
- Create: `api/public/print-jobs/[job_id]/artifacts.js`
- Create: `api/public/print-jobs/[job_id]/inspection.js`
- Create: `api/public/print-jobs/[job_id]/approve-quality.js`
- Create: `api/public/print-jobs/[job_id]/reject-quality.js`
- Create: `api/public/print-jobs/[job_id]/post-processing.js`
- Create: `api/public/print-jobs/[job_id]/post-processing/approve.js`
- Create: `api/public/material-reservations/index.js`
- Create: `api/public/material-reservations/[reservation_id].js`
- Create: `api/public/batches/index.js`
- Create: `api/public/batches/[batch_id].js`
- Create: `api/public/batches/[batch_id]/pause.js`
- Create: `api/public/batches/[batch_id]/resume.js`
- Create: `api/public/batches/[batch_id]/cancel.js`
- Create: `api/public/shipments/index.js`
- Create: `api/public/shipments/[shipment_id].js`
- Create: `api/public/shipments/[shipment_id]/label.js`
- Create: `api/public/rate-card/index.js`
- Create: `api/public/invoices/index.js`
- Create: `api/public/realtime/tokens.js`
- Create: `api/public/webhooks/[webhook_id].js`
- Create: `api/public/webhooks/[webhook_id]/test.js`
- Modify: `api/public/webhooks/index.js`
- Create: `api/public/openapi-v2.js`

Admin:

- Modify: `src/cloud/adminHandlers.js`
- Create: `api/cloud/merchant-v2.js`
- Modify: `public/cloud.html`
- Modify: `public/js/cloud-dashboard.js`
- Modify: `public/css/cloud.css`
- Test: `tests/cloud/adminMerchantV2Handlers.test.js`
- Test: `tests/cloud/dashboardAssets.test.js`

Docs:

- Modify: `docs/merchant-api.md`
- Modify: `public/merchant-api.html`
- Create: `public/openapi/merchant-api-v2.json`
- Test: `tests/cloud/merchantDocs.test.js`

## Conventions

Use these shared helper contracts throughout the plan.

Merchant resource scope:

```js
function merchantScope(merchant) {
    return {
        org_id: merchant.org_id,
        merchant_id: merchant.merchant_id,
    };
}
```

Public success response:

```js
function publicOk(payload, requestId) {
    return { ok: true, request_id: requestId, ...payload };
}
```

Public error response:

```js
function publicError(error, requestId) {
    return {
        ok: false,
        error: error.code || 'internal_error',
        message: error.message || 'Unexpected server error',
        request_id: requestId,
    };
}
```

Route wrapper shape:

```js
import { createSupabaseRestClient } from '../../../src/cloud/supabaseRest.js';
import { authenticateMerchantRequest } from '../../../src/cloud/merchantAuth.js';
import { createDefaultAdapters } from '../../../src/cloud/adapters/index.js';

export default async function handler(req, res) {
    const store = createSupabaseRestClient();
    const adapters = createDefaultAdapters();
    return createSpecificHandler({
        store,
        authenticateMerchant: authenticateMerchantRequest,
        adapters,
    })(req, res);
}
```

Use the existing `MERCHANT_API_KEY_PEPPER || NODE_TOKEN_PEPPER` behavior in merchant route files, matching v1 route patterns.

---

### Task 1: Add Merchant API v2 Schema And Store Surface

**Files:**
- Create: `supabase/migrations/20260701050000_merchant_api_v2_adapter_backbone.sql`
- Modify: `src/cloud/supabaseRest.js`
- Create: `tests/cloud/merchantV2Store.test.js`
- Modify: `tests/cloud/supabaseMigrations.test.js`

- [ ] **Step 1: Write failing migration/store tests**

Add `tests/cloud/merchantV2Store.test.js`:

```js
import { describe, expect, it } from 'vitest';

const requiredMethods = [
    'createMerchantFile',
    'getMerchantFile',
    'updateMerchantFile',
    'deleteMerchantFile',
    'createMerchantSliceJob',
    'getMerchantSliceJob',
    'updateMerchantSliceJob',
    'createMerchantOrder',
    'getMerchantOrder',
    'updateMerchantOrder',
    'createMerchantOrderItem',
    'createMerchantMaterialReservation',
    'getMerchantMaterialReservation',
    'releaseMerchantMaterialReservation',
    'createMerchantBatch',
    'getMerchantBatch',
    'updateMerchantBatch',
    'createMerchantBatchItem',
    'recordMerchantJobEvent',
    'listMerchantJobEvents',
    'createMerchantJobArtifact',
    'listMerchantJobArtifacts',
    'createMerchantInspection',
    'getMerchantInspectionByJob',
    'updateMerchantInspection',
    'createMerchantPostProcessingTask',
    'listMerchantPostProcessingTasks',
    'updateMerchantPostProcessingTask',
    'createMerchantShipment',
    'getMerchantShipment',
    'createMerchantShippingLabel',
    'getMerchantRateCard',
    'createMerchantInvoice',
    'listMerchantInvoices',
    'createMerchantInvoiceLine',
    'createMerchantWebhookEndpoint',
    'listMerchantWebhookEndpoints',
    'updateMerchantWebhookEndpoint',
    'deleteMerchantWebhookEndpoint',
    'createMerchantWebhookDelivery',
    'listMerchantWebhookDeliveries',
    'createMerchantRealtimeToken',
    'recordMerchantAdapterEvent',
];

describe('merchant API v2 store surface', () => {
    it('exposes every v2 store method required by the public API backbone', async () => {
        const { createSupabaseRestClient } = await import('../../src/cloud/supabaseRest.js');
        const store = createSupabaseRestClient({
            supabaseUrl: 'https://example.supabase.co',
            serviceRoleKey: 'service_role',
            fetchImpl: async () => ({ ok: true, status: 200, text: async () => '[]' }),
        });

        for (const method of requiredMethods) {
            expect(typeof store[method], method).toBe('function');
        }
    });
});
```

Extend `tests/cloud/supabaseMigrations.test.js` with:

```js
it('includes Merchant API v2 adapter backbone tables', () => {
    const sql = fs.readFileSync('supabase/migrations/20260701050000_merchant_api_v2_adapter_backbone.sql', 'utf8');
    for (const table of [
        'merchant_files',
        'merchant_slice_jobs',
        'merchant_orders',
        'merchant_order_items',
        'merchant_material_reservations',
        'merchant_batches',
        'merchant_batch_items',
        'merchant_job_events',
        'merchant_job_artifacts',
        'merchant_inspections',
        'merchant_post_processing_tasks',
        'merchant_shipments',
        'merchant_shipping_labels',
        'merchant_rate_cards',
        'merchant_invoices',
        'merchant_invoice_lines',
        'merchant_webhook_endpoints',
        'merchant_webhook_deliveries',
        'merchant_realtime_tokens',
        'merchant_adapter_events',
    ]) {
        expect(sql).toContain(`public.${table}`);
        expect(sql).toContain(`grant all on public.${table} to service_role`);
        expect(sql).toContain(`alter table public.${table} enable row level security`);
    }
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm test -- tests/cloud/merchantV2Store.test.js tests/cloud/supabaseMigrations.test.js
```

Expected: fails because the migration file and store methods do not exist.

- [ ] **Step 3: Add the migration**

Create `supabase/migrations/20260701050000_merchant_api_v2_adapter_backbone.sql` with tables from the spec. Use UUID primary keys, `org_id`, `merchant_id`, `metadata jsonb not null default '{}'::jsonb`, timestamps, status checks, indexes, RLS, and service-role grants.

Required status checks:

```sql
check (status in ('uploaded','completed','deleted','rejected'));
check (status in ('queued','running','completed_mock','completed','failed','canceled'));
check (status in ('draft','submitted','partially_routed','in_production','awaiting_quality','post_processing','ready_to_ship','shipped','completed','canceled','failed'));
check (status in ('reserved','released','expired','consumed'));
check (status in ('queued','running','paused','completed','canceled','failed'));
check (status in ('pending','passed','failed','manual_review'));
check (status in ('pending','running','completed','skipped','failed'));
check (status in ('created','label_requested','label_created','shipped','delivered','canceled'));
check (status in ('draft','issued','void'));
check (status in ('active','disabled'));
check (status in ('queued','delivered','failed','mock_recorded'));
```

- [ ] **Step 4: Add store methods**

Modify `src/cloud/supabaseRest.js` to add one method per test name. Use existing `request`, `firstRow`, and REST path helpers. Keep each method thin:

```js
async createMerchantFile(file) {
    const rows = await request('/rest/v1/merchant_files?select=*', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: file,
    });
    return firstRow(rows);
}
```

For merchant-scoped reads, include `merchant_id=eq.${encodeURIComponent(merchantId)}` in the REST path. For soft deletes, patch `status: 'deleted'` instead of deleting rows.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npm test -- tests/cloud/merchantV2Store.test.js tests/cloud/supabaseMigrations.test.js
```

Expected: pass.

Commit:

```bash
git add supabase/migrations/20260701050000_merchant_api_v2_adapter_backbone.sql src/cloud/supabaseRest.js tests/cloud/merchantV2Store.test.js tests/cloud/supabaseMigrations.test.js
git commit -m "feat: add merchant api v2 store surface"
```

---

### Task 2: Add Shared v2 Helpers And Mock Adapters

**Files:**
- Create: `src/cloud/merchantApiV2.js`
- Create: `src/cloud/adapters/index.js`
- Create: `src/cloud/adapters/mockSlicerAdapter.js`
- Create: `src/cloud/adapters/mockShippingAdapter.js`
- Create: `src/cloud/adapters/mockBillingAdapter.js`
- Create: `src/cloud/adapters/mockInspectionAdapter.js`
- Create: `src/cloud/adapters/mockRealtimeAdapter.js`
- Create: `tests/cloud/merchantAdapters.test.js`

- [ ] **Step 1: Write failing adapter tests**

Create `tests/cloud/merchantAdapters.test.js`:

```js
import { describe, expect, it } from 'vitest';

describe('merchant API v2 mock adapters', () => {
    it('creates deterministic mock adapter outputs', async () => {
        const { createDefaultAdapters } = await import('../../src/cloud/adapters/index.js');
        const adapters = createDefaultAdapters({ now: () => new Date('2026-07-01T05:00:00.000Z') });

        const slice = await adapters.slicer.createSliceJob({
            merchant: { merchant_id: 'm1' },
            sourceFile: { file_id: 'f1', original_name: 'part.stl' },
            profile: { quality: 'standard' },
            requirements: { materials: ['PLA'] },
        });
        expect(slice).toMatchObject({
            provider: 'mock',
            status: 'completed_mock',
            artifact: { original_name: 'part.mock-sliced.gcode.3mf' },
        });

        const shipment = await adapters.shipping.createShipment({
            merchant: { merchant_id: 'm1' },
            order: { order_id: 'o1' },
            address: { country: 'US' },
            packages: [{ weight_grams: 500 }],
        });
        expect(shipment.tracking_number).toMatch(/^mock_track_/);
        expect(shipment.provider).toBe('mock');

        const rateCard = await adapters.billing.getRateCard({ merchant: { merchant_id: 'm1' } });
        expect(rateCard.currency).toBe('USD');
        expect(rateCard.provider).toBe('mock');

        const inspection = await adapters.inspection.getInspection({ job: { job_id: 'j1' } });
        expect(inspection.status).toBe('manual_review');

        const token = await adapters.realtime.createMerchantToken({
            merchant: { merchant_id: 'm1' },
            scopes: ['jobs:read'],
            expiresInSeconds: 300,
        });
        expect(token.token).toMatch(/^pkx_mock_rt_/);
    });
});
```

- [ ] **Step 2: Run failing adapter tests**

Run:

```bash
npm test -- tests/cloud/merchantAdapters.test.js
```

Expected: fails because adapter modules do not exist.

- [ ] **Step 3: Implement helpers**

Create `src/cloud/merchantApiV2.js`:

```js
import crypto from 'node:crypto';

export function createRequestId(prefix = 'req') {
    return `${prefix}_${crypto.randomUUID()}`;
}

export function merchantScope(merchant) {
    return {
        org_id: merchant.org_id,
        merchant_id: merchant.merchant_id,
    };
}

export function publicOk(payload = {}, requestId = createRequestId()) {
    return { ok: true, request_id: requestId, ...payload };
}

export function publicError(error, requestId = createRequestId()) {
    return {
        ok: false,
        error: error.code || 'internal_error',
        message: error.message || 'Unexpected server error',
        request_id: requestId,
    };
}

export function createHttpError(statusCode, code, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.code = code;
    return error;
}
```

- [ ] **Step 4: Implement mock adapters**

Each adapter returns deterministic records with `provider: 'mock'`. Use `crypto.randomUUID()` for IDs and `now().toISOString()` for timestamps. `mockSlicerAdapter` must convert `part.stl` to `part.mock-sliced.gcode.3mf`. `mockShippingAdapter` must return `mock_track_${shipment_id.slice(0, 8)}`. `mockRealtimeAdapter` must return `pkx_mock_rt_${uuidWithoutDashes}`.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npm test -- tests/cloud/merchantAdapters.test.js
```

Expected: pass.

Commit:

```bash
git add src/cloud/merchantApiV2.js src/cloud/adapters tests/cloud/merchantAdapters.test.js
git commit -m "feat: add merchant api v2 adapters"
```

---

### Task 3: Add Files API

**Files:**
- Create: `src/cloud/merchantFiles.js`
- Create: `api/public/files/index.js`
- Create: `api/public/files/[file_id].js`
- Create: `api/public/files/[file_id]/complete.js`
- Create: `tests/cloud/merchantFiles.test.js`

- [ ] **Step 1: Write failing files tests**

Create tests for:

```js
expect(await createFile({ file: { name: 'part.stl', base64: Buffer.from('solid').toString('base64') } }))
    .toMatchObject({ status: 'uploaded', file_mode: 'source_model', checksum_sha256: expect.any(String) });
expect(await completeFile({ file_id: 'file1' })).toMatchObject({ status: 'completed' });
expect(await getFile({ file_id: 'file1' })).toMatchObject({ file_id: 'file1' });
expect(await deleteFile({ file_id: 'file1' })).toMatchObject({ status: 'deleted' });
```

Mock `store` with `createMerchantFile`, `updateMerchantFile`, `getMerchantFile`, and `deleteMerchantFile`. Assert the handler never reads `merchant_id` from request body.

- [ ] **Step 2: Run failing files tests**

Run:

```bash
npm test -- tests/cloud/merchantFiles.test.js
```

Expected: fails because files module and routes do not exist.

- [ ] **Step 3: Implement files module**

Export handler factories:

```js
export function createFileHandlers({ store, authenticateMerchant, now = () => new Date() }) {
    return {
        createFile,
        completeFile,
        getFile,
        deleteFile,
    };
}
```

Classify extensions:

```js
const readyExtensions = new Set(['.gcode', '.3mf', '.gcode.3mf']);
const sourceExtensions = new Set(['.stl', '.obj', '.step', '.stp']);
```

Compute SHA-256 with `crypto.createHash('sha256').update(buffer).digest('hex')`. Store `storage_path` as `${org_id}/${merchant_id}/files/${file_id}/${safeName}` in metadata or the table field chosen in Task 1; never return it publicly.

- [ ] **Step 4: Add route files**

Route files inject `createSupabaseRestClient`, merchant auth, and file handlers. `api/public/files/[file_id].js` supports `GET` and `DELETE`. `api/public/files/[file_id]/complete.js` supports `POST`.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npm test -- tests/cloud/merchantFiles.test.js
```

Expected: pass.

Commit:

```bash
git add src/cloud/merchantFiles.js api/public/files tests/cloud/merchantFiles.test.js
git commit -m "feat: add merchant files api"
```

---

### Task 4: Add Slicing API

**Files:**
- Create: `src/cloud/merchantSlices.js`
- Create: `api/public/slices/index.js`
- Create: `api/public/slices/[slice_id].js`
- Create: `api/public/slices/[slice_id]/cancel.js`
- Create: `tests/cloud/merchantSlices.test.js`

- [ ] **Step 1: Write failing slicing tests**

Test cases:

```js
expect(await createSlice({ file_id: 'source-file', profile: { quality: 'standard' } }))
    .toMatchObject({ status: 'completed_mock', provider: 'mock' });
expect(await getSlice({ slice_id: 'slice1' })).toMatchObject({ slice_id: 'slice1' });
expect(await cancelSlice({ slice_id: 'slice1' })).toMatchObject({ status: 'canceled' });
```

Reject ready-to-print files with `422` and `error: 'source_model_required'`.

- [ ] **Step 2: Run failing slicing tests**

Run:

```bash
npm test -- tests/cloud/merchantSlices.test.js
```

Expected: fails because module and routes do not exist.

- [ ] **Step 3: Implement slicing module**

Use `adapters.slicer.createSliceJob`. Store both a `merchant_slice_jobs` row and a `merchant_job_artifacts` row when the mock adapter returns an artifact. Public response includes `slice_id`, `status`, `provider`, `artifact.file_id` only if an internal file row is created for the mock artifact.

- [ ] **Step 4: Add route files**

`api/public/slices/index.js` handles `POST`. `api/public/slices/[slice_id].js` handles `GET`. `api/public/slices/[slice_id]/cancel.js` handles `POST`.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npm test -- tests/cloud/merchantSlices.test.js tests/cloud/merchantAdapters.test.js
```

Expected: pass.

Commit:

```bash
git add src/cloud/merchantSlices.js api/public/slices tests/cloud/merchantSlices.test.js
git commit -m "feat: add merchant slicing api"
```

---

### Task 5: Add Orders And Routing v2

**Files:**
- Create: `src/cloud/merchantOrders.js`
- Create: `src/cloud/merchantRoutingV2.js`
- Create: `api/public/orders/index.js`
- Create: `api/public/orders/[order_id].js`
- Create: `api/public/orders/[order_id]/cancel.js`
- Create: `api/public/routing/estimate.js`
- Create: `api/public/routing/options.js`
- Create: `tests/cloud/merchantOrders.test.js`
- Create: `tests/cloud/merchantRoutingV2.test.js`

- [ ] **Step 1: Write failing order/routing tests**

Order tests assert:

```js
expect(order).toMatchObject({
    status: 'submitted',
    merchant_order_id: '1001',
    item_count: 2,
});
expect(canceled).toMatchObject({ status: 'canceled' });
```

Routing tests assert:

```js
expect(options.strategies).toEqual(expect.arrayContaining([
    'fastest_fulfillment',
    'cheapest',
    'exact_material_match',
    'batch_by_material',
    'least_printer_wear',
    'ship_cutoff',
]));
expect(estimate).toMatchObject({
    strategy: 'fastest_fulfillment',
    confidence: expect.stringMatching(/^(low|medium|high)$/),
    eta: expect.objectContaining({ queue_minutes: expect.any(Number) }),
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm test -- tests/cloud/merchantOrders.test.js tests/cloud/merchantRoutingV2.test.js
```

Expected: fails because modules and routes do not exist.

- [ ] **Step 3: Implement routing v2**

Wrap existing `merchantRouting.js` where possible. Return merchant-safe route estimates:

```js
{
    strategy,
    confidence,
    eta: { queue_minutes, print_minutes, lead_time_minutes, ship_by_window },
    price_estimate,
    compatible: true,
    rejection_reasons: [],
}
```

Do not return internal `node_id`, `printer_id`, or `spool_id`.

- [ ] **Step 4: Implement orders**

Creating an order writes `merchant_orders`, `merchant_order_items`, usage events, and initial job events. Ready files can create v1 print jobs through existing `merchantPrintHandlers` helpers when the payload requests `auto_submit: true`. Source files create slice jobs when `auto_slice: true`.

- [ ] **Step 5: Add route files, run tests, commit**

Run:

```bash
npm test -- tests/cloud/merchantOrders.test.js tests/cloud/merchantRoutingV2.test.js tests/cloud/merchantRouting.test.js
```

Expected: pass.

Commit:

```bash
git add src/cloud/merchantOrders.js src/cloud/merchantRoutingV2.js api/public/orders api/public/routing tests/cloud/merchantOrders.test.js tests/cloud/merchantRoutingV2.test.js
git commit -m "feat: add merchant orders and routing v2"
```

---

### Task 6: Add Reservations, Batches, Timelines, And Artifacts

**Files:**
- Create: `src/cloud/merchantReservations.js`
- Create: `src/cloud/merchantBatches.js`
- Create: `src/cloud/merchantTimeline.js`
- Create: `api/public/material-reservations/index.js`
- Create: `api/public/material-reservations/[reservation_id].js`
- Create: `api/public/batches/index.js`
- Create: `api/public/batches/[batch_id].js`
- Create: `api/public/batches/[batch_id]/pause.js`
- Create: `api/public/batches/[batch_id]/resume.js`
- Create: `api/public/batches/[batch_id]/cancel.js`
- Create: `api/public/print-jobs/[job_id]/events.js`
- Create: `api/public/print-jobs/[job_id]/artifacts.js`
- Create: `tests/cloud/merchantReservationsV2.test.js`
- Create: `tests/cloud/merchantBatches.test.js`
- Create: `tests/cloud/merchantTimeline.test.js`

- [ ] **Step 1: Write failing tests**

Reservation test:

```js
expect(reservation).toMatchObject({
    status: 'reserved',
    material: 'PLA',
    color_hex: '#ffffff',
    grams_reserved: 250,
});
expect(released).toMatchObject({ status: 'released' });
```

Batch test:

```js
expect(batch).toMatchObject({ status: 'queued', item_count: 3 });
expect(paused).toMatchObject({ status: 'paused' });
expect(resumed).toMatchObject({ status: 'running' });
expect(canceled).toMatchObject({ status: 'canceled' });
```

Timeline test:

```js
expect(events.events[0]).toMatchObject({ event_type: 'job.created' });
expect(artifacts.artifacts[0]).toMatchObject({ artifact_type: 'print_file' });
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm test -- tests/cloud/merchantReservationsV2.test.js tests/cloud/merchantBatches.test.js tests/cloud/merchantTimeline.test.js
```

Expected: fails because modules and routes do not exist.

- [ ] **Step 3: Implement modules**

Reservations must never reveal internal spool IDs. Batches control future scheduling only; pause/resume/cancel must not send hardware stop commands. Timelines read `merchant_job_events` and `merchant_job_artifacts` with merchant scoping, cursor, limit, and event type filters.

- [ ] **Step 4: Add route files, run tests, commit**

Run:

```bash
npm test -- tests/cloud/merchantReservationsV2.test.js tests/cloud/merchantBatches.test.js tests/cloud/merchantTimeline.test.js
```

Expected: pass.

Commit:

```bash
git add src/cloud/merchantReservations.js src/cloud/merchantBatches.js src/cloud/merchantTimeline.js api/public/material-reservations api/public/batches api/public/print-jobs tests/cloud/merchantReservationsV2.test.js tests/cloud/merchantBatches.test.js tests/cloud/merchantTimeline.test.js
git commit -m "feat: add merchant reservations batches and timelines"
```

---

### Task 7: Add Inspection And Post-Processing APIs

**Files:**
- Create: `src/cloud/merchantInspection.js`
- Create: `src/cloud/merchantPostProcessing.js`
- Create: `api/public/print-jobs/[job_id]/inspection.js`
- Create: `api/public/print-jobs/[job_id]/approve-quality.js`
- Create: `api/public/print-jobs/[job_id]/reject-quality.js`
- Create: `api/public/print-jobs/[job_id]/post-processing.js`
- Create: `api/public/print-jobs/[job_id]/post-processing/approve.js`
- Create: `tests/cloud/merchantInspection.test.js`
- Create: `tests/cloud/merchantPostProcessing.test.js`

- [ ] **Step 1: Write failing tests**

Inspection test:

```js
expect(inspection).toMatchObject({ status: 'manual_review', provider: 'mock' });
expect(approved).toMatchObject({ decision: 'approved', status: 'passed' });
expect(rejected).toMatchObject({ decision: 'rejected', status: 'failed', reprint_recommended: true });
```

Post-processing test:

```js
expect(tasks.tasks.map((task) => task.task_type)).toEqual([
    'auto_eject',
    'bed_clear',
    'packing',
    'labeling',
]);
expect(approved).toMatchObject({ status: 'completed' });
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm test -- tests/cloud/merchantInspection.test.js tests/cloud/merchantPostProcessing.test.js
```

Expected: fails because modules and routes do not exist.

- [ ] **Step 3: Implement modules and routes**

Inspection uses `adapters.inspection`. Quality decisions write inspection rows, job events, and usage events. Post-processing returns real task rows and supports approval for a completed merchant-visible task.

- [ ] **Step 4: Run tests and commit**

Run:

```bash
npm test -- tests/cloud/merchantInspection.test.js tests/cloud/merchantPostProcessing.test.js
```

Expected: pass.

Commit:

```bash
git add src/cloud/merchantInspection.js src/cloud/merchantPostProcessing.js api/public/print-jobs tests/cloud/merchantInspection.test.js tests/cloud/merchantPostProcessing.test.js
git commit -m "feat: add merchant inspection and post processing"
```

---

### Task 8: Add Shipping, Billing, And Realtime APIs

**Files:**
- Create: `src/cloud/merchantShipping.js`
- Create: `src/cloud/merchantBilling.js`
- Create: `src/cloud/merchantRealtime.js`
- Create: `api/public/shipments/index.js`
- Create: `api/public/shipments/[shipment_id].js`
- Create: `api/public/shipments/[shipment_id]/label.js`
- Create: `api/public/rate-card/index.js`
- Create: `api/public/invoices/index.js`
- Create: `api/public/realtime/tokens.js`
- Create: `tests/cloud/merchantShipping.test.js`
- Create: `tests/cloud/merchantBilling.test.js`
- Create: `tests/cloud/merchantRealtime.test.js`

- [ ] **Step 1: Write failing tests**

Shipping test:

```js
expect(shipment).toMatchObject({ status: 'created', provider: 'mock' });
expect(label).toMatchObject({ status: 'label_created', label_mode: 'mock' });
```

Billing test:

```js
expect(rateCard).toMatchObject({ currency: 'USD', provider: 'mock' });
expect(invoices.invoices[0]).toMatchObject({ status: 'draft' });
```

Realtime test:

```js
expect(token).toMatchObject({
    token_type: 'mock',
    scopes: ['jobs:read'],
    channels: expect.arrayContaining(['merchant:m1:jobs']),
});
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm test -- tests/cloud/merchantShipping.test.js tests/cloud/merchantBilling.test.js tests/cloud/merchantRealtime.test.js
```

Expected: fails because modules and routes do not exist.

- [ ] **Step 3: Implement modules and routes**

Shipping creates mock shipment, label, and tracking records with `mock_track_...`. Billing returns a default USD rate card and draft invoice records; it must not charge. Realtime returns scoped mock tokens with expiration and channel names.

- [ ] **Step 4: Run tests and commit**

Run:

```bash
npm test -- tests/cloud/merchantShipping.test.js tests/cloud/merchantBilling.test.js tests/cloud/merchantRealtime.test.js
```

Expected: pass.

Commit:

```bash
git add src/cloud/merchantShipping.js src/cloud/merchantBilling.js src/cloud/merchantRealtime.js api/public/shipments api/public/rate-card api/public/invoices api/public/realtime tests/cloud/merchantShipping.test.js tests/cloud/merchantBilling.test.js tests/cloud/merchantRealtime.test.js
git commit -m "feat: add merchant shipping billing and realtime"
```

---

### Task 9: Add Webhooks v2

**Files:**
- Create: `src/cloud/merchantWebhooksV2.js`
- Modify: `api/public/webhooks/index.js`
- Create: `api/public/webhooks/[webhook_id].js`
- Create: `api/public/webhooks/[webhook_id]/test.js`
- Create: `tests/cloud/merchantWebhooksV2.test.js`

- [ ] **Step 1: Write failing webhooks v2 tests**

Test endpoint CRUD, redacted secrets, test delivery, and delivery logging:

```js
expect(created).toMatchObject({ status: 'active', secret: expect.stringMatching(/^whsec_/) });
expect(list.endpoints[0]).not.toHaveProperty('secret');
expect(patched).toMatchObject({ events: ['job.created', 'shipment.created'] });
expect(testDelivery).toMatchObject({ status: 'mock_recorded', event_type: 'webhook.test' });
expect(deleted).toMatchObject({ status: 'disabled' });
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm test -- tests/cloud/merchantWebhooksV2.test.js
```

Expected: fails because module and dynamic routes do not exist.

- [ ] **Step 3: Implement webhooks v2**

Persist endpoint rows in `merchant_webhook_endpoints`. Persist delivery rows in `merchant_webhook_deliveries`. Use existing HMAC helper style from `src/cloud/webhooks.js` for signing test payloads. Redact secrets in all list/get responses after initial creation.

- [ ] **Step 4: Run tests and commit**

Run:

```bash
npm test -- tests/cloud/merchantWebhooksV2.test.js tests/cloud/webhooks.test.js tests/cloud/merchantWebhookHandlers.test.js
```

Expected: pass.

Commit:

```bash
git add src/cloud/merchantWebhooksV2.js api/public/webhooks tests/cloud/merchantWebhooksV2.test.js
git commit -m "feat: add merchant webhooks v2"
```

---

### Task 10: Add Admin API And Dashboard Visibility

**Files:**
- Modify: `src/cloud/adminHandlers.js`
- Create: `api/cloud/merchant-v2.js`
- Modify: `public/cloud.html`
- Modify: `public/js/cloud-dashboard.js`
- Modify: `public/css/cloud.css`
- Create: `tests/cloud/adminMerchantV2Handlers.test.js`
- Modify: `tests/cloud/dashboardAssets.test.js`

- [ ] **Step 1: Write failing admin/dashboard tests**

Admin handler test asserts `GET /api/cloud/merchant-v2` style handler returns:

```js
expect(payload).toMatchObject({
    ok: true,
    v2: expect.objectContaining({
        orders: expect.any(Array),
        files: expect.any(Array),
        slices: expect.any(Array),
        batches: expect.any(Array),
        reservations: expect.any(Array),
        shipments: expect.any(Array),
        invoices: expect.any(Array),
        webhook_deliveries: expect.any(Array),
        adapter_events: expect.any(Array),
    }),
});
```

Dashboard asset test checks IDs:

```js
for (const id of [
    'merchant-v2-orders-table',
    'merchant-v2-files-table',
    'merchant-v2-slices-table',
    'merchant-v2-batches-table',
    'merchant-v2-reservations-table',
    'merchant-v2-shipments-table',
    'merchant-v2-invoices-table',
    'merchant-v2-webhooks-table',
    'merchant-v2-adapters-table',
]) {
    expect(html).toContain(`id="${id}"`);
}
expect(js).toContain('/api/cloud/merchant-v2');
```

- [ ] **Step 2: Run failing tests**

Run:

```bash
npm test -- tests/cloud/adminMerchantV2Handlers.test.js tests/cloud/dashboardAssets.test.js
```

Expected: fails because admin v2 route and dashboard assets do not exist.

- [ ] **Step 3: Implement admin handler and dashboard**

Add read-heavy admin data loading. Keep mutations to cancel order, release reservation, retry webhook delivery, and refresh adapter health only. Render compact tables using existing `renderTable`, `makeStatus`, and detail drawer helpers.

- [ ] **Step 4: Run tests and commit**

Run:

```bash
npm test -- tests/cloud/adminMerchantV2Handlers.test.js tests/cloud/dashboardAssets.test.js
node --check public/js/cloud-dashboard.js
```

Expected: pass.

Commit:

```bash
git add src/cloud/adminHandlers.js api/cloud/merchant-v2.js public/cloud.html public/js/cloud-dashboard.js public/css/cloud.css tests/cloud/adminMerchantV2Handlers.test.js tests/cloud/dashboardAssets.test.js
git commit -m "feat: add merchant api v2 admin visibility"
```

---

### Task 11: Update Public Docs And OpenAPI v2

**Files:**
- Modify: `docs/merchant-api.md`
- Modify: `public/merchant-api.html`
- Create: `public/openapi/merchant-api-v2.json`
- Create: `api/public/openapi-v2.js`
- Modify: `tests/cloud/merchantDocs.test.js`

- [ ] **Step 1: Write failing docs tests**

Add assertions:

```js
const html = fs.readFileSync('public/merchant-api.html', 'utf8');
const spec = JSON.parse(fs.readFileSync('public/openapi/merchant-api-v2.json', 'utf8'));
for (const path of [
    '/api/public/files',
    '/api/public/slices',
    '/api/public/orders',
    '/api/public/routing/estimate',
    '/api/public/material-reservations',
    '/api/public/batches',
    '/api/public/shipments',
    '/api/public/rate-card',
    '/api/public/invoices',
    '/api/public/realtime/tokens',
]) {
    expect(html).toContain(path);
    expect(spec.paths[path]).toBeTruthy();
}
expect(html).toContain('mock adapter');
expect(html).toContain('merchant-api-v2.json');
expect(spec.openapi).toBe('3.1.0');
```

- [ ] **Step 2: Run failing docs tests**

Run:

```bash
npm test -- tests/cloud/merchantDocs.test.js
```

Expected: fails because v2 docs/spec do not exist.

- [ ] **Step 3: Update docs and spec**

Keep `public/openapi/merchant-api-v1.json` unchanged. Add `public/openapi/merchant-api-v2.json` with every v2 route, `MerchantApiKey` security, schemas for all resources, and mock adapter disclaimers in descriptions. Link v1 and v2 specs from `public/merchant-api.html`.

- [ ] **Step 4: Add OpenAPI route**

`api/public/openapi-v2.js` returns the static JSON with `Content-Type: application/json`.

- [ ] **Step 5: Run tests and commit**

Run:

```bash
npm test -- tests/cloud/merchantDocs.test.js
node -e "JSON.parse(require('fs').readFileSync('public/openapi/merchant-api-v2.json','utf8')); console.log('openapi-v2-ok')"
```

Expected: pass and print `openapi-v2-ok`.

Commit:

```bash
git add docs/merchant-api.md public/merchant-api.html public/openapi/merchant-api-v2.json api/public/openapi-v2.js tests/cloud/merchantDocs.test.js
git commit -m "docs: add merchant api v2 public docs"
```

---

### Task 12: Full Verification, Migration, Deploy, And Live Smoke

**Files:**
- All files changed by Tasks 1-11.

- [ ] **Step 1: Run full local verification**

Run:

```bash
git diff --check
npm test
find api src/cloud -name '*.js' -print0 | xargs -0 -n1 node --check
node -e "JSON.parse(require('fs').readFileSync('public/openapi/merchant-api-v2.json','utf8')); console.log('openapi-v2-ok')"
```

Expected:

- `git diff --check` produces no output.
- `npm test` passes all test files.
- Every `node --check` command exits 0.
- OpenAPI parse prints `openapi-v2-ok`.

- [ ] **Step 2: Apply Supabase migration**

Run:

```bash
supabase db push
```

Expected: migration `20260701050000_merchant_api_v2_adapter_backbone` applies to project `qnegcrjdriyuyzyoizzb`.

- [ ] **Step 3: Deploy production**

Run:

```bash
git push origin main
vercel --prod --yes
```

Expected: Vercel reports deployment `READY` and aliases `https://bambu-print-farm-automation.vercel.app`.

- [ ] **Step 4: Smoke public routes**

Run:

```bash
node - <<'NODE'
const base = 'https://bambu-print-farm-automation.vercel.app';
for (const path of [
  '/merchant-api.html',
  '/openapi/merchant-api-v2.json',
  '/api/public/openapi-v2',
  '/api/public/farm/capabilities',
  '/api/public/farm/filaments'
]) {
  const res = await fetch(`${base}${path}`);
  console.log(path, res.status);
}
NODE
```

Expected:

- Public docs/spec routes return `200`.
- Farm capability/filament routes return `200`.

- [ ] **Step 5: Smoke auth behavior**

Run:

```bash
node - <<'NODE'
const base = 'https://bambu-print-farm-automation.vercel.app';
for (const path of [
  '/api/public/files',
  '/api/public/orders',
  '/api/public/routing/estimate',
  '/api/public/realtime/tokens'
]) {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const text = await res.text();
  console.log(path, res.status, text.slice(0, 120).replace(/\s+/g, ' '));
}
NODE
```

Expected: merchant-authenticated routes return `401` with `missing_merchant_api_key` or equivalent existing auth code.

- [ ] **Step 6: Check Vercel logs**

Run:

```bash
vercel logs --environment production --since 30m --level error --no-follow --limit 50
```

Expected: no new 500-level errors from v2 route smoke checks.

- [ ] **Step 7: Final commit state**

Run:

```bash
git status --short
git log -1 --oneline
```

Expected: clean working tree and latest commit for the v2 docs/deploy completion.

Report production URL, deployment ID, tests, migration status, and any remaining mock-adapter limitations.
