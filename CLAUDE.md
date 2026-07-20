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

## THE core problem — RESOLVED (2026-07-17): it was the project_file URL, not the SD card

The historic "can't send large looped files / 0500-C010 MicroSD exception" failures were
**our bug, not printer hardware**. Root cause (hardware-verified on a sibling farm build,
2026-07-03 → 07-07, and now ported here):

- The start command used `url: ftp:///sdcard/cache/<file>` — but **the FTPS root IS the
  SD card**, so the firmware looked for a nonexistent `/sdcard/sdcard/...` path and
  reported a bogus **0500-C010 "MicroSD card read/write exception"**.
- The corrected `ftp:///cache/<file>` form works for small files but makes the firmware
  re-fetch the file and **chokes on multi-MB files with the same bogus SD error**
  (3.2 MB failed, 117 KB fine — byte-identical upload verified by md5 re-download).
- **`file:///sdcard/cache/<file>` is the reliable PRIMARY form** (the printer reads the
  already-uploaded file directly). `startJob` sends it first and retries once with
  `ftp:///cache/` for firmware variants.

The old diagnosis ("failing MicroSD card", below in `DIAGNOSIS.md`) is retained for
history but is **superseded** — those printers were healthy all along. `proof_test.js`
still predates the fix and uses the old URL form; don't treat its output as evidence
without updating it.

## Changes already made (2026-07-17→20 session — phase 2: slicer stack, compositor, review pass)

PR #11 (branch `port/slicer-phase2`, builds on #10). Read the PR body for full detail.
1. **Multi-color slicing core**: `Model3mf.js` (buildPlain3mf / buildBambuProject3mf) +
   `assets/bambu_multicolor_template.3mf` (DO NOT DELETE — multi-color depends on it) +
   full `SliceService` (resolved preset chains baked into project config — never
   `--load-settings` on the project path, it re-centers the plate; fully-resolved flat
   presets for the CLI; materials; 49-field schema; merged-parts `options.groups` where
   the LATER part wins overlap = show-through; Textured PEI default bed; plate Z offset;
   teardown-crash retry; post-slice multi-filament verification). Fixed A1/A1_MINI
   slice_info modelIds (A1 was stamped 'N1' = A1 mini). Regression:
   `node verification/mc_verify.mjs` (real engine, ~21 checks).
2. **Full browser slicer + saved prints**: slicer.js (text/logo tools, colors, scene
   persistence), `#/prints` pages, text templates + fill webhook (`X-Webhook-Token`),
   custom colors (`/api/colors`, migration 019), vendored offline 3D stack
   (three r160 + SVGLoader + bvh/CSG + opentype + fonts; import map in
   farm-dashboard.html; identical npm devDeps for Node-side use).
   Migrations 017 (text_templates) / 018 (filament_profiles) / 019 (custom_colors).
3. **AMS color intelligence**: `AmsService.matchColorsToTrays` (MATERIAL first at the
   base-tray-type level — "PLA Silk" satisfies PLA, PLA-CF does not — then RGB distance);
   startJob resolves `ams_roles {mode:'auto'}` against LIVE inventory; failover checks
   candidate spools.
4. **Customization compositor** (`src/services/CustomizationCompositor.js`): the consumer
   of the order-intake `placement[]` contract — auto-orients SVG/STL/text assets onto the
   requested case face, slices as ONE merged object (asset last = shows through). Logos
   default 0.5mm; bottom-face = flush CSG-carved inlay occupying the first ~2 layers.
   ENGINE FACT (empirical): on layer 1 only, strokes ≲3mm wide are absorbed into the
   surrounding filament — solid areas hold color from layer 1. Cloud: printDispatch signs
   per-placement asset URLs (WITH org/merchant ownership check); node executor downloads,
   composes, starts with AMS auto colors. Merchant opt-in: `options.customization` on
   POST /api/public/print-jobs. Regression: `node verification/compositor_verify.mjs`.
