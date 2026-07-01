# Merchant API v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a merchant-facing live API, approval workflow, file ingestion, routing, usage tracking, admin controls, and public docs on top of the existing Vercel/Supabase PrintKinetix cloud control plane.

**Architecture:** Keep merchant/public API code in focused `src/cloud/merchant*` modules and thin Vercel routes under `api/public`. Reuse the existing Supabase REST client, `print-artifacts` storage bucket, `print_jobs`, `job_files`, `node_commands`, and Windows node command loop. Add migration-backed tables for merchants, merchant API keys, platform settings, routing decisions, usage events, and job status history.

**Tech Stack:** Node ESM on Vercel serverless routes, Supabase REST/Storage via service key, Vitest, existing local Windows node runtime.

---

### Task 1: Merchant Schema and Store Surface

**Files:**
- Create: `supabase/migrations/20260701000100_merchant_api_v1.sql`
- Modify: `src/cloud/supabaseRest.js`
- Test: `tests/cloud/merchantStore.test.js`

- [ ] Write failing store tests for platform settings, merchant signup, API key storage, usage events, routing decisions, job files, print jobs, and command creation.
- [ ] Run `npm test -- tests/cloud/merchantStore.test.js` and verify missing methods fail.
- [ ] Add migration tables and indexes:
  - `public.platform_settings`
  - `public.merchants`
  - `public.merchant_api_keys`
  - `public.routing_decisions`
  - `public.merchant_usage_events`
  - `public.print_job_status_history`
  - `merchant_id` columns on `job_files` and `print_jobs`
- [ ] Extend `createSupabaseRestClient()` with focused merchant store methods.
- [ ] Re-run `npm test -- tests/cloud/merchantStore.test.js` until green.
- [ ] Commit `feat: add merchant schema store surface`.

### Task 2: Merchant API Keys and Authentication

**Files:**
- Create: `src/cloud/merchantAuth.js`
- Test: `tests/cloud/merchantAuth.test.js`

- [ ] Write failing tests for `pkx_live_` generation, SHA-256 hashing with pepper, timing-safe key match, one-time reveal payloads, revoked key rejection, inactive merchant rejection, and scoped merchant identity.
- [ ] Run `npm test -- tests/cloud/merchantAuth.test.js` and verify failures are expected.
- [ ] Implement merchant token helpers, request authenticator, and normalized public error responses.
- [ ] Re-run focused tests until green.
- [ ] Commit `feat: add merchant api key auth`.

### Task 3: Public Merchant Signup and Key Management API

**Files:**
- Create: `src/cloud/merchantHandlers.js`
- Create: `api/public/merchants/signup.js`
- Create: `api/public/merchant/me.js`
- Create: `api/public/api-keys/index.js`
- Create: `api/public/api-keys/revoke.js`
- Test: `tests/cloud/merchantHandlers.test.js`

- [ ] Write failing tests for pending-by-default signup, full-auto active signup, approved merchant key creation, one-time secret return, key list redaction, key revoke, and cross-merchant spoofing rejection.
- [ ] Run `npm test -- tests/cloud/merchantHandlers.test.js` and verify failures.
- [ ] Implement thin handlers that never trust client-supplied `merchant_id`, `org_id`, key status, or approval state.
- [ ] Add Vercel route files that inject `createSupabaseRestClient()` and `MERCHANT_API_KEY_PEPPER || NODE_TOKEN_PEPPER`.
- [ ] Re-run focused tests until green.
- [ ] Commit `feat: add merchant signup and key api`.

### Task 4: Routing Engine

**Files:**
- Create: `src/cloud/merchantRouting.js`
- Test: `tests/cloud/merchantRouting.test.js`

- [ ] Write failing tests for fastest compatible printer selection, queue-depth sorting, online/idle filtering, material/color requirements, build-volume requirements, rejected candidate reasons, and no-compatible-printer status.
- [ ] Run `npm test -- tests/cloud/merchantRouting.test.js` and verify failures.
- [ ] Implement deterministic routing from cloud printer rows, node rows, active job counts, and job requirements.
- [ ] Re-run focused tests until green.
- [ ] Commit `feat: add merchant print routing`.

### Task 5: Print Job Ingestion API

**Files:**
- Create: `src/cloud/merchantFiles.js`
- Modify: `src/cloud/merchantHandlers.js`
- Create: `api/public/print-jobs/index.js`
- Create: `api/public/print-jobs/[id].js`
- Create: `api/public/usage.js`
- Test: `tests/cloud/merchantPrintJobs.test.js`

