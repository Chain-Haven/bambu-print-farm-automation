// src/models/CustomColor.js — user-saved custom print colors (sql.js API)
// Saved from the full-spectrum picker; listed alongside the built-in palette
// in the slicer, printer AMS config and order color pairings. Keyed by hex
// ('#rrggbb' lowercase) — re-saving a hex renames it.
import { dbAll, dbGet, dbRun } from '../db/database.js';

const normHex = (h) => {
    const s = String(h || '').trim().replace(/^#/, '').toLowerCase();
    return /^[0-9a-f]{6}$/.test(s) ? `#${s}` : null;
};

export class CustomColorModel {
    static normalizeHex(h) { return normHex(h); }

    static findAll() {
        return dbAll('SELECT * FROM custom_colors ORDER BY created_at DESC, name ASC');
    }

    static get(hex) {
        const h = normHex(hex);
        return h ? (dbGet('SELECT * FROM custom_colors WHERE hex = ?', [h]) || null) : null;
    }

    static save(name, hex) {
        const h = normHex(hex);
        if (!h) throw new Error(`Invalid hex "${hex}" — expected #rrggbb`);
        const label = String(name || '').trim() || h;
        dbRun('DELETE FROM custom_colors WHERE hex = ?', [h]); // sql.js UPSERT workaround
        dbRun('INSERT INTO custom_colors (hex, name) VALUES (?, ?)', [h, label]);
        return this.get(h);
    }

    static delete(hex) {
        const h = normHex(hex);
        if (h) dbRun('DELETE FROM custom_colors WHERE hex = ?', [h]);
    }

    /** {normalized name: '#rrggbb'} — lets order rows use custom color NAMES. */
    static asNameMap() {
        const map = {};
        for (const r of this.findAll()) {
            const key = String(r.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
            if (key && map[key] === undefined) map[key] = r.hex;
        }
        return map;
    }
}

export default CustomColorModel;
