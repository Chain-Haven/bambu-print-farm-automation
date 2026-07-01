# Merchant API Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the live merchant API into a production-facing print farm API with public capabilities, quote/preflight, lifecycle controls, webhook/integration management, idempotent job submission, filament reservation, SLA-aware routing, and upgraded docs.

**Architecture:** Add focused cloud modules beside the existing merchant API handlers rather than creating a second backend. Reuse Supabase `platform_settings` for farm policy/inventory/integrations, `print_jobs.options` for idempotency and lifecycle metadata, `merchant.metadata` for webhook settings, and `merchant_usage_events` for operational audit trails. Keep public unauthenticated farm discovery separate from merchant-authenticated job/quote/lifecycle/webhook endpoints.

**Tech Stack:** Vercel serverless routes, Supabase REST service-role client, Vitest, existing merchant bearer auth, OpenAPI 3.1 JSON, static public docs.

---

### Task 1: Public Farm Capabilities

**Files:**
- Create: `src/cloud/farmCapabilities.js`
- Modify: `src/cloud/publicFarmHandlers.js`
- Create: `api/public/farm/capabilities.js`
- Test: `tests/cloud/farmCapabilities.test.js`
- Test: `tests/cloud/publicFarmHandlers.test.js`

- [ ] Write failing tests for safe aggregate capabilities: file types, routing strategies, max build volume, materials, colors, feature map, and no printer/node internals.
- [ ] Implement capability aggregation from farm overview, farm automation policy, public filament availability, and integrations.
- [ ] Add a public GET handler and Vercel route.
- [ ] Run targeted farm capability tests.

### Task 2: Quote And Preflight

**Files:**
- Create: `src/cloud/printIntake.js`
- Create: `src/cloud/quoteEstimator.js`
- Create: `src/cloud/merchantQuoteHandlers.js`
- Create: `api/public/quotes/index.js`
- Create: `api/public/print-jobs/preflight.js`
- Test: `tests/cloud/quoteEstimator.test.js`
- Test: `tests/cloud/merchantQuoteHandlers.test.js`

- [ ] Write failing tests for quote estimates, lead-time bands, validation warnings, route status, and source-model review flags.
- [ ] Extract file classification and requirement normalization into `printIntake.js`.
- [ ] Implement deterministic quote/preflight estimates using dimensions, estimated grams, material multipliers, queue depth, and routing.
- [ ] Add merchant-authenticated quote and preflight handlers.
- [ ] Run targeted quote/preflight tests.

### Task 3: SLA-Aware Routing And Reservations

**Files:**
- Modify: `src/cloud/merchantRouting.js`
- Create: `src/cloud/filamentReservations.js`
- Modify: `src/cloud/merchantPrintHandlers.js`
- Test: `tests/cloud/merchantRouting.test.js`
- Test: `tests/cloud/filamentReservations.test.js`
- Test: `tests/cloud/merchantPrintHandlers.test.js`

- [ ] Write failing tests for `batch_by_material`, `least_printer_wear`, and `ship_cutoff` strategies.
- [ ] Write failing tests for reserving a matching dry/unreserved spool on accepted ready-print jobs.
- [ ] Implement strategy-aware score weights while preserving `fastest_fulfillment` defaults.
- [ ] Implement best-effort reservation and release helpers against `farm_filament_inventory`.
- [ ] Wire idempotency keys and reservations into print-job creation.
- [ ] Run targeted routing/reservation/job tests.

### Task 4: Lifecycle Controls

**Files:**
- Create: `src/cloud/merchantLifecycleHandlers.js`
- Create: `api/public/print-jobs/cancel.js`
- Create: `api/public/print-jobs/approve.js`
- Create: `api/public/print-jobs/reprint.js`
- Test: `tests/cloud/merchantLifecycleHandlers.test.js`

- [ ] Write failing tests for cancel, approve, and reprint with merchant scoping and usage events.
- [ ] Implement lifecycle validation, job patching, reservation release on cancel, and copied reprint job creation.
- [ ] Return standardized request IDs and machine-readable errors.
- [ ] Run targeted lifecycle tests.

### Task 5: Webhooks And Integrations

**Files:**
- Create: `src/cloud/webhooks.js`
- Create: `src/cloud/merchantWebhookHandlers.js`
- Create: `api/public/webhooks/index.js`
- Create: `api/public/integrations/index.js`
- Modify: `src/cloud/merchantPrintHandlers.js`
- Modify: `src/cloud/merchantLifecycleHandlers.js`
- Test: `tests/cloud/webhooks.test.js`
- Test: `tests/cloud/merchantWebhookHandlers.test.js`

- [ ] Write failing tests for webhook config persistence in merchant metadata, event signing, supported integration catalog, and dispatch on job/lifecycle events.
- [ ] Implement HMAC `X-PrintKinetix-Signature` delivery with event allowlists and no raw API-key exposure.
- [ ] Add merchant-authenticated webhook config endpoints and a public integrations catalog endpoint.
- [ ] Fire best-effort webhooks for job accepted, needs approval, canceled, approved, reprint requested, failed, completed, shipped, and filament unavailable events where this API controls the transition.
- [ ] Run targeted webhook tests.

### Task 6: Docs And OpenAPI

**Files:**
- Modify: `docs/merchant-api.md`
- Modify: `public/merchant-api.html`
- Modify: `public/openapi/merchant-api-v1.json`
- Test: `tests/cloud/merchantDocs.test.js`

- [ ] Write failing docs tests for every new endpoint and the OpenAPI schemas.
- [ ] Add quickstart, lifecycle, webhook verification, quote/preflight, capabilities, integrations, idempotency, errors, and routing strategy docs.
- [ ] Add OpenAPI paths/schemas/security declarations.
- [ ] Parse OpenAPI JSON and run docs tests.

### Task 7: Verification And Release

**Files:**
- All touched source, route, docs, and test files.

- [ ] Run `npm test`.
- [ ] Run `git diff --check`.
- [ ] Run `node --check` on new source and route files.
- [ ] Parse `public/openapi/merchant-api-v1.json`.
- [ ] Commit and push `main`.
- [ ] Deploy production with `vercel deploy --prod --yes --scope chain-havens-projects`.
- [ ] Smoke live capabilities, filament, quote/preflight auth behavior, docs, OpenAPI, and Vercel logs.
