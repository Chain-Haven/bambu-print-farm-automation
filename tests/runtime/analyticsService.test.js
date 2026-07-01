import { beforeAll, describe, expect, it } from 'vitest';

process.env.MOCK_MODE = 'true';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.DB_PATH = '/tmp/analytics-service-test.db';

let dbRun;
let AnalyticsService;

function seedRun({ runId, jobId, printerId, status, startedAt = null, endedAt = null, error = null }) {
    dbRun('INSERT INTO jobs (job_id, name, printer_id, status) VALUES (?, ?, ?, ?)',
        [jobId, `job-${jobId}`, printerId, 'completed']);
    dbRun(
        'INSERT INTO job_runs (run_id, job_id, printer_id, status, started_at, ended_at, error) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [runId, jobId, printerId, status, startedAt, endedAt, error],
    );
}

beforeAll(async () => {
    const fs = await import('node:fs');
    for (const ext of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(process.env.DB_PATH + ext); } catch { /* fresh db */ }
    }
    const db = await import('../../src/db/database.js');
    await db.initDb();
    db.runMigrations();
    dbRun = db.dbRun;
    ({ AnalyticsService } = await import('../../src/services/AnalyticsService.js'));

    dbRun('INSERT INTO printers (printer_id, name, model, ip_hostname) VALUES (?, ?, ?, ?)',
        ['p1', 'Alpha', 'Bambu P1S', '10.0.0.1']);
    dbRun('INSERT INTO printers (printer_id, name, model, ip_hostname) VALUES (?, ?, ?, ?)',
        ['p2', 'Bravo', 'Bambu A1', '10.0.0.2']);

    // p1: 2 completed (60 min + 30 min), 1 failed
    seedRun({ runId: 'r1', jobId: 'j1', printerId: 'p1', status: 'completed', startedAt: '2026-06-01 10:00:00', endedAt: '2026-06-01 11:00:00' });
    seedRun({ runId: 'r2', jobId: 'j2', printerId: 'p1', status: 'completed', startedAt: '2026-06-02 10:00:00', endedAt: '2026-06-02 10:30:00' });
    seedRun({ runId: 'r3', jobId: 'j3', printerId: 'p1', status: 'failed', startedAt: '2026-06-03 10:00:00', endedAt: '2026-06-03 10:05:00', error: 'MicroSD read error' });
    // p2: 1 completed (120 min), 1 canceled, 1 printing (active)
    seedRun({ runId: 'r4', jobId: 'j4', printerId: 'p2', status: 'completed', startedAt: '2026-06-04 08:00:00', endedAt: '2026-06-04 10:00:00' });
    seedRun({ runId: 'r5', jobId: 'j5', printerId: 'p2', status: 'canceled', startedAt: '2026-06-05 08:00:00' });
    seedRun({ runId: 'r6', jobId: 'j6', printerId: 'p2', status: 'printing', startedAt: '2026-06-06 08:00:00' });
});

describe('AnalyticsService', () => {
    it('summarizes counts, success rate, and print time across the fleet', () => {
        const s = AnalyticsService.getSummary();
        expect(s.total).toBe(6);
        expect(s.completed).toBe(3);
        expect(s.failed).toBe(1);
        expect(s.canceled).toBe(1);
        expect(s.active).toBe(1);
        // 3 completed / (3 completed + 1 failed) = 75%
        expect(s.success_rate).toBe(75);
        // 60 + 30 + 120 = 210 minutes of completed print time
        expect(s.total_print_minutes).toBe(210);
        expect(s.total_print_hours).toBe(3.5);
        expect(s.avg_print_minutes).toBe(70);
    });

    it('breaks stats down per printer, newest activity first', () => {
        const rows = AnalyticsService.getPerPrinter();
        expect(rows).toHaveLength(2);
        const byId = Object.fromEntries(rows.map((r) => [r.printer_id, r]));

        expect(byId.p1.printer_name).toBe('Alpha');
        expect(byId.p1.completed).toBe(2);
        expect(byId.p1.failed).toBe(1);
        expect(byId.p1.success_rate).toBe(66.7); // 2/3
        expect(byId.p1.total_print_minutes).toBe(90);

        expect(byId.p2.completed).toBe(1);
        expect(byId.p2.total_print_minutes).toBe(120);
        // p2's newest run (2026-06-06) is later than p1's, so p2 sorts first.
        expect(rows[0].printer_id).toBe('p2');
    });

    it('lists recent failures with printer + error', () => {
        const failures = AnalyticsService.getRecentFailures({ limit: 10 });
        expect(failures).toHaveLength(1);
        expect(failures[0].printer_name).toBe('Alpha');
        expect(failures[0].error).toContain('MicroSD');
    });

    it('buckets activity by day', () => {
        const days = AnalyticsService.getActivityByDay({ days: 3650 });
        const completedTotal = days.reduce((sum, d) => sum + Number(d.completed || 0), 0);
        expect(completedTotal).toBe(3);
    });
});
