# CLAUDE.md — Project context for Antigravity / 3DFLOW

This file is read automatically by Claude Code at the start of every session. It captures
what this project is, how to run it, the real state of the open problem, and the changes
already made, so you don't have to rediscover them.

## What this is

A multi-printer orchestrator for **Bambu Lab** 3D printers (A1 / A1 Mini / P1S / X1C),
branded "Antigravity" in the code and "3DFLOW" in the UI. It automates looped print farms:
transform a sliced file to add cool-release ejection + N loops, upload it to the printer,
start it, and auto-eject between runs.

- **Stack:** Node.js (ESM) + Express + WebSocket, SQLite via `sql.js` (WASM), vanilla-JS SPA in `public/`.
- **Entry point:** `server.js` → http://localhost:3000 (login `admin` / `antigravity`).
- **Config:** `.env` (PORT, MOCK_MODE, LOG_LEVEL, ENCRYPTION_KEY, JWT_SECRET, etc.). `MOCK_MODE=true` uses simulators; `false` talks to real printers.

## How to run

```bash
npm install           # first time (installs deps for THIS machine)
npm run dev           # auto-reloads on file changes (best for development)
# or: node server.js  # no auto-reload
```

Or double-click **`Start Antigravity.bat`** (Windows) — it stops any server already on
port 3000, starts a fresh one, and opens the dashboard. Keep its console window open.

## THE core problem (read this first)

The long-standing blocker was described as "can't send large looped files to the printer."
Investigation of the evidence logs (`evidence_output*.log`, `experiments_output.log`,
`final_evidence_output.log`) shows that is a **misdiagnosis**:

- FTPS upload **works** — remote `SIZE` matches local bytes every time.
- The MQTT `project_file` start command is **accepted** (`result: success`)…
- …but the printer **never leaves IDLE**, even for a **known-good Bambu Studio file already on the SD card** (Experiment 1). If even Bambu's own file won't start, the cause is not this code.
- The status stream carries a persistent **`print_error: 83935248` = `0x0500C010`**, which `src/utils/PrinterErrors.js` maps to **"MicroSD card read/write exception" (blocking)** — present even at idle.

**Conclusion: the blocker is a failing/!faulty printer MicroSD card, not the software.**
Fix is hardware: reseat → format in the printer → replace with a high-endurance card.
**To confirm current state, run `node proof_test.js`** (known-good control vs. generated
artifact, direct FTPS+MQTT). NOTE: evidence logs are from Feb–Mar 2026; if the card was
swapped since, re-run `proof_test.js` before concluding anything.

Full write-up is in `DIAGNOSIS.md`.

## Changes already made (July 2026 session — public storefront: quote → pay → ship)

1. **Anyone can order a print at `/order`** (no account): upload STL/3MF/STEP/
 OBJ/gcode(.3mf) → instant server-side price → shipping address → Stripe
 hosted checkout → paid order dispatches through the REAL merchant pipeline
 (`routeAndDispatchJobFile`, exported split of `merchantPrintHandlers`'
 `createPrintJob`) under a platform-owned **"Walk-in Storefront" merchant**
 (auto-provisioned once, `ensureStorefrontIdentity`, `storefront_state`).
 One print job per ordered piece; capacity parking + heartbeat redispatch
 apply as usual. Tokenized public status page (`/order?order_id&token`).
2. **Honest pricing from the file itself** — `src/cloud/modelAnalysis.js`:
 sliced files parse the slicer's "filament used [g]" (gcode header or
 slice_info `used_g`); STL gets exact signed-tetrahedron mesh volume
 (binary + ASCII) × density × 0.35 solidity; OBJ/STEP fall back to a
 size heuristic labeled `file_size_heuristic`. Quote = per-piece estimator
 (`quoteEstimator`) × qty + setup + markup% + flat shipping (all in
 `storefront_settings`). **Quotes are HMAC-tokenized** (checksum+material+
 qty+total+expiry, `storefront_state.quote_secret`) and recomputed at
 checkout — clients cannot name their own price.
