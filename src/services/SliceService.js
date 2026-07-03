// src/services/SliceService.js — Pluggable slicing backend.
//
// Per SLICER_REVIEW.md §2/§8: the UI and integration are the same no matter
// where the heavy slicing compute runs, so we define ONE slice-job interface and
// keep the compute backend pluggable. The browser hands us {model, profile,
// options}; a backend turns it into a `.gcode.3mf` that the EXISTING
// JobOrchestrator.submit() pipeline already knows how to loop/eject/print.
//
// Backends (in priority order), all behind the same interface:
//   local-agent — OrcaSlicer/Bambu CLI on the operator's PC via a companion agent (Option B)
//   pi-cli      — OrcaSlicer/Prusa CLI headless on the host running 3DFLOW   (Option C)
//   cloud       — slice-worker + queue for external customers                (Option D)
//
// Today NONE are wired to a real binary yet — this module establishes the
// contract and reports availability so the UI can light up the right path.
// Phase 0 (the OrcaSlicer CLI spike) drops in behind `_runCli()` without any
// change to callers.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createLogger } from '../utils/logger.js';
import { buildGcode3mf } from '../gcode/AutomatorZip.js';

const log = createLogger('SliceService');

// Default OrcaSlicer install locations probed when SLICER_CLI_PATH is unset.
const DEFAULT_CLI_CANDIDATES = [
    'C:\\Program Files\\OrcaSlicer\\orca-slicer.exe',
    'C:\\Program Files (x86)\\OrcaSlicer\\orca-slicer.exe',
    '/usr/bin/orca-slicer',
    '/usr/local/bin/orca-slicer',
    '/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer',
];

// OrcaSlicer bundled BBL profiles dir (override with ORCA_RESOURCES).
const ORCA_RESOURCES = process.env.ORCA_RESOURCES
    || 'C:\\Program Files\\OrcaSlicer\\resources\\profiles\\BBL';

// printer model -> bundled machine/process/filament preset basenames.
// (P1S verified working; P1S/X1 share the X1C 0.4-nozzle process+filament.)
const ORCA_PRESETS = {
    P1S: { machine: 'Bambu Lab P1S 0.4 nozzle', process: '0.20mm Standard @BBL X1C', filament: 'Bambu PLA Basic @BBL X1C', modelId: 'C12' },
    X1: { machine: 'Bambu Lab X1 Carbon 0.4 nozzle', process: '0.20mm Standard @BBL X1C', filament: 'Bambu PLA Basic @BBL X1C', modelId: 'BL-P001' },
    A1: { machine: 'Bambu Lab A1 0.4 nozzle', process: '0.20mm Standard @BBL A1', filament: 'Bambu PLA Basic @BBL A1', modelId: 'N1' },
    A1_MINI: { machine: 'Bambu Lab A1 mini 0.4 nozzle', process: '0.20mm Standard @BBL A1M', filament: 'Bambu PLA Basic @BBL A1M', modelId: 'N2' },
    // Newer models: presets exist in current OrcaSlicer BBL bundles; if a
    // given install is missing them, sliceViaCli reports the missing preset
    // path so the operator can update OrcaSlicer or override ORCA_RESOURCES.
    P2S: { machine: 'Bambu Lab P2S 0.4 nozzle', process: '0.20mm Standard @BBL P2S', filament: 'Bambu PLA Basic @BBL P2S', modelId: 'C14' },
    X2D: { machine: 'Bambu Lab X2D 0.4 nozzle', process: '0.20mm Standard @BBL X2D', filament: 'Bambu PLA Basic @BBL X2D', modelId: 'X2D' },
    H2D: { machine: 'Bambu Lab H2D 0.4 nozzle', process: '0.20mm Standard @BBL H2D', filament: 'Bambu PLA Basic @BBL H2D', modelId: 'H2D' },
    A2L: { machine: 'Bambu Lab A2L 0.4 nozzle', process: '0.20mm Standard @BBL A2L', filament: 'Bambu PLA Basic @BBL A2L', modelId: 'A2L' },
};

