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
import { buildPlain3mf, buildBambuProject3mf } from '../gcode/Model3mf.js';
import { normalizeModel } from '../models/PrinterModels.js';

/** Build volume for a slicer model key, from the canonical registry. */
function bedFor(model) {
    return normalizeModel(model)?.bed || { x: 256, y: 256, z: 256 };
}

const log = createLogger('SliceService');

// Default OrcaSlicer install locations probed when SLICER_CLI_PATH is unset.
const DEFAULT_CLI_CANDIDATES = [
    'C:\\Program Files\\OrcaSlicer\\orca-slicer.exe',
    'C:\\Program Files (x86)\\OrcaSlicer\\orca-slicer.exe',
    '/usr/bin/orca-slicer',
    '/usr/local/bin/orca-slicer',
    '/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer',
];

/**
 * Locate the engine's bundled BBL profiles. Portable: derived from wherever the
 * detected CLI binary lives (Windows: resources/ next to the exe; macOS:
 * ../Resources inside the .app), overridable with ORCA_RESOURCES.
 */
function resolveResourcesDir(enginePath) {
    const candidates = [
        process.env.ORCA_RESOURCES,
        enginePath && path.join(path.dirname(enginePath), 'resources', 'profiles', 'BBL'),
        enginePath && path.join(path.dirname(enginePath), '..', 'Resources', 'profiles', 'BBL'),
        enginePath && path.join(path.dirname(enginePath), '..', 'resources', 'profiles', 'BBL'),
        '/usr/share/OrcaSlicer/profiles/BBL',
    ].filter(Boolean);
    for (const c of candidates) {
        try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
    }
    return null;
}

// printer model -> bundled machine/process/filament preset basenames.
// (P1S verified working; P1S/X1 share the X1C 0.4-nozzle process+filament.)
const ORCA_PRESETS = {
    P1S: { machine: 'Bambu Lab P1S 0.4 nozzle', process: '0.20mm Standard @BBL X1C', filament: 'Bambu PLA Basic @BBL X1C', modelId: 'C12' },
    X1: { machine: 'Bambu Lab X1 Carbon 0.4 nozzle', process: '0.20mm Standard @BBL X1C', filament: 'Bambu PLA Basic @BBL X1C', modelId: 'BL-P001' },
    // modelId = Bambu printer_model_id written into slice_info.config.
    // Ground truth from Studio-sliced files: A1 = N2S, A1 mini = N1. These
    // were WRONG until 2026-07-13 (A1 stamped as N1 = A1 mini) — invisible
    // until the file↔printer start guard began reading them.
    A1: { machine: 'Bambu Lab A1 0.4 nozzle', process: '0.20mm Standard @BBL A1', filament: 'Bambu PLA Basic @BBL A1', modelId: 'N2S' },
    A1_MINI: { machine: 'Bambu Lab A1 mini 0.4 nozzle', process: '0.20mm Standard @BBL A1M', filament: 'Bambu PLA Basic @BBL A1M', modelId: 'N1' },
    // 2026 lineup: presets exist in current OrcaSlicer BBL bundles; if a given
    // install is missing them, _runCli reports the missing preset path so the
    // operator can update OrcaSlicer or override ORCA_RESOURCES. The modelIds
    // are best-effort (unverified against Studio-sliced files) — unknown ids
    // resolve to null in modelFromSliceInfoId, so the start-time model guard
    // simply skips rather than misfiring.
    P2S: { machine: 'Bambu Lab P2S 0.4 nozzle', process: '0.20mm Standard @BBL P2S', filament: 'Bambu PLA Basic @BBL P2S', modelId: 'C14' },
    X2D: { machine: 'Bambu Lab X2D 0.4 nozzle', process: '0.20mm Standard @BBL X2D', filament: 'Bambu PLA Basic @BBL X2D', modelId: 'X2D' },
    H2D: { machine: 'Bambu Lab H2D 0.4 nozzle', process: '0.20mm Standard @BBL H2D', filament: 'Bambu PLA Basic @BBL H2D', modelId: 'H2D' },
    A2L: { machine: 'Bambu Lab A2L 0.4 nozzle', process: '0.20mm Standard @BBL A2L', filament: 'Bambu PLA Basic @BBL A2L', modelId: 'A2L' },
};

