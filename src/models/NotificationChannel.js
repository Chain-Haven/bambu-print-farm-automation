// src/models/NotificationChannel.js — notification channel data access (sql.js).
import { dbAll, dbGet, dbRun } from '../db/database.js';
import { generateId } from '../utils/uuid.js';

const VALID_TYPES = new Set(['discord', 'slack', 'telegram', 'webhook']);

function parseJson(value, fallback) {
    if (value == null) return fallback;
    try { return JSON.parse(value); } catch { return fallback; }
}

export class NotificationChannelModel {
    static create({ name = null, type, config = {}, events = ['all'], enabled = true } = {}) {
        if (!VALID_TYPES.has(type)) throw new Error(`invalid channel type: ${type}`);
        const id = generateId();
        dbRun(
            `INSERT INTO notification_channels (channel_id, name, type, config, events, enabled)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [id, name, type, JSON.stringify(config || {}), JSON.stringify(events || ['all']), enabled ? 1 : 0],
        );
        return this.findById(id);
    }

    static findById(id) {
        const row = dbGet('SELECT * FROM notification_channels WHERE channel_id = ?', [id]);
        return row ? this._parse(row) : null;
    }

    static findAll({ enabledOnly = false } = {}) {
        const sql = enabledOnly
            ? 'SELECT * FROM notification_channels WHERE enabled = 1 ORDER BY created_at ASC'
            : 'SELECT * FROM notification_channels ORDER BY created_at ASC';
        return dbAll(sql).map((r) => this._parse(r));
    }

    /** Enabled channels subscribed to an event type (or to "all"). */
    static findForEvent(eventType) {
        return this.findAll({ enabledOnly: true }).filter((c) =>
            c.events.includes('all') || c.events.includes(eventType));
    }

    static update(id, patch = {}) {
        const sets = [];
        const vals = [];
        if (patch.name !== undefined) { sets.push('name = ?'); vals.push(patch.name); }
        if (patch.type !== undefined) {
            if (!VALID_TYPES.has(patch.type)) throw new Error(`invalid channel type: ${patch.type}`);
            sets.push('type = ?'); vals.push(patch.type);
        }
        if (patch.config !== undefined) { sets.push('config = ?'); vals.push(JSON.stringify(patch.config || {})); }
        if (patch.events !== undefined) { sets.push('events = ?'); vals.push(JSON.stringify(patch.events || ['all'])); }
        if (patch.enabled !== undefined) { sets.push('enabled = ?'); vals.push(patch.enabled ? 1 : 0); }
        if (!sets.length) return this.findById(id);
        sets.push("updated_at = datetime('now')");
        vals.push(id);
        dbRun(`UPDATE notification_channels SET ${sets.join(', ')} WHERE channel_id = ?`, vals);
        return this.findById(id);
    }

    static remove(id) {
        dbRun('DELETE FROM notification_channels WHERE channel_id = ?', [id]);
    }

    static _parse(row) {
        return {
            ...row,
            config: parseJson(row.config, {}),
            events: parseJson(row.events, ['all']),
            enabled: !!row.enabled,
        };
    }
}

export default NotificationChannelModel;
