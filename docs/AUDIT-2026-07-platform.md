# Platform Audit — Landing, Portals, API-key System, Merchant API & Windows-Node Integration

_Date: 2026-07-01 · Scope: full-stack audit + E2E verification of the cloud control plane
(Vercel + Supabase) and the local Windows print-server node._

## Method

Three complementary passes:

1. **Static multi-agent audit** — 7 parallel finders (landing/local SPA, admin portal,
   merchant portal + API keys, merchant API v1/v2, Windows-node integration, cross-cutting
   security, consistency/config). Every finding was re-checked by an independent adversarial
   verifier; 31 of 34 survived verification.
2. **Dynamic E2E** — booted the local node in `MOCK_MODE`, exercised the REST API and auth;
   invoked all `api/public/**`, `api/agent/**`, and `api/cloud/**` handlers to confirm auth
   gating; drove the full API-key and setup-token lifecycles through the real handlers.
3. **Browser rendering** — loaded every portal page in Chromium at desktop + mobile widths,
   capturing console/page errors, failed requests, and layout overflow.

## What was verified good

- **Auth primitives are sound.** Merchant keys and node tokens use `sha256(pepper:token)`
  peppered hashing with timing-safe comparison; admin passwords use bcrypt cost 12.
- **API-key revocation works** — `findMerchantApiKeyByHash` filters `revoked_at=is.null`, so a
  revoked key can no longer authenticate (confirmed by live E2E: issue → auth → revoke → 401).
- **No cross-tenant data leakage.** Every merchant-facing by-id path is tenant-scoped, either
  by a self-filtering store helper (`merchant_id=eq.`) or a merchant-scoped ownership fetch
  before any mutation. Service-role access bypasses RLS, but the application-layer filters hold.
- **The entire API surface enforces auth** — all 58 `api/public/**` + 4 agent + 20 admin routes
  reject unauthenticated calls (401/403), reject wrong methods (405), and never leak a 200/500.
- **Merchant onboarding UX is clean** — bootstraps the first key via `X-Merchant-Setup-Token`
  (no chicken-and-egg), shows the secret once, and does not persist it in the browser.
- **Baseline test suite is green** (now 339 tests, up from 329 with the fixes below).

## Fixed in this change

### Frontend / UX (features that were broken)
- **Logout, Connection-Doctor refresh, and accessory door/eject buttons** threw
  `ReferenceError` — their inline `onclick` targets (`confirmLogout`, `refreshDiagnostics`,
  `execAcc`) were never defined on `window` (app.js is an ES module). Now implemented.
- **Print-tuning Speed-Profile / Z-Offset Apply & Reset** referenced module-scoped vars from
  inline handlers → always threw. Promoted `_zOff` / `_pendingSpeedProfile` to `window`.
- **Job history-clear WS event** never fired on other clients — client listened for
  `job.history_cleared` but the server broadcasts `jobs.history_cleared`. Aligned.
- **Admin "Detail" drawer was always visible on load and its Close button did nothing** —
  `.detail-drawer { display: grid }` overrode the `[hidden]` attribute. Added
  `.detail-drawer[hidden] { display: none }`.
- **Admin portal had 37px horizontal overflow at ~1280px** — grid tracks had hard
  `minmax(240–320px, …)` floors and items had default `min-width:auto`. Relaxed to
  `minmax(0, …)` and added `min-width: 0` to the grid containers/items. Verified 0px overflow
  from 1024–1440px.
- **Landing page loaded Google Fonts from a CDN** (failed on an offline print-farm host).
  Removed the runtime `@import` and strengthened the system-font fallback stack.
- **Hardcoded personal email placeholders** (`info@chainhaven.co`, `ianmebert@gmail.com`) in the
  public `/cloud` HTML → replaced with `admin@example.com`.