5. **Richer printer page** (1s live status, decoded error panel + Clear Error & Recover,
   live AMS trays, motion-action 409 guard, stop→job-fail + residue dismissal, real
   `ams_change`) and **Jobs page** (Start AMS modal — PATCH /jobs/:id now accepts
   ams_roles/repeat_total/status escapes; save-job-as-template via
   POST /job-templates/from-job/:jobId recovers the ORIGINAL pre-transform file by
   repack; shared `JobOrchestrator.submitFromJobTemplate`).
6. **47-agent adversarial review pass fixed 16 confirmed defects** — see commit cd6a775
   (cross-tenant asset signing, ES-module inline-handler ReferenceErrors, stale
   activeJobId, MQTT-drop completion, failover queue-stealing, raw-mode startable
   artifacts, path sanitize, upload caps, and more). merchantDocs test fixed for
   Windows (path.sep normalization). Node bundle rebuilt WITH the compositor.
NOTE: the SPA at `/` locally is `farm-dashboard.html`; on Vercel `/` is the cloud
landing `index.html` (server.js rootPageFile — deliberate, commit 51232bc).

## Changes already made (2026-07-17 session — start-reliability port from the local farm build)

Ported the hardware-verified start pipeline hardening from the sibling Antigravity farm
build (all covered by `tests/runtime/startReliability.test.js` + updated
`printCompletionLoop.test.js`):

1. **project_file URL fix** — `BambuMqttClient.startPrint` defaults to
   `file:///sdcard/cache/<file>`; `startJob` retries once with `ftp:///cache/<file>`
   (see "THE core problem — RESOLVED" above). `flow_cali`/`vibration_cali` now default
   **OFF** (Bambu bakes the saved K-factor into sliced gcode; the start-of-print flow
   cali extrudes test filament — "nozzle in the air, filament falling"). Opt in per job
   via `transform_overrides.flow_cali`.
2. **startJob hardening** — standing-print-error preflight (clean_print_error + 8s
   recheck, fail fast with decoded remediation instead of burning the 60s ACK timeout),
   self-heal recovery for error-state printers (`PrinterWorker.recoverFromError`:
   dismiss + re-home for 0300-40xx homing faults), 2 start attempts with URL fallback,
   stuck-start watchdog (ACKed but 0% + blocking error for 4 min → stop + fail loudly),
   positive-state ACK (only `printing`/`paused` counts — "not idle" false-ACKed from the
   dismissed-FAILED state), AMS default-to-first-tray when a job has no tray config on an
   AMS printer (use_ams:false hangs on the external spool holder, 07FF-C006), retryable
   `failed` jobs, and **auto-failover** to an idle same-geometry printer on printer-local
   errors (kill switch `JOB_AUTO_FAILOVER=false`; slot_map jobs never fail over).
3. **File↔printer model guard** — `submit()` reads the file's `printer_model_id` from
   `Metadata/slice_info.config` (registry: `modelFromSliceInfoId`), prefers it for the
   transform dialect, and `startJob` refuses a file↔printer geometry mismatch with a 409
   (P1S gcode on an A1 = garbage prints; 3 real incidents). Override:
   `transform_overrides.allow_model_mismatch`.
4. **Bambu FAILED-state semantics** — gcode_state=FAILED with **no active error code**
   is dismissed-cancel residue, not a fault: the worker now reads it as `idle` (queue/
   failover see the printer as available; no human screen-tap needed on a farm), and
   preflight blocks on `paused` (starting over a paused print wrecks it).
5. **Error decoding** — vendored the official Bambu error table
   (`assets/bambu_error_codes.json`, ~530 print errors + ~4000 HMS codes), `decodeHms()`,
   curated remediation for 0300-4000 (Z-homing) and 1200-8001 (filament-change failure);
   HMS numeric attr/code coercion + zero-padded module check (0500 = storage; 0300 is
   motion and is no longer misflagged as an SD fault).
