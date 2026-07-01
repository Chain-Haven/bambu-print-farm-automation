# PrintKinetix Merchant API

The Merchant API lets approved merchants submit print files into PrintKinetix for automated routing and fulfillment. Merchant API v1 remains available for basic print-job ingestion. Merchant API v2 adds the adapter-backed workflow surface for files, slicing, orders, routing, reservations, batches, QA, post-processing, shipping, billing, realtime tokens, and webhooks.

Public merchant URLs:

- Public onboarding page: `/merchant-onboarding.html`
- Public API docs page: `/merchant-api.html`
- Merchant API v1 OpenAPI JSON: `/openapi/merchant-api-v1.json`
- Merchant API v2 OpenAPI JSON: `/openapi/merchant-api-v2.json`
- Merchant API v2 JSON route: `/api/public/openapi-v2`

## Onboarding

1. Merchant signs up with `POST /api/public/merchants/signup`.
2. Signup is approval-required by default. The merchant is created with `status: pending` and no credentials are issued.
3. An admin approves the merchant with `POST /api/cloud/merchants`.
4. The admin can issue a one-time `pkx_setup_...` setup token during approval or later with `POST /api/cloud/merchant-setup-token`.
5. The merchant exchanges the setup token for a live `pkx_live_...` API key with `POST /api/public/api-keys`, or an admin issues a live key directly with `POST /api/cloud/merchant-api-keys`.

Full-auto merchant signup is available through the admin setting `full_auto_merchant_mode`, but it defaults to disabled.

Farm automation settings live behind `GET/PATCH /api/cloud/farm-automation`. The Vercel admin console uses that endpoint to manage smart material queueing, auto-eject policy, filament/AMS spool inventory, low-spool alerts, camera failure hooks, ecommerce hooks, shipping hooks, and remote-access integration metadata.

Public farm filament availability is served by `GET /api/public/farm/filaments`. It does not require merchant auth and only returns safe aggregate material/color availability. Internal spool IDs, printer IDs, rack locations, lot codes, and reserved job IDs are never exposed.

Public farm capabilities are served by `GET /api/public/farm/capabilities`. It returns accepted file types, routing strategies, max build volume, enabled automation features, safe filament availability, and public integration readiness without exposing printer IDs or node IDs.

## Authentication

Merchant endpoints use live API-key bearer auth:

```http
Authorization: Bearer pkx_live_...
```

For print-job creation, send a unique idempotency header to avoid duplicate jobs if a merchant system retries:

```http
Idempotency-Key: order-1001-print-v1
```

Setup-token exchange uses:

```http
X-Merchant-Setup-Token: pkx_setup_...
```

Admin endpoints use:

```http
Authorization: Bearer <CLOUD_ADMIN_TOKEN>
```

Merchant API v2 webhooks require production operator configuration before live setup:

```text
MERCHANT_WEBHOOK_SIGNING_SECRET_KEY=<high-entropy encryption key>
```

Without `MERCHANT_WEBHOOK_SIGNING_SECRET_KEY`, v2 webhook creation fails closed because signing secrets cannot be encrypted for storage.

## Merchant API v2 Mode

Merchant API v2 is public and merchant-facing, but the external provider layer is adapter-first. Unless production adapters are configured, v2 records files, slices, orders, shipments, invoices, inspections, and realtime tokens through deterministic mock adapter implementations. Mock adapter records are useful for onboarding, integration tests, and operator review, but they do not buy carrier labels, charge accounts, run a real slicer provider, or issue production realtime credentials.

Use `Authorization: Bearer pkx_live_...` for all authenticated v2 calls. Include an `Idempotency-Key` header for create calls that may be retried by a merchant system.

## Merchant API v2 Routes

Files:

- `POST /api/public/files` creates a file record.
- `GET /api/public/files` is not currently implemented; read individual files by ID.
- `GET /api/public/files/{file_id}` reads one file.
- `DELETE /api/public/files/{file_id}` deletes one file.
- `POST /api/public/files/{file_id}/complete` marks upload complete.

Slices:

