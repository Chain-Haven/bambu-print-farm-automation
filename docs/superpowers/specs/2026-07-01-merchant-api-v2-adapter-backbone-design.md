# Merchant API v2 Adapter Backbone Design

## Goal

Build a full merchant automation API for PrintKinetix that covers file intake, slicing, orders, routing, job timelines, material reservations, batches, QA, post-processing, shipping, billing, webhooks, and realtime updates.

The first implementation must be useful without waiting on external provider credentials. It will create real internal records, state transitions, usage events, webhook events, and admin visibility, while placing slicer, shipping, billing, inspection, and realtime provider calls behind adapter interfaces with production-safe mock adapters.

## Current Context

The existing platform already has:

- Merchant signup, approval, setup token exchange, and `pkx_live_...` API keys.
- Public farm capabilities and filament availability endpoints.
- Quote, preflight, print-job submit, status, cancel, approve, and reprint routes.
- Merchant webhooks and public integrations catalog.
- Supabase-backed merchants, API keys, routing decisions, usage events, status history, print jobs, job files, and private print artifact storage.
- A Vercel cloud control plane and a Windows local-node command loop that can execute printer work on the LAN.

Merchant API v2 should extend this surface rather than replace v1.

## Scope

### Add Public Merchant Routes

Files:

- `POST /api/public/files`
- `POST /api/public/files/{file_id}/complete`
- `GET /api/public/files/{file_id}`
- `DELETE /api/public/files/{file_id}`

Slicing:

- `POST /api/public/slices`
- `GET /api/public/slices/{slice_id}`
- `POST /api/public/slices/{slice_id}/cancel`

Orders:

- `POST /api/public/orders`
- `GET /api/public/orders/{order_id}`
- `POST /api/public/orders/{order_id}/cancel`

Routing and ETA:

- `POST /api/public/routing/estimate`
- `GET /api/public/routing/options`

Job timeline and artifacts:

- `GET /api/public/print-jobs/{job_id}/events`
- `GET /api/public/print-jobs/{job_id}/artifacts`

Material reservations:

- `POST /api/public/material-reservations`
- `GET /api/public/material-reservations/{reservation_id}`
- `DELETE /api/public/material-reservations/{reservation_id}`

Batches:

- `POST /api/public/batches`
- `GET /api/public/batches/{batch_id}`
- `POST /api/public/batches/{batch_id}/pause`
- `POST /api/public/batches/{batch_id}/resume`
- `POST /api/public/batches/{batch_id}/cancel`

QA and inspection:

- `GET /api/public/print-jobs/{job_id}/inspection`
- `POST /api/public/print-jobs/{job_id}/approve-quality`
- `POST /api/public/print-jobs/{job_id}/reject-quality`

Post-processing:

- `GET /api/public/print-jobs/{job_id}/post-processing`
- `POST /api/public/print-jobs/{job_id}/post-processing/approve`

Shipping:

- `POST /api/public/shipments`
- `GET /api/public/shipments/{shipment_id}`
- `POST /api/public/shipments/{shipment_id}/label`

Billing and usage:

- `GET /api/public/usage`
- `GET /api/public/rate-card`
- `GET /api/public/invoices`

Webhooks v2:

- `GET /api/public/webhooks`
- `POST /api/public/webhooks`
- `PATCH /api/public/webhooks/{webhook_id}`
- `DELETE /api/public/webhooks/{webhook_id}`
- `POST /api/public/webhooks/{webhook_id}/test`

Realtime:

- `POST /api/public/realtime/tokens`

### Add Admin Visibility

The `/cloud` admin console should gain compact management views for:

- Orders
- Files
- Slices
- Batches
- Reservations
- QA and post-processing states
- Shipments
- Usage, rate cards, and invoices
- Webhook delivery logs
- Adapter health/status

Admin visibility can be read-heavy in the first pass. Mutations should be limited to operationally necessary actions such as canceling orders, releasing reservations, retrying webhook deliveries, and refreshing adapter status.

## Non-Goals For First Pass

- Do not integrate real ShipStation, Stripe, slicer cloud services, or realtime providers yet.
- Do not expose internal printer IDs, node IDs, spool IDs, rack locations, lot codes, or Supabase storage paths to merchants.
- Do not build a separate backend service. Keep the Vercel/Supabase architecture and existing merchant authentication.
- Do not replace v1 routes. v2 routes should coexist and may reuse v1 handlers where the contract already fits.

## Architecture

### Modules

Add focused modules under `src/cloud`:

- `merchantFiles.js`
- `merchantSlices.js`
- `merchantOrders.js`
- `merchantRoutingV2.js`
- `merchantTimeline.js`
- `merchantReservations.js`
- `merchantBatches.js`
- `merchantInspection.js`
- `merchantPostProcessing.js`
- `merchantShipping.js`
- `merchantBilling.js`
- `merchantWebhooksV2.js`
- `merchantRealtime.js`
- `adapters/index.js`
- `adapters/mockSlicerAdapter.js`
- `adapters/mockShippingAdapter.js`
- `adapters/mockBillingAdapter.js`
- `adapters/mockInspectionAdapter.js`
- `adapters/mockRealtimeAdapter.js`

