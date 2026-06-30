// src/models/JobRun.js — Job run data access layer (sql.js API)
import { dbAll, dbGet, dbRun } from '../db/database.js';
import { generateId } from '../utils/uuid.js';

export class JobRunModel {
    static create({ job_id, printer_id }) {
        const id = generateId();
        dbRun(
            'INSERT INTO job_runs (run_id, job_id, printer_id) VALUES (?, ?, ?)',
            [id, job_id, printer_id]
        );
        return this.findById(id);
    }

    static findById(id) {
        const row = dbGet('SELECT * FROM job_runs WHERE run_id = ?', [id]);
        return row ? this._parse(row) : null;
    }

    static findByJobId(jobId) {
        return dbAll('SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC', [jobId]).map(r => this._parse(r));
    }

    static updateStatus(id, status, extra = {}) {
        const sets = ['status = ?'];
        const vals = [status];
        if (status === 'completed' || status === 'failed') {
            sets.push("ended_at = datetime('now')");
        }
        if (extra.result) { sets.push('result = ?'); vals.push(JSON.stringify(extra.result)); }
        if (extra.error) { sets.push('error = ?'); vals.push(extra.error); }
        vals.push(id);
        dbRun(`UPDATE job_runs SET ${sets.join(', ')} WHERE run_id = ?`, vals);
        return this.findById(id);
    }

    static _parse(row) {
        return { ...row, result: _pj(row.result, null) };
    }
}

function _pj(v, fb) { if (!v) return fb; try { return JSON.parse(v); } catch { return fb; } }
export default JobRunModel;
