// src/utils/colors.js — the shared named color catalog + resolution helpers.
// This is the SINGLE source of truth for print/AMS colors: the slicer swatch
// grid, the printer-page tray config and the order-intake color overrides all
// resolve against it (FilamentCatalog re-exports COLOR_PALETTE from here so
// existing imports keep working). Hex entries are RRGGBBAA uppercase (AA=FF
// opaque) — the Bambu tray format.

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
 * Resolve ONE color spec to lowercase '#rrggbb' (the print-color format
 * ams_roles/matchColorsToTrays use). Accepted, in precedence order:
 *   1. a seller-defined color alias (aliasMap {normalizedName: '#rrggbb'} —
 *      checked FIRST so a seller's "blue" can override palette Blue),
 *   2. a Bambu palette name ("Teal", case-insensitive),
 *   3. a hex code ("#008080" / "008080" / "008080FF").
 * Null if none match.
 */
export function resolveColorSpec(spec, aliasMap = null) {
    const s = String(spec ?? '').trim();
    if (!s) return null;
    const norm = s.toLowerCase().replace(/\s+/g, ' ');
    if (aliasMap && aliasMap[norm]) return aliasMap[norm];
    const byName = COLOR_PALETTE.find(c => c.name.toLowerCase() === norm);
    if (byName) return `#${byName.hex.slice(0, 6).toLowerCase()}`;
    const hex = s.replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex)) return `#${hex.slice(0, 6).toLowerCase()}`;
    return null;
}

/**
 * Resolve a comma-separated color list (the sheet's `color` column, in
 * filament-slot order) → { ok, colors:['#rrggbb',...] } or { ok:false, error }.
 */
export function resolveColorList(str, aliasMap = null) {
    const parts = String(str ?? '').split(',').map(p => p.trim()).filter(Boolean);
    if (!parts.length) return { ok: false, error: 'No colors given' };
    const colors = [];
    for (const p of parts) {
        const c = resolveColorSpec(p, aliasMap);
        if (!c) {
            return {
                ok: false,
                error: `Unknown color "${p}" — use a hex code (#RRGGBB), a color alias (Orders → SKU mappings → Color pairings), or one of: ${COLOR_PALETTE.map(x => x.name).join(', ')}`,
            };
        }
        colors.push(c);
    }
    return { ok: true, colors };
}

export default { COLOR_PALETTE, resolveColorSpec, resolveColorList };