// Curated UI settings -> OrcaSlicer JSON keys. The UI sends simple values; we
// translate to the engine's exact key names/formats. Process settings go into a
// derived process JSON, filament settings into a derived filament JSON; both keep
// the base preset's `inherits` so the rest resolves from OrcaSlicer's datadir.
export const SLICER_SETTING_FIELDS = [
    { key: 'layer_height', label: 'Layer height (mm)', type: 'number', min: 0.04, max: 0.6, step: 0.02, group: 'process' },
    { key: 'infill_density', label: 'Infill (%)', type: 'number', min: 0, max: 100, step: 5, group: 'process' },
    { key: 'infill_pattern', label: 'Infill pattern', type: 'select', options: ['grid', 'gyroid', 'honeycomb', 'cubic', 'line', 'concentric', 'rectilinear'], group: 'process' },
    { key: 'wall_loops', label: 'Wall loops', type: 'number', min: 1, max: 10, step: 1, group: 'process' },
    { key: 'top_layers', label: 'Top layers', type: 'number', min: 0, max: 20, step: 1, group: 'process' },
    { key: 'bottom_layers', label: 'Bottom layers', type: 'number', min: 0, max: 20, step: 1, group: 'process' },
    { key: 'supports', label: 'Supports', type: 'bool', group: 'process' },
    { key: 'support_type', label: 'Support type', type: 'select', options: ['normal(auto)', 'tree(auto)'], group: 'process' },
    { key: 'brim', label: 'Brim', type: 'bool', group: 'process' },
    { key: 'nozzle_temp', label: 'Nozzle temp (°C)', type: 'number', min: 160, max: 300, step: 5, group: 'filament' },
];

/** Translate UI settings into OrcaSlicer process/filament JSON overrides. */
function orcaOverrides(settings = {}) {
    const process = {}, filament = {};
    const num = (v) => Number.parseFloat(v);
    const int = (v) => String(Math.round(Number.parseFloat(v)));
    if (settings.layer_height != null && settings.layer_height !== '') process.layer_height = String(num(settings.layer_height));
    if (settings.infill_density != null && settings.infill_density !== '') process.sparse_infill_density = `${Math.round(num(settings.infill_density))}%`;
    if (settings.infill_pattern) process.sparse_infill_pattern = String(settings.infill_pattern);
    if (settings.wall_loops != null && settings.wall_loops !== '') process.wall_loops = int(settings.wall_loops);
    if (settings.top_layers != null && settings.top_layers !== '') process.top_shell_layers = int(settings.top_layers);
    if (settings.bottom_layers != null && settings.bottom_layers !== '') process.bottom_shell_layers = int(settings.bottom_layers);
    if (settings.supports != null) process.enable_support = settings.supports ? '1' : '0';
    if (settings.support_type) process.support_type = String(settings.support_type);
    if (settings.brim != null) process.brim_type = settings.brim ? 'outer_only' : 'no_brim';
    if (settings.nozzle_temp != null && settings.nozzle_temp !== '') {
        filament.nozzle_temperature = [int(settings.nozzle_temp)];
        filament.nozzle_temperature_initial_layer = [int(settings.nozzle_temp)];
    }
    return { process, filament };
}

/** Read a base preset JSON, apply overrides, write a derived copy to `outPath`. */
function writeDerivedPreset(basePath, overrides, outPath) {
    const obj = JSON.parse(fs.readFileSync(basePath, 'utf-8'));
    delete obj.setting_id; // avoid colliding with the system preset id
    Object.assign(obj, overrides);
    fs.writeFileSync(outPath, JSON.stringify(obj, null, 2));
    return outPath;
}

/**
 * A slice job — the single interface every backend implements.
 * @typedef {Object} SliceJob
 * @property {Buffer} modelBuffer   - raw model bytes (STL / 3MF / STEP)
 * @property {string} modelName     - original filename (for extension/format)
 * @property {object} profile       - resolved slicing profile (machine/process/filament)
 * @property {object} [options]     - { plate, supports, ams_mapping, ... }
 *
 * @typedef {Object} SliceResult
 * @property {boolean} ok
 * @property {Buffer}  [gcode3mf]    - the `.gcode.3mf` artifact (feeds submit())
 * @property {string}  [outputName]
 * @property {object}  [report]      - { backend, durationMs, engine, ... }
 * @property {string}  [error]
 * @property {string}  [code]        - machine-readable failure code
 */

const SUPPORTED_INPUT_FORMATS = ['stl', '3mf', 'obj', 'step', 'stp'];

/**
 * Resolve a CLI engine path from env, returning {path, label} or null.
 * Checked lazily so the env can change without a restart of this module.
 */
