# API Endpoint→Feature & Windows-Node Audit

_Date: 2026-07-01 · 37 findings, 19 adversarially verified. Cloud (Vercel `api/` + Supabase)
merchant/admin/agent surfaces + the local Windows-node runtime._

## What was fixed in this change (tested)

### Local node — confirmed bugs
- **HMS `.toLowerCase()` crash** — `getPreflightStatus()` and `/diagnostics` called `.toLowerCase()`
  on the **numeric** HMS `code`, throwing a 500 **exactly when an HMS error was present** (i.e.
  when preflight/recheck/diagnostics matter most). Now coerced to string. This also fed the
  `cloud.print.ready` preflight gate.
- **`/control` connectivity guard** used `mqttClient.isConnected` (nonexistent) — replaced by a
  mock-aware `worker.canControl()`.
- **`/control` pause/resume/stop** now route through `worker._pausePrint/_resumePrint/_stopPrint`
  (state-machine bookkeeping) instead of poking MQTT directly, so REST and the cloud/CommandBus
  path can't drift. Added a **`clear_error`** control action (`mqtt.cleanPrintError()`).
- **Diagnostics `has_sd_error`** now also decodes a standing `print_error` (e.g. `0x0500C010`),
  not just the (now-fixed) HMS branch — so an SD fault is actually reported.
- **AMS `in_sync`** compared the raw live tray type ("PLA") to the configured **material**
  ("PLA Silk"), flagging every subtype as out-of-sync. Now compares against the material's **base
  tray type** via the filament catalog.
- **Restart error-spam** — the worker seeds `latestStatus` from the persisted snapshot so a
  restart doesn't re-log already-known HMS/print_error state as brand-new error events.

### Local node — new fleet endpoints (for 300-printer management)
- **`GET /printers/ams`** — aggregate loaded filament (material/color/%) across the whole fleet,
  filterable by `?material=`/`?color=` (find a printer already loaded for a color-critical job).
- **`POST /printers/bulk/control`** — pause-all / resume-all / stop-all / clear-all-errors /
  lights across `{printer_ids?}` (default all), with per-printer results.

### Cloud — cancel now reaches the printer
- **`POST /api/public/print-jobs/cancel`** now enqueues a best-effort `printer.stop` node command
  (guarded) so canceling in the storefront actually halts the printer — previously it only flipped
  the DB status while the printer kept printing.

Plus the earlier self-healing/error-log/retention work (separate commit).

**Tests: 360 pass** (new runtime suites for the HMS crash, AMS in-sync, `canControl`, self-healing,
and event retention).

## Endpoint→feature matrix (verdicts)

**Correct & wired:** agent bridge (`heartbeat`/`commands`/`events`/`command-result`), merchant
`print-jobs` (ready-file → routing → `cloud.print.ready`), `farm/capabilities`, files/orders reads,
local `printers` CRUD, camera, discover, AMS config, `/printers/:id/errors`.

**Stub / mock (real DB shell, fake behavior):**
| Endpoint | Reality |
|---|---|
| `POST /slices`, source-model print-jobs | `mockSlicerAdapter` → `completed_mock`, zero real bytes |
| `POST /shipments`, labels | `mockShippingAdapter` (`mock://` label) |
| billing rate-card / invoice preview | `mockBillingAdapter` pricing (usage rows are real) |
| `POST /realtime/tokens` | `mockRealtimeAdapter`, no gateway honors the token |
| inspections accept/reject | `mockInspectionAdapter` (always `manual_review`) |
| `POST /orders` (`auto_submit`) | records `intent_recorded`, `job_id:null` — **no job created** |
| `POST /print-jobs/reprint` | writes inert `reprint_requested` row, no routing |
| batch pause/resume/cancel | status-only, no per-item node commands |

**Misrouted / drift:** `GET /api/public/integrations` enforces no auth while OpenAPI marks it
`MerchantApiKey` (spec/impl drift).

## Missing features (needed, not yet built)
- **Merchant-scoped `GET /api/public/printers[/:id]`** — a storefront can't list printers / live
  status (only admin overview exposes them).
- **Merchant-facing hardware-error surface** — HMS/`print_error` aren't projected to merchant job
  events; a merchant sees "stopped" with no cause.
- **Orders → jobs** linkage; **reprint → real routing**; **batch controls → node commands**.
- **Real slicer / shipping / billing / realtime / inspection** providers (all mock).
- **Queue management** (priority/reorder); **broader cloud→local command set**
  (`printer.control`/`printer.ams.*`/`clear_error`/diagnostics/camera passthrough).
- **Persisted live AMS per tray + grams** (Bambu reports 0–100%, not grams).

## The 300-printer throughput ceiling (biggest scale risk)
The single-threaded `sql.js` node writes each status report synchronously **and re-exports the
entire DB file every 10s**; this is O(DB size) on the event loop and is the real ceiling
(≈ tens of printers today, not 300). Retention (added) caps the worst growth, but the fix is
**status-write coalescing/debounce + incremental persistence** (`better-sqlite3`/libsql, or move
status+events to Postgres) and eventually **sharding across worker_threads**. Also open: FTPS uses a
process-wide `tls.connect` monkey-patch that can corrupt concurrent uploads; and cloud
`claim_node_commands` has no lease, so a crashed node's claimed commands aren't re-dispatched.

## Also still open (from prior audits)
`JobOrchestrator.onJobCompleted` (auto-eject/repeat/next) is orphaned — never called; and
`cloud.print.ready` bypasses `JobOrchestrator`, so cloud prints skip loops/cool-release/ACK. These
are the core production-loop builds. Branding is still split three ways.
