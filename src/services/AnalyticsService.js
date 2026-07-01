// src/services/AnalyticsService.js — fleet print-history analytics (read model).
//
// Aggregates the existing job_runs history into the success-rate / throughput /
// per-printer stats that OctoFarm, Mainsail/Fluidd, Repetier-Server and
// SimplyPrint surface. Pure reads — no schema changes.
import { dbAll, dbGet } from '../db/database.js';

// Minutes between started_at and ended_at for a completed run, computed in SQL.
const RUN_MINUTES = "(julianday(ended_at) - julianday(started_at)) * 24 * 60";

function sinceClause(since, column = "COALESCE(started_at, created_at)") {
    if (!since) return { sql: '', params: [] };
    return { sql: ` AND ${column} >= ?`, params: [since] };
}

function round(value, digits = 1) {
    if (value == null || Number.isNaN(value)) return 0;
    const f = 10 ** digits;
    return Math.round(value * f) / f;
}

export const AnalyticsService = {
    /** Fleet-wide totals: counts by status, success rate, print-time totals. */
    getSummary({ since = null } = {}) {
        const s = sinceClause(since);
        const row = dbGet(`
            SELECT
                COUNT(*)                                                        AS total,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)           AS completed,
                SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END)           AS failed,
                SUM(CASE WHEN status = 'canceled'  THEN 1 ELSE 0 END)           AS canceled,
                SUM(CASE WHEN status IN ('pending','printing') THEN 1 ELSE 0 END) AS active,
                SUM(CASE WHEN status = 'completed' AND started_at IS NOT NULL AND ended_at IS NOT NULL
                         THEN ${RUN_MINUTES} ELSE 0 END)                        AS total_minutes
            FROM job_runs
            WHERE 1=1${s.sql}
        `, s.params) || {};

        const completed = Number(row.completed || 0);
        const failed = Number(row.failed || 0);
        const finished = completed + failed;
        const totalMinutes = round(Number(row.total_minutes || 0), 1);

        return {
            total: Number(row.total || 0),
            completed,
            failed,
            canceled: Number(row.canceled || 0),
            active: Number(row.active || 0),
            success_rate: finished ? round((completed / finished) * 100, 1) : null,
            total_print_minutes: totalMinutes,
            total_print_hours: round(totalMinutes / 60, 2),
            avg_print_minutes: completed ? round(totalMinutes / completed, 1) : 0,
        };
    },

    /** Per-printer breakdown, newest activity first. */
    getPerPrinter({ since = null } = {}) {
        const s = sinceClause(since, "COALESCE(r.started_at, r.created_at)");
        const rows = dbAll(`
            SELECT
                r.printer_id                                                   AS printer_id,
                COALESCE(p.name, r.printer_id)                                  AS printer_name,
                p.model                                                         AS model,
                COUNT(*)                                                        AS total,
                SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END)         AS completed,
                SUM(CASE WHEN r.status = 'failed'    THEN 1 ELSE 0 END)         AS failed,
                SUM(CASE WHEN r.status = 'completed' AND r.started_at IS NOT NULL AND r.ended_at IS NOT NULL
                         THEN (julianday(r.ended_at) - julianday(r.started_at)) * 24 * 60 ELSE 0 END) AS total_minutes,
                MAX(COALESCE(r.ended_at, r.started_at, r.created_at))           AS last_activity
            FROM job_runs r
            LEFT JOIN printers p ON p.printer_id = r.printer_id
            WHERE 1=1${s.sql}
            GROUP BY r.printer_id
            ORDER BY last_activity DESC
        `, s.params);

        return rows.map((row) => {
            const completed = Number(row.completed || 0);
            const failed = Number(row.failed || 0);
            const finished = completed + failed;
            const totalMinutes = round(Number(row.total_minutes || 0), 1);
            return {
                printer_id: row.printer_id,
                printer_name: row.printer_name,
                model: row.model || null,
                total: Number(row.total || 0),
                completed,
                failed,
                success_rate: finished ? round((completed / finished) * 100, 1) : null,
                total_print_minutes: totalMinutes,
                total_print_hours: round(totalMinutes / 60, 2),
                last_activity: row.last_activity || null,
            };
        });
    },

    /** Most recent failed runs with error + printer, for a quick failure feed. */
    getRecentFailures({ limit = 20 } = {}) {
        const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);
        return dbAll(`
            SELECT r.run_id, r.job_id, r.printer_id,
                   COALESCE(p.name, r.printer_id) AS printer_name,
                   r.error, r.started_at, r.ended_at
            FROM job_runs r
            LEFT JOIN printers p ON p.printer_id = r.printer_id
            WHERE r.status = 'failed'
            ORDER BY COALESCE(r.ended_at, r.started_at, r.created_at) DESC
            LIMIT ?
        `, [safeLimit]);
    },

    /** Completed/failed counts per day for the last N days (activity chart). */
    getActivityByDay({ days = 14 } = {}) {
        const safeDays = Math.min(Math.max(parseInt(days, 10) || 14, 1), 365);
        return dbAll(`
            SELECT
                date(COALESCE(ended_at, started_at, created_at))              AS day,
                SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END)         AS completed,
                SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END)         AS failed
            FROM job_runs
            WHERE COALESCE(ended_at, started_at, created_at) >= date('now', ?)
            GROUP BY day
            ORDER BY day ASC
        `, [`-${safeDays} days`]);
    },
};

export default AnalyticsService;
