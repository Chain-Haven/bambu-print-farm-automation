// src/models/Command.js — Command data access layer (sql.js API)
import { dbAll, dbGet, dbRun } from '../db/database.js';
import { generateId } from '../utils/uuid.js';

export class CommandModel {
    static create({ target_type, target_id, action, params, requested_by, idempotency_key, timeout_seconds, max_retries }) {
        // Idempotency check
        if (idempotency_key) {
            const existing = dbGet('SELECT * FROM commands WHERE idempotency_key = ?', [idempotency_key]);
            if (existing) return this._parse(existing);
        }
        const id = generateId();
        dbRun(
            `INSERT INTO commands (command_id, target_type, target_id, action, params, requested_by, idempotency_key, timeout_seconds, max_retries)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, target_type, target_id, action, JSON.stringify(params || {}), requested_by || 'system',
                idempotency_key || null, timeout_seconds || 30, max_retries || 2]
        );
        return this.findById(id);
    }

    static findById(id) {
        const row = dbGet('SELECT * FROM commands WHERE command_id = ?', [id]);
        return row ? this._parse(row) : null;
    }

    static findAll({ status, limit = 50, offset = 0 } = {}) {
        if (status) {
            return dbAll('SELECT * FROM commands WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?', [status, limit, offset]).map(r => this._parse(r));
        }
        return dbAll('SELECT * FROM commands ORDER BY created_at DESC LIMIT ? OFFSET ?', [limit, offset]).map(r => this._parse(r));
    }

    static findQueued(targetType, targetId, limit = 10) {
        return dbAll(
            `SELECT * FROM commands WHERE target_type = ? AND target_id = ? AND status = 'queued' ORDER BY created_at ASC LIMIT ?`,
            [targetType, targetId, limit]
        ).map(r => this._parse(r));
    }

    static findByTarget(targetType, targetId, { status, limit = 50, offset = 0 } = {}) {
        if (status) {
            return dbAll('SELECT * FROM commands WHERE target_type = ? AND target_id = ? AND status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
                [targetType, targetId, status, limit, offset]).map(r => this._parse(r));
        }
        return dbAll('SELECT * FROM commands WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
            [targetType, targetId, limit, offset]).map(r => this._parse(r));
    }

    static updateStatus(id, status, extra = {}) {
        const sets = ['status = ?'];
        const vals = [status];
        if (extra.result !== undefined) { sets.push('result = ?'); vals.push(JSON.stringify(extra.result)); }
        if (extra.error !== undefined) { sets.push('error = ?'); vals.push(extra.error); }
        sets.push('attempt_count = attempt_count + 1');
        vals.push(id);
        dbRun(`UPDATE commands SET ${sets.join(', ')} WHERE command_id = ?`, vals);
        return this.findById(id);
    }

    static cancel(id) {
        dbRun("UPDATE commands SET status = 'canceled' WHERE command_id = ? AND status IN ('queued','sent')", [id]);
        return this.findById(id);
    }

    static _parse(row) {
        return { ...row, params: _pj(row.params, {}), result: _pj(row.result, null) };
    }
}

function _pj(v, fb) { if (!v) return fb; try { return JSON.parse(v); } catch { return fb; } }
export default CommandModel;
