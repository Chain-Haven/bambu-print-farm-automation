// src/models/Accessory.js — Accessory data access layer (sql.js API)
import { dbAll, dbGet, dbRun } from '../db/database.js';
import { generateId } from '../utils/uuid.js';

export class AccessoryModel {
    static create({ type, printer_id, connection_type, endpoint, capabilities, calibration }) {
        const id = generateId();
        dbRun(
            `INSERT INTO accessories (accessory_id, type, printer_id, connection_type, endpoint, capabilities, calibration)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [id, type, printer_id || null, connection_type,
                typeof endpoint === 'object' ? JSON.stringify(endpoint) : endpoint,
                JSON.stringify(capabilities || {}),
                JSON.stringify(calibration || {})]
        );
        return this.findById(id);
    }

    static findAll() {
        return dbAll('SELECT * FROM accessories ORDER BY created_at DESC').map(r => this._parse(r));
    }

    static findById(id) {
        const row = dbGet('SELECT * FROM accessories WHERE accessory_id = ?', [id]);
        return row ? this._parse(row) : null;
    }

    static findByPrinterId(printerId) {
        return dbAll('SELECT * FROM accessories WHERE printer_id = ?', [printerId]).map(r => this._parse(r));
    }

    static update(id, fields) {
        const allowed = ['type', 'printer_id', 'connection_type', 'endpoint', 'capabilities', 'calibration', 'health', 'last_error'];
        const sets = []; const vals = [];
        for (const [k, v] of Object.entries(fields)) {
            if (!allowed.includes(k)) continue;
            sets.push(`${k} = ?`);
            vals.push(typeof v === 'object' ? JSON.stringify(v) : v);
        }
        if (sets.length === 0) return this.findById(id);
        vals.push(id);
        dbRun(`UPDATE accessories SET ${sets.join(', ')} WHERE accessory_id = ?`, vals);
        return this.findById(id);
    }

    static delete(id) { return dbRun('DELETE FROM accessories WHERE accessory_id = ?', [id]); }

    static updateHealth(id, health, lastError = null) {
        dbRun(
            `UPDATE accessories SET health = ?, last_error = ?, last_seen = datetime('now') WHERE accessory_id = ?`,
            [health, lastError, id]
        );
    }

    static _parse(row) {
        return {
            ...row,
            endpoint: _pj(row.endpoint, row.endpoint),
            capabilities: _pj(row.capabilities, {}),
            calibration: _pj(row.calibration, {}),
        };
    }
}

function _pj(v, fb) { if (!v) return fb; try { return JSON.parse(v); } catch { return fb; } }
export default AccessoryModel;
