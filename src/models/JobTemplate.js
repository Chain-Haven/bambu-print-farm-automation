// src/models/JobTemplate.js — Job Template data access layer (sql.js API)
import { dbAll, dbGet, dbRun } from '../db/database.js';
import { generateId } from '../utils/uuid.js';

export class JobTemplateModel {
    static create({ name, description, profile_id, printer_id, source_file_name, source_file_path, ams_roles, repeat_total, tags, transform_overrides }) {
        const id = generateId();
        dbRun(
            `INSERT INTO job_templates (template_id, name, description, profile_id, printer_id, source_file_name, source_file_path, ams_roles, repeat_total, tags, transform_overrides)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, name, description || '', profile_id || null, printer_id || null,
                source_file_name || null, source_file_path || null,
                JSON.stringify(ams_roles || null), repeat_total || 1,
                JSON.stringify(tags || []), JSON.stringify(transform_overrides || {})]
        );
        return this.findById(id);
    }

    static findAll() {
        return dbAll('SELECT * FROM job_templates ORDER BY last_used_at DESC NULLS LAST, created_at DESC').map(r => this._parse(r));
    }

    static findById(id) {
        const row = dbGet('SELECT * FROM job_templates WHERE template_id = ?', [id]);
        return row ? this._parse(row) : null;
    }

    static update(id, fields) {
        const allowed = ['name', 'description', 'profile_id', 'printer_id', 'source_file_name', 'source_file_path', 'ams_roles', 'repeat_total', 'tags', 'transform_overrides'];
        const sets = []; const vals = [];
        for (const [k, v] of Object.entries(fields)) {
            if (!allowed.includes(k)) continue;
            sets.push(`${k} = ?`);
            vals.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
        }
        if (sets.length === 0) return this.findById(id);
        sets.push("updated_at = datetime('now')");
        vals.push(id);
        dbRun(`UPDATE job_templates SET ${sets.join(', ')} WHERE template_id = ?`, vals);
        return this.findById(id);
    }

    static recordUse(id) {
        dbRun("UPDATE job_templates SET use_count = use_count + 1, last_used_at = datetime('now') WHERE template_id = ?", [id]);
    }

    static delete(id) {
        dbRun('DELETE FROM job_templates WHERE template_id = ?', [id]);
    }

    static _parse(row) {
        return {
            ...row,
            ams_roles: _pj(row.ams_roles, null),
            tags: _pj(row.tags, []),
            transform_overrides: _pj(row.transform_overrides, {}),
        };
    }
}

function _pj(v, fb) { if (!v) return fb; try { return JSON.parse(v); } catch { return fb; } }
export default JobTemplateModel;
