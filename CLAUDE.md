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

## Changes already made (July 2026 session — console audit, tabbed UX, cloud-link)

1. **Cloud console is tabbed** (`cloud.html` + `.console-tabs` CSS + `bindTabs`):
   Fleet / Merchants / Automation / Setup & Admin — same panels and element IDs,
   one section on screen at a time (last tab persists in `pkxCloudTab`).
2. **One-click migration runner**: the Backend Setup panel has "Apply pending
   migrations" (POST `/api/cloud/admin/migrations`) — previously an operator on
   an out-of-date schema was stuck behind the setup gate with no UI path.
3. **Audit fixes** (see PR for the full list): admin session pepper is now
   threaded through every data handler (`adminPepper` option — self-hosted
   session logins used to 403 on `/overview` etc. when env peppers diverged);
   `localCloudServer` gained the 4 missing admin routes (merchant-api-keys/
   jobs/usage/v2); password-reset tokens are consumed atomically BEFORE the
   password write (double-submit safe) on both stores; the public merchant
   projection now redacts `metadata.webhook.secret`; migration error redaction
   covers `pkx_muser_*`.
4. **Node lifecycle management**: `/api/cloud/nodes` accepts
   `{action: rename|rotate_token|decommission, node_id}` (decommission
   scrambles `token_hash` so the old token can never authenticate; nodes table
   has Rename / Rotate token / Decommission row actions). New store methods
   `findFarmNodeById`/`updateFarmNode`.
5. **More admin tools**: "Portal Accounts" panel (list a merchant's portal
   users + issue password reset via `/api/cloud/merchant-users`), "Sign out
   everywhere" (admin logout `{all:true}`; merchant portal has the same).
6. **Cloud Link — print server ⇄ cloud integration**: the agent loop moved to
   `src/cloud/cloudAgentRuntime.js` (restartable, single-instance);
   `server.js` auto-starts it when configured via the new `app_settings` table
   (migration 017 + `SettingsModel`) or `CLOUD_API_URL`/`LOCAL_NODE_TOKEN` env;
   `runLocalNode.js` is now a thin wrapper (bundle entry unchanged). New
   `/api/cloud-link` REST (GET status / PUT save+connect / DELETE / POST test)
   and a "Cloud Link" modal in the local dashboard header — an operator can now
   join the cloud by pasting a URL + token into the UI, no `.env` editing.
   Rebuilt `dist/windows-node/farm-node.cjs`.

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
- **No automated tests** despite `vitest` being configured. Worth adding: transform round-trip, error decoder, auth. `npm test` currently has nothing to run.
- **Start-print URL is inconsistent** across code/scripts (`ftp://`, `ftp:///cache/`, `ftp:///sdcard/cache/`). Pin down the correct form once the printer can start prints.
- **Repo is heavy** — `uploads/` holds ~1.2 GB of artifacts (incl. 100 MB debug `.gcode`). Archive when convenient.
- Branding is split between "Antigravity" (logs/package.json) and "3DFLOW" (UI title).

## Conventions

- ESM modules (`"type": "module"`). Use the existing `createLogger(context)` for logging.
- Don't commit `.env` (it holds the encryption key + access codes). `.gitignore` covers it.
- Printer auth (access codes/serials) is encrypted at rest via `src/utils/crypto.js`.
