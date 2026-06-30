// src/services/FilamentCatalog.js — Bambu Generic Filament Catalog
// All setting_id codes extracted from Bambu Studio system profiles

/**
 * Printer model → setting_id suffix mapping.
 * The suffix is appended to the base setting_id for printer-specific profiles.
 */
const PRINTER_SUFFIXES = {
    'Bambu A1':       '_04',
    'Bambu A1 Mini':  '_04',  // A1M uses same suffix in most cases
    'Bambu P1S':      '_01',
    'Bambu P1P':      '_01',
    'Bambu X1C':      '_01',
    'Bambu X1E':      '_01',
};

/**
 * Complete generic filament catalog.
 * Each entry has material name, base setting_id, tray_type for MQTT,
 * and nozzle/bed temperature ranges.
 */
export const FILAMENT_TYPES = [
    { material: 'PLA',           settingBase: 'GFSL99', trayType: 'PLA',     nozzleMin: 190, nozzleMax: 230, bedTemp: 55 },
    { material: 'PLA High Speed',settingBase: 'GFSL95', trayType: 'PLA',     nozzleMin: 190, nozzleMax: 240, bedTemp: 55 },
    { material: 'PLA Silk',      settingBase: 'GFSL96', trayType: 'PLA',     nozzleMin: 200, nozzleMax: 230, bedTemp: 55 },
    { material: 'PLA-CF',        settingBase: 'GFSL98', trayType: 'PLA-CF',  nozzleMin: 210, nozzleMax: 240, bedTemp: 55 },
    { material: 'PETG',          settingBase: 'GFSG99', trayType: 'PETG',    nozzleMin: 220, nozzleMax: 260, bedTemp: 70 },
    { material: 'PETG HF',       settingBase: 'GFSG96', trayType: 'PETG',    nozzleMin: 220, nozzleMax: 260, bedTemp: 70 },
    { material: 'PETG-CF',       settingBase: 'GFSG98', trayType: 'PETG-CF', nozzleMin: 230, nozzleMax: 270, bedTemp: 70 },
    { material: 'PCTG',          settingBase: 'GFSG97', trayType: 'PCTG',    nozzleMin: 240, nozzleMax: 270, bedTemp: 70 },
    { material: 'ABS',           settingBase: 'GFSB99', trayType: 'ABS',     nozzleMin: 240, nozzleMax: 270, bedTemp: 100 },
    { material: 'ASA',           settingBase: 'GFSB98', trayType: 'ASA',     nozzleMin: 240, nozzleMax: 270, bedTemp: 100 },
    { material: 'TPU',           settingBase: 'GFSU99', trayType: 'TPU',     nozzleMin: 200, nozzleMax: 230, bedTemp: 55 },
    { material: 'TPU for AMS',   settingBase: 'GFSU98', trayType: 'TPU',     nozzleMin: 200, nozzleMax: 230, bedTemp: 55 },
    { material: 'PA (Nylon)',    settingBase: 'GFSN99', trayType: 'PA',      nozzleMin: 270, nozzleMax: 300, bedTemp: 100 },
    { material: 'PA-CF',         settingBase: 'GFSN98', trayType: 'PA-CF',   nozzleMin: 270, nozzleMax: 300, bedTemp: 100 },
    { material: 'PC',            settingBase: 'GFSC99', trayType: 'PC',      nozzleMin: 260, nozzleMax: 290, bedTemp: 110 },
    { material: 'PVA',           settingBase: 'GFSS99', trayType: 'PVA',     nozzleMin: 190, nozzleMax: 210, bedTemp: 55 },
    { material: 'HIPS',          settingBase: 'GFSS98', trayType: 'HIPS',    nozzleMin: 230, nozzleMax: 260, bedTemp: 90 },
    { material: 'BVOH',          settingBase: 'GFSS97', trayType: 'BVOH',    nozzleMin: 190, nozzleMax: 210, bedTemp: 55 },
    { material: 'EVA',           settingBase: 'GFSR99', trayType: 'EVA',     nozzleMin: 200, nozzleMax: 230, bedTemp: 55 },
    { material: 'PHA',           settingBase: 'GFSR98', trayType: 'PHA',     nozzleMin: 190, nozzleMax: 220, bedTemp: 55 },
    { material: 'PE',            settingBase: 'GFSP99', trayType: 'PE',      nozzleMin: 190, nozzleMax: 220, bedTemp: 55 },
    { material: 'PE-CF',         settingBase: 'GFSP98', trayType: 'PE-CF',   nozzleMin: 200, nozzleMax: 230, bedTemp: 55 },
    { material: 'PP',            settingBase: 'GFSP97', trayType: 'PP',      nozzleMin: 200, nozzleMax: 240, bedTemp: 55 },
    { material: 'PP-CF',         settingBase: 'GFSP96', trayType: 'PP-CF',   nozzleMin: 210, nozzleMax: 250, bedTemp: 55 },
    { material: 'PP-GF',         settingBase: 'GFSP95', trayType: 'PP-GF',   nozzleMin: 210, nozzleMax: 250, bedTemp: 55 },
    { material: 'PPA-CF',        settingBase: 'GFSN97', trayType: 'PPA-CF',  nozzleMin: 280, nozzleMax: 310, bedTemp: 100 },
    { material: 'PPA-GF',        settingBase: 'GFSN96', trayType: 'PPA-GF',  nozzleMin: 280, nozzleMax: 310, bedTemp: 100 },
    { material: 'PPS',           settingBase: 'GFSR97', trayType: 'PPS',     nozzleMin: 300, nozzleMax: 330, bedTemp: 110 },
    { material: 'PPS-CF',        settingBase: 'GFSR96', trayType: 'PPS-CF',  nozzleMin: 300, nozzleMax: 330, bedTemp: 110 },
];