function detectCliEngine() {
    const candidates = [
        process.env.SLICER_CLI_PATH,
        process.env.ORCA_CLI_PATH,
        ...DEFAULT_CLI_CANDIDATES,
    ].filter(Boolean);
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) return { path: candidate, label: path.basename(candidate) };
        } catch { /* ignore */ }
    }
    return null;
}

const BACKENDS = {
    'local-agent': {
        id: 'local-agent',
        label: 'Local companion agent (operator PC)',
        option: 'B',
        // Detected via a future local bridge handshake; not present yet.
        detect: () => ({ available: false, reason: 'Companion agent not detected on this device' }),
    },
    'pi-cli': {
        id: 'pi-cli',
        label: 'Host CLI (OrcaSlicer headless)',
        option: 'C',
        detect: () => {
            const engine = detectCliEngine();
            return engine
                ? { available: true, reason: `CLI found: ${engine.label}`, engine: engine.label }
                : { available: false, reason: 'Set SLICER_CLI_PATH to an OrcaSlicer/Prusa CLI binary' };
        },
    },
    'cloud': {
        id: 'cloud',
        label: 'Cloud slice workers',
        option: 'D',
        detect: () => ({ available: false, reason: 'Cloud slicing not configured' }),
    },
};

// Priority order — first available wins when caller does not pin a backend.
const BACKEND_PRIORITY = ['local-agent', 'pi-cli', 'cloud'];

