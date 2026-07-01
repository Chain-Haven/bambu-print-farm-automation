# Print-Farm Platform — Vision Gap Analysis & Roadmap

_Date: 2026-07-01 · 79 capabilities assessed across 5 vision pillars, 24 adversarially verified._

**The vision:** external storefronts drive everything by API — customers pick color / case
type / design and **upload logos/photos onto cases**; the platform slices, routes, and
produces across a **300+ printer** farm with **camera/telemetry-driven auto-cancel + alerts**
and a usable admin UI on both the Windows node and the cloud.

This doc is the honest map of where the code is vs. that vision, what was shipped toward it,
and the tiered roadmap for the rest.

---

## Hard truths (the biggest gaps)

1. **The signature feature — "upload a logo/photo and place it on the case" — does not exist.**
   No image intake (png/jpg/svg are rejected by `merchantFiles.classifyFileName`), no placement
   compositor, no image→geometry pipeline. "Pick a case type / design" has no product catalog,
   no SKU→model mapping, and no parametric engine. Today the platform can only **route and print
   a file the customer already made**.
2. **Slicing is a rename, not a slicer.** The cloud path is `mockSlicerAdapter` → `completed_mock`
   with zero bytes; the local `SliceService._runCli` is real but gated on a manually-installed
   OrcaSlicer that ships nowhere (`detect()` hardcodes `available:false`). Any STL/OBJ/STEP
   dead-ends. Without real slicing, color/material/customization can't affect a real print.
3. **The hands-off production loop is orphaned.** `JobOrchestrator.onJobCompleted()` (ejection,
   loop-repeat, auto-start-next) is **never called by any producer** — a finished print returns
   to idle with the job stuck "printing." The core "looped print farm" automation doesn't run.
4. **The cloud fulfillment path bypasses the core IP.** `executeCloudPrintReady` does a raw
   one-shot MQTT start — no in-file loops, no cool-release ejection, no ACK-wait — so a
   storefront-driven print gets none of the farm automation.
5. **300+ printers is unproven and architecturally blocked.** One event loop does all MQTT parse
   + synchronous WASM SQLite writes + WS fan-out + HTTP + SSDP + FTPS; a **full-DB `export()`
   rewrite every 10s** blocks everything and grows unbounded; MQTT startup is sequential; and the
   **FTPS `tls.connect` monkey-patch is process-wide and corrupts concurrent uploads**. Realistic
   ceiling today is tens of printers.
6. **Orders don't produce anything.** `POST /orders` writes durable records but `auto_submit`
   only records `intent_recorded`, consumed by nothing; items get `job_id:null`. Only the separate
   `POST /print-jobs` path actually prints.
7. **Three mock adapters** (billing, shipping, realtime) sit behind real interfaces — no Stripe,
   no carrier, no realtime backend.

## What already works (verified good)

- **Color/material selection + capability-aware routing** — `merchantRouting.js` matches
  `requirements.material`/`color` to AMS trays and routes to a printer with that filament.
- **Self-serve API key onboarding**, ready-to-print file intake, order records, quote heuristic,
  status polling, and `farm/capabilities` / `farm/filaments` queries all function.
- **Auth is sound**, revocation works, no cross-tenant leakage (from the prior security audit).

---

## Shipped this session (toward the vision)

Tested, additive changes — 350 tests pass (from 329 at the start of the audit).

**Pillar D — camera + failure automation**
- **Camera feed mounted**: `GET /:id/camera/snapshot` + `/camera/stream` (MJPEG). The
  `CameraProxy` (P1 JPEG :6000 / X1 RTSPS :322) existed but was never exposed; `?token=` auth
  works for `<img>` tags.
- **Auto-cancel + alert on failure**: `PrinterWorker` now reacts to a new blocking `print_error`
  mid-print — critical alert (WS + system event + persisted) and auto-cancel (de-duped, idle-safe,
  `AUTO_CANCEL_ON_FAILURE=false` to opt out). Covered by `tests/runtime/printerWorkerFailure.test.js`.
- **`AlertDispatcher`**: alerts now reach **off-screen** — a configured HTTPS webhook
  (`ALERT_WEBHOOK_URL`, HMAC-signed, SSRF-guarded) plus always-log. The local node also forwards
  alerts to the cloud control plane via the agent events channel. Tests in
  `tests/runtime/alertDispatcher.test.js`.

**Pillar E — printer control / management (were broken)**
- **Fixed the `.isConnected` bug** (3 sites): the property is `.connected`, so every `/control`
  call, the recheck route, and a liveness check treated connected printers as offline. Manual
  printer control was 100% non-functional; now works.
