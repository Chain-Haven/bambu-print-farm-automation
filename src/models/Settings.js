// src/models/Settings.js — global key/value settings (sql.js). Values are
// stored as JSON so callers can persist small config objects (the cloud-link
// config being the first user).
import { dbGet, dbRun } from '../db/database.js';

function parseJson(value, fallback) {
    if (value == null) return fallback;
    try { return JSON.parse(value); } catch { return fallback; }
}

export class SettingsModel {
    static get(key, fallback = null) {
        const row = dbGet('SELECT value FROM app_settings WHERE key = ?', [key]);
        return row ? parseJson(row.value, fallback) : fallback;
    }

    static set(key, value) {
        dbRun(
            `INSERT INTO app_settings (key, value, updated_at)
             VALUES (?, ?, datetime('now'))
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
            [key, JSON.stringify(value ?? null)],
        );
        return this.get(key);
    }

    static remove(key) {
        dbRun('DELETE FROM app_settings WHERE key = ?', [key]);
    }
}
