# Audit: Admin/Cloud UI · AMS Filament · Auto-Router · Auto-Eject (July 2026)

_Scope requested: (1) see all active printers from the cloud, (2) assign the
color + material in each AMS slot, persisted and readable by merchants via API,
(3) an API auto-router that picks a printer with the right filament and
auto-prints, (4) auto-eject when the print finishes. Full audit + fixes; all
389 tests pass; the loop was verified end-to-end in MOCK_MODE._

## Verdict before this session

| Ask | State found |
|---|---|
| Cloud shows all active printers | **Broken at the root** — `cloud_printers` had **no writer anywhere**; the admin table and the router read a table nothing populated. |
| AMS slot assignment, persisted, merchant-readable | Local SPA had a full per-slot editor (SQLite-persisted), but the **cloud console had none**, and the merchant `farm/filaments` API read only a hand-typed spool JSON — never the real AMS data. |
| Filament-aware auto-router | The algorithm existed and was sound, but ran on empty/stale mirrors, ignored the spool inventory at submit time, silently downgraded strategies, never sent an `ams_mapping`, and cancel targeted the wrong printer id. |
| Auto-eject on completion | **Orphaned** — `JobOrchestrator.onJobCompleted()` (eject/repeat/next) was never called by anything, and cloud prints bypassed the transform that bakes in ejection. Completion never reached the cloud: jobs stuck "printing", reservations never released, printers never freed. |

## What was fixed (by layer)

### Local node — the production loop now closes
- `PrinterWorker` detects print end (`printing/paused → idle|error`) and
  resolves the active job: FINISH → completed, idle-without-FINISH → aborted,
  error → failed; offline is not terminal (prints survive MQTT drops).
- `RuntimeSupervisor` hands the outcome to `JobOrchestrator.onJobCompleted`
  (ejection → repeat → auto-start-next) or the new `onJobAborted` (mark failed,
  no auto-start — bed state unknown). Both are idempotent.
- `EjectionService` checks for the ejector accessory **before** the (up to
  45-minute) cool-down wait, so printers using in-gcode sweep ejection resolve
  instantly.
- MOCK_MODE now runs the whole pipeline (upload/start simulated), so the loop
  can be exercised with simulators.

### Cloud print path — merchant jobs get the core IP
- `cloud.print.ready` now routes through `JobOrchestrator.submit`: transform
  (cool-release + sweep ejection, optional loops), preflight, verified FTPS
  upload, MQTT ACK wait, and job tracking with cloud linkage metadata.
  Transform failures fall back to printing the artifact untouched
  (`transform_mode: 'optional'`); `pipeline: 'raw'` keeps the legacy behavior.
- A busy printer queues the job (`auto_start: false`); the completion hook
  auto-starts it when the bed clears.

### Node ⇄ cloud sync — the mirror is real now
- Heartbeats carry a `printers` array (state + merged AMS trays + build volume
  + auto-eject capability); the cloud upserts `cloud_printers`
  (`on_conflict=node_id,local_printer_id`). **This is the only writer of that
  table.**
- The node forwards `print_job.started/completed/failed`; the cloud events
  endpoint updates `print_jobs` (org-scoped), releases filament reservations on
  terminal states, and fires merchant webhooks.

### AMS filament — one source of truth, three consumers
- New node commands `printer.ams.get/set/clear`; `set` persists to
  `printer_ams_config` and pushes to the printer via MQTT when reachable.
- New cloud console panel **"AMS Filament Mapping"**: pick a printer, assign
  material + color per slot; queues `printer.ams.set` and mirrors back on the
  next heartbeat.
- `GET /api/public/farm/filaments` (and `farm/capabilities`) now overlay the
  loaded AMS trays (`loaded_slot_count`) on the spool inventory, so merchants
  see what is actually printable right now.
- Bug fixes: `tray_info_idx` was malformed for every material
  (`GFSL99→GFLL99`; now `GFS→GF`), the PUT route accepted flat tray ids that
  became invisible (now decomposed to unit+slot), and unknown materials are
  rejected with the valid list.

### Router — smarter and honest
- Submit-time routing now augments the overview with the spool inventory
  (previously only the planner did, so inventory-only filaments were rejected
  with `missing_material`).
- Strategy list unified (`cheapest`, `exact_material_match`,
  `smart_material_queue` no longer silently downgrade to
  `fastest_fulfillment`), and `smart_material_queue` actually batches by
  material.
- The dispatch payload now includes `print_job_id` and a computed
  `ams_mapping` (required color/material → the selected printer's matching
  tray, subtype-aware via `material_base`).
- `routing_summary` carries `selected_local_printer_id`; merchant cancel now
  stops the right printer.

### Fresh-install bug (found by the end-to-end run)
- Migration 005 inserts "A1 Mini" into an empty DB **before** seeding, so the
  count-guarded seeder skipped everything: fresh installs had no Universal
  profile and every submit without an explicit profile failed. The seeder is
  now per-profile idempotent and the profile lookup is case-insensitive with a
  wildcard-model fallback.

## Verified end-to-end (MOCK_MODE)

`AMS assign (cloud command) → persisted in SQLite → heartbeat snapshot carries
PLA/Red tray → cloud.print.ready → transform applied (automation block in the
artifact) → started → simulated print → completion detected → ejection step
(skipped cleanly, no hardware ejector) → job completed → job.started/completed
forwarded with the cloud job id.`

## Still open (not in scope of this pass)

- `farm/filaments` + `farm/capabilities` remain **unauthenticated** (existing
  product decision — recommend requiring the merchant key).
- `redactedJob`/`redactedFile` in the v1 merchant handlers are still
  pass-throughs (v2 uses real projections).
- Hardware ejection (`eject_printhead` accessory) is untested against real
  hardware; in-gcode sweep ejection is the active strategy.
- Real-printer validation still gated on the SD-card issue (`DIAGNOSIS.md`,
  `proof_test.js`).
