// src/models/FilamentSpool.js — filament spool inventory data access (sql.js API).
import { dbAll, dbGet, dbRun } from '../db/database.js';
import { generateId } from '../utils/uuid.js';

const NUMERIC_FIELDS = new Set(['total_grams', 'remaining_grams', 'low_threshold_grams', 'ams_unit', 'ams_tray']);

function num(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

export class FilamentSpoolModel {
    static create(input = {}) {
        const id = generateId();
        const total = num(input.total_grams, 1000);
        const remaining = input.remaining_grams != null ? num(input.remaining_grams, total) : total;
        dbRun(
            `INSERT INTO filament_spools
                (spool_id, name, material, color_hex, color_name, vendor, printer_id, ams_unit, ams_tray,
                 total_grams, remaining_grams, low_threshold_grams)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                id,
                input.name || null,
                input.material || 'PLA',
                input.color_hex || 'FFFFFFFF',
                input.color_name || 'Unknown',
                input.vendor || null,
                input.printer_id || null,
                input.ams_unit != null ? num(input.ams_unit) : null,
                input.ams_tray != null ? num(input.ams_tray) : null,
                total,
                Math.max(0, remaining),
                num(input.low_threshold_grams, 100),
            ],
        );
        return this.findById(id);
    }

    static findById(id) {
        const row = dbGet('SELECT * FROM filament_spools WHERE spool_id = ?', [id]);
        return row ? this._parse(row) : null;
    }

    static findAll({ includeArchived = false, lowStockOnly = false } = {}) {
        const where = [];
        if (!includeArchived) where.push('archived = 0');
        if (lowStockOnly) where.push('remaining_grams <= low_threshold_grams');
        const sql = `SELECT * FROM filament_spools${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC`;
        return dbAll(sql).map((r) => this._parse(r));
    }

    static update(id, patch = {}) {
        const allowed = ['name', 'material', 'color_hex', 'color_name', 'vendor', 'printer_id',
            'ams_unit', 'ams_tray', 'total_grams', 'remaining_grams', 'low_threshold_grams', 'archived'];
        const sets = [];
        const vals = [];
        for (const key of allowed) {
            if (patch[key] === undefined) continue;
            sets.push(`${key} = ?`);
            vals.push(NUMERIC_FIELDS.has(key) ? num(patch[key]) : patch[key]);
        }
        if (!sets.length) return this.findById(id);
        sets.push("updated_at = datetime('now')");
        vals.push(id);
        dbRun(`UPDATE filament_spools SET ${sets.join(', ')} WHERE spool_id = ?`, vals);
        return this.findById(id);
    }

    static remove(id) {
        dbRun('DELETE FROM filament_spools WHERE spool_id = ?', [id]);
    }

    /**
     * Decrement a spool by `grams`, clamped at 0, and record a ledger entry.
     * Returns { spool, consumed, low, depleted, crossedLowThreshold }.
     */
    static consume(id, grams, { jobId = null, note = null } = {}) {
        const spool = this.findById(id);
        if (!spool) throw new Error('spool not found');
        const amount = Math.max(0, num(grams));
        const before = num(spool.remaining_grams);
        const after = Math.max(0, before - amount);
        const consumed = before - after;

        dbRun("UPDATE filament_spools SET remaining_grams = ?, updated_at = datetime('now') WHERE spool_id = ?", [after, id]);
        dbRun(
            'INSERT INTO filament_consumption (id, spool_id, job_id, grams, note) VALUES (?, ?, ?, ?, ?)',
            [generateId(), id, jobId, consumed, note],
        );

        const threshold = num(spool.low_threshold_grams);
        return {
            spool: this.findById(id),
            consumed,
            depleted: after <= 0,
            low: after <= threshold,
            crossedLowThreshold: before > threshold && after <= threshold,
        };
    }

    static ledger(id, { limit = 50 } = {}) {
        const safe = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
        return dbAll('SELECT * FROM filament_consumption WHERE spool_id = ? ORDER BY created_at DESC LIMIT ?', [id, safe]);
    }

    static _parse(row) {
        return {
            ...row,
            total_grams: num(row.total_grams),
            remaining_grams: num(row.remaining_grams),
            low_threshold_grams: num(row.low_threshold_grams),
            archived: !!row.archived,
            low_stock: num(row.remaining_grams) <= num(row.low_threshold_grams),
        };
    }
}

export default FilamentSpoolModel;
