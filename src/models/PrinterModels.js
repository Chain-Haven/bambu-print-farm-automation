// src/models/PrinterModels.js — THE canonical Bambu printer model registry.
//
// Every subsystem that needs to reason about a printer model (transform
// geometry, camera transport, fleet chassis art, adoption, capabilities,
// platform strategy) should resolve the model string through this registry
// instead of keeping its own list. Model strings arrive in several shapes
// ("Bambu X1C", "X1C", "x1 carbon", automator codes like "A1_MINI"); the
// registry normalizes all of them to one record.
//
// Field reference:
//   id             stable registry id, doubles as the Automator geometry key
//   name           canonical display / DB name ("Bambu X1C")
//   short          short display name used in dropdowns ("X1C")
//   family         fleet chassis family (a1|a1mini|a2|p1|p2|x1|x2|h2)
//   strategyFamily platform-strategy family (platformStrategy.js MODEL_PROFILES)
//   camera         camera transport: 'p1' (port 6000 TLS+JPEG) | 'x1' (RTSPS 322)
//   bed            build volume in mm { x, y, z }
//   kinematics     'corexy' | 'bedslinger'
//   hasCamera      whether the stock printer ships with a usable camera
//   adoptable      offered in the cloud adopt dropdown
//   aliases        extra strings that should resolve to this model

export const PRINTER_MODELS = [
    {
        id: 'A1_MINI',
        name: 'Bambu A1 Mini',
        short: 'A1 Mini',
        family: 'a1mini',
        strategyFamily: 'a1_series',
        camera: 'p1',
        bed: { x: 180, y: 180, z: 180 },
        kinematics: 'bedslinger',
        hasCamera: true,
        adoptable: true,
        aliases: ['A1M', 'A1 MINI', 'A1-MINI', 'BAMBU LAB A1 MINI'],
    },
    {
        id: 'A1',
        name: 'Bambu A1',
        short: 'A1',
        family: 'a1',
        strategyFamily: 'a1_series',
        camera: 'p1',
        bed: { x: 256, y: 256, z: 256 },
        kinematics: 'bedslinger',
        hasCamera: true,
        adoptable: true,
        aliases: ['BAMBU LAB A1', 'A1 COMBO', 'BAMBU A1 (EARLY)'],
    },
    {
        id: 'A2L',
        name: 'Bambu A2L',
        short: 'A2L',
        family: 'a2',
        strategyFamily: 'a1_series',
        camera: 'p1',
        bed: { x: 330, y: 320, z: 325 },
        kinematics: 'bedslinger',
        hasCamera: true,
        adoptable: true,
        aliases: ['BAMBU LAB A2L', 'A2'],
    },
    {
        id: 'P1P',
        name: 'Bambu P1P',
        short: 'P1P',
        family: 'p1',
        strategyFamily: 'p1_series',
        camera: 'p1',
        bed: { x: 256, y: 256, z: 256 },
        kinematics: 'corexy',
        hasCamera: false,
        adoptable: true,
        aliases: ['BAMBU LAB P1P'],
    },
    {
        id: 'P1S',
        name: 'Bambu P1S',
        short: 'P1S',
        family: 'p1',
        strategyFamily: 'p1_series',
        camera: 'p1',
        bed: { x: 256, y: 256, z: 256 },
        kinematics: 'corexy',
        hasCamera: true,
        adoptable: true,
        aliases: ['P1', 'BAMBU LAB P1S', 'BAMBU P1S 2', 'P1S 2'],
    },
    {
        id: 'P2S',
        name: 'Bambu P2S',
        short: 'P2S',
        family: 'p2',
        strategyFamily: 'p2_series',
        camera: 'x1',
        bed: { x: 256, y: 256, z: 256 },
        kinematics: 'corexy',
        hasCamera: true,
        adoptable: true,
        aliases: ['P2', 'BAMBU LAB P2S'],
    },
    {
        id: 'X1',
        name: 'Bambu X1',
        short: 'X1',
        family: 'x1',
        strategyFamily: 'p1_series',
        camera: 'x1',
        bed: { x: 256, y: 256, z: 256 },
        kinematics: 'corexy',
        hasCamera: true,
        adoptable: false,
        aliases: ['BAMBU LAB X1'],
    },
    {
        id: 'X1C',
        name: 'Bambu X1C',
        short: 'X1C',
        family: 'x1',
        strategyFamily: 'p1_series',
        camera: 'x1',
        bed: { x: 256, y: 256, z: 256 },
        kinematics: 'corexy',
        hasCamera: true,
        adoptable: true,
        aliases: ['X1 CARBON', 'BAMBU LAB X1C', 'BAMBU LAB X1 CARBON', '3DPRINTER-X1-CARBON'],
    },
    {
        id: 'X1E',
        name: 'Bambu X1E',
        short: 'X1E',
        family: 'x1',
        strategyFamily: 'p1_series',
        camera: 'x1',
        bed: { x: 256, y: 256, z: 256 },
        kinematics: 'corexy',
        hasCamera: true,
        adoptable: true,
        aliases: ['BAMBU LAB X1E'],
    },
    {
        id: 'X2D',
        name: 'Bambu X2D',
        short: 'X2D',
        family: 'x2',
        strategyFamily: 'x2_series',
        camera: 'x1',
        bed: { x: 256, y: 256, z: 260 },
        kinematics: 'corexy',
        hasCamera: true,
        adoptable: true,
        // "X2C" does not exist in Bambu's lineup — the X-series successor is
        // the X2D. Treat X2C as an alias so operators typing it still land on
        // a real machine.
        aliases: ['X2', 'X2C', 'BAMBU LAB X2D'],
    },
    {
        id: 'H2S',
        name: 'Bambu H2S',
        short: 'H2S',
        family: 'h2',
        strategyFamily: 'h2_series',
        camera: 'x1',
        bed: { x: 325, y: 320, z: 325 },
        kinematics: 'corexy',
        hasCamera: true,
        adoptable: true,
        aliases: ['BAMBU LAB H2S'],
    },
    {
        id: 'H2D',
        name: 'Bambu H2D',
        short: 'H2D',
        family: 'h2',
        strategyFamily: 'h2_series',
        camera: 'x1',
        bed: { x: 325, y: 320, z: 325 },
        kinematics: 'corexy',
        hasCamera: true,
        adoptable: true,
        aliases: ['BAMBU LAB H2D', 'H2D PRO', 'H2 PRO'],
    },
    {
        id: 'H2C',
        name: 'Bambu H2C',
        short: 'H2C',
        family: 'h2',
        strategyFamily: 'h2_series',
        camera: 'x1',
        bed: { x: 325, y: 320, z: 325 },
        kinematics: 'corexy',
        hasCamera: true,
        adoptable: true,
        aliases: ['BAMBU LAB H2C'],
    },
];

