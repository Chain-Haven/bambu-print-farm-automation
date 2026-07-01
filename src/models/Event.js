// src/models/Event.js — Event data access layer (sql.js API)
import { dbAll, dbGet, dbRun } from '../db/database.js';
import { generateId } from '../utils/uuid.js';

export class EventModel {
    static create({ entity_type, entity_id, event_type, payload }) {
        const id = generateId();
        dbRun(
            'INSERT INTO events (event_id, entity_type, entity_id, event_type, payload) VALUES (?, ?, ?, ?, ?)',
            [id, entity_type, entity_id, event_type, JSON.stringify(payload || {})]
        );
        return { event_id: id, entity_type, entity_id, event_type, payload };
    }

    static findByEntity(entityType, entityId, { limit = 50, offset = 0 } = {}) {
        return dbAll(
            'SELECT * FROM events WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
            [entityType, entityId, limit, offset]
        ).map(r => ({ ...r, payload: _pj(r.payload, {}) }));
    }

    /**
     * Delete events older than `days` to bound table growth on a long-running node
     * (critical at 300 printers, where status/error events accumulate forever and
     * the periodic full-DB export gets slower with every row). Returns rows removed.
     */
    static pruneOlderThan(days = 30) {
        const before = dbGet('SELECT COUNT(*) AS n FROM events')?.n || 0;
        dbRun("DELETE FROM events WHERE created_at < datetime('now', ?)", [`-${Math.max(1, days)} days`]);
        const after = dbGet('SELECT COUNT(*) AS n FROM events')?.n || 0;
        return Math.max(0, before - after);
    }

    static findAll({ entity_type, event_type, limit = 100, offset = 0 } = {}) {
        let sql = 'SELECT * FROM events';
        const conds = []; const vals = [];
        if (entity_type) { conds.push('entity_type = ?'); vals.push(entity_type); }
        if (event_type) { conds.push('event_type = ?'); vals.push(event_type); }
        if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
        sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        vals.push(limit, offset);
        return dbAll(sql, vals).map(r => ({ ...r, payload: _pj(r.payload, {}) }));
    }
}

function _pj(v, fb) { if (!v) return fb; try { return JSON.parse(v); } catch { return fb; } }
export default EventModel;