Each module should own one workflow boundary and export handler factories that accept `{ store, authenticateMerchant, adapters, now }`.

### Adapter Interfaces

Adapters must return deterministic, testable results and never require provider secrets in the first pass.

Slicer adapter:

```js
{
  createSliceJob({ merchant, sourceFile, profile, requirements }),
  getSliceJob({ sliceId }),
  cancelSliceJob({ sliceId })
}
```

Shipping adapter:

```js
{
  createShipment({ merchant, order, address, packages }),
  createLabel({ shipment }),
  getTracking({ shipment })
}
```

Billing adapter:

```js
{
  getRateCard({ merchant }),
  createUsageLine({ merchant, event }),
  createInvoice({ merchant, period })
}
```

Inspection adapter:

```js
{
  getInspection({ job }),
  createQualityDecision({ job, decision, reason })
}
```

Realtime adapter:

```js
{
  createMerchantToken({ merchant, scopes, expiresInSeconds })
}
```

Mock adapters should create realistic statuses and payloads, clearly marking `provider: "mock"` or `mode: "adapter_mock"` in internal metadata.

## Data Model

Add a Supabase migration for:

- `merchant_files`
- `merchant_slice_jobs`
- `merchant_orders`
- `merchant_order_items`
- `merchant_material_reservations`
- `merchant_batches`
- `merchant_batch_items`
- `merchant_job_events`
- `merchant_job_artifacts`
- `merchant_inspections`
- `merchant_post_processing_tasks`
- `merchant_shipments`
- `merchant_shipping_labels`
- `merchant_rate_cards`
- `merchant_invoices`
- `merchant_invoice_lines`
- `merchant_webhook_endpoints`
- `merchant_webhook_deliveries`
- `merchant_realtime_tokens`
- `merchant_adapter_events`

All tables should include:

- `org_id`
- `merchant_id` where merchant-scoped
- primary UUID
- `metadata jsonb not null default '{}'::jsonb`
- `created_at`
- `updated_at` where mutable

Indexes should favor merchant dashboards:

- `(merchant_id, created_at desc)`
- `(merchant_id, status, created_at desc)`
- foreign keys for order/job/file/batch lookups

RLS should be enabled, with service-role access for Vercel handlers. Merchant isolation is enforced in handlers by authenticated merchant identity, not by trusting request body IDs.

## Workflow

### File Intake

Merchants can upload files independently from print jobs. File records should store:

- Merchant-visible file ID
- Original filename
- Content type
- Size
- SHA-256 checksum
- File mode: `ready_to_print` or `source_model`
- Storage object path internally only
- Processing status: `uploaded`, `completed`, `deleted`, `rejected`

`POST /files` may accept JSON base64 first to match the current v1 API. The schema should leave room for future signed multipart/resumable uploads.

### Slicing

Source models can create slice jobs. Mock slicing should:

- Validate source-model file type.
- Store requested profile, material, color, support, infill, quality, and plate settings.
- Return `queued` then a deterministic `completed_mock` status when retrieved, with a mock artifact record.

This makes API clients build against the final slicing lifecycle while real slicing is added later.

### Orders

Orders group files, slices, jobs, shipments, billing, and merchant external order IDs.

Order statuses:

- `draft`
- `submitted`
- `partially_routed`
- `in_production`
- `awaiting_quality`
- `post_processing`
- `ready_to_ship`
- `shipped`
- `completed`
- `canceled`
- `failed`

Creating an order should optionally create print jobs immediately for ready files and create slice jobs for source models.

### Routing And Reservations

Routing v2 should wrap existing merchant routing and expose merchant-safe estimates:

- `fastest_fulfillment`
- `cheapest`
- `exact_material_match`
- `batch_by_material`
- `least_printer_wear`
- `ship_cutoff`

Routing estimate responses should include:

- Compatible materials/colors
- Queue minute estimate
- Print minute estimate
- Ship/pickup ETA band
- Confidence level
- Rejection reasons without exposing internal hardware IDs

Material reservations should reserve aggregate filament capacity by material/color/grams and link to files, orders, jobs, or batches.

### Job Timeline

Job events should normalize cloud and Windows-node activity into merchant-safe events:

- `job.created`
- `job.routed`
- `file.uploaded`
- `slice.queued`
- `slice.completed`
- `print.queued`
- `print.started`
- `print.paused`
- `print.failed`
- `print.completed`
- `inspection.ready`
- `quality.approved`
- `quality.rejected`
- `post_processing.started`
- `post_processing.completed`
- `shipment.created`
- `shipment.label_created`
- `shipment.shipped`

Timeline APIs should support `limit`, `cursor`, and event-type filters.

### Batches