// Bambu `printer_model_id` values from Metadata/slice_info.config inside a
// .gcode.3mf → registry id. Lets us read what machine a file was SLICED for
// (drives the transform dialect and the start-time file↔printer guard).
// 2026-lineup ids are added as they're observed; unknown ids resolve to null
// and the guard simply doesn't fire.
const SLICE_INFO_MODEL_IDS = {
    'N1': 'A1_MINI',
    'N2S': 'A1',
    'C11': 'P1P',
    'C12': 'P1S',
    'C13': 'X1E',
    'BL-P001': 'X1C',
    'BL-P002': 'X1',
};

/** Registry record for a slice_info printer_model_id, or null when unknown. */
export function modelFromSliceInfoId(printerModelId) {
    const id = SLICE_INFO_MODEL_IDS[String(printerModelId || '').trim()];
    return id ? getModelById(id) : null;
}

function canonicalKey(value) {
    return String(value || '')
        .trim()
        .toUpperCase()
        .replace(/^BAMBU\s+LAB\s+/, 'BAMBU ')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ');
}

const LOOKUP = new Map();
for (const model of PRINTER_MODELS) {
    const keys = [
        model.id,
        model.name,
        model.short,
        ...(model.aliases || []),
    ];
    for (const key of keys) {
        LOOKUP.set(canonicalKey(key), model);
    }
}

/**
 * Resolve any model string to its registry record, or null when unknown.
 * Falls back to substring matching for slightly-off strings coming from
 * discovery / user input (e.g. "bambu lab p1s (bay 2)").
 */
export function normalizeModel(value) {
    const key = canonicalKey(value);
    if (!key) return null;
    if (LOOKUP.has(key)) return LOOKUP.get(key);
    const bare = key.replace(/^BAMBU\s+/, '');
    if (LOOKUP.has(bare)) return LOOKUP.get(bare);

    // Substring fallback, most specific first.
    if (bare.includes('A1') && bare.includes('MINI')) return getModelById('A1_MINI');
    if (bare.includes('A2L') || /\bA2\b/.test(bare)) return getModelById('A2L');
    if (bare.includes('A1')) return getModelById('A1');
    if (bare.includes('X2')) return getModelById('X2D');
    if (bare.includes('X1E')) return getModelById('X1E');
    if (bare.includes('X1C') || bare.includes('CARBON')) return getModelById('X1C');
    if (bare.includes('X1')) return getModelById('X1');
    if (bare.includes('P2')) return getModelById('P2S');
    if (bare.includes('P1P')) return getModelById('P1P');
    if (bare.includes('P1')) return getModelById('P1S');
    if (bare.includes('H2S')) return getModelById('H2S');
    if (bare.includes('H2C')) return getModelById('H2C');
    if (bare.includes('H2')) return getModelById('H2D');
    return null;
}

export function getModelById(id) {
    return PRINTER_MODELS.find((model) => model.id === id) || null;
}

/**
 * Map any model string to the Automator geometry key (MODEL_DEFAULTS in
 * src/gcode/Automator.js). X-family variants share the X1 geometry; H2
 * variants share H2. Unknown models fall back to P1S (256mm CoreXY), which is
 * the historical behavior — but callers that resolved a real model no longer
 * hit that fallback by accident.
 */
export function automatorModelKey(value) {
    const model = normalizeModel(value);
    if (!model) return 'P1S';
    switch (model.id) {
        case 'X1C':
        case 'X1E':
            return 'X1';
        case 'H2S':
        case 'H2C':
            return 'H2D';
        case 'P1P':
            return 'P1S';
        default:
            return model.id;
    }
}

/** Camera transport family for a model string: 'p1' | 'x1'. */
export function cameraFamilyFor(value) {
    const model = normalizeModel(value);
    return model ? model.camera : 'p1';
}

/** Fleet chassis family for a model string. */
export function chassisFamilyFor(value) {
    const model = normalizeModel(value);
    return model ? model.family : 'generic';
}

/** Models offered in the cloud adopt dropdown (short names). */
export function adoptableModels() {
    return PRINTER_MODELS.filter((model) => model.adoptable).map((model) => model.short);
}

/** Build-volume capabilities for PrinterRegistry.deriveCapabilities. */
export function capabilitiesFor(value) {
    const model = normalizeModel(value);
    if (!model) return null;
    return {
        mqtt_control: true,
        ams: true,
        camera: model.hasCamera,
        max_x: model.bed.x,
        max_y: model.bed.y,
        max_z: model.bed.z,
    };
}
