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
    };
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

export function buildPublicFilamentAvailability({ inventory = {}, updatedAt = null } = {}) {
    const settings = normalizeFarmAutomationSettings({ inventory });
    const materialsByName = new Map();
    const colorsByHex = new Map();

    for (const spool of settings.inventory.spools) {
        const available = isPubliclyAvailable(spool);

        if (!materialsByName.has(spool.material)) {
            materialsByName.set(spool.material, {
                material: spool.material,
                spool_count: 0,
                available_spool_count: 0,
                total_grams_remaining: 0,
                available_grams_remaining: 0,
                colors: new Map(),
            });
        }
        const materialSummary = materialsByName.get(spool.material);
        addSpool(materialSummary, spool, available);

        if (!materialSummary.colors.has(spool.color_hex)) {
            materialSummary.colors.set(spool.color_hex, createColorSummary({
                colorHex: spool.color_hex,
                colorName: spool.color_name,
            }));
        }
        addSpool(materialSummary.colors.get(spool.color_hex), spool, available);

        if (!colorsByHex.has(spool.color_hex)) {
            colorsByHex.set(spool.color_hex, createColorSummary({
                colorHex: spool.color_hex,
                colorName: spool.color_name,
                materials: [spool.material],
            }));
        }
        const colorSummary = colorsByHex.get(spool.color_hex);
        if (!colorSummary.materials.includes(spool.material)) {
            colorSummary.materials.push(spool.material);
            colorSummary.materials.sort();
        }
        addSpool(colorSummary, spool, available);
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