6. **Restart resilience** — `_readoptActiveJob` (re-adopt a running print's job after a
   server restart) and `_reconcileOrphanedJobs` (settle jobs stranded 'printing' when the
   print ended while the server was offline — FINISH → late completion with bookkeeping
   only, anything else → failed/retryable). AMS status pushes now MERGE (an incremental
   `{tray_tar}` push no longer wipes the tray inventory until the next pushall).
7. **onJobCompleted** skips the accessory ejection pass when the job's gcode already
   contains the transform's cooldown+sweep (`transform_report.insertionPoint`) — with an
   ejector fitted the accessory pass would double-eject and stall the repeat chain.

## Changes already made (July 2026 session — UI/UX refresh: landing, operator console, merchant portal)

1. **Merchant portal (`public/merchant.html` + `merchant-portal.js`) rebuilt**:
 sticky brand header, split auth layout (gradient brand/value panel + auth
 card), login ↔ forgot-password now swap in place (`showSigninForm`; new
 `#back-to-login`), focus rings, and a real signed-in dashboard — company
 name + status pill header, account tiles, hoverable API-key table, one-click
 **Copy key to clipboard** (`#copy-key-secret`), and "Build with the farm"
 quick links (API guide / Woo plugin / /order). All test-asserted IDs and
 endpoints unchanged.
2. **Operator console visual refresh (`cloud.css` + small `cloud.html` edits)**:
 compact brand-mark header (h1 42→22px), centered brand on the login screen,
 tabs became a segmented control, metric cards dropped the thick colored top
 borders for dot-labeled cards with tabular numbers + hover, focus rings on
 all inputs/buttons, softer layered shadows/radii, table `thead`/row-hover
 styling, subpanel tint, animated toast. Every ID/class asserted by
 `dashboardAssets.test.js` kept (incl. `[hidden]{display:none}` guards).
3. **Landing page polish (`index.html`)**: hero eyebrow chip + gradient
 headline accent, numbered step badges, per-section uppercase eyebrows with
 uniform 76px section rhythm, panel/pricing hover lift, "Most popular" badge,
 smooth-scroll + `:focus-visible`. Dark-mode vars respected throughout.
4. Verified with Playwright before/after shots (incl. a mocked signed-in
 portal). Tests: 664 pass.

## Changes already made (July 2026 session — MCP v2: agent-native commerce + org routing fix)

1. **CRITICAL routing fix**: `ensureStorefrontIdentity` now provisions the
 walk-in merchant **inside the org that owns the farm nodes** (routing +
 redispatch are org-scoped; the old separate "Public Storefront" org meant
 production storefront/agent jobs could NEVER dispatch). Self-heals stored
 identities created before nodes existed (re-provisions merchant in the node
 org, keeps quote_secret).
2. **MCP v2 (`mcpServer.js`, 11 tools)**: adds `farm_capacity` (live printers/
 queue/lead time + AMS-loaded colors via buildFilamentStockView),
 `print_preview` (meshPreview.js: shaded isometric SVG returned as MCP image
 content), `generate_model` (OpenSCAD → STL via new node command
 `cloud.model.generate`; executor compiles with `openscad` CLI, 90s timeout,
 4MB cap, MOCK emits a cube; nodes advertise `can_generate_models`; poll
 with generation_id), `print_snapshot` (live camera frame via
 printer.camera.snapshot command round-trip, poll with snapshot_command_id),
 `cancel_order` (unpaid), `request_refund` (queued + operator alert;
 admin settles via POST /api/cloud/storefront {action:'mark_refunded'}).
 Multi-item orders (items[] ≤10, one shipping fee, combined-digest quote
 token); per-IP token-bucket rate limiting (429 + Retry-After); merchant
 tier (Bearer pkx_ key → resolveMerchantAuth → bills merchant account,
 dispatches immediately, no USDC).
