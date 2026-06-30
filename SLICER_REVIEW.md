# In-Browser Slicer — Deep Review & Architecture Options

_Research/design review for adding a SimplyPrint-style slicer to Antigravity / 3DFLOW.
No code yet — this is the "how to go about it" document. Date: June 2026._

## 1. The single most important finding

**SimplyPrint built an in-browser slicer with Kiri:Moto (100% client-side), then tore it
out and replaced it with cloud slicing that runs the *real* slicer binaries
(PrusaSlicer / OrcaSlicer / BambuStudio) headless via their command line.**

Their own stated reasons for abandoning in-browser slicing:

1. **Browser slicing crashes on complex models** — supports-heavy or high-poly models hit the
   browser tab's memory/CPU limits and the slice fails. They could not guarantee a slice would
   finish on any device.
2. **The real engines "are not made to — and can't — run in your browser."** PrusaSlicer/Orca/
   Bambu are large C++/wxWidgets desktop apps; only the lighter **CuraEngine** has ever been
   compiled to WebAssembly, and those ports (cura-wasm, etc.) are unmaintained/deprecated.
3. **Profiles & ecosystem** — the value is in the thousands of community printer/filament
   profiles that ship with Prusa/Orca/Bambu. Kiri:Moto doesn't have that.

Takeaway for us: **the 3D editing UI belongs in the browser, but the heavy slicing compute
should run on a real machine running a real slicer binary.** The open question for this project
is *which* machine. That's the heart of this review.

## 2. Decompose "a slicer" — four independent pieces

It helps enormously to stop thinking of "a slicer" as one thing. It's four loosely-coupled parts,
and only one of them is hard to place:

| Part | What it is | Where it runs |
|------|-----------|---------------|
| **A. Model viewer / editor** | Load STL/3MF/STEP, render in 3D, move/rotate/scale, arrange on plate, paint supports/seams | **Browser, always** (Three.js / react-three-fiber). Independent of everything else. |
| **B. Settings & profiles** | Printer/filament/process profiles, the giant settings tree, presets | **Browser UI + stored server-side.** Data problem, not a compute problem. |
| **C. The slicing engine** | The CPU/RAM-heavy step: geometry → toolpaths → G-code | **The contested choice** (see §3). |
| **D. Output + integration** | Turn the engine's output into something your existing loop/eject pipeline consumes | **Your Node app** (see §5). |

The big strategic point: **A, B, and D are the same no matter where C runs.** So you can build the
UI and integration once, and keep the slicing backend *pluggable*. That de-risks the whole project —
you don't have to perfectly pick the compute location on day one.

## 3. Where the slicing engine can run — the core decision

Your evolving thinking (Pi → "maybe browser or the device that has the site open") is exactly the
right axis to reason about. Five candidates:

### Option A — In the user's browser (WebAssembly)
- **How:** Compile **CuraEngine** to WASM (only realistic engine; cura-wasm / Symple Slicer show it's
  possible). Slicing runs client-side, zero install, zero server load.
- **Pros:** No infrastructure, no Pi load, works offline, scales for free (each user brings their own CPU).
- **Cons:** This is the path **SimplyPrint abandoned.** Crashes on complex models, CuraEngine WASM
  ports are unmaintained, **no OrcaSlicer/Bambu engine** (so no native Bambu profiles or `.gcode.3mf`
  output — a real problem for your Bambu-only farm). Single-threaded-ish, slow on big plates.
- **Verdict:** Viable only for a *light/preview* slice or simple models. Not a foundation for a
  "full slicer" with Bambu support.

### Option B — On the device that has the site open (local companion agent) ⭐
- **How:** A small native helper installed on the viewing computer (a packaged OrcaSlicer/PrusaSlicer
  CLI + a tiny local HTTP/WebSocket bridge, or an Electron/Tauri wrapper). The browser UI hands the
  model + profile to the local agent; the agent runs the **real Orca/Bambu binary** on the client's
  CPU and returns a `.gcode.3mf`.
- **Pros:** Full real-engine power and fidelity, native Bambu support, native `.gcode.3mf` output,
  uses the (usually powerful) viewing PC instead of the Pi, no cloud cost, files never leave the LAN.
- **Cons:** Requires a small install on each operator's machine (not "pure web"). Doesn't help a phone/
  tablet/Chromebook (those would fall back to Pi/cloud).
- **Verdict:** **Best fit for your "runs on the device that has the site open" idea** and for a Bambu
  farm. This is essentially how desktop slicers already work, just driven by your web UI.

### Option C — On the Raspberry Pi (the host running 3DFLOW)
- **How:** Run OrcaSlicer/PrusaSlicer **CLI headless** on the Pi; browser UI calls your Node server,
  which shells out to the slicer.
- **Pros:** Zero client install, works from any device (phone/tablet), single box to manage.
- **Cons:** **The Pi is weak.** PrusaSlicer/Orca run on a Pi 4/5 but are slow, and a full model plus the
  3D UI is marginal; 4 GB Pis hit RAM limits. **One slice can saturate the Pi** that's also supposed to
  be orchestrating prints — bad for a farm. Multi-tenant ("both eventually") makes this much worse:
  N users slicing at once will not fit on a Pi.
