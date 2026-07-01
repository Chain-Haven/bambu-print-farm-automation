// src/models/Job.js — Job data access layer (sql.js API)
import { dbAll, dbGet, dbRun } from '../db/database.js';
import { generateId } from '../utils/uuid.js';
import fs from 'node:fs';
import path from 'node:path';
import { getUploadRoot } from '../utils/uploadPaths.js';

export class JobModel {
    static create({ name, printer_id, profile_id, source_file_name, ams_roles, repeat_total, priority, scheduled_for, max_retries, metadata }) {
        const id = generateId();
        dbRun(
            `INSERT INTO jobs (job_id, name, printer_id, profile_id, source_file_name, ams_roles, repeat_total, repeat_remaining, priority, scheduled_for, max_retries, metadata)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, name, printer_id || null, profile_id || null, source_file_name || null,
                JSON.stringify(ams_roles || null), repeat_total || 1, repeat_total || 1,
                Number.isFinite(Number(priority)) ? Number(priority) : 0, scheduled_for || null,
                Number.isFinite(Number(max_retries)) ? Math.max(0, Math.trunc(Number(max_retries))) : 0,
                metadata ? JSON.stringify(metadata) : null]
        );
        return this.findById(id);
    }

    static findAll({ status, printer_id, limit = 50, offset = 0 } = {}) {
        let sql = 'SELECT * FROM jobs';
        const conds = []; const vals = [];
        if (status) { conds.push('status = ?'); vals.push(status); }
        if (printer_id) { conds.push('printer_id = ?'); vals.push(printer_id); }
        if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
        sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
        vals.push(limit, offset);
        return dbAll(sql, vals).map(r => this._parse(r));
    }

    static findById(id) {
        const row = dbGet('SELECT * FROM jobs WHERE job_id = ?', [id]);
        return row ? this._parse(row) : null;
    }

    static update(id, fields) {
        const allowed = ['name', 'printer_id', 'status', 'transformed_file_name', 'transform_report', 'diff_summary', 'ams_roles', 'repeat_total', 'repeat_remaining', 'priority', 'scheduled_for', 'max_retries', 'metadata'];
        const sets = []; const vals = [];
        for (const [k, v] of Object.entries(fields)) {
            if (!allowed.includes(k)) continue;
            sets.push(`${k} = ?`);
            vals.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
        }
        if (sets.length === 0) return this.findById(id);
        sets.push("updated_at = datetime('now')");
        vals.push(id);
        dbRun(`UPDATE jobs SET ${sets.join(', ')} WHERE job_id = ?`, vals);
        return this.findById(id);
    }

    static getQueue(printerId) {
        return dbAll("SELECT * FROM jobs WHERE printer_id = ? AND status IN ('queued','assigned') ORDER BY priority DESC, created_at ASC", [printerId]).map(r => this._parse(r));
    }

    static getGlobalQueue() {
        return dbAll("SELECT * FROM jobs WHERE printer_id IS NULL AND status = 'queued' ORDER BY priority DESC, created_at ASC").map(r => this._parse(r));
    }

    /** Is a job runnable now? (queued/assigned and not scheduled for the future) */
    static isReady(job, now = new Date()) {
        if (!job) return false;
        if (!['queued', 'assigned'].includes(job.status)) return false;
        if (!job.scheduled_for) return true;
        const when = new Date(job.scheduled_for);
        if (Number.isNaN(when.getTime())) return true; // unparseable → treat as ready
        return when.getTime() <= now.getTime();
    }

    /**
     * Ready queue for a printer: queued/assigned jobs whose scheduled_for has
     * passed (or is unset), ordered by priority (desc) then schedule/creation.
     */
    static getReadyQueue(printerId, now = new Date()) {
        const iso = (now instanceof Date ? now : new Date(now)).toISOString();
        return dbAll(
            `SELECT * FROM jobs
             WHERE printer_id = ? AND status IN ('queued','assigned')
               AND (scheduled_for IS NULL OR scheduled_for <= ?)
             ORDER BY priority DESC, COALESCE(scheduled_for, created_at) ASC, created_at ASC`,
            [printerId, iso],
        ).map(r => this._parse(r));
    }

    static delete(id) {
        dbRun('DELETE FROM jobs WHERE job_id = ?', [id]);
        dbRun('DELETE FROM job_runs WHERE job_id = ?', [id]);
        dbRun('DELETE FROM events WHERE entity_type = ? AND entity_id = ?', ['job', id]);
    }

    static clearHistory() {
        // Delete all jobs that are in final states
        const finalStates = ['completed', 'failed', 'canceled'];
        const placeholders = finalStates.map(() => '?').join(',');

        // Get full job data first to clean up files
        const jobs = dbAll(`SELECT * FROM jobs WHERE status IN (${placeholders})`, finalStates);
        const ids = jobs.map(j => j.job_id);

        if (ids.length === 0) return 0;

        // Delete associated files
        const uploadsPath = getUploadRoot();

        for (const job of jobs) {
            const patterns = [
                `${job.job_id}_${job.source_file_name}`,
                `${job.job_id}_${job.transformed_file_name}`,
            ].filter(Boolean);

            for (const p of patterns) {
                const fullPath = path.join(uploadsPath, p);
                try {
                    if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
                } catch { /* best effort */ }
            }
        }

        const idPlaceholders = ids.map(() => '?').join(',');

        dbRun(`DELETE FROM jobs WHERE job_id IN (${idPlaceholders})`, ids);
        dbRun(`DELETE FROM job_runs WHERE job_id IN (${idPlaceholders})`, ids);
        dbRun(`DELETE FROM events WHERE entity_type = 'job' AND entity_id IN (${idPlaceholders})`, ids);

        return ids.length;
    }

    static _parse(row) {
        return {
            ...row,
            transform_report: _pj(row.transform_report, null),
            diff_summary: _pj(row.diff_summary, null),
            ams_roles: _pj(row.ams_roles, null),
            metadata: _pj(row.metadata, null),
        };
    }
}

function _pj(v, fb) { if (!v) return fb; try { return JSON.parse(v); } catch { return fb; } }
export default JobModel;