- **Added `pause` / `resume` / `stop`** to `POST /:id/control` (MQTT methods already existed) and
  **Pause/Resume/Stop buttons** to the SPA printer detail — a farm-floor safety stop.
- **Fixed `PrinterRegistry.getAuth()`** — referenced but undefined, so diagnostics/preflight/
  test-connection/camera silently used an empty access code against real printers.
- **MQTT reconnect jitter** — avoids a synchronized reconnect storm across a large fleet.

**Pillar A/B — customization intake (contract, additive)**
- Order items now accept a **`customization`** object (`case_type`, `design_id`, `color`,
  `material`, `finish`, `notes`, and a `placement[]` array for logo/photo positioning). It's
  persisted verbatim in item metadata, and `color`/`material` feed capability-aware routing. This
  unblocks storefront integration and typed clients **before** the compositor/slicer exist — nothing
  downstream is forced to consume the placement geometry yet. Tests in `merchantOrders.test.js`.

---

## Roadmap (remaining)

### T1 — quick wins (< 1 day)
- **Require merchant auth (or an explicit public-read flag) on `farm/capabilities` + `farm/filaments`.**
  They're currently unauthenticated and leak fleet size / online counts / integration posture, while
  the OpenAPI spec claims `MerchantApiKey`. _(Left as a product decision — see below.)_
- **Refine `isBlockingError`** with a severity allow/deny map so unknown/transient codes alert but
  don't auto-cancel (reduce false positives at scale).
- **Cache `collectNetworkInterfaces()`** on an interval instead of per SSDP packet.
- **Scale config knobs**: DB-write throttle, status-write coalescing, WS-broadcast batch interval —
  defaulted to current behavior, inert until tuned.

### T2 — medium builds (days)
- **Revive the production loop**: wire print-completion → `onJobCompleted()` (eject / repeat / next).
- **Route `cloud.print.ready` through `JobOrchestrator`** so cloud/storefront prints get loops +
  cool-release ejection + ACK verification.
- **Order-fulfillment worker** consuming `intent_recorded` → route → create job → back-link `job_id`.
- **Batched WS fan-out** (`printers.batch` every ~1s) + SPA live-status subscription (fixes scale
  fan-out and unfreezes the dashboard).
- **Event-driven / single-batched command dispatch** (kills the 300–600 SELECT/sec floor).
- **Remove the FTPS global `tls.connect` monkey-patch**; per-client TLS + an upload concurrency limiter.
- **Presigned-URL upload flow** (lift the 25 MB base64-in-JSON ceiling for real STL/3MF).
- **Webhook delivery outbox** (retry/backoff/DLQ) + emit lifecycle events (completed/failed/shipped/order.*).
- **HMS mid-print evaluation** + thermal-deviation / filament-runout checks in `_checkForFailures`.
- **Admin UIs**: printer Edit modal + Pause/Resume/Stop on the cloud console; periodic polling.
- **AMS→cloud inventory push** (heartbeat carries trays/grams) so "real-time colors" is actually real.

### T3 — large builds (weeks)
- **Real slicer engine** — pinned OrcaSlicer/Bambu CLI on the host + a Linux slice-worker for the
  cloud, behind the existing adapter interface. _Unblocks everything customization/STL-driven._
- **Image intake + logo/photo compositor** — accept png/jpg/svg → heightmap/vectorize → mesh
  boolean/decal → AMS color regions. _The single most concrete vision feature; net-new subsystem._
- **Product/case catalog + parametric design engine** — SKU→base model, design template→geometry
  (OpenSCAD/CadQuery/Manifold).
- **Fleet sharding** across `worker_threads` + `better-sqlite3` (real WAL) + event retention — the
  architecture change required to credibly reach 300 printers. Add a load test.
- **Vision failure detector** — frame ring → spaghetti/first-layer inference → the existing cancel path.
- **Real billing (Stripe) / shipping (EasyPost/ShipStation) / realtime (Pusher/Ably)** adapters.
- **Color-aware AMS mapping + unified, atomic reservation** with an expiry sweeper; thread the
  reserved tray to the node.
- **UI scale**: server-side pagination + search/filter/virtualization on both dashboards.

---

## Decisions for the owner

- **Branding**: still split three ways (PrintKinetix / 3DFLOW / Antigravity) — pick a canonical name.
- **`farm/capabilities` auth**: keep it public (easy storefront integration, leaks fleet stats) or
  require the merchant key (more secure, tiny storefront change)? Recommend requiring the key.
- **Sequencing**: the vision's headline (logo-on-case customization) is blocked on **real slicing**
  first, then the **compositor**. Those two T3 builds are the critical path; most other items make
  the farm robust/scalable around them.