3. **Hands-free USDC settlement**: every anonymous order gets a UNIQUE
 payable amount (sub-cent dither, collision-checked vs open orders);
 storefront sweep stage 0 scans Transfer logs to the wallet
 (`scanUsdcTransfersToWallet`, eth_getLogs from `storefront_sweep_state.
 usdc_scanned_block` with confirmation-window rewind) and settles matching
 orders — the agent just pays. Plus EIP-681 URI, per-material rates
 (`USDC_PRICE_PER_GRAM_<MAT>`), volume break (`USDC_VOLUME_BREAK_GRAMS`/
 `_DISCOUNT_PCT`), and x402 (`settleX402Payment` via `X402_FACILITATOR_URL`
 verify→settle; `print_pay` accepts x402_payment; mock 'mock_x402').
 dist/windows-node rebuilt (executor + capability changes). Tests:
 mcpServer.test.js rewritten (17) — 664 total.

## Changes already made (July 2026 session — MCP server: agents buy prints with USDC)

1. **Remote MCP server at `POST /api/mcp`** (`src/cloud/mcpServer.js`):
 stateless Streamable HTTP JSON-RPC (initialize/tools list+call/ping;
 notifications → 202; GET → 405 hint; batch tolerated). Five tools:
 `farm_info`, `print_quote` (file_url with SSRF guard OR base64; finish
 options), `print_order` (quote token + shipping address → pending_payment
 order), `print_pay` (tx hash), `print_status`. Orders reuse the storefront
 machinery end-to-end (`source:'mcp_agent'`, provider `usdc`), so dispatch,
 auto-retry, auto-ship labels, and emails all apply. Wired: `api/mcp.js`
 (Vercel) + localCloudServer; landing "For developers" card documents it.
2. **USDC per-filament-gram payments** (`src/cloud/usdcPayments.js`):
 price = grams × `USDC_PRICE_PER_GRAM` (0.05 default) × qty +
 `USDC_SHIPPING_FLAT` (8), exact 6-decimal base units. Self-custodial:
 agent transfers to `USDC_WALLET_ADDRESS` (env, Vercel) on `USDC_CHAIN`
 (base default; ethereum/polygon/arbitrum; token + RPC overridable), then
 submits the tx hash; verification is read-only RPC
 (eth_getTransactionReceipt: status 0x1, USDC contract Transfer log to OUR
 wallet, amount ≥ owed, `USDC_MIN_CONFIRMATIONS` ≥ 2 via eth_blockNumber).
 One tx settles exactly one order (reuse rejected). MOCK: tx `mock_paid`.
 Env documented in `.env.example`. Tests: `mcpServer.test.js` (6) — pricing
 math, on-chain verify matrix (wrong wallet/underpaid/unconfirmed), full
 agent funnel, tamper/reuse/token attacks, SSRF guard (653 total).

## Changes already made (July 2026 session — fulfillment loop + alerts + WooCommerce)

1. **Auto-shipping** — `src/cloud/shippingLabels.js`: EasyPost REST adapter
 (create shipment → cheapest/preferred rate → buy; Basic auth; MOCK
 simulates). Storefront sweep stage 3: orders whose jobs are ALL completed
 buy a label, flip to `shipped`, email tracking; without a carrier key they
 park `ready_to_ship` + alert. Config in `storefront_settings.shipping`
 (easypost key write-only or `EASYPOST_API_KEY`, from_address defaults to
 the Houston dock, parcel dims + base weight, `auto_ship` default ON).
2. **Customer emails** (Resend mailer, best-effort): paid receipt with status
 link, shipped with tracking, cancel/refund confirmation. Status link stored
 on the order (`status_url`). Handlers take `mailer`; Vercel functions pass
 `createMailer()`; heartbeat/events wire it too.
3. **Cancel/refund** — `POST /api/public/storefront/cancel` {order_id, token}:
 allowed until any job leaves queued/waiting; cancels jobs, refunds via new
 `createStripeRefund` (payment_intent captured from webhook/sweep), status
 `refunded`/`canceled`. UI: cancel button + shipped/refunded statuses +
 tracking line on /order. **Stripe Tax**: `stripe.tax_enabled` setting →
 `automatic_tax[enabled]` on Checkout Sessions.
