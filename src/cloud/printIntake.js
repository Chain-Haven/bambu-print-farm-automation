export const MAX_JSON_FILE_BYTES = 25 * 1024 * 1024;
export const READY_EXTENSIONS = ['.gcode.3mf', '.3mf', '.gcode'];
export const SOURCE_EXTENSIONS = ['.stl', '.obj', '.step', '.stp'];
// Must stay in sync with the scorer in merchantRouting.js and the strategy
// list advertised by merchantRoutingV2.js — a strategy accepted at estimate
// time but missing here silently downgrades to fastest_fulfillment at submit.
export const ROUTING_STRATEGIES = [
    'fastest_fulfillment',
    'cheapest',
    'exact_material_match',
    'batch_by_material',
    'least_printer_wear',
    'ship_cutoff',
    'smart_material_queue',
];

export function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function asArray(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string' && value.trim()) return [value];
    return [];
}

export function normalizeMaterial(value) {
    return typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : null;
}

export function normalizeColor(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const raw = value.trim().replace(/^#/, '').toUpperCase();
    const expanded = raw.length === 3 ? raw.split('').map((char) => `${char}${char}`).join('') : raw;
    const hex = expanded.slice(0, 6);
    return /^[0-9A-F]{6}$/.test(hex) ? `#${hex}` : null;
}

export function getNumber(...values) {
    for (const value of values) {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return null;
}

export function getRequiredDimensions(requirements = {}) {
    const dimensions = requirements.dimensions_mm || requirements.dimensions || {};
    const x = getNumber(dimensions.x, dimensions.width);
    const y = getNumber(dimensions.y, dimensions.depth);
    const z = getNumber(dimensions.z, dimensions.height);
    if (!x && !y && !z) return null;
    return { x, y, z };
}

export function classifyFileName(fileName) {
    const lower = String(fileName || '').toLowerCase();
    if (READY_EXTENSIONS.some((extension) => lower.endsWith(extension))) return 'ready_to_print';
    if (SOURCE_EXTENSIONS.some((extension) => lower.endsWith(extension))) return 'source_model';
    throw new Error('file.name must end in .gcode, .3mf, .gcode.3mf, .stl, .obj, .step, or .stp');
}

export function normalizeRoutingStrategy(value) {
    return ROUTING_STRATEGIES.includes(value) ? value : 'fastest_fulfillment';
}

export function getPrimaryMaterial(requirements = {}) {
    return normalizeMaterial(asArray(requirements.materials || requirements.material)[0]);
}

export function getPrimaryColor(requirements = {}) {
    return normalizeColor(asArray(requirements.colors || requirements.colours || requirements.color)[0]);
}

export function getEstimatedGrams(requirements = {}) {
    const direct = getNumber(requirements.estimated_grams, requirements.grams, requirements.material_grams);
    if (direct) return Math.ceil(direct);

    const dimensions = getRequiredDimensions(requirements);
    if (!dimensions?.x || !dimensions?.y || !dimensions?.z) return 50;

    const infill = Math.max(0.05, Math.min(Number(requirements.infill_ratio || requirements.infill || 0.15), 1));
    return Math.max(10, Math.ceil(dimensions.x * dimensions.y * dimensions.z * infill * 0.0018));
}