3. **Stripe without the SDK** — `src/cloud/stripePayments.js`: hosted
 Checkout Sessions via form-encoded REST; keys from settings (write-only)
 or `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`; `mock` mode for offline.
 **Webhook trust**: Vercel functions lack the raw body, so the delivered
 event is only a hint — the handler re-fetches the event by id from Stripe
 with our key before mutating anything (forgery-proof, replay-idempotent);
 raw-body HMAC verify (`verifyStripeSignature`) also available self-hosted.
 No Stripe → orders park unless `allow_unpaid_orders` (or MOCK_MODE demo).
4. **Surfaces**: public `/api/public/storefront/{quote,checkout,orders,
 stripe-webhook}`; admin `/api/cloud/storefront` (GET settings+orders /
 PATCH settings); wired on Vercel + `localCloudServer` (+ `/order` page
 route + vercel.json rewrite). Landing page: hero CTA + nav "Instant Print
 Quote" + no-account card. Storefront page excluded from the farm-node
 bundle (all three exclusion lists). Orders log: `storefront_orders`
 platform setting (capped 500). Tests: `tests/cloud/storefront.test.js`
 (17) — mesh math, token tamper, offline + Stripe funnels, webhook
 idempotency, secret redaction.

## Changes already made (July 2026 session — filament auto-ordering via Amazon Business)

1. **Auto-restocking closes the supply loop** — `src/cloud/filamentReorder.js`
 watches the spool inventory (`farm_filament_inventory`, AMS-synced) against
 per-material/color rules (`min_spools`, `order_quantity`, `asin`,
 `max_unit_price_usd`) and creates reorders when usable spools (≥
 `min_usable_grams`) drop below threshold. Config in platform setting
 `farm_filament_reorder`, order log in `farm_filament_reorder_state` (capped
 200). Evaluation runs from the **heartbeat path** (same pattern as
 auto-eject; throttled to 1/5min, never fails a heartbeat) and manually via
 "Check Stock Now".
2. **Amazon Business Ordering API client** — `src/cloud/amazonBusiness.js`:
 LWA refresh-token exchange (`api.amazon.com/auth/o2/token`), regional hosts
 (na/eu/jp.business-api.amazon.com), `POST /ordering/2022-10-30/orders` +
 `GET …/orders/{externalId}`, headers `x-amz-access-token` +
 `x-amz-user-email`. Requires an Amazon Business account approved for the
 Ordering API (partner onboarding) — credentials via console or `AB_LWA_*`
 env vars. MOCK_MODE simulates acceptance.
3. **Safety rails**: `trial_mode` default ON (Amazon test orders — flip off
 after a trial round-trips), approval mode default (one-click Approve/Deny in
 the console), monthly budget + per-order caps (over-cap parks for approval),
 per-rule cooldown + open-order dedupe, and Amazon-side idempotency via
 deterministic `externalId` (`pkx-{rule}-{month}-{seq}`) so racing heartbeats
 can't double-order.
4. **Surface**: `/api/cloud/filament-orders` (GET overview / PATCH config with
 write-only secrets / POST evaluate|approve|deny|test_connection), wired in
 Vercel (`api/cloud/filament-orders.js`) + `localCloudServer`. Console:
 "Filament Auto-Ordering" panel + "Filament Orders" table on the Automation
 tab. Tests: `tests/cloud/filamentReorder.test.js` (28) incl. heartbeat
 integration; LWA secrets never echo in responses.
5. **Fully hands-off variant (AMS-level tracking + tagging)** — stock now
 includes **live AMS tray levels** (`count_ams_trays`, default ON): trays from
 heartbeat-mirrored printers (`capabilities.ams_trays[].live_remaining`,
 Bambu `remain` %; null/-1 = no RFID → counts as full; RGBA colors normalized
 to #RRGGBB; printers silent >24h ignored; inventory spools assigned to a
 printer skipped to avoid double-count with their live tray). Zero manual
 inventory needed. `buildFilamentStockView` powers the **"Filament Catalog —
 tag to Amazon"** table: every detected filament (AMS + shelf) with live
 stock and per-row ASIN/threshold inputs — Tag/Untag upserts rules
 (`rule_defaults` config prefills). Loop closes physically: order arrives →
 spools loaded → tray levels rise → no re-order (plus cooldown while
 shipping).

