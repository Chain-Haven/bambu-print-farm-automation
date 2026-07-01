// src/models/PrinterMaintenance.js — per-printer maintenance tasks + odometer.
import { dbAll, dbGet, dbRun } from '../db/database.js';
import { generateId } from '../utils/uuid.js';

function num(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 2) {
    const f = 10 ** digits;
    return Math.round(num(value) * f) / f;
}

export class PrinterMaintenanceModel {
    /** Cumulative completed print hours for a printer (the odometer). */
    static odometerHours(printerId) {
        const row = dbGet(`
            SELECT SUM((julianday(ended_at) - julianday(started_at)) * 24) AS hours
            FROM job_runs
            WHERE printer_id = ? AND status = 'completed'
              AND started_at IS NOT NULL AND ended_at IS NOT NULL
        `, [printerId]);
        return round(row?.hours || 0, 2);
    }

    static create({ printer_id, task, interval_hours = 200, notes = null, hours_at_last_done = null } = {}) {
        if (!printer_id) throw new Error('printer_id is required');
        if (!task) throw new Error('task is required');
        const id = generateId();
        const baseline = hours_at_last_done != null ? num(hours_at_last_done) : this.odometerHours(printer_id);
        dbRun(
            `INSERT INTO printer_maintenance (id, printer_id, task, interval_hours, hours_at_last_done, notes)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [id, printer_id, task, num(interval_hours, 200), baseline, notes],
        );
        return this.findById(id);
    }

    static findById(id) {
        const row = dbGet('SELECT * FROM printer_maintenance WHERE id = ?', [id]);
        return row ? this._withDue(row) : null;
    }

    static findAll({ printerId = null, dueOnly = false } = {}) {
        const rows = printerId
            ? dbAll('SELECT * FROM printer_maintenance WHERE printer_id = ? ORDER BY task', [printerId])
            : dbAll('SELECT * FROM printer_maintenance ORDER BY printer_id, task');
        // Cache odometer per printer so we compute it once per printer, not per row.
        const odometerCache = new Map();
        const withDue = rows.map((row) => {
            if (!odometerCache.has(row.printer_id)) {
                odometerCache.set(row.printer_id, this.odometerHours(row.printer_id));
            }
            return this._withDue(row, odometerCache.get(row.printer_id));
        });
        return dueOnly ? withDue.filter((r) => r.due) : withDue;
    }

    static update(id, patch = {}) {
        const allowed = ['task', 'interval_hours', 'notes', 'hours_at_last_done'];
        const sets = [];
        const vals = [];
        for (const key of allowed) {
            if (patch[key] === undefined) continue;
            sets.push(`${key} = ?`);
            vals.push(key === 'interval_hours' || key === 'hours_at_last_done' ? num(patch[key]) : patch[key]);
        }
        if (!sets.length) return this.findById(id);
        sets.push("updated_at = datetime('now')");
        vals.push(id);
        dbRun(`UPDATE printer_maintenance SET ${sets.join(', ')} WHERE id = ?`, vals);
        return this.findById(id);
    }

    /** Mark a task done: reset its baseline to the current odometer. */
    static markDone(id) {
        const row = dbGet('SELECT * FROM printer_maintenance WHERE id = ?', [id]);
        if (!row) return null;
        const odometer = this.odometerHours(row.printer_id);
        dbRun(
            "UPDATE printer_maintenance SET hours_at_last_done = ?, last_done_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
            [odometer, id],
        );
        return this.findById(id);
    }

    static remove(id) {
        dbRun('DELETE FROM printer_maintenance WHERE id = ?', [id]);
    }

    static _withDue(row, odometer = null) {
        const odo = odometer != null ? odometer : this.odometerHours(row.printer_id);
        const interval = num(row.interval_hours, 200);
        const hoursSinceDone = round(odo - num(row.hours_at_last_done), 2);
        const hoursUntilDue = round(interval - hoursSinceDone, 2);
        return {
            ...row,
            interval_hours: interval,
            hours_at_last_done: num(row.hours_at_last_done),
            odometer_hours: odo,
            hours_since_done: hoursSinceDone,
            hours_until_due: hoursUntilDue,
            percent_used: interval > 0 ? Math.min(100, round((hoursSinceDone / interval) * 100, 1)) : 0,
            due: hoursSinceDone >= interval,
        };
    }
}

export default PrinterMaintenanceModel;