export const SliceService = {
    SUPPORTED_INPUT_FORMATS,

    /** Inspect every backend's current availability (for the UI to render). */
    getBackends() {
        return BACKEND_PRIORITY.map((id) => {
            const b = BACKENDS[id];
            const status = b.detect();
            return { id: b.id, label: b.label, option: b.option, ...status };
        });
    },

    /** The first available backend, or null. */
    getActiveBackend() {
        for (const id of BACKEND_PRIORITY) {
            const b = BACKENDS[id];
            const status = b.detect();
            if (status.available) return { id: b.id, label: b.label, option: b.option, ...status };
        }
        return null;
    },

    /** True if `name`'s extension is a model format we can accept. */
    isSupportedInput(name = '') {
        const ext = name.split('.').pop()?.toLowerCase();
        return SUPPORTED_INPUT_FORMATS.includes(ext);
    },

    /**
     * Run a slice job through the active (or pinned) backend.
     * @param {SliceJob} job
     * @param {string} [preferredBackend]
     * @returns {Promise<SliceResult>}
     */
    async slice(job, preferredBackend = null) {
        const started = Date.now();

        if (!job?.modelBuffer?.length) {
            return { ok: false, code: 'no_model', error: 'No model data supplied' };
        }
        if (!this.isSupportedInput(job.modelName)) {
            return {
                ok: false, code: 'unsupported_format',
                error: `Unsupported model format. Accepts: ${SUPPORTED_INPUT_FORMATS.join(', ')}`,
            };
        }

        const backend = preferredBackend
            ? { id: preferredBackend, ...BACKENDS[preferredBackend]?.detect?.() }
            : this.getActiveBackend();

        if (!backend || !backend.available) {
            log.warn(`Slice requested but no backend available (model=${job.modelName})`);
            return {
                ok: false,
                code: 'no_backend',
                error: backend
                    ? `Backend "${backend.id}" is not available: ${backend.reason}`
                    : 'No slicing backend is configured yet. ' +
                      'Configure a companion agent or set SLICER_CLI_PATH to an OrcaSlicer CLI.',
                report: { backends: this.getBackends() },
            };
        }

        log.info(`Slice job: backend=${backend.id}, model=${job.modelName} (${job.modelBuffer.length} bytes)`);

        try {
            // Phase 0 lands here: dispatch to the concrete backend runner.
            // The CLI runner is stubbed until the engine spike is wired up.
            const result = await this._dispatch(backend.id, job);
            return { ...result, report: { ...(result.report || {}), backend: backend.id, durationMs: Date.now() - started } };
        } catch (err) {
            log.error(`Slice failed (${backend.id}): ${err.message}`);
            return { ok: false, code: 'engine_error', error: err.message, report: { backend: backend.id } };
        }
    },

    /** @private route to a concrete backend implementation. */
    async _dispatch(backendId, job) {
        switch (backendId) {
            case 'pi-cli':
            case 'local-agent':
                return this._runCli(job);
            default:
                return { ok: false, code: 'not_implemented', error: `Backend "${backendId}" has no runner yet` };
        }
    },

    /**
     * @private Run OrcaSlicer headless and wrap the result into a `.gcode.3mf`.
     *
     * NOTE: this build's `--export-3mf` segfaults headless, so we slice with
     * `--outputdir` (reliable: emits Metadata-less `plate_N.gcode`) and build the
     * `.gcode.3mf` ourselves via buildGcode3mf(). `--orient` is intentionally
     * omitted (heavy, and we don't want auto-reorientation of functional parts).
     */
    async _runCli(job) {
        const engine = detectCliEngine();
        if (!engine) return { ok: false, code: 'no_backend', error: 'No CLI engine found' };

        const model = (job.options?.printer_model) || job.profile?.printer_model || 'P1S';
        const preset = ORCA_PRESETS[model] || ORCA_PRESETS.P1S;

        const machineJson = path.join(ORCA_RESOURCES, 'machine', `${preset.machine}.json`);
        const processJson = path.join(ORCA_RESOURCES, 'process', `${preset.process}.json`);
        const filamentJson = path.join(ORCA_RESOURCES, 'filament', `${preset.filament}.json`);
        for (const [label, f] of [['machine', machineJson], ['process', processJson], ['filament', filamentJson]]) {
            if (!fs.existsSync(f)) {
                return { ok: false, code: 'preset_missing', error: `Slicer ${label} preset not found: ${f}` };
            }
        }

        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-slice-'));
        const ext = (job.modelName.split('.').pop() || 'stl').toLowerCase();
        const modelPath = path.join(work, `input.${ext}`);
        fs.writeFileSync(modelPath, job.modelBuffer);

        // Apply user print-setting overrides by deriving copies of the process /
        // filament presets (the CLI loads whichever path we point it at).
        const ov = orcaOverrides(job.options?.settings);
        let processArg = processJson, filamentArg = filamentJson;
        if (Object.keys(ov.process).length) processArg = writeDerivedPreset(processJson, ov.process, path.join(work, 'process.json'));
        if (Object.keys(ov.filament).length) filamentArg = writeDerivedPreset(filamentJson, ov.filament, path.join(work, 'filament.json'));
        const appliedSettings = { ...ov.process, ...ov.filament };
        if (Object.keys(appliedSettings).length) log.info(`Slice overrides: ${JSON.stringify(appliedSettings)}`);

        const args = [
            modelPath,
            '--load-settings', `${machineJson};${processArg}`,
            '--load-filaments', filamentArg,
            '--arrange', '1', '--ensure-on-bed',
            '--slice', '0',
            '--outputdir', work,
        ];

        try {
            const { stdout } = await runProcess(engine.path, args, { cwd: undefined, timeoutMs: 180000 });

            // Collect plate gcodes produced in the output dir.
            const plates = fs.readdirSync(work)
                .map(f => ({ f, m: /^plate_(\d+)\.gcode$/i.exec(f) }))
                .filter(x => x.m)
                .map(x => ({ index: parseInt(x.m[1], 10), gcode: fs.readFileSync(path.join(work, x.f), 'utf-8') }))
                .sort((a, b) => a.index - b.index);

            if (!plates.length) {
                const tail = (stdout || '').split('\n').slice(-4).join(' ');
                return { ok: false, code: 'no_output', error: `Slicer produced no plate gcode. ${tail}` };
            }

            const gcode3mf = buildGcode3mf(plates, { printerModelId: preset.modelId, clientVersion: engine.label });
            const base = job.modelName.replace(/\.[^.]+$/, '');
            return {
                ok: true,
                gcode3mf,
                outputName: `${base}.gcode.3mf`,
                report: { engine: engine.label, plates: plates.length, printerModel: model, settings: appliedSettings },
            };
        } finally {
            try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
        }
    },
};

/** Promise wrapper around execFile with output capture. */
function runProcess(exe, args, { cwd, timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
        execFile(exe, args, { cwd, timeout: timeoutMs, maxBuffer: 128 * 1024 * 1024, windowsHide: true },
            (err, stdout, stderr) => {
                // OrcaSlicer can exit non-zero even on a usable slice; the caller
                // decides success by whether plate gcode was produced.
                if (err && !stdout && !stderr) return reject(err);
                resolve({ stdout: stdout?.toString() || '', stderr: stderr?.toString() || '', err });
            });
    });
}

export default SliceService;