## Changes already made (July 2026 session — macOS farm node + out-of-the-box download)

1. **The portable node app now runs on macOS** — the same downloaded ZIP works on
 Windows, macOS (Apple Silicon + Intel), and Pi/Linux. New `Start Farm Node.command`
 double-click launcher (`createStartFarmNodeCommand` in `nodePackage.js`):
 clears the `com.apple.quarantine` flag + restores exec bits on first run,
 prepends Homebrew paths (`/opt/homebrew/bin:/usr/local/bin`) because Finder
 launches with a bare PATH, resolves Node three ways (bundled `./node` →
 system/Homebrew → auto-downloads `darwin-arm64`/`darwin-x64` tarball via the
 now OS-aware `get-node.sh`), and holds the Terminal window open on errors.
 First launch needs right-click → Open (Gatekeeper; documented in
 README-FIRST + guide + toast).
2. **Unix launchers ship 0755 in the ZIP** — `zip.addFile(..., 0o755)` for
 `.command`/`.sh` so Archive Utility/unzip extract them executable (verified by
 a real unzip round-trip test). Without it, double-click dies with
 "permission denied".
3. **Auto-config stays baked in** (`.env` with CLOUD_API_URL + LOCAL_NODE_TOKEN
 generated per download) and the node now **auto-opens the local dashboard**:
 `farmNodeEntry.js` polls `127.0.0.1:PORT` until the server answers, then opens
 the browser (`open`/`start`/`xdg-open`) — TTY-only (never CI/services),
 `PKX_OPEN_DASHBOARD=false` in `.env` to disable. `dist/windows-node/farm-node.cjs`
 rebuilt (committed artifact).
4. **SEA build on macOS fixed** — `build-windows-node.mjs --exe` on darwin now
 strips the runtime signature before postject injection and ad-hoc re-signs
 after (`codesign --sign -`), otherwise Gatekeeper kills the binary.
5. **Copy de-Windows-ed** — console quickstart ("Windows · macOS · Pi 5 · Linux"),
 platform-aware download toast, `windows-node-guide.html` (filename kept, now
 "Local Farm Node" with a macOS/Gatekeeper section), index/merchant pages,
 platformStrategy gate texts.

## Changes already made (July 2026 session — console overhaul + models + drop-in printing)

1. **Unified API key management** — `/api/public/api-keys` is the canonical
 surface (GET list / POST create / **DELETE revoke**; POST `/revoke` kept as a
 back-compat alias). The admin route (`/api/cloud/merchant-api-keys`) now
 delegates to the same shared implementations (`createLiveKeyForMerchant`,
 `createSetupTokenForMerchant` in `merchantHandlers.js`) and supports scopes.
 One merchant auth resolver: `resolveMerchantAuth` (live key | portal session).
 Dead v1 webhook *config* handler retired (v2 `/api/public/webhooks/*` is the
 real one; outbound v1 deliveries still honor stored `metadata.webhook`).
 Pepper story documented in `.env.example`; cross-pepper isolation tested
 (`tests/cloud/pepperIsolation.test.js`).
2. **Node deletion** — `DELETE /api/cloud/nodes?node_id=` (admin): refuses when
 the node has active jobs/pending commands unless `force=true`; FK cascades
 remove mirrored printers + commands; the node token dies immediately. Store
 methods `getNodeWorkSummary`/`deleteFarmNode` in both stores. Delete button
 in the console's Nodes table.