Batches let merchants submit production runs. A batch can reference:

- Existing files
- Existing orders
- New print-job requests

Batch controls pause/resume/cancel should update batch status and future job scheduling, not abruptly stop already-printing hardware unless a separate explicit emergency stop is added later.

### QA And Post-Processing

Mock inspection should create real inspection records with:

- `pending`
- `passed`
- `failed`
- `manual_review`

Quality approval/rejection should update job/order state and optionally request a reprint. Post-processing tasks should track:

- Auto-eject
- Bed clear
- Support removal
- Packing
- Labeling

First pass should store states and events. Physical automation can connect later through Windows node commands.

### Shipping

Shipping routes should create shipment and label records through `mockShippingAdapter`.

Mock labels must be clearly marked non-carrier labels and should not produce real tracking numbers that could be confused with carrier data. Use deterministic IDs such as `mock_track_...`.

### Billing And Usage

Billing should expand current usage tracking with:

- Rate-card endpoint
- Usage events grouped by merchant, job, order, file, shipment, and slice
- Invoice records and invoice line records

Mock billing should not charge. It should produce invoice previews and usage totals suitable for export.

### Webhooks v2

Webhook endpoints should be first-class rows rather than only metadata.

Features:

- CRUD endpoints
- Event allowlist
- HMAC signing
- Test event delivery
- Delivery log rows
- Retry state fields

First pass may record delivery attempts without making outbound HTTP calls when endpoint mode is `mock`. If real HTTP delivery already exists safely, v2 can reuse it through a dispatcher that logs every attempt.

### Realtime

Realtime tokens should return short-lived mock tokens in the first pass:

- Merchant ID
- Scopes
- Expiration
- Suggested channel names

Do not claim these are Supabase Realtime tokens until the real adapter is implemented. The API contract should be future-compatible.

## Error Handling

Every public route should return:

```json
{
  "ok": false,
  "error": "machine_readable_code",
  "message": "Human readable message",
  "request_id": "req_..."
}
```

Use these status patterns:

- `400` validation errors
- `401` missing/invalid API key
- `403` inactive/suspended merchant
- `404` merchant-scoped resource not found
- `409` invalid lifecycle transition or idempotency conflict
- `422` accepted but not automatable, such as source model needs slicing
- `500` unexpected server error

## Security And Privacy

- Never trust `merchant_id` or `org_id` from public request bodies.
- Never expose raw storage paths, Supabase signed URLs, node tokens, admin tokens, printer IDs, node IDs, spool IDs, or access codes.
- All resource reads and mutations must be scoped to the authenticated merchant.
- Keep file checksum validation server-side.
- Redact webhook secrets after creation.
- Use idempotency keys for create-heavy endpoints where duplicate merchant retries are likely.

## Documentation

Update:

- `docs/merchant-api.md`
- `public/merchant-api.html`
- `public/openapi/merchant-api-v2.json`

Keep `public/openapi/merchant-api-v1.json` stable for existing clients and link both specs from the public docs.

Docs must include:

- Auth and setup
- Route list
- State diagrams in text form
- File upload examples
- Order examples
- Slicing examples
- Batch examples
- Timeline polling examples
- Shipping mock-mode disclaimer
- Billing mock-mode disclaimer
- Webhook signing and delivery logs
- Realtime token mock-mode disclaimer
- Error codes

## Testing

Add focused Vitest coverage for each module:

- Store methods and migration presence
- Files
- Slices
- Orders
- Routing v2
- Timeline/artifacts
- Reservations
- Batches
- Inspection
- Post-processing
- Shipping
- Billing
- Webhooks v2
- Realtime
- Public docs and OpenAPI parsing
- Admin dashboard assets

Run full `npm test` before any deployment.

## Rollout Plan

Phase 1: Schema and store surface.

Phase 2: Files, slices, orders, and routing estimates.

Phase 3: Reservations, batches, timelines, and artifacts.

Phase 4: QA, post-processing, shipping, billing, webhooks v2, and realtime mock adapters.

Phase 5: Admin dashboard and public docs/OpenAPI.

Phase 6: Production deploy and live smoke checks.

## Acceptance Criteria

- Every route listed in scope exists and is documented.
- Every route enforces merchant authentication unless explicitly public.
- Merchants can create files, orders, slices, batches, reservations, shipments, and invoices with real database records.
- Mock adapters produce deterministic, clearly marked provider results.
- Job/order/batch timelines show state changes.
- Webhook endpoint CRUD and delivery logging work.
- Public docs and OpenAPI are live and parseable.
- Full tests pass.
- Production deployment succeeds and route smoke checks pass.

## Self-Review Notes

- No external provider is required in the first pass.
- The design keeps v1 intact and extends it with v2-style resources.
- Mock adapters are explicit and cannot be mistaken for real charging, shipping, or slicing providers.
- Merchant isolation is stated repeatedly because this API expansion touches many resource types.
- Physical printer actions remain routed through the existing Windows node command loop.