// Material -> bundled Bambu/Generic filament preset candidates (first existing
// file wins). The material's preset carries the engine-blessed temps/speeds —
// we never hand-roll material behavior. P1S mostly uses the X1C presets.
const MODEL_FILAMENT_SUFFIX = {
    P1S: ['P1S', 'X1C'], X1: ['X1C'], A1: ['A1'], A1_MINI: ['A1M', 'A1'],
    // 2026 models: prefer their own bundled suffix, fall back to the closest
    // proven family (CoreXY → X1C temps, bedslinger → A1).
    P2S: ['P2S', 'P1S', 'X1C'], X2D: ['X2D', 'X1C'], H2D: ['H2D', 'X1C'], A2L: ['A2L', 'A1'],
};
const MATERIAL_PRESETS = {
    PLA: ['Bambu PLA Basic @BBL {S}', 'Generic PLA @BBL {S}'],
    PETG: ['Bambu PETG Basic @BBL {S}', 'Bambu PETG HF @BBL {S}', 'Generic PETG @BBL {S}'],
    ABS: ['Bambu ABS @BBL {S}', 'Generic ABS @BBL {S}'],
    TPU: ['Bambu TPU 95A @BBL {S}', 'Generic TPU @BBL {S}'],
    PC: ['Bambu PC @BBL {S}', 'Generic PC @BBL {S}'],
};
export const SLICER_MATERIALS = Object.keys(MATERIAL_PRESETS);

/**
 * Adjust the post-ABL z-trim for third-party build plates. Bambu's start
 * gcode compensates exactly -0.02mm for THEIR textured PEI (nozzle homes on
 * the texture peaks); plates with deeper texture need the nozzle closer or
 * the first layer floats and never adheres. `offset` (mm, negative = closer)
 * is ADDED to the bed-type trim when one exists, else injected before the
 * first layer. Total trim is clamped to ±0.3mm.
 */
function applyPlateZOffset(gcode, offset) {
    if (!offset) return gcode;
    const trimRe = /^(G29\.1 Z)(-?[\d.]+)( ; for Textured PEI Plate.*)$/m;
    const m = gcode.match(trimRe);
    if (m) {
        const total = Math.max(-0.3, Math.min(0.3, parseFloat(m[2]) + offset));
        return gcode.replace(trimRe, `$1${total.toFixed(3)} ; bed-type trim ${m[2]} + plate offset ${offset} (3DFLOW)`);
    }
    // Other bed types emit no trim line — inject one after ABL, right before
    // the first layer starts.
    const anchor = gcode.indexOf('; CHANGE_LAYER');
    if (anchor === -1) { log.warn('plate_z_offset: no CHANGE_LAYER anchor found — offset NOT applied'); return gcode; }
    const clamped = Math.max(-0.3, Math.min(0.3, offset));
    return gcode.slice(0, anchor) + `G29.1 Z${clamped.toFixed(3)} ; plate offset (3DFLOW)\n` + gcode.slice(anchor);
}

function resolveFilamentPreset(resourcesDir, model, material) {
    const mat = String(material || 'PLA').toUpperCase();
    const candidates = MATERIAL_PRESETS[mat];
    if (!candidates) return { error: `Unknown material "${material}". Supported: ${SLICER_MATERIALS.join(', ')}` };
    for (const sfx of (MODEL_FILAMENT_SUFFIX[model] || ['X1C'])) {
        for (const c of candidates) {
            const f = path.join(resourcesDir, 'filament', `${c.replace('{S}', sfx)}.json`);
            if (fs.existsSync(f)) return { file: f };
        }
    }
    return { error: `No bundled ${mat} filament preset found for ${model} — update OrcaSlicer or pick another material.` };
}

