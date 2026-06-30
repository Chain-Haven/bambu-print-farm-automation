# Antigravity / 3DFLOW — Project Diagnosis

_Diagnosis run: 2026-06-23. Environment: Node v22.22.3, sandboxed Linux, MOCK_MODE._

## Summary

The application is healthy and runs. It boots, serves the dashboard, authenticates,
exposes a working REST API, and the G-code transform/looping pipeline works end-to-end
on a real sample file. **No defect in this codebase prevents sending files to the printer.**

The original blocker ("can't send large looped files to the printer") is, on the evidence,
**a failing printer MicroSD card** — not a software bug. Details below.

---

## What was tested and what passed

| Area | Method | Result |
|------|--------|--------|
| Dependencies | `node`, deps present | ✅ Node 22, 191 packages, sql.js WASM present |
| Server boot | `node server.js` (mock) | ✅ All 9 DB migrations applied, runtime started |
| Dashboard | `GET /` | ✅ HTTP 200, SPA HTML served |
| Auth | `POST /api/auth/login` | ✅ JWT issued; unauthenticated requests correctly rejected (401) |
| REST API | printers, profiles, jobs, system, accessories | ✅ All return 200 with valid JSON |
| Profiles seed | `GET /api/gcode/profiles` | ✅ System profiles present (A1, A1 Mini, P1S, etc.) |
| G-code extract | `extractGcodeFrom3mf` on real 3MF | ✅ 149,067 lines from `Metadata/plate_8.gcode` |
| Loop expansion | `automate()` at 1 / 5 / 20 loops | ✅ Exactly linear (149,158 × 20 = 2,983,238 lines) |
| 3MF repack | `repack3mf` + round-trip re-extract | ✅ 20-loop file = 15.9 MB; re-extract matches byte-for-byte |
| Source syntax | `node --check` on all `src/**/*.js` | ✅ No syntax errors |

A 20-loop job produces a **~16 MB `.gcode.3mf`**. That is the "large file" in question, and the
earlier evidence logs show files of this kind uploading successfully (FTPS `SIZE` verification matched).

---

## Root-cause diagnosis of the print-start blocker

Evidence is in `evidence_output*.log`, `experiments_output.log`, `final_evidence_output.log`.

1. **FTPS upload works.** Every upload completes and the remote `SIZE` equals the local byte count.
   The file reaches `/cache/` on the printer.
2. **The MQTT `project_file` start command is accepted** — the printer replies `result: success`.
3. **But the printer never leaves IDLE.** `gcode_state` stays empty; no print begins.
4. **Decisive control test (Experiment 1):** starting a *Bambu-Studio-generated, known-good `.3mf`
   already on the SD card* (no upload involved) **also failed to start.** If even Bambu's own file
   won't run, the cause is downstream of this software.
5. **Persistent blocking error:** the status stream carries `print_error: 83935248` = `0x0500C010`,
   which this project's own `src/utils/PrinterErrors.js` maps to
   **"MicroSD card read/write exception," severity: blocking** — and it is present even while idle.

**Conclusion:** the upload pipeline places the file on the card; the card has a read/write fault;
the printer cannot read the file back to begin printing and stays idle with a blocking storage error.
Larger looped files make it *look* worse only because a marginal card is more likely to choke on bigger writes.

### Fix (hardware, not code)
1. Power off; remove and reseat the MicroSD card; power on.
2. If it persists, format the card via the printer's own menu (Settings → Storage), then power-cycle.
3. If it still persists, replace with a high-endurance card (e.g. Samsung PRO Endurance).
4. Re-run `node proof_test.js` — it runs a known-good control vs. a generated artifact and will
   confirm whether the card is the issue.

> Caveat: these logs are dated Feb–Mar 2026. If the card has been changed since, re-run
> `proof_test.js` to confirm the current state before drawing conclusions.

---

## Code issues found (independent of the card)