4. **Operator alerts** — `src/cloud/operatorAlerts.js`: fan-out to
 `farm_integrations.alerts` channels ({type: discord|slack|webhook|email}).
 Fired on: job failed (final), job auto-retried, printer.alert/auto_canceled
 node events, order paid/shipped/canceled, ready_to_ship, maintenance due.
5. **Auto-retry + maintenance** (agentHandlers): `print_job.failed` →
 `maybeRetryFailedJob` re-routes the same file once (policy
 `auto_retry_failed_jobs` ON, `auto_retry_max` 1, marker `options.retry_of`);
 `print_job.completed` → per-printer counter in `printer_service_state`,
 alert every `maintenance_alert_every_prints` (200).
6. **WooCommerce plugin** — `integrations/woocommerce/printkinetix-print-on-
 demand/` (PHP 8 linted, single-file + assets): merchant pastes API key;
 product meta box uploads the model to `/api/public/files`; product page
 customizer (material/color/scale/strength/quality + optional interactive 3D
 preview via bundled `pkx-model-viewer.js`); paid Woo orders POST
 `/api/public/orders` with `auto_submit` + shipping address (idempotent
 `external_order_id` woo-{host}-{id}) → our pickup sweep prints them; hourly
 cron syncs farm status back to order notes. Download:
 `GET /api/public/integrations/woocommerce-plugin` (adm-zip on demand,
 viewer injected; `src/cloud/woocommercePlugin.js`; vercel.json
 includeFiles). Links on landing + onboarding pages.
7. Deferred deliberately: slice-to-quote refinement for STEP/OBJ, carrier-rate
 quoting at checkout, storefront orders → real table, node self-update.
 Tests: `fulfillment.test.js` (10) + storefront ship/cancel tests (647 total).

## Changes already made (July 2026 session — 3D viewer + finishing touches on /order)

1. **Interactive 3D preview** — `public/js/model-viewer.js`: dependency-free
 WebGL viewer (no three.js/CDN; ~450 lines): binary+ASCII STL and OBJ
 parsers, per-face flat normals, two-light lambert shader, orbit/wheel/pinch
 controls, auto-fit + idle spin, DPI-aware. `window.PKXModelViewer`.
 Verified in real Chromium (Playwright smoke: parse, WebGL init, bounds,
 zero page errors + screenshot).
2. **Finishing touches that really change the print** (panel under the
 viewer): scale 25–400% (server reprices by scale³ via `analyzePrintUpload
 scalePercent`; sliced files ignore scale), color swatch (tints the viewer
 AND becomes `requirements.colors` → router prefers a printer with that
 filament loaded), strength light/standard/strong (solidity 0.28/0.35/0.48 +
 `slice_settings.infill_percent` 10/15/25), quality draft/standard/fine
 (machine-time ×0.8/1/1.35 + `layer_height_mm` 0.28/0.2/0.12). All in
 `normalizeFinishOptions`/`finishSolidity`/`finishSliceSettings`
 (storefrontHandlers); jobs carry `options.finish` + `options.slice_settings`.
 Client marks the quote stale on any change (checkout disabled until
 re-quote); the HMAC token binds the finish via the total.
3. **Page polish**: /order gets the viewer card + finish panel + status
 timeline (Paid → Printing → Done); landing page gets a customer
 "three steps" strip; file reading switched to ArrayBuffer (feeds viewer +
 chunked base64). `model-viewer.js` excluded from the farm-node bundle
 (all three lists); browser scripts syntax-checked in dashboardAssets test.

## Changes already made (July 2026 session — unprinted-order pickup + ASIN suggestions)