### Security
- **Webhook SSRF (S-2).** Merchant-controlled webhook URLs were fetched server-side with no
  validation (V1 didn't even require HTTPS; V2 required HTTPS but not host filtering). Added a
  shared `assertSafeWebhookUrl` guard (HTTPS-only; rejects loopback/private/link-local/ULA/
  metadata/`localhost`/`.local`/`.internal`) used by both V1 (`normalizeWebhookConfig`) and V2
  (`normalizeUrl`). _Note: does not defend against DNS-rebinding — see remaining work._
- **Admin webhook-secret disclosure (S-5).** The admin merchants listing returned full
  `metadata`, including the plaintext V1 webhook HMAC secret. Now redacted (`has_secret`).
- **Auth hot-path robustness (GAP-5).** `authenticateMerchantRequest` awaited the last-used
  `touchMerchantApiKey` PATCH unguarded, so a transient failure would 500 a valid request. Now
  best-effort (try/catch).
- **`.env.example` (S-11)** — added the required `MERCHANT_WEBHOOK_SIGNING_SECRET_KEY` (fails
  closed, no fallback) and the two peppers, so a by-the-book deploy doesn't 500 on webhook
  creation.

### Correctness / data integrity
- **Setup-token → live-key minting is now atomic (S-1).** Consumption was non-atomic and ran
  *after* the key was created. Now the token is consumed first via a conditional update
  (`used_at=is.null`); the key is minted only if exactly one row was consumed. Concurrent
  requests can no longer mint multiple keys from one one-time token, and a mid-flow failure
  leaves no dangling key. Covered by a new race test + live E2E.
- **Cloud `cloud.print.ready` no longer reports false success (S-3).** `PrinterWorker._startPrint`
  discarded the boolean from `mqttClient.startPrint()`; a `publish()` that failed because MQTT
  was disconnected still returned `{started:true}`. Now propagates the failure.
- **Terminal node commands can't be resurrected (S-22).** `recordCommandResult` now includes a
  `status=in.(claimed,running)` precondition, so a delayed/duplicate outbox re-delivery cannot
  overwrite an already succeeded/failed command.
- **Unbounded input caps (S-15, S-16).** Order items capped at 200, batch items at 500, and V2
  base64 file uploads capped at 25MB (parity with the V1 path), checked before allocating.

## Remaining findings (documented — larger changes or product decisions)

| ID | Severity | Area | Summary & remediation |
|----|----------|------|-----------------------|
| S-4 | High | node integration | Claimed/running node commands are never reclaimed; a node crash orphans the command forever. Needs a lease-TTL reclaim in `claim_node_commands` (DB migration). |
| S-23 | Low | merchant API | V1 print-job idempotency is best-effort (JSONB, no unique index); concurrent duplicate keys can create two jobs. Needs a unique column + create-then-replay (as V2 does). |
| S-6 | High* | local SPA | Camera stream/snapshot endpoints are not mounted (`CameraProxy.js` is dead code); the live feed degrades to "Camera connection failed". Mount the proxy or hide the widget. |
| S-19 | Medium | security | Admin login / reset have no rate limiting. Add a Supabase-backed per-IP/per-account limiter (serverless has no shared memory). |
| S-20 | Medium | node integration | Node artifact download has no timeout/size cap and runs in the serialized poll loop; a hung URL wedges the loop. Add an AbortController timeout + byte cap. |
| S-21 | Medium | node integration | Result outbox drops the *oldest* undelivered results at capacity (1000). Apply backpressure or log/raise the cap. |
| S-25 | Low | merchant API | Signup commits the org before the merchant insert (dup-email leaves an orphan org) and leaks raw PostgREST error text. Insert merchant-first / transaction + generic error. |
| S-14 | Medium | local SPA | Manual printer entry has no Serial field but the connection-test endpoint requires one, so Test always fails (only "save anyway" works). Add a serial input. |
| S-26 | Low | admin portal | Windows-node ZIP download is disabled after a page reload (in-memory state only). Persist to sessionStorage or add a re-download form. |
| S-10, S-17 | Low | consistency | OpenAPI drift: V1 webhook block documents the retired single-config contract; V2 `File`/`CreateFileRequest` schema omits `base64` and uses wrong field names. Align specs to the deployed routes. |
| S-18, S-27, S-28 | Low | merchant API / security | V1 handlers return 400 for internal errors and echo raw `error.message`; envelopes omit `request_id`. Converge V1 onto the V2 `publicError`/`createHttpError` helpers and `sanitizeOperationalError`. |
| S-30 | Low | consistency | Branding is split three ways: **PrintKinetix** (cloud/webhooks, de-facto canonical), **3DFLOW** (local SPA), **Antigravity** (`package.json`/logs). Pick a canonical name (product decision). |
| GAP-1 | Verify | billing | Confirm no inbound billing/invoice-status callback accepts unauthenticated/​unsigned state changes (`merchantBilling.js`). |
| GAP-3 | Verify | admin | Confirm admin session cookies use HttpOnly/Secure/SameSite and that state-changing admin POSTs are CSRF-safe. |

\* Verifier-corrected severity where applicable.

## Cross-cutting themes

1. **Inline `onclick` + ES-module scope mismatch** was the single largest cause of SPA breakage
   (4 findings) — fixed by attaching handlers/vars to `window`.
2. **Non-atomic multi-write flows** (setup-token, reject+token, signup) — the V2 subsystem
   already models the correct conditional-update / create-then-replay pattern; converge V1 onto it.
3. **V1-vs-V2 divergence** — most remaining medium/low items are "V1 lacks a guard V2 already has."

## Verification

- `npm test` → **339 passed** (48 files), including new tests for the SSRF guard, admin
  webhook-secret redaction, file-size cap, and the setup-token single-use race.
- Live E2E: API-key lifecycle (issue→auth→revoke→401), setup-token single-use, and full
  unauthenticated-rejection sweep of every cloud/agent/public route.
- Browser: all portal pages render with zero page errors; admin overflow eliminated
  (1024–1440px); landing page makes zero failed requests offline.