- `POST /api/public/slices` creates a slice job through the slicer adapter.
- `GET /api/public/slices/{slice_id}` reads one slice job.
- `POST /api/public/slices/{slice_id}/cancel` cancels one slice job.

Orders and routing:

- `POST /api/public/orders` creates an order.
- `GET /api/public/orders` is not currently implemented; read individual orders by ID.
- `GET /api/public/orders/{order_id}` reads one order.
- `POST /api/public/orders/{order_id}/cancel` cancels one order.
- `POST /api/public/routing/estimate` estimates routing, capacity, cost, and lead time.
- `GET /api/public/routing/options` lists routing options.

Print-job timeline, artifacts, and QA:

- `GET /api/public/print-jobs/{job_id}/events` lists job timeline events.
- `GET /api/public/print-jobs/{job_id}/artifacts` lists generated job artifacts.
- `GET /api/public/print-jobs/{job_id}/inspection` reads inspection state for a job.
- `POST /api/public/print-jobs/{job_id}/inspection` requests inspection for a job.
- `POST /api/public/inspections/{inspection_id}/accept` accepts an inspection result.
- `POST /api/public/inspections/{inspection_id}/reject` rejects an inspection result.
- `POST /api/public/inspections/{inspection_id}/manual-review` sends an inspection to manual review.

Post-processing:

- `GET /api/public/post-processing/tasks` lists post-processing tasks.
- `POST /api/public/post-processing/tasks` creates a post-processing task.
- `GET /api/public/post-processing/tasks/{task_id}` reads one task.
- `POST /api/public/post-processing/tasks/{task_id}/start` starts one task.
- `POST /api/public/post-processing/tasks/{task_id}/complete` completes one task.
- `POST /api/public/post-processing/tasks/{task_id}/fail` fails one task.
- `POST /api/public/post-processing/tasks/{task_id}/skip` skips one task.

Materials and batches:

- `POST /api/public/material-reservations` creates a material reservation.
- `GET /api/public/material-reservations/{reservation_id}` reads one reservation.
- `POST /api/public/material-reservations/{reservation_id}/release` releases one reservation.
- `POST /api/public/batches` creates a batch.
- `GET /api/public/batches/{batch_id}` reads one batch.
- `POST /api/public/batches/{batch_id}/pause` pauses one batch.
- `POST /api/public/batches/{batch_id}/resume` resumes one batch.
- `POST /api/public/batches/{batch_id}/cancel` cancels one batch.

Shipping:

- `GET /api/public/shipments` lists shipments.
- `POST /api/public/shipments` creates a shipment through the shipping adapter.
- `GET /api/public/shipments/{shipment_id}` reads one shipment.
- `POST /api/public/shipments/{shipment_id}/labels` creates a label. The implemented route uses `/labels` plural.

Billing:

- `GET /api/public/billing/rate-card` reads the rate-card route. Use this path in live integrations.
- `/api/public/rate-card` may appear in planning notes as a short discovery label only. It is not an executable route; use `/api/public/billing/rate-card`.
- `GET /api/public/billing/usage` lists usage lines.
- `GET /api/public/billing/invoices` lists invoices. Use this path in live integrations.
- `/api/public/invoices` may appear in planning notes as a short discovery label only. It is not an executable route; use `/api/public/billing/invoices`.
- `GET /api/public/billing/invoices/{invoice_id}` reads one invoice.
- `POST /api/public/billing/invoices/preview` previews invoice totals.

Realtime and webhooks:

- `GET /api/public/realtime/tokens` lists realtime tokens.
- `POST /api/public/realtime/tokens` creates a realtime token through the realtime adapter.
- `GET /api/public/webhooks` lists webhook endpoints.
- `POST /api/public/webhooks` creates a webhook endpoint and returns the signing secret once.
- `GET /api/public/webhooks/{webhook_id}` reads one endpoint.
- `PATCH /api/public/webhooks/{webhook_id}` updates one endpoint.
- `DELETE /api/public/webhooks/{webhook_id}` deletes one endpoint.
- `POST /api/public/webhooks/{webhook_id}/test` sends a signed test delivery.

## Submit A Print Job

`POST /api/public/print-jobs`

