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