// Declarative settings schema (SLICER_FEATURES_DIRECTIVE §3): each field maps a
// UI control straight onto an OrcaSlicer JSON key, verified against the presets
// bundled with the installed engine. The UI leaves fields blank to mean "use the
// preset default" — only explicitly-set values are written into the derived
// process/filament JSONs. The ENGINE applies every one of these during slicing;
// we never implement a setting's effect ourselves.
//   type: 'number' | 'int' | 'percent' ("NN%") | 'bool' ('1'/'0') | 'select'
//   target: 'process' | 'filament' (filament values are wrapped in arrays)
export const SLICER_SETTING_FIELDS = [
    // --- Quality ---
    { key: 'layer_height', label: 'Layer height', unit: 'mm', type: 'number', min: 0.04, max: 0.6, step: 0.02, group: 'Quality', target: 'process' },
    { key: 'initial_layer_print_height', label: 'First layer height', unit: 'mm', type: 'number', min: 0.08, max: 0.6, step: 0.02, group: 'Quality', target: 'process' },
    { key: 'line_width', label: 'Line width', unit: 'mm', type: 'number', min: 0.2, max: 1.2, step: 0.02, group: 'Quality', target: 'process' },
    { key: 'outer_wall_line_width', label: 'Outer wall line width', unit: 'mm', type: 'number', min: 0.2, max: 1.2, step: 0.02, group: 'Quality', target: 'process' },
    { key: 'seam_position', label: 'Seam position', type: 'select', options: ['nearest', 'aligned', 'back', 'random'], group: 'Quality', target: 'process' },
    { key: 'wall_generator', label: 'Wall generator', type: 'select', options: ['classic', 'arachne'], group: 'Quality', target: 'process' },
    { key: 'top_surface_pattern', label: 'Top surface pattern', type: 'select', options: ['monotonic', 'monotonicline', 'alignedrectilinear', 'concentric', 'rectilinear', 'hilbertcurve'], group: 'Quality', target: 'process' },
    { key: 'bottom_surface_pattern', label: 'Bottom surface pattern', type: 'select', options: ['monotonic', 'monotonicline', 'alignedrectilinear', 'concentric', 'rectilinear'], group: 'Quality', target: 'process' },
    { key: 'ironing_type', label: 'Ironing', type: 'select', options: ['no ironing', 'top', 'topmost', 'solid'], group: 'Quality', target: 'process' },
    { key: 'fuzzy_skin', label: 'Fuzzy skin', type: 'select', options: ['none', 'external', 'all'], group: 'Quality', target: 'process' },
    { key: 'fuzzy_skin_thickness', label: 'Fuzzy skin thickness', unit: 'mm', type: 'number', min: 0.1, max: 1, step: 0.05, group: 'Quality', target: 'process' },
    { key: 'xy_hole_compensation', label: 'X-Y hole compensation', unit: 'mm', type: 'number', min: -2, max: 2, step: 0.01, group: 'Quality', target: 'process' },
    { key: 'xy_contour_compensation', label: 'X-Y contour compensation', unit: 'mm', type: 'number', min: -2, max: 2, step: 0.01, group: 'Quality', target: 'process' },
    // --- Strength ---
    { key: 'wall_loops', label: 'Wall loops', type: 'int', min: 1, max: 20, step: 1, group: 'Strength', target: 'process' },
    { key: 'top_shell_layers', label: 'Top shell layers', type: 'int', min: 0, max: 30, step: 1, group: 'Strength', target: 'process' },
    { key: 'bottom_shell_layers', label: 'Bottom shell layers', type: 'int', min: 0, max: 30, step: 1, group: 'Strength', target: 'process' },
    { key: 'sparse_infill_density', label: 'Infill density', unit: '%', type: 'percent', min: 0, max: 100, step: 5, group: 'Strength', target: 'process' },
    { key: 'sparse_infill_pattern', label: 'Infill pattern', type: 'select', options: ['grid', 'gyroid', 'honeycomb', 'cubic', 'adaptivecubic', 'crosshatch', 'line', 'concentric', 'rectilinear', 'triangles', 'tri-hexagon', 'lightning'], group: 'Strength', target: 'process' },
    { key: 'infill_direction', label: 'Infill direction', unit: '°', type: 'number', min: 0, max: 359, step: 1, group: 'Strength', target: 'process' },
    { key: 'infill_wall_overlap', label: 'Infill/wall overlap', unit: '%', type: 'percent', min: 0, max: 100, step: 1, group: 'Strength', target: 'process' },
    // --- Speed ---
    { key: 'outer_wall_speed', label: 'Outer wall speed', unit: 'mm/s', type: 'number', min: 10, max: 600, step: 5, group: 'Speed', target: 'process' },
    { key: 'inner_wall_speed', label: 'Inner wall speed', unit: 'mm/s', type: 'number', min: 10, max: 600, step: 5, group: 'Speed', target: 'process' },
    { key: 'sparse_infill_speed', label: 'Infill speed', unit: 'mm/s', type: 'number', min: 10, max: 600, step: 5, group: 'Speed', target: 'process' },
    { key: 'initial_layer_speed', label: 'First layer speed', unit: 'mm/s', type: 'number', min: 5, max: 200, step: 5, group: 'Speed', target: 'process' },
    { key: 'travel_speed', label: 'Travel speed', unit: 'mm/s', type: 'number', min: 50, max: 1000, step: 10, group: 'Speed', target: 'process' },
    { key: 'bridge_speed', label: 'Bridge speed', unit: 'mm/s', type: 'number', min: 5, max: 300, step: 5, group: 'Speed', target: 'process' },
    { key: 'default_acceleration', label: 'Default acceleration', unit: 'mm/s²', type: 'number', min: 100, max: 20000, step: 100, group: 'Speed', target: 'process' },
    // --- Support ---
    { key: 'enable_support', label: 'Enable supports', type: 'bool', group: 'Support', target: 'process' },
    { key: 'support_type', label: 'Support type', type: 'select', options: ['normal(auto)', 'tree(auto)', 'normal(manual)', 'tree(manual)'], group: 'Support', target: 'process' },
    { key: 'support_threshold_angle', label: 'Threshold angle', unit: '°', type: 'int', min: 0, max: 90, step: 1, group: 'Support', target: 'process' },
    { key: 'support_top_z_distance', label: 'Top Z distance', unit: 'mm', type: 'number', min: 0, max: 1, step: 0.05, group: 'Support', target: 'process' },
    { key: 'support_base_pattern', label: 'Base pattern', type: 'select', options: ['default', 'rectilinear', 'rectilinear-grid', 'honeycomb', 'lightning', 'hollow'], group: 'Support', target: 'process' },
    { key: 'support_interface_top_layers', label: 'Interface top layers', type: 'int', min: 0, max: 10, step: 1, group: 'Support', target: 'process' },
    { key: 'raft_layers', label: 'Raft layers', type: 'int', min: 0, max: 10, step: 1, group: 'Support', target: 'process' },
    // --- Adhesion / Others ---
    { key: 'curr_bed_type', label: 'Build plate', type: 'select', options: ['Textured PEI Plate', 'Cool Plate', 'Hot Plate', 'Cool Plate (SuperTack)'], group: 'Adhesion', target: 'process' },
    // NOT an engine key — applied by us to the sliced gcode's post-ABL z-trim.
    // Third-party textured plates often have deeper texture than Bambu's; the
    // stock -0.02 trim leaves the nozzle riding the peaks and the first layer
    // never sticks (root cause of the 2026-07-14 adhesion failures).
    { key: 'plate_z_offset', label: 'Plate Z offset (− = nozzle closer; for 3rd-party plates)', unit: 'mm', type: 'number', min: -0.2, max: 0.2, step: 0.01, group: 'Adhesion', target: 'process' },
    { key: 'enable_prime_tower', label: 'Prime tower (multi-color)', type: 'bool', group: 'Adhesion', target: 'process' },
    { key: 'brim_type', label: 'Brim type', type: 'select', options: ['no_brim', 'outer_only', 'inner_only', 'outer_and_inner', 'auto_brim'], group: 'Adhesion', target: 'process' },
    { key: 'brim_width', label: 'Brim width', unit: 'mm', type: 'number', min: 0, max: 30, step: 1, group: 'Adhesion', target: 'process' },
    { key: 'skirt_loops', label: 'Skirt loops', type: 'int', min: 0, max: 10, step: 1, group: 'Adhesion', target: 'process' },
    { key: 'skirt_distance', label: 'Skirt distance', unit: 'mm', type: 'number', min: 0, max: 20, step: 1, group: 'Adhesion', target: 'process' },
    { key: 'print_sequence', label: 'Print sequence', type: 'select', options: ['by layer', 'by object'], group: 'Adhesion', target: 'process' },
    // --- Filament ---
    { key: 'nozzle_temperature', label: 'Nozzle temp', unit: '°C', type: 'int', min: 160, max: 320, step: 5, group: 'Filament', target: 'filament' },
    { key: 'nozzle_temperature_initial_layer', label: 'Nozzle temp (1st layer)', unit: '°C', type: 'int', min: 160, max: 320, step: 5, group: 'Filament', target: 'filament' },
    { key: 'hot_plate_temp', label: 'Bed temp (hot plate)', unit: '°C', type: 'int', min: 0, max: 120, step: 5, group: 'Filament', target: 'filament' },
    { key: 'hot_plate_temp_initial_layer', label: 'Bed temp 1st layer', unit: '°C', type: 'int', min: 0, max: 120, step: 5, group: 'Filament', target: 'filament' },
    { key: 'textured_plate_temp', label: 'Bed temp (textured)', unit: '°C', type: 'int', min: 0, max: 120, step: 5, group: 'Filament', target: 'filament' },
    { key: 'filament_flow_ratio', label: 'Flow ratio', type: 'number', min: 0.5, max: 1.5, step: 0.01, group: 'Filament', target: 'filament' },
    { key: 'filament_max_volumetric_speed', label: 'Max volumetric speed', unit: 'mm³/s', type: 'number', min: 1, max: 40, step: 0.5, group: 'Filament', target: 'filament' },
    { key: 'fan_min_speed', label: 'Fan min', unit: '%', type: 'int', min: 0, max: 100, step: 5, group: 'Filament', target: 'filament' },
    { key: 'fan_max_speed', label: 'Fan max', unit: '%', type: 'int', min: 0, max: 100, step: 5, group: 'Filament', target: 'filament' },
    { key: 'slow_down_layer_time', label: 'Min layer time', unit: 's', type: 'int', min: 0, max: 60, step: 1, group: 'Filament', target: 'filament' },
    { key: 'slow_down_min_speed', label: 'Min print speed', unit: 'mm/s', type: 'number', min: 5, max: 100, step: 1, group: 'Filament', target: 'filament' },
    { key: 'enable_pressure_advance', label: 'Enable pressure advance', type: 'bool', group: 'Filament', target: 'filament' },
    { key: 'pressure_advance', label: 'Pressure advance', type: 'number', min: 0, max: 2, step: 0.002, group: 'Filament', target: 'filament' },
    { key: 'filament_retraction_length', label: 'Retraction length', unit: 'mm', type: 'number', min: 0, max: 10, step: 0.1, group: 'Filament', target: 'filament' },
    { key: 'close_fan_the_first_x_layers', label: 'No fan for first N layers', type: 'int', min: 0, max: 10, step: 1, group: 'Filament', target: 'filament' },
    { key: 'overhang_fan_speed', label: 'Overhang fan', unit: '%', type: 'int', min: 0, max: 100, step: 5, group: 'Filament', target: 'filament' },
    { key: 'additional_cooling_fan_speed', label: 'Aux fan', unit: '%', type: 'int', min: 0, max: 100, step: 5, group: 'Filament', target: 'filament' },
];

