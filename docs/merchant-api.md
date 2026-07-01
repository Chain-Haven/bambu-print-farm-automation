# PrintKinetix Merchant API v1

The Merchant API lets approved merchants submit print files into PrintKinetix for automated routing and fulfillment.

## Onboarding

1. Merchant signs up with `POST /api/public/merchants/signup`.
2. Signup is approval-required by default. The merchant is created with `status: pending` and no credentials are issued.
3. An admin approves the merchant with `POST /api/cloud/merchants`.
4. The admin can issue a one-time `pkx_setup_...` setup token during approval or later with `POST /api/cloud/merchant-setup-token`.
5. The merchant exchanges the setup token for a live `pkx_live_...` API key with `POST /api/public/api-keys`, or an admin issues a live key directly with `POST /api/cloud/merchant-api-keys`.

Full-auto merchant signup is available through the admin setting `full_auto_merchant_mode`, but it defaults to disabled.

## Authentication

Merchant endpoints use:

```http
Authorization: Bearer pkx_live_...
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

## Public Documentation

The public HTML docs are served at `/merchant-api.html`.
The OpenAPI spec is served at `/openapi/merchant-api-v1.json`.