- [ ] Write failing tests for ready-to-print upload validation, source-model upload validation, unsupported file rejection, file metadata creation, checksum capture, storage path scoping, routable command creation, source-model `needs_slicing` state, no-compatible-printer `waiting_for_capacity` state, usage event creation, and merchant-isolated listing.
- [ ] Run `npm test -- tests/cloud/merchantPrintJobs.test.js` and verify failures.
- [ ] Implement JSON-first ingestion using base64 file payloads for v1 (`file.name`, `file.content_type`, `file.base64`) to avoid multipart complexity in the first public API.
- [ ] Store artifacts under `org_id/merchant_id/job_id/original_name` in the private `print-artifacts` bucket.
- [ ] Create job rows and commands only from server-side routing output.
- [ ] Re-run focused tests until green.
- [ ] Commit `feat: add merchant print job ingestion`.

### Task 6: Local Node Cloud Print Commands

**Files:**
- Modify: `src/cloud/localCommandExecutor.js`
- Modify: `src/cloud/localNodeClient.js`
- Test: `tests/cloud/agentProtocol.test.js`

- [ ] Write failing tests for `cloud.print.ready` command execution and explicit `cloud.print.prepare` source-model response.
- [ ] Run `npm test -- tests/cloud/agentProtocol.test.js` and verify failures.
- [ ] Implement a command path that can download a cloud file through a signed/proxied URL or return `needs_slicing` when source slicing is not ready.
- [ ] Re-run focused tests until green.
- [ ] Commit `feat: support merchant cloud print commands`.

### Task 7: Admin Management Surface

**Files:**
- Modify: `src/cloud/adminHandlers.js`
- Create: `api/cloud/merchants.js`
- Create: `api/cloud/merchant-approval.js`
- Modify: `public/cloud.html`
- Modify: `public/js/cloud-dashboard.js`
- Modify: `public/css/cloud.css`
- Test: `tests/cloud/adminHandlers.test.js`

- [ ] Write failing tests for pending merchant list, approve/reject, full-auto setting toggle, key revoke, routing decision visibility, and usage visibility.
- [ ] Run `npm test -- tests/cloud/adminHandlers.test.js` and verify failures.
- [ ] Implement server-side admin handlers behind `CLOUD_ADMIN_TOKEN`.
- [ ] Add compact dashboard panels for merchants, platform settings, jobs, routing decisions, and usage.
- [ ] Re-run tests until green.
- [ ] Commit `feat: add merchant admin controls`.

### Task 8: Public Docs and OpenAPI

**Files:**
- Create: `docs/merchant-api.md`
- Modify: `docs/cloud-control-plane.md`
- Create: `public/api-docs.html`
- Create: `src/cloud/openapi.js`
- Create: `api/public/openapi.json.js`
- Test: `tests/cloud/dashboardAssets.test.js`

- [ ] Write failing tests that `/api/public/openapi.json` imports and docs assets exist.
- [ ] Run focused tests and verify failures.
- [ ] Add docs with auth, signup, key management, job submission, source-model behavior, status, usage, errors, limits, routing, and curl examples.
- [ ] Add OpenAPI JSON generator and route.
- [ ] Re-run focused tests until green.
- [ ] Commit `docs: add merchant api docs`.

### Task 9: Verification, Migration, Deployment

**Files:**
- No new files expected.

- [ ] Run `npm test`.
- [ ] Run route import/smoke checks for `api/public` and `api/cloud` route files.
- [ ] Apply Supabase migrations to project `qnegcrjdriyuyzyoizzb`.
- [ ] Set `MERCHANT_API_KEY_PEPPER` in Vercel if not already present, or deliberately use `NODE_TOKEN_PEPPER` fallback.
- [ ] Deploy production with `vercel deploy --prod --yes --archive=tgz`.
- [ ] Verify `/api/cloud/setup`, `/api/public/openapi.json`, `/api-docs`, merchant signup, admin approval, API key creation, and a live ready-to-print test job without printing secrets.
- [ ] Run production logs check for real failures.
- [ ] Commit/push/deployment directives in final response.

### Self-Review

- Requirements covered: merchant signup, approval/full-auto, live keys only, public docs/OpenAPI, public API endpoints, ready/source file ingestion, fastest-compatible routing, local node support, admin management, usage tracking, Supabase/RLS/security, tests, docs, deployment.
- Known implementation constraint: v1 public upload format is JSON with base64 file content, documented clearly, because this repo's current Vercel routes and tests use JSON helpers rather than multipart parsing.
- Source-model slicing is represented honestly as `needs_slicing` unless a local slicer path is implemented during Task 6.
