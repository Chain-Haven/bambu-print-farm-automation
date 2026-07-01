# PrintKinetix Merchant API v1

The Merchant API lets approved merchants submit print files into PrintKinetix for automated routing and fulfillment.

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

Merchant endpoints use:

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