- **Verdict:** OK as a *fallback* for light/unattended/queued slicing from thin devices. Not the
  primary path, and definitely not the multi-tenant path.

### Option D — Cloud / dedicated server (what SimplyPrint does)
- **How:** Orca/Prusa/Bambu CLI on a real Linux server (or autoscaling workers + a slice queue).
- **Pros:** Most powerful, scales to many users, any client device works, this is the proven model.
- **Cons:** Ongoing compute cost, you run infrastructure, models leave the LAN (privacy/security to manage),
  needs a queue + autoscaling to do well. Overkill for a single internal farm.
- **Verdict:** The right answer **only when you actually open it to external customers** (your "both
  eventually"). Design for it, don't build it first.

### Option E — Hybrid (recommended shape)
Pluggable backend (from §2): **UI always in browser; slice request routed to whichever engine is
available** — local companion agent first (Option B), Pi fallback for thin clients (Option C), cloud
later for customers (Option D), and optionally a CuraEngine-WASM "quick preview" in-browser (Option A).
You build one UI + one job interface and swap the compute.

## 4. Which engine: OrcaSlicer (with BambuStudio as a sibling)

For a **Bambu** farm this is close to a settled question:

- **OrcaSlicer / BambuStudio** (both PrusaSlicer descendants) have **first-class Bambu Lab support**
  and, crucially, their **CLI emits `.gcode.3mf`** — a ZIP containing `Metadata/plate_N.gcode` plus
  thumbnails and slice info. **That is exactly the artifact your existing pipeline already eats**
  (`AutomatorZip.extractGcodeFrom3mf` / `repack3mf`, plate-number detection, the looping + ejection
  transforms). This is a massive integration win — see §5.
- Representative CLI shape (Orca):
  `orca-slicer --slice 0 --load-settings "machine.json;process.json" --load-filaments "filament.json" --export-3mf out.gcode.3mf model.3mf`
  (`--slice 0` = all plates; flags shift between versions, so pin a version.)
- **CuraEngine** is the only engine that realistically runs in-browser (WASM), but it's a weaker fit:
  no native Bambu profiles, different output format (raw G-code, not `.gcode.3mf`), and you'd lose the
  pipeline synergy above. Keep it only as the optional in-browser "preview" path.
- **Don't write your own engine.** SimplyPrint's blunt take ("we couldn't possibly make a better engine
  in-house") applies tenfold here.

## 5. Integration with the existing 3DFLOW pipeline (this is the good news)

Your app already does the *hard part downstream of slicing*. The slicer just needs to feed it.

Today: user slices in Bambu Studio → uploads a `.gcode.3mf` → `JobOrchestrator.submit()` →
`extractGcodeFrom3mf` → `Automator` (loops + cool-release + ejection) → `repack3mf` → FTPS upload → print.

With an integrated slicer, the only change is the front of that chain:
**model (STL/3MF) + chosen profile → [slicing engine] → `.gcode.3mf` → (exact same pipeline as today).**

Because Orca/Bambu CLI outputs `.gcode.3mf` with `Metadata/plate_N.gcode`, the handoff is essentially
"drop the sliced file into the existing `submit()` path." No changes to the looping/ejection IP.
This is the strongest argument for OrcaSlicer over CuraEngine.

## 6. The browser UI (this part is real work, but well-trodden)

Regardless of where slicing runs, the front-end is a 3D app:

- **Rendering / manipulation:** `three.js` (optionally `react-three-fiber`). Load STL/3MF/OBJ; STEP needs
  a converter (e.g. an OpenCascade WASM build) if you want CAD input.
- **Plate / arrangement:** transform gizmos, auto-arrange (bin-packing), collision with bed bounds.
- **Supports / seam / multi-material painting:** **the hardest UI features.** SimplyPrint shipped their
  cloud slicer *without* paint-on supports/seam initially and added them later — a good signal to
  defer these. Auto-supports (engine-driven) are easy; *painted* supports are not.
- **Settings tree:** mirror the engine's settings/labels. SimplyPrint keeps theirs auto-synced from the
  engine. Plan a profile data model now (it overlaps your existing `gcode_profiles` table).
- **G-code preview:** layer view / toolpath colors after slicing.

## 7. Reuse what's already open source

You don't start from zero — SimplyPrint open-sourced the surrounding pieces (engine builds are MIT-/
permissively licensed; their wrappers are theirs but instructive):

- **`SimplyPrint/slicer-builds`** — custom headless builds of the slicers (how to package the engines).
- **`SimplyPrint/slicer-profiles-db`** — open DB of printer/filament/process profiles for Prusa/Orca/Bambu.
- **`SimplyPrint/open-filament-database`** — open filament database (brands, materials, settings).
- **OrcaSlicer / BambuStudio** themselves — AGPL/GPL; fine to *invoke as a CLI binary*, but be careful
  about license implications if you ever *link* their code into your app. Invoking the binary as a
  separate process is the clean path.
- **Symple Slicer / cura-wasm** — reference implementations if you pursue the in-browser CuraEngine path.

> Licensing note: OrcaSlicer is GPL-family. Shipping it as a *separate binary you call* is the normal,
> low-risk pattern. Bundling/linking it into your own distributed software raises copyleft questions —
> worth a proper license check before you ship anything commercial/multi-tenant.

## 8. Recommended architecture

For a Bambu farm that's internal now and "maybe customers later," and given your Pi constraint:

1. **Build the slicer UI in the browser** (Three.js viewer + settings + profile manager + G-code preview).
   This is the bulk of the work and is identical regardless of compute location.
2. **Define one "slice job" interface** in your Node app: `{model, profile, options} → .gcode.3mf`,
   then route it to a backend. Keep it pluggable.
3. **Primary backend = local companion agent on the viewing device (Option B):** a packaged OrcaSlicer
   CLI + tiny local bridge. Full engine, Bambu-native `.gcode.3mf`, uses the operator's PC, not the Pi.
4. **Fallback backend = Pi CLI (Option C)** for thin clients (phone/tablet), small models, or unattended
   queue slicing — accepting it's slow.
5. **Feed the resulting `.gcode.3mf` straight into the existing `JobOrchestrator.submit()` pipeline** —
   looping/ejection unchanged.
6. **Later, for customers (Option D):** stand up a cloud slice-worker + queue using the *same* job
   interface. No UI rewrite.
7. **Optional:** a CuraEngine-WASM in-browser "quick preview" (Option A) for instant feedback on simple models.

This gives you a "runs in the browser / on the device that has the site open" experience now, keeps the
Pi from being crushed, reuses 100% of your existing automation, and has a clean path to multi-tenant.

## 9. Hard parts & risks (worth knowing before committing)

- **Painted supports/seam/multi-material** — the expensive UI features; defer (SimplyPrint did).
- **AMS / multi-color** — Bambu AMS mapping in the slice + your existing `ams_roles` handling must line up.
- **Profile management at scale** — keeping engine settings/profiles in sync with upstream is real,
  ongoing work; lean on `slicer-profiles-db` / `open-filament-database`.
- **Engine version drift** — Orca CLI flags change between releases; pin a version and test upgrades.
- **Companion-agent distribution** — install/update/security of the local helper on each machine.
- **Pi performance ceiling** — set expectations; possibly cap on-Pi slicing to small models.
- **Multi-tenant security** — once external users upload models, you need isolation, limits, and a
  delete-after-slice policy (SimplyPrint deletes models immediately post-slice).
- **GPL/AGPL licensing** — keep engines as separately-invoked binaries; get a license read before commercial use.

## 10. Suggested phasing

- **Phase 0 (spike):** Drive OrcaSlicer CLI headless from the Node app on a desktop; confirm the output
  `.gcode.3mf` flows through `submit()` → loop/eject → print on the real printer. Pure backend, no UI.
  Smallest experiment that proves the whole chain.
- **Phase 1 (UI):** Browser model viewer + load/arrange + pick a profile + "Slice" button calling the
  Phase-0 backend + G-code preview.
- **Phase 2 (compute placement):** Package the local companion agent (Option B); add Pi fallback (Option C).
- **Phase 3 (depth):** richer settings, auto-supports, AMS/multi-color, profile management.
- **Phase 4 (scale):** cloud slice-workers + queue for external customers (Option D).

## Sources

- [SimplyPrint Cloud Slicer (online OrcaSlicer/BambuStudio/PrusaSlicer)](https://simplyprint.io/blog/cloud-slicer-orca-bambu-prusa-online-slicer/)
- [SimplyPrint — Online Cloud Slicer feature page](https://simplyprint.io/features/slicer)
- [SimplyPrint/slicer-builds (GitHub)](https://github.com/SimplyPrint/slicer-builds)
- [SimplyPrint/slicer-profiles-db (GitHub)](https://github.com/SimplyPrint/slicer-profiles-db/)
- [SimplyPrint/open-filament-database (GitHub)](https://github.com/SimplyPrint/open-filament-database/)
- [cura-wasm — CuraEngine compiled to WebAssembly (GitHub, deprecated)](https://github.com/Cloud-CNC/cura-wasm)
- [Symple Slicer — web-based CuraEngine slicer (GitHub)](https://github.com/SynDaverCO/symple-slicer)
- [OrcaSlicer CLI reference (Printago)](https://printago.io/blog/orca-slicer-cli-reference)
- [OrcaSlicer CLI mode & headless operation (DeepWiki)](https://deepwiki.com/SoftFever/OrcaSlicer/10.2-cli-mode-and-headless-operation)
- [PrusaSlicer on Raspberry Pi 4 (Prusa forum)](https://forum.prusa3d.com/forum/prusaslicer/prusaslicer-2-3-0-on-raspberrypi-4-success/)
- [prusa-slicer-raspberrypi build (GitHub)](https://github.com/koendv/prusa-slicer-raspberrypi)