```json
{
  "name": "Order 1001",
  "file": {
    "name": "part.gcode.3mf",
    "content_type": "application/octet-stream",
    "base64": "..."
  },
  "requirements": {
    "dimensions_mm": { "x": 100, "y": 100, "z": 80 },
    "materials": ["PLA"],
    "colors": ["#ffffff"]
  },
  "options": {
    "merchant_order_id": "1001"
  }
}
```

Ready files: `.gcode`, `.3mf`, `.gcode.3mf`.
Source models: `.stl`, `.obj`, `.step`, `.stp`.

Ready files are routed with the `fastest_fulfillment` strategy. Source models are accepted and tracked with `needs_slicing` until slicing automation is added.

Routing strategies:

- `fastest_fulfillment`: shortest available queue
- `batch_by_material`: prefers printers already running the requested material
- `least_printer_wear`: prefers lower lifetime print hours when capacity is otherwise equal
- `ship_cutoff`: weighs queue depth more aggressively for promised ship times

## Quote And Preflight

`POST /api/public/quotes` returns estimated material grams, print minutes, queue minutes, lead time, and price before creating a job.

`POST /api/public/print-jobs/preflight` validates file type, dimensions, routing capacity, and review flags. Source models are accepted but return a `source_model_requires_slicing` warning.

```json
{
  "requirements": {
    "dimensions_mm": { "x": 100, "y": 80, "z": 40 },
    "materials": ["PETG"],
    "colors": ["#ffaa00"],
    "estimated_grams": 120
  },
  "options": {
    "routing_strategy": "ship_cutoff"
  }
}
```

## Job Lifecycle

Merchant-authenticated lifecycle controls:

- `POST /api/public/print-jobs/approve`
- `POST /api/public/print-jobs/cancel`
- `POST /api/public/print-jobs/reprint`

Each request uses:

```json
{
  "job_id": "job_...",
  "reason": "Customer changed order"
}
```

Canceling a job releases any matching filament reservation. Reprint creates a new `reprint_requested` job tied to the original file.

## Webhooks And Integrations

`GET /api/public/integrations` lists supported integrations such as Shopify, WooCommerce, Etsy, ShipStation, Slack, Zapier, Make, and direct webhooks.

`GET/POST /api/public/webhooks` manages the merchant webhook endpoint. Webhook secrets are stored in merchant metadata and redacted from responses.

Webhook deliveries include:

```http
X-PrintKinetix-Event: job.accepted
X-PrintKinetix-Timestamp: 1782916800
X-PrintKinetix-Signature: v1=<hmac-sha256>
```

Verify signatures by computing `HMAC_SHA256(secret, timestamp + "." + raw_body)` and comparing it to the `v1=` value. Supported events include `job.accepted`, `job.needs_approval`, `job.approved`, `job.canceled`, `job.reprint_requested`, `job.failed`, `job.completed`, `job.shipped`, and `filament.unavailable`.

## Public Farm Filaments

`GET /api/public/farm/filaments`

```json
{
  "ok": true,
  "filaments": {
    "materials": [
      {
        "material": "PLA",
        "spool_count": 2,
        "available_spool_count": 1,
        "total_grams_remaining": 1800,
        "available_grams_remaining": 1200,
        "colors": [
          {
            "color_hex": "#FFFFFF",
            "color_name": "White",
            "spool_count": 1,
            "available_spool_count": 1,
            "total_grams_remaining": 1200,
            "available_grams_remaining": 1200
          }
        ]
      }
    ],
    "colors": [
      {
        "color_hex": "#FFFFFF",
        "color_name": "White",
        "materials": ["PLA"],
        "spool_count": 1,
        "available_spool_count": 1,
        "total_grams_remaining": 1200,
        "available_grams_remaining": 1200
      }
    ],
    "updated_at": null
  }
}
```

## Public Documentation

The public HTML docs are served at `/merchant-api.html`.
The OpenAPI spec is served at `/openapi/merchant-api-v1.json`.
The Merchant API v2 OpenAPI spec is served at `/openapi/merchant-api-v2.json` and `/api/public/openapi-v2`.