/**
 * Translate UI settings into OrcaSlicer process/filament JSON overrides,
 * driven entirely by SLICER_SETTING_FIELDS. Blank/absent values are skipped
 * (they fall through to the loaded preset), so a slice with no edits is
 * byte-identical to the preset default.
 */
function orcaOverrides(settings = {}) {
    const process = {}, filament = {};
    for (const f of SLICER_SETTING_FIELDS) {
        const raw = settings[f.key];
        if (raw == null || raw === '' || raw === 'default') continue;
        let val;
        switch (f.type) {
            case 'percent': val = `${Math.round(Number.parseFloat(raw))}%`; break;
            case 'int': val = String(Math.round(Number.parseFloat(raw))); break;
            case 'number': val = String(Number.parseFloat(raw)); break;
            case 'bool': val = (raw === true || raw === 'true' || raw === '1' || raw === 'on') ? '1' : '0'; break;
            default: val = String(raw);
        }
        if (val === 'NaN') continue;
        const bucket = f.target === 'filament' ? filament : process;
        bucket[f.key] = f.target === 'filament' ? [val] : val;
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

// Non-config metadata keys in bundled preset JSONs — everything else is a
// real config value the engine would apply via --load-settings.
const PRESET_META_KEYS = new Set([
    'name', 'inherits', 'from', 'setting_id', 'instantiation', 'type',
    'is_custom_defined', 'version', 'url', 'description',
    'compatible_printers', 'compatible_printers_condition',
    'print_settings_id', 'printer_settings_id', 'filament_settings_id',
]);

/**
 * Fully resolve a bundled preset's `inherits` chain (child wins) and strip
 * preset metadata, leaving only real config key/values. Used to bake machine
 * and process settings INTO a project 3MF's project_settings.config: loading
 * them via --load-settings would make the CLI invalidate the project's plate
 * and re-center all content, destroying the user's placement (verified
 * empirically 2026-07-03 — see buildBambuProject3mf).
 */
function resolvePresetConfig(presetPath) {
    const dir = path.dirname(presetPath);
    const chain = [];
    let cur = presetPath;
    const seen = new Set();
    while (cur) {
        if (seen.has(cur)) throw new Error(`Preset inherits cycle at ${cur}`);
        seen.add(cur);
        const json = JSON.parse(fs.readFileSync(cur, 'utf-8'));
        chain.push(json);
        if (json.inherits) {
            cur = path.join(dir, `${json.inherits}.json`);
            if (!fs.existsSync(cur)) throw new Error(`Preset parent not found: ${cur} (inherited by ${chain[chain.length - 1].name})`);
        } else {
            cur = null;
        }
    }
    const merged = {};
    for (const json of chain.reverse()) Object.assign(merged, json); // root first, leaf wins
    for (const k of Object.keys(merged)) if (PRESET_META_KEYS.has(k)) delete merged[k];
    return merged;
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

        if (!job?.modelBuffer?.length && !job?.modelBuffers?.length) {
            return { ok: false, code: 'no_model', error: 'No model data supplied' };
        }
        if (!job.modelBuffers?.length && !this.isSupportedInput(job.modelName)) {
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

        const inputDesc = job.modelBuffers?.length
            ? `${job.modelBuffers.length} placed object(s)`
            : `${job.modelBuffer.length} bytes`;
        log.info(`Slice job: backend=${backend.id}, model=${job.modelName} (${inputDesc})`);

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

        const resourcesDir = resolveResourcesDir(engine.path);
        if (!resourcesDir) {
            return {
                ok: false, code: 'preset_missing',
                error: `Could not locate the slicer's bundled profiles next to ${engine.path}. ` +
                    `Set ORCA_RESOURCES to the engine's resources/profiles/BBL directory.`,
            };
        }
        const machineJson = path.join(resourcesDir, 'machine', `${preset.machine}.json`);
        const processJson = path.join(resourcesDir, 'process', `${preset.process}.json`);
        // Material comes from the UI (defaults to PLA) and picks the bundled
        // Bambu/Generic preset for this printer model.
        const material = String(job.options?.material || 'PLA').toUpperCase();
        const filamentResolved = resolveFilamentPreset(resourcesDir, model, material);
        if (filamentResolved.error) return { ok: false, code: 'preset_missing', error: filamentResolved.error };
        const filamentJson = filamentResolved.file;
        for (const [label, f] of [['machine', machineJson], ['process', processJson], ['filament', filamentJson]]) {
            if (!fs.existsSync(f)) {
                return { ok: false, code: 'preset_missing', error: `Slicer ${label} preset not found: ${f}` };
            }
        }

        const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-slice-'));

        // Input handling (DIRECTIVE §1/§6): when the browser sends pre-placed
        // geometry (one baked STL per object, printer coords), we assemble a
        // plain 3MF and slice with --arrange 0 so the engine slices EXACTLY the
        // user's layout — the engine must never re-arrange manual placement.
        // Legacy single unplaced model files keep --arrange 1 (engine placement).
        // Per-object filament slots (DIRECTIVE §5, 1-based; default all slot 1).
        const filaments = (job.modelBuffers || []).map((b, i) =>
            Math.max(1, Math.round(job.options?.filaments?.[i] || b.filament || 1)));
        const maxFilament = filaments.length ? Math.max(...filaments) : 1;

        // Apply user print-setting overrides. For the plain/legacy paths they
        // become derived preset JSONs the CLI loads; for the multi-material
        // PROJECT path they are baked into project_settings.config instead
        // (see below — --load-settings would destroy placement).
        // Compat: the cloud print-source path spreads settings at the TOP level
        // of options (not under options.settings) — accept known setting keys
        // from either place so merchant-supplied settings actually apply.
        const settingsIn = { ...(job.options?.settings || {}) };
        for (const f of SLICER_SETTING_FIELDS) {
            if (settingsIn[f.key] == null && job.options?.[f.key] != null) settingsIn[f.key] = job.options[f.key];
        }
        const ov = orcaOverrides(settingsIn);
        // (The multi-material wipe tower is pinned bed-aware inside
        // buildBambuProject3mf — its project config always wins on that path.)

        // Build plate: `curr_bed_type` is NOT a preset key — it rides on its
        // own CLI flag. Default is Textured PEI for EVERY material: the farm's
        // printers all run textured PEI sheets, and the engine's own default
        // (Cool Plate) sets a 35°C bed for PLA — on textured PEI that means no
        // first-layer adhesion and spaghetti prints (root cause of the
        // 2026-07-13 "completely messed up" Deluxe case prints; the known-good
        // Studio-sliced files all say Textured PEI / M190 S65). The Build
        // plate setting in the Adhesion group still overrides.
        let bedType = settingsIn.curr_bed_type || 'Textured PEI Plate';
        delete ov.process.curr_bed_type; // never send it as a preset key

        // Plate Z offset: OUR post-slice adjustment of the gcode's post-ABL
        // z-trim (see applyPlateZOffset) — never an engine preset key.
        let plateZOffset = parseFloat(settingsIn.plate_z_offset);
        if (!Number.isFinite(plateZOffset)) plateZOffset = 0;
        plateZOffset = Math.max(-0.2, Math.min(0.2, plateZOffset));
        delete ov.process.plate_z_offset;

        // Merge grouping (Bambu Studio "merge" equivalent): buffers sharing a
        // group key become ONE object with multiple parts. Required whenever
        // parts touch/overlap (e.g. text sunk into a model) — overlapping
        // SEPARATE objects abort the CLI — so merged plates take the project
        // path even when single-color.
        const groups = job.options?.groups || [];
        const hasMerge = groups.length > 0 && new Set(groups).size < groups.length;
        const isProjectMulti = Boolean(job.modelBuffers?.length && (maxFilament > 1 || hasMerge));
        let modelPaths, arrange;
        if (isProjectMulti) {
            // MULTI-MATERIAL: build a full Bambu PROJECT 3MF from the verified
            // GUI-exported template (per-object/per-part extruder + plate
            // instances + complete config). Machine + process preset values are
            // RESOLVED HERE and baked into project_settings.config — loading
            // them via --load-settings makes the CLI invalidate the plate and
            // re-center all content, losing user placement (verified
            // 2026-07-03). Only filaments are still loaded via CLI (that path
            // keeps placement). The result is checked after slicing — never
            // assume.
            const overlay = {
                ...resolvePresetConfig(machineJson),
                ...resolvePresetConfig(processJson),
                ...ov.process,
            };
            // Prime tower: the A1 family purges through the chute, so
            // multi-color does NOT need a tower there — default OFF (big
            // time/filament save on looped jobs). P1S/X1 flush INTO the
            // tower — keep it. Explicit user setting always wins.
            if (ov.process.enable_prime_tower == null) {
                overlay.enable_prime_tower = (model === 'A1' || model === 'A1_MINI') ? '0' : '1';
            }
            // Within one object the LATER part wins the shared volume — text
            // parts come after their base, so the text shows through.
            const grouped = new Map();
            job.modelBuffers.forEach((b, i) => {
                const key = groups[i] ?? b.group ?? `__solo_${i}`;
                if (!grouped.has(key)) grouped.set(key, { name: b.name, parts: [] });
                grouped.get(key).parts.push({ name: b.name, stl: b.buffer, filament: filaments[i] });
            });
            const bed = bedFor(model);
            let project;
            try {
                project = buildBambuProject3mf([...grouped.values()], job.options?.colors || [], bed, overlay);
            } catch (err) {
                try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
                return { ok: false, code: 'bad_plate', error: err.message };
            }
            const p = path.join(work, 'input.3mf');
            fs.writeFileSync(p, project);
            modelPaths = [p];
            arrange = '0';
        } else if (job.modelBuffers?.length) {
            const input3mf = buildPlain3mf(job.modelBuffers.map(b => ({ name: b.name, stl: b.buffer })), bedFor(model));
            const p = path.join(work, 'input.3mf');
            fs.writeFileSync(p, input3mf);
            modelPaths = [p];
            arrange = '0';
        } else {
            const ext = (job.modelName.split('.').pop() || 'stl').toLowerCase();
            const p = path.join(work, `input.${ext}`);
            fs.writeFileSync(p, job.modelBuffer);
            modelPaths = [p];
            arrange = '1';
        }
        // Explicit caller override wins (options.arrange: true/false).
        if (job.options?.arrange === true) arrange = '1';
        if (job.options?.arrange === false) arrange = '0';

        // The CLI does NOT resolve `inherits` for FILE-loaded presets — a PETG
        // leaf sliced with filament_type=PLA because the type lives two parents
        // up the chain (verified empirically). Always hand it fully-RESOLVED
        // flat copies (chain merged by resolvePresetConfig + user overrides).
        const writeResolvedPreset = (presetPath, type, overrides, outPath) => {
            const flat = { ...resolvePresetConfig(presetPath), ...overrides };
            const leaf = JSON.parse(fs.readFileSync(presetPath, 'utf-8'));
            flat.name = path.basename(presetPath, '.json');
            flat.type = type;
            flat.from = 'system'; // loader rejects files without a known `from`
            flat.instantiation = 'true';
            // compatibility metadata must survive — without it the process is
            // treated as incompatible with the machine and the CLI refuses
            for (const k of ['compatible_printers', 'compatible_printers_condition', 'setting_id']) {
                if (leaf[k] !== undefined) flat[k] = leaf[k];
            }
            fs.writeFileSync(outPath, JSON.stringify(flat, null, 1));
            return outPath;
        };
        let machineArg = machineJson, processArg = processJson;
        if (!isProjectMulti) {
            machineArg = writeResolvedPreset(machineJson, 'machine', {}, path.join(work, 'machine.json'));
            processArg = writeResolvedPreset(processJson, 'process', ov.process, path.join(work, 'process.json'));
        }
        const filamentArg = writeResolvedPreset(filamentJson, 'filament', ov.filament, path.join(work, 'filament.json'));
        const appliedSettings = { ...ov.process, ...ov.filament };
        if (Object.keys(appliedSettings).length) log.info(`Slice overrides: ${JSON.stringify(appliedSettings)}`);

        // Multi-material loads one filament preset per slot. The copies must be
        // UNIQUELY NAMED (the engine dedups same-name presets down to one) —
        // physical color still comes from the AMS mapping at print time.
        let filamentList = filamentArg;
        if (maxFilament > 1) {
            const baseFil = JSON.parse(fs.readFileSync(filamentArg, 'utf-8'));
            const copies = [];
            for (let k = 1; k <= maxFilament; k++) {
                const copy = { ...baseFil, name: `${baseFil.name} S${k}` };
                delete copy.setting_id;
                const colorHex = job.options?.colors?.[k - 1];
                if (colorHex) copy.default_filament_colour = [colorHex];
                const p = path.join(work, `filament_s${k}.json`);
                fs.writeFileSync(p, JSON.stringify(copy, null, 1));
                copies.push(p);
            }
            filamentList = copies.join(';');
        }
        // Project path: NO --load-settings (machine/process are baked into the
        // 3MF — loading them re-centers the plate and loses placement) and no
        // --ensure-on-bed (browser geometry is already baked on-bed; the flag
        // belongs to the preset-loading plate check).
        const args = isProjectMulti
            ? [
                ...modelPaths,
                '--load-filaments', filamentList,
                '--allow-newer-file',
                ...(bedType ? ['--curr-bed-type', bedType] : []),
                '--arrange', arrange,
                '--slice', '0',
                '--outputdir', work,
            ]
            : [
                ...modelPaths,
                '--load-settings', `${machineArg};${processArg}`,
                '--load-filaments', filamentList,
                '--allow-newer-file',
                ...(bedType ? ['--curr-bed-type', bedType] : []),
                '--arrange', arrange, '--ensure-on-bed',
                '--slice', '0',
                '--outputdir', work,
            ];

        try {
            const collectPlates = () => fs.readdirSync(work)
                .map(f => ({ f, m: /^plate_(\d+)\.gcode$/i.exec(f) }))
                .filter(x => x.m)
                .map(x => ({ index: parseInt(x.m[1], 10), gcode: fs.readFileSync(path.join(work, x.f), 'utf-8') }))
                .filter(p => p.gcode.includes('EXECUTABLE_BLOCK_END') || (log.error(`plate_${p.index}.gcode is truncated (no end marker) — discarded`), false))
                .sort((a, b) => a.index - b.index);

            // The engine can crash on teardown (heap corruption, seen with 3+
            // filaments) — sometimes AFTER writing perfectly good plates,
            // sometimes before. Exit codes don't decide success (plates do),
            // and a pre-output crash gets ONE retry.
            let exitCode = 0, outTail = '', plates = [];
            for (let engineAttempt = 1; engineAttempt <= 2; engineAttempt++) {
                const { stdout, stderr, err } = await runProcess(engine.path, args, { cwd: undefined, timeoutMs: 180000 });
                // Windows negative exit codes come back as unsigned 32-bit
                exitCode = err?.code > 2147483647 ? err.code - 4294967296 : (err?.code ?? 0);
                outTail = ((stdout || '') + (stderr || '')).trim().split('\n').slice(-6).join(' | ');
                plates = collectPlates();
                if (plates.length || engineAttempt === 2) break;
                if (exitCode === -1073740940) {
                    log.warn(`Engine teardown crash before output (attempt ${engineAttempt}) — retrying once`);
                    continue;
                }
                break; // real failure — don't mask it with a retry
            }

            if (!plates.length || (maxFilament > 1 && exitCode !== 0)) {
                log.error(`Engine exit=${exitCode}, plates=${plates.length}, args=${JSON.stringify(args)}`);
                log.error(`Engine output tail: ${outTail || '(none)'}`);
            }

            // Multi-material must be VERIFIED, never assumed: old engine builds
            // (e.g. OrcaSlicer 1.9.x) accept --load-filament-ids but silently
            // slice everything with filament 1 (or die on the wipe tower). A
            // wrong-color print is a hard failure (DIRECTIVE §0: fail loudly).
            if (maxFilament > 1) {
                const dual = plates.length > 0 && plates.every(p => {
                    const ft = (p.gcode.match(/; filament_type = (.+)/) || [])[1] || '';
                    return ft.includes(';');
                });
                if (!dual) {
                    const hint = exitCode === -101
                        ? ' Exit -101 usually means separate objects overlap or float in mid-air — touching parts are merged automatically, so re-slice from a refreshed browser page, or move the objects apart.'
                        : ' Workaround: slice single-color and pick the spool via AMS mapping.';
                    return {
                        ok: false, code: 'engine_no_multimaterial',
                        error: `Multi-color slice did not produce filament changes ` +
                            `(${plates.length ? 'engine used filament 1 for everything' : `engine rejected the plate, exit ${exitCode}`}). ` +
                            `Engine said: ${outTail || '(no output)'}.${hint}`,
                    };
                }
            }

            if (!plates.length) {
                return { ok: false, code: 'no_output', error: `Slicer produced no plate gcode (exit ${exitCode}). ${outTail}` };
            }

            if (plateZOffset) {
                for (const p of plates) p.gcode = applyPlateZOffset(p.gcode, plateZOffset);
                log.info(`Plate Z offset ${plateZOffset}mm applied to ${plates.length} plate(s)`);
            }

            const gcode3mf = buildGcode3mf(plates, { printerModelId: preset.modelId, clientVersion: engine.label });
            const base = job.modelName.replace(/\.[^.]+$/, '');
            return {
                ok: true,
                gcode3mf,
                outputName: `${base}.gcode.3mf`,
                report: {
                    engine: engine.label, plates: plates.length, printerModel: model,
                    settings: appliedSettings, arrange: arrange === '1',
                    objects: job.modelBuffers?.length || 1,
                },
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
                // NEVER reject: OrcaSlicer can exit non-zero — or even crash on
                // teardown without flushing stdout (seen with 3+ filaments) —
                // AFTER writing perfectly good plate gcode. The caller decides
                // success by whether plate gcode was produced.
                resolve({ stdout: stdout?.toString() || '', stderr: stderr?.toString() || '', err });
            });
    });
}

export default SliceService;