/**
 * Standard color palette with names and hex codes (RRGGBBAA).
 * The AA is alpha — always FF for opaque.
 */
export const COLOR_PALETTE = [
    { name: 'White',        hex: 'FFFFFFFF' },
    { name: 'Black',        hex: '000000FF' },
    { name: 'Red',          hex: 'FF0000FF' },
    { name: 'Blue',         hex: '0000FFFF' },
    { name: 'Green',        hex: '00FF00FF' },
    { name: 'Yellow',       hex: 'FFFF00FF' },
    { name: 'Orange',       hex: 'FF8C00FF' },
    { name: 'Purple',       hex: '800080FF' },
    { name: 'Pink',         hex: 'FF69B4FF' },
    { name: 'Gray',         hex: '808080FF' },
    { name: 'Light Gray',   hex: 'C0C0C0FF' },
    { name: 'Dark Gray',    hex: '404040FF' },
    { name: 'Brown',        hex: '8B4513FF' },
    { name: 'Cyan',         hex: '00FFFFFF' },
    { name: 'Lime',         hex: '32CD32FF' },
    { name: 'Navy',         hex: '000080FF' },
    { name: 'Teal',         hex: '008080FF' },
    { name: 'Gold',         hex: 'FFD700FF' },
    { name: 'Transparent',  hex: 'FFFFFF01' },
    { name: 'Natural',      hex: 'F5F5DCFF' },
];

/**
 * Get the printer-specific setting_id for a filament type.
 * @param {string} material - Material name (e.g. "PLA", "PETG")
 * @param {string} printerModel - Printer model (e.g. "Bambu A1")
 * @returns {string|null} setting_id like "GFSL99_04"
 */
export function getSettingId(material, printerModel) {
    const entry = FILAMENT_TYPES.find(f => f.material === material);
    if (!entry) return null;
    const suffix = PRINTER_SUFFIXES[printerModel] || '_01';
    return `${entry.settingBase}${suffix}`;
}

/**
 * Get a filament type entry by material name.
 */
export function getFilamentType(material) {
    return FILAMENT_TYPES.find(f => f.material === material) || null;
}

/**
 * Build the full MQTT ams_filament_setting payload for a single tray.
 * @param {Object} opts
 * @param {number} opts.amsId - AMS unit index (0 for single AMS)
 * @param {number} opts.trayId - Tray index (0-3)
 * @param {string} opts.material - Material name
 * @param {string} opts.colorHex - 8-char RRGGBBAA hex string
 * @param {string} opts.printerModel - Printer model for setting_id lookup
 * @returns {Object} MQTT payload ready to publish
 */
export function buildTrayPayload({ amsId = 0, trayId, material, colorHex = 'FFFFFFFF', printerModel = 'Bambu A1' }) {
    const entry = getFilamentType(material);
    if (!entry) throw new Error(`Unknown filament material: ${material}`);

    const settingId = getSettingId(material, printerModel);

    return {
        print: {
            command: 'ams_filament_setting',
            sequence_id: String(Date.now()),
            ams_id: amsId,
            tray_id: trayId,
            tray_info_idx: entry.settingBase.replace('GFS', 'GFL').slice(0, -2) + '99',
            tray_type: entry.trayType,
            tray_sub_brands: '',
            tray_color: colorHex.toUpperCase(),
            nozzle_temp_min: entry.nozzleMin,
            nozzle_temp_max: entry.nozzleMax,
            tray_weight: '1000',
            setting_id: settingId,
            k: 0.02,
            n: 1.0,
        }
    };
}

/**
 * Auto-generate ams_mapping array.
 * Matches slicer filament requirements to available AMS trays by material type.
 * @param {Array} slicerFilaments - Array of material names from the slicer (ordered)
 * @param {Array} amsTrays - Array of { tray_id, material, color } for all AMS trays
 * @returns {Array<number>} ams_mapping array (tray IDs, -1 for unmatched)
 */
export function autoMapFilaments(slicerFilaments, amsTrays) {
    const used = new Set();
    return slicerFilaments.map(needed => {
        // Find first matching tray not already used
        const match = amsTrays.find(t => t.material === needed && !used.has(t.tray_id));
        if (match) {
            used.add(match.tray_id);
            return match.tray_id;
        }
        // Try partial match (same base type)
        const neededEntry = getFilamentType(needed);
        if (neededEntry) {
            const partialMatch = amsTrays.find(t => {
                const tEntry = getFilamentType(t.material);
                return tEntry && tEntry.trayType === neededEntry.trayType && !used.has(t.tray_id);
            });
            if (partialMatch) {
                used.add(partialMatch.tray_id);
                return partialMatch.tray_id;
            }
        }
        return -1; // No match
    });
}

export default { FILAMENT_TYPES, COLOR_PALETTE, getSettingId, getFilamentType, buildTrayPayload, autoMapFilaments };
