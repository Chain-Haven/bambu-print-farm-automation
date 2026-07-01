import { normalizeFarmAutomationSettings } from './farmAutomation.js';

const UNAVAILABLE_DRY_STATES = new Set(['wet', 'needs_drying']);

function isUnavailableDryState(value) {
    return UNAVAILABLE_DRY_STATES.has(String(value || '').trim().toLowerCase());
}

function isPubliclyAvailable(spool) {
    return spool.grams_remaining > 0
        && !spool.reserved_for_job_id
        && !isUnavailableDryState(spool.dry_status);
}

function createColorSummary({ colorHex, colorName = null, materials = [] }) {
    return {
        color_hex: colorHex,
        color_name: colorName,
        materials: [...materials].sort(),
        spool_count: 0,
        available_spool_count: 0,
        total_grams_remaining: 0,
        available_grams_remaining: 0,
        loaded_slot_count: 0,
    };
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeAmsColor(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const raw = value.trim().replace(/^#/, '').toUpperCase();
    const expanded = raw.length === 3 ? raw.split('').map((char) => `${char}${char}`).join('') : raw;
    const hex = expanded.slice(0, 6);
    return /^[0-9A-F]{6}$/.test(hex) ? `#${hex}` : null;
}

/**
 * Trays actually loaded in printers' AMS units, taken from the cloud printer
 * mirror (synced by the local node heartbeat: operator slot assignments merged
 * with live telemetry). These are what a merchant can really print with right
 * now — the spool inventory is warehouse stock by comparison.
 */
function collectLoadedAmsTrays(overview) {
    const printers = Array.isArray(overview?.printers) ? overview.printers : [];
    const trays = [];
    for (const printer of printers) {
        const printerTrays = Array.isArray(printer?.capabilities?.ams_trays) ? printer.capabilities.ams_trays : [];
        for (const tray of printerTrays) {
            if (!isPlainObject(tray)) continue;
            const material = typeof tray.material === 'string' && tray.material.trim()
                ? tray.material.trim().toUpperCase()
                : null;
            const colorHex = normalizeAmsColor(tray.color_hex || tray.color);
            if (!material || !colorHex) continue;
            trays.push({
                material,
                color_hex: colorHex,
                color_name: typeof tray.color_name === 'string' && tray.color_name.trim() ? tray.color_name.trim() : null,
            });
        }
    }
    return trays;
}

function addSpool(summary, spool, available) {
    summary.spool_count += 1;
    summary.total_grams_remaining += spool.grams_remaining;
    if (!summary.color_name && spool.color_name) summary.color_name = spool.color_name;

    if (available) {
        summary.available_spool_count += 1;
        summary.available_grams_remaining += spool.grams_remaining;
    }
}

function toSortedColorSummaries(colors) {
    return [...colors.values()].sort((a, b) => {
        const colorCompare = a.color_hex.localeCompare(b.color_hex);
        if (colorCompare !== 0) return colorCompare;
        return String(a.color_name || '').localeCompare(String(b.color_name || ''));
    });
}

export function buildPublicFilamentAvailability({ inventory = {}, overview = null, updatedAt = null } = {}) {
    const settings = normalizeFarmAutomationSettings({ inventory });
    const materialsByName = new Map();
    const colorsByHex = new Map();

    function ensureMaterialSummary(material) {
        if (!materialsByName.has(material)) {
            materialsByName.set(material, {
                material,
                spool_count: 0,
                available_spool_count: 0,
                total_grams_remaining: 0,
                available_grams_remaining: 0,
                loaded_slot_count: 0,
                colors: new Map(),
            });
        }
        return materialsByName.get(material);
    }

    function ensureColorSummary(map, { colorHex, colorName, material }) {
        if (!map.has(colorHex)) {
            map.set(colorHex, createColorSummary({
                colorHex,
                colorName,
                materials: material ? [material] : [],
            }));
        }
        const summary = map.get(colorHex);
        if (material && Array.isArray(summary.materials) && !summary.materials.includes(material)) {
            summary.materials.push(material);
            summary.materials.sort();
        }
        if (!summary.color_name && colorName) summary.color_name = colorName;
        return summary;
    }

    for (const spool of settings.inventory.spools) {
        const available = isPubliclyAvailable(spool);

        const materialSummary = ensureMaterialSummary(spool.material);
        addSpool(materialSummary, spool, available);
        addSpool(ensureColorSummary(materialSummary.colors, {
            colorHex: spool.color_hex,
            colorName: spool.color_name,
        }), spool, available);
        addSpool(ensureColorSummary(colorsByHex, {
            colorHex: spool.color_hex,
            colorName: spool.color_name,
            material: spool.material,
        }), spool, available);
    }

    // Overlay the trays actually loaded in printers (from the cloud printer
    // mirror). A material/color loaded in an AMS slot is offerable even when no
    // spool inventory record exists for it.
    for (const tray of collectLoadedAmsTrays(overview)) {
        const materialSummary = ensureMaterialSummary(tray.material);
        materialSummary.loaded_slot_count += 1;
        ensureColorSummary(materialSummary.colors, {
            colorHex: tray.color_hex,
            colorName: tray.color_name,
        }).loaded_slot_count += 1;
        ensureColorSummary(colorsByHex, {
            colorHex: tray.color_hex,
            colorName: tray.color_name,
            material: tray.material,
        }).loaded_slot_count += 1;
    }

    const materials = [...materialsByName.values()]
        .map((summary) => ({
            ...summary,
            colors: toSortedColorSummaries(summary.colors).map(({ materials, ...color }) => color),
        }))
        .sort((a, b) => a.material.localeCompare(b.material));

    return {
        materials,
        colors: toSortedColorSummaries(colorsByHex),
        updated_at: updatedAt || null,
    };
}