1. **Nothing paid/submitted can sit unprinted in Supabase anymore.** Two
 heartbeat sweeps (both throttled 5min, best-effort, never fail a heartbeat):
 - `pickupUnprintedOrderItems` (`src/cloud/orderPickup.js`): merchant v2
   `merchant_order_items` rows with a file but `job_id: null` (the old
   `auto_submit` dead end that only "recorded intent") become REAL routed
   print jobs — one per unit (cap 20), item gets `job_id` + `metadata.job_ids`
   + `auto_submit_status:'submitted'`, order → `in_production`
   (in_production/printing stay pickup-eligible so multi-item orders finish).
   Gate: farm policy `auto_print_submitted_orders` (default ON; off = only
   items that explicitly requested auto_submit). Missing file →
   `pickup_failed` marker (no retry loop). New store methods
   `listUnprintedMerchantOrderItems`/`updateMerchantOrderItem` (supabaseRest;
   `merchant_order_items` added to MERCHANT_V2_IDS).
 - `sweepStorefrontOrders` (storefrontHandlers): `pending_payment` orders
   whose Stripe webhook never arrived are settled by asking Stripe for the
   session state directly (paid → dispatch; expired → `payment_expired`;
   ≤8 lookups/sweep); paid/processing orders with zero jobs (dispatch crash)
   re-dispatch idempotently. Throttle state in `storefront_sweep_state`.
2. **"Suggest product" for filament tagging** — Amazon Business Product
 Search API client (`searchAmazonBusinessProducts`,
 `GET /products/2020-08-26/products?keywords=…`), handler action
 `suggest_product` (never 400s — returns `search_error` inline), console
 button per Filament Catalog row fills ASIN + price cap (top hit × 1.1).
 MOCK returns a fake product.
3. Heartbeat responses now include pickup/sweep counts; `createHeartbeatHandler`
 takes `fetchImpl`. Tests: `orderPickup.test.js` (6) + sweep tests in
 `storefront.test.js` + search/suggest tests in `filamentReorder.test.js`
 (629 total).

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
5. **Ships to the farm dock + fully-auto defaults** — every Amazon order
 carries an Ordering-API `ShippingAddress` attribute (PhysicalAddress);
 default ship-to is the farm's receiving address (**5151 Mitchelldale St
 A10, Houston TX 77092**, `DEFAULT_SHIP_TO`), editable in the console
 ("Ship filament to" fields; absent key = keep default, explicit null =
 clear; incomplete address → attribute omitted → AB account default).
 Reorder defaults flipped to hands-off: `enabled` + `mode:'auto'` out of
 the box (trial_mode still ON + budget caps still gate real spend).
6. **Fully hands-off variant (AMS-level tracking + tagging)** — stock now
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

- ~~Run `proof_test.js` to confirm the SD-card blocker~~ — superseded: the "SD card" errors were the project_file URL bug, fixed 2026-07-17. A real-hardware smoke of the new start pipeline (file:/// primary + ftp:/// fallback) is still worth one run on this repo's build.
- ~~No automated tests~~ — stale: `npm test` now runs 560+ vitest tests (auth, stores, routing, transform round-trips per model, offline e2e full loop). On a loaded machine cap concurrency: `npx vitest run --maxWorkers=2`.
- ~~Start-print URL is inconsistent~~ — resolved 2026-07-17: `file:///sdcard/cache/` is primary, `ftp:///cache/` is the retry fallback (see "THE core problem — RESOLVED"). The ad-hoc root scripts (`proof_test.js`, `experiments.js`, …) still carry old URL forms — update before trusting them.
- **Repo is heavy** — `uploads/` holds ~1.2 GB of artifacts (incl. 100 MB debug `.gcode`). It is gitignored; archive/delete the local folder when convenient.
- New-model eject geometry (P2S / X2D / H2 / A2L in `Automator.MODEL_DEFAULTS`) is derived from published bed sizes — validate sweep lanes + park coordinates on real hardware before unattended loops.
- Orca preset names for the new models (`SliceService.ORCA_PRESETS`) assume a current OrcaSlicer install; a missing preset returns a clear `preset_missing` error with the path.

## Conventions

- ESM modules (`"type": "module"`). Use the existing `createLogger(context)` for logging.
- Don't commit `.env` (it holds the encryption key + access codes). `.gitignore` covers it.
- Printer auth (access codes/serials) is encrypted at rest via `src/utils/crypto.js`.