### 1. Double-looping risk (logic bug) — `src/services/JobOrchestrator.js`
Loops are applied in two different places:
- **Baked into the file at submit:** `loopsN: transform_overrides?.n_loops || profile.n_loops || repeat_total || 1`
  (line ~94). If `repeat_total` is used as the loop count, the gcode is physically repeated N times.
- **Job-level restart:** `onJobCompleted` re-runs `startJob` while `repeat_remaining > 1` (line ~525),
  decrementing each finish.

If a caller passes `repeat_total = 20` with no separate `n_loops`, the file gets 20 loops baked in
**and** the job tries to restart 19 more times → 20 × 20 intended prints. `repeat_total` is overloaded
as both "in-file loop count" and "job restart count." These two mechanisms should be separated explicitly
(e.g. `n_loops` = in-file, `repeat_total` = job restarts) and validated so they can't both be > 1 by accident.

### 2. Inconsistent start-print URL form
- Production `src/mqtt/BambuMqttClient.js` sends `url: ftp:///sdcard/cache/<file>`.
- The diagnostic scripts used `ftp://<file>` and `ftp:///cache/<file>`.

None of these was the deciding factor (the known-good file failed regardless), but the canonical form
should be pinned down and used everywhere once the card is healthy.

### 3. "Soft success" masks a non-start — `startJob` ACK logic
If the printer neither transitions nor reports an error within the 30 s window, the pipeline logs a
warning but still marks the job `printing` (lines ~440–445). This is exactly the failure mode the bad
card produces, so the UI would show "printing" while nothing happens. Consider treating no-transition
as a failure (or a distinct "awaiting confirmation" state) and surfacing any standing `print_error`
(the SD fault is non-zero even before start).

### 4. Minor: dead/no-op trace math
`JobOrchestrator.js` line ~324: `t.elapsed_ms + Math.round(performance.now() - t0 - (performance.now() - t0))`
reduces to `t.elapsed_ms + 0` and calls `performance.now()` twice for nothing. Harmless, but should be simplified.

### 5. Tooling / housekeeping
- **No unit tests exist** despite `vitest` being configured (`npm test` has nothing to run). The numerous
  `*_test.js` / `proof_test.js` files at the repo root are ad-hoc diagnostic scripts, not a test suite.
- `node_modules` was installed on Windows, so `vitest` can't run in Linux (missing
  `@rollup/rollup-linux-x64-gnu`). Run `npm install` on the target OS before testing there.
- Branding is inconsistent: the SPA is titled **"3DFLOW"** while server logs and `package.json` say
  **"Antigravity."**
- ~1.2 GB of upload artifacts sit in `uploads/` (including 100 MB debug `.gcode` files). Worth archiving.

---

## Fixes applied (2026-06-23)

Implemented in `src/services/JobOrchestrator.js` and verified by isolated logic tests:

1. **Double-looping decoupled.** `loopsN` no longer falls back to `repeat_total`; it comes only
   from an explicit `n_loops` override or the profile (default 1). Added a guard that warns (in logs
   and the transform report) when both `n_loops > 1` and `repeat_total > 1` — the accidental N×M multiply.
2. **No more false "printing."** When the printer accepts the command but never leaves IDLE, `startJob`
   now fails with a clear message and surfaces any standing `print_error` (e.g. the SD fault) instead of
   marking the job `printing`. ACK window raised 30s → 60s so large looped files aren't failed prematurely.
3. **Cleanup.** Removed a no-op timing expression in the FTPS trace merge.

> Note: changes were written by the file tools (authoritative for your machine). Run `npm run dev`
> and submit a job to see the new behavior live.

## Recommended next steps (in order)
1. **Check/replace the printer's MicroSD card**, then run `proof_test.js` to confirm prints start.
2. Separate `n_loops` (in-file) from `repeat_total` (job restarts) and add a guard against double-looping.
3. Make `startJob` treat a no-transition ACK as non-success and surface standing `print_error` codes.
4. Add a minimal real test suite (transform round-trip, error decoder, auth) under `vitest`.
