// src/models/Printer.js — Printer data access layer (sql.js API)
import { dbAll, dbGet, dbRun } from '../db/database.js';
import { generateId } from '../utils/uuid.js';
import { encrypt, decrypt } from '../utils/crypto.js';

export class PrinterModel {
    static create({ name, model, ip_hostname, auth, camera_url, capabilities }) {
        const id = generateId();
        const encAuth = auth ? encrypt(auth) : null;
        dbRun(
            `INSERT INTO printers (printer_id, name, model, ip_hostname, auth, camera_url, capabilities)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [id, name, model, ip_hostname, encAuth, camera_url || null, JSON.stringify(capabilities || {})]
        );
        return this.findById(id);
    }

    static findAll() {
        const rows = dbAll('SELECT * FROM printers ORDER BY created_at DESC');
        return rows.map(r => this._sanitize(r));
    }

    static findById(id) {
        const row = dbGet('SELECT * FROM printers WHERE printer_id = ?', [id]);
        return row ? this._sanitize(row) : null;
    }

    static update(id, fields) {
        const allowed = ['name', 'model', 'ip_hostname', 'camera_url', 'capabilities', 'status_snapshot', 'last_seen', 'cert_fingerprint'];
        const sets = [];
        const vals = [];
        for (const [k, v] of Object.entries(fields)) {
            if (k === 'auth') {
                sets.push('auth = ?');
                vals.push(v ? encrypt(v) : null);
            } else if (allowed.includes(k)) {
                sets.push(`${k} = ?`);
                vals.push(typeof v === 'object' ? JSON.stringify(v) : v);
            }
        }
        if (sets.length === 0) return this.findById(id);
        sets.push("updated_at = datetime('now')");
        vals.push(id);
        dbRun(`UPDATE printers SET ${sets.join(', ')} WHERE printer_id = ?`, vals);
        return this.findById(id);
    }

    static delete(id) {
        return dbRun('DELETE FROM printers WHERE printer_id = ?', [id]);
    }

    static updateStatus(id, statusSnapshot) {
        dbRun(
            `UPDATE printers SET status_snapshot = ?, last_seen = datetime('now'), updated_at = datetime('now') WHERE printer_id = ?`,
            [JSON.stringify(statusSnapshot), id]
        );
    }

    static _sanitize(row) {
        return {
            ...row,
            capabilities: _parseJson(row.capabilities, {}),
            status_snapshot: _parseJson(row.status_snapshot, null),
            auth: row.auth ? { configured: true } : { configured: false },
            _authEncrypted: row.auth,
        };
    }

    static getAuth(id) {
        const row = dbGet('SELECT auth FROM printers WHERE printer_id = ?', [id]);
        if (!row || !row.auth) return null;
        return decrypt(row.auth);
    }
}

function _parseJson(val, fallback) {
    if (!val) return fallback;
    try { return JSON.parse(val); } catch { return fallback; }
}

export default PrinterModel;