3. **Canonical printer model registry** — `src/models/PrinterModels.js`: one
 record per model (aliases, chassis family, camera transport, bed size,
 Automator geometry key). Added the 2026 lineup: **X2D, P2S, H2S, H2D, H2C,
 A2L** ("X2C" doesn't exist — it aliases to X2D). Every model list now
 resolves through the registry (CameraProxy, PrinterRegistry capabilities,
 adopt normalization, platformStrategy families, fleet chassis art, SPA
 dropdowns, seeds, Orca presets). **Fixed the silent-P1S bug**:
 `JobOrchestrator` maps `profile.printer_model` ("Bambu X1C") through
 `automatorModelKey()` so real geometry applies; wildcard profiles defer to
 the assigned printer's model.
4. **Camera fixed** — `GET /api/cloud/commands?command_id=` direct lookup
 (`getNodeCommandById`) replaces the lossy overview scan in the fleet board's
 poll; camera family from the registry; longer poll window; actionable error
 messages (missing access code, LAN/dev mode, ffmpeg); CameraProxy falls back
 to system ffmpeg/`FFMPEG_PATH` for RTSPS models on portable nodes.
5. **Auto-eject wired end-to-end** — heartbeats now turn the farm-automation
 `auto_eject` policy into durable `printer.eject` node commands
 (`maybeQueueAutoEjectCommands` in `agentHandlers.js`; deduped against
 pending/recent ejects, 30-min cooldown). New node command `printer.eject`
 runs `EjectionService` (skips instantly without an ejector accessory, so it
 never double-ejects in-gcode sweeps). Per-model sweep geometry for all new
 models in `Automator.MODEL_DEFAULTS` (validate on hardware before unattended
 loops). Transform round-trip tests per model.
5b. **Merchant API prints any format fully automatically** — `POST
 /api/public/print-jobs` now routes source models (STL/OBJ/STEP, unsliced
 3MF) exactly like ready files: they dispatch **`cloud.print.source`** to a
 slicer-capable node (nodes advertise `can_slice`; `preferSlicerNodes`),
 which slices with OrcaSlicer and submits through `JobOrchestrator`. The old
 `needs_slicing` dead end is gone from the print-jobs path. Shared dispatch
 plumbing lives in `src/cloud/printDispatch.js` (used by merchant + admin
 endpoints). Jobs that can't place park as `waiting_for_capacity` and are
 **re-dispatched automatically from the heartbeat path**
 (`redispatchWaitingJobs`, claim-guarded via `claimWaitingPrintJob` so
 concurrent heartbeats can't double-dispatch; oldest job first; one job per
 freed printer per pass). `/api/public/farm/capabilities` advertises
 `file_types.auto_slice`.
6. **Drop-in printing** — `POST /api/cloud/print-files` (admin): drop a
 `.gcode.3mf`/`.3mf`/`.gcode`/`.stl` → uploads to storage → routes via
 `routeMerchantPrintJob` → ready files ride `cloud.print.ready`; source models
 ride new **`cloud.print.source`** (the TARGET node downloads, slices via
 `SliceService`/OrcaSlicer CLI — mock gcode in MOCK_MODE — then submits
 through `JobOrchestrator`). Unsliced project `.3mf` is now detected by ZIP
 inspection (`classifyPrintFile` in `printIntake.js`) instead of being
 misclassified as ready. Nodes advertise `can_slice` in heartbeats; source
 models prefer slicer-capable nodes. Drag-drop UI on the Fleet tab.
7. **Console rebuilt as tabs** — `/cloud` is now Fleet / Merchants / Nodes &
 Setup / Automation (hash-routed, `showTab` in `cloud-dashboard.js`).
 **Backend Setup moved to the bottom of Nodes & Setup** with a warning banner
 up top when not ready. Merchant workspace merged to ONE visible merchant-ID
 field (the other three are hidden, synced inputs); v2 commerce tables live
 in a collapsed `<details>`; command console collapsed on Automation.
 Browser-verified via Playwright (screenshots in `output/playwright/`).
 NOTE: `.tab-panel`/`.setup-banner` needed explicit `[hidden]{display:none}`
 (same UA-stylesheet footgun as `.login-view`).
8. **Branding** — user-facing name unified on **PrintKinetix**
 (`src/config/branding.js`); "3DFLOW" removed from the SPA, server log line
 updated. Internal identifiers (package name, DB paths, `AG_` gcode markers)
 intentionally unchanged.

## Changes already made (July 2026 session — admin + merchant sign-in overhaul)

1. **Admin sign-in is a normal email/password flow** (`src/cloud/adminAuthHandlers.js`):
   one-shot first-time setup (`POST /api/cloud/admin/bootstrap` with the
   `CLOUD_ADMIN_TOKEN` + `{email, password}` sets the password AND returns a live
   session), login with per-email rate limiting, server-side logout
   (`/api/cloud/admin/logout`), and **public self-service forgot-password**
   (`POST /api/cloud/admin/password-reset` — generic response, link delivered by
   email; authenticated super admins get the link back as a support tool).
   Super admins: `info@chainhaven.co` + `ianmebert@gmail.com` (seeded in the
   `platform_admin_auth` migration, hardcoded in `DEFAULT_SUPER_ADMIN_EMAILS`,
   protected from disable).
2. **Admin account management** — `GET/POST /api/cloud/admin/users`
   (super_admin only): list, create-with-invite-link, disable/enable, issue
   reset links. Surfaced as the "Admin Accounts" panel on `/cloud`.
3. **Merchants got real sign-in** — new `merchant_users` /
   `merchant_user_sessions` / `merchant_user_password_resets` tables
   (`supabase/migrations/20260702080000_merchant_user_auth.sql`, allowlisted in
   the admin migration runner). Signup (`/api/public/merchants/signup`) accepts
   a `password` and creates the portal owner. Endpoints:
   `/api/public/merchant/login|logout|session|password|password-reset`.
   Portal sessions (`pkx_muser_session_*`) can also manage API keys on
   `/api/public/api-keys(+/revoke)` and hit `/api/public/merchant/me`.
4. **Merchant portal UI** — `public/merchant.html` + `public/js/merchant-portal.js`
   at `/merchant`: sign in, forgot/reset password (`/merchant?reset_token=…`),
   account status (incl. pending-approval notice), API key create/revoke.
   Onboarding page now collects a password and links to the portal.
5. **Email** — `src/cloud/mailer.js`: Resend HTTP API when `RESEND_API_KEY` +
   `EMAIL_FROM` are set; otherwise disabled and reset links go to the server log.
   Auth responses never reveal whether an email was sent (no account enumeration).
6. **Local/self-hosted parity** — `memoryCloudStore` implements all admin +
   merchant-user methods; `localCloudServer` wires every auth route, serves
   `/merchant`, and takes an injectable `mailer`. The whole sign-in story runs
   offline; `tests/cloud/e2eFullLoop.test.js` proves both loops over real HTTP
   (setup → login → reset-by-email → logout).

## Changes already made (July 2026 session — Print Fleet cloud UI)

1. **Print Fleet board** on `/cloud` (`public/js/fleet-view.js` + fleet section in
 `cloud.html`/`cloud.css`): one card per mirrored printer with model-accurate
 chassis art (A1 / A1 Mini bedslinger; P1 / P2 / X1 / H2 CoreXY), four AMS spool
 icons above each printer (color, material, % remaining from `ams_trays[].live_remaining`),
 the in-progress model rendered inside the printer window, progress bar +
 time remaining, and camera / pause / resume / stop buttons. Auto-refreshes
 every 8s ("Live updates" toggle).
2. **Live job telemetry in heartbeats** — `localPrinterSnapshot.buildCurrentJobView`
 attaches `current_job` (name, progress %, remaining minutes, layers, preview)
 per printer; `agentProtocol.normalizeCurrentJob` sanitizes it into
 `status_snapshot.current_job` (no new DB column needed).
3. **Model previews** — `src/services/JobPreview.js`: extracts the slicer's
 plate render PNG from `.gcode.3mf`, else parses gcode extrusion moves into an
 isometric SVG wireframe. Cached per job; capped at 350KB.
4. **Remote camera over the command channel** — new `printer.camera.snapshot`
 command: node grabs a JPEG via CameraProxy (P1 port 6000 / X1 RTSPS) and
 returns it base64 in the command result; the console modal re-queues every
 ~3.5s for a live-ish feed. MOCK_MODE returns a placeholder frame.
5. **Printer adoption** — new `cloud.printers.adopt` command: the fleet board
 shows LAN-discovered printers ("Found on the network"); clicking one opens a
 modal (name + access code), the node registers it via PrinterRegistry (worker
 spawns immediately), and it joins the fleet on the next heartbeat.
6. **Self-hosted console** — `localCloudServer.js` now serves `public/` +
 `/cloud`, `/api/cloud/setup`, and `/api/cloud/admin/me` (bootstrap token works
 as the stored login). `scripts/fleet-demo.mjs` seeds a demo fleet for UI work.
7. **CSS fixes** — `[hidden]` was being overridden by `display:grid/flex` on
 `.login-view` and the new `.modal-backdrop` (login card stayed visible after
 sign-in); both now have explicit `[hidden]{display:none}` rules.

## Changes already made (July 2026 session — download funnel + readiness gates + offline e2e)

1. **Vercel now ships the portable Windows bundle** — `vercel.json` was missing
 `dist/windows-node/**` in the `node-package` function's `includeFiles`, so the
 deployed "Download Windows App" silently fell back to the npm-install source ZIP.
 Fixed + regression test. The portable bundle (`farm-node.cjs` + `Start Farm
 Node.bat`, auto-downloads a portable Node runtime) needs no install. Rebuild with
 `npm run build:node` (commit the two tracked artifacts); `--exe` builds a native
 SEA executable when run on Windows.
2. **Readiness gates fixed** (`src/cloud/platformStrategy.js`): a stale "online"
 node (no heartbeat in 10 min) no longer counts; AMS filament synced from printer
 heartbeats now satisfies "Spool and AMS inventory" (no manual spool entry
 required); next-action texts point at the real flow. Roadmap phases unblock as
 gates flip.
3. **Local cloud control plane** — `src/cloud/memoryCloudStore.js` (in-memory
 store contract) + `src/cloud/localCloudServer.js` (Express app wiring the REAL
 Vercel handlers). Runs the whole cloud without Vercel/Supabase.
4. **Offline end-to-end proof** — `tests/cloud/e2eFullLoop.test.js` (in
 `npm test`) and `npm run e2e:local` (`scripts/local-e2e-test.mjs`), which
 downloads the ZIP over HTTP, extracts it, **boots the actual shipped
 `farm-node.cjs` in MOCK_MODE**, registers a printer, waits for the heartbeat
 mirror, asserts every gate ready / no phase blocked, onboards a merchant, and
 watches a print job route and start. Nodes/printers must live in the merchant's
 org for routing (org-scoped overview).

## Changes already made (July 2026 session — farm loop audit)

Full write-up: `docs/AUDIT-2026-07-farm-loop.md`. Headlines:

1. **The production loop is closed** — `PrinterWorker` now detects print end and
   drives `JobOrchestrator.onJobCompleted` (eject → repeat → auto-start-next) /
   `onJobAborted`. Previously orphaned; finished prints stayed "printing".
2. **Cloud merchant prints run the real pipeline** — `cloud.print.ready` goes
   through `JobOrchestrator.submit` (transform w/ auto-eject, ACK wait, job
   tracking; queues when the printer is busy). `pipeline:'raw'` = legacy path.
3. **`cloud_printers` finally has a writer** — node heartbeats mirror every
   printer (state + merged AMS trays) into the cloud; job lifecycle events flow
   back (`print_job.*`), updating merchant jobs, releasing filament
   reservations, and firing webhooks.
4. **AMS everywhere** — cloud console "AMS Filament Mapping" panel →
   `printer.ams.set/get/clear` node commands → SQLite persistence + MQTT push;
   merchant `farm/filaments` overlays loaded trays (`loaded_slot_count`).
5. **Router fixes** — inventory-augmented submit routing, unified strategies,
   `ams_mapping` in dispatch payloads, `selected_local_printer_id` for cancel.
6. **Fresh-install seeding bug fixed** — migration 005 + count-guarded seeder
   left new DBs without the Universal profile (every profile-less submit
   failed). Seeder is per-profile idempotent now; profile lookup NOCASE.
7. **MOCK_MODE runs the full loop** (simulated upload/start), verified e2e.

## Changes already made (June 2026 session)

In `src/services/JobOrchestrator.js`:
1. **Decoupled looping** — `loopsN` (in-file loops) no longer falls back to `repeat_total`
   (job restarts); added a guard that warns when both > 1 (would multiply to N×M prints).
2. **No false "printing"** — `startJob` no longer marks a job `printing` when the printer
   never leaves IDLE; it fails with a clear message and surfaces any standing `print_error`.
   ACK window raised 30s → 60s for large files.

In `src/api/routes/printers.js`, `src/runtime/PrinterWorker.js`, `src/mqtt/BambuMqttClient.js`:
3. **Real Test Connection** — `POST /:id/test-connection` now probes live MQTT + FTPS instead
   of always returning success; frontend shows the real verdict.
4. **Auto offline detection** — printer list/detail endpoints overlay live worker state, so a
   disconnected printer shows "offline" automatically; health check broadcasts the change.
5. **Quieter logs** — MQTT "disconnected" is logged once per drop instead of every 5s retry.

## Architecture map (where things live)

- `src/gcode/` — the transform pipeline (the core IP). `Automator.js` (loops + cool-release +
  ejection), `AutomatorZip.js` (extract/repack `.gcode.3mf`), `transforms/`.
- `src/services/` — `JobOrchestrator.js` (submit→transform→upload→start), `BambuFtpsClient.js`
  (FTPS upload, port 990), `PrinterRegistry.js`, `EjectionService.js`, `AmsService.js`.
- `src/mqtt/` — `BambuMqttClient.js` (control channel, port 8883), `BambuClient.js`.
- `src/runtime/` — `RuntimeSupervisor.js` (spawns workers), `PrinterWorker.js` (per-printer state).
- `src/api/routes/` — REST endpoints. `src/db/migrations/` — schema.
- `public/` — SPA (`js/app.js` is the whole frontend).
- Root `*_test.js`, `proof_test.js`, `experiments.js`, `evidence_*` — ad-hoc diagnostic scripts (not a real test suite).

## Known issues / good next steps

- **Run `proof_test.js` against the real printer** to confirm whether the SD card is still the blocker. (Requires being on the same network as the printer — Claude Code can do this; the Cowork sandbox could not.)
- ~~No automated tests~~ — stale: `npm test` now runs 560+ vitest tests (auth, stores, routing, transform round-trips per model, offline e2e full loop). On a loaded machine cap concurrency: `npx vitest run --maxWorkers=2`.
- **Start-print URL is inconsistent** across code/scripts (`ftp://`, `ftp:///cache/`, `ftp:///sdcard/cache/`). Pin down the correct form once the printer can start prints.
- **Repo is heavy** — `uploads/` holds ~1.2 GB of artifacts (incl. 100 MB debug `.gcode`). It is gitignored; archive/delete the local folder when convenient.
- New-model eject geometry (P2S / X2D / H2 / A2L in `Automator.MODEL_DEFAULTS`) is derived from published bed sizes — validate sweep lanes + park coordinates on real hardware before unattended loops.
- Orca preset names for the new models (`SliceService.ORCA_PRESETS`) assume a current OrcaSlicer install; a missing preset returns a clear `preset_missing` error with the path.

## Conventions

- ESM modules (`"type": "module"`). Use the existing `createLogger(context)` for logging.
- Don't commit `.env` (it holds the encryption key + access codes). `.gitignore` covers it.
- Printer auth (access codes/serials) is encrypted at rest via `src/utils/crypto.js`.
