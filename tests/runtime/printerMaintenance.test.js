import { beforeAll, describe, expect, it } from 'vitest';

process.env.MOCK_MODE = 'true';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.DB_PATH = '/tmp/printer-maintenance-test.db';

let dbRun;
let PrinterMaintenanceModel;

beforeAll(async () => {
    const fs = await import('node:fs');
    for (const ext of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(process.env.DB_PATH + ext); } catch { /* fresh db */ }
    }
    const db = await import('../../src/db/database.js');
    await db.initDb();
    db.runMigrations();
    dbRun = db.dbRun;
    ({ PrinterMaintenanceModel } = await import('../../src/models/PrinterMaintenance.js'));

    dbRun('INSERT INTO printers (printer_id, name, model, ip_hostname) VALUES (?, ?, ?, ?)',
        ['m1', 'Maint One', 'Bambu P1S', '10.0.0.9']);
    // One completed run of exactly 250 hours (10 days 10 hours).
    dbRun('INSERT INTO jobs (job_id, name, printer_id, status) VALUES (?, ?, ?, ?)', ['mj1', 'j', 'm1', 'completed']);
    dbRun('INSERT INTO job_runs (run_id, job_id, printer_id, status, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)',
        ['mr1', 'mj1', 'm1', 'completed', '2026-06-01 00:00:00', '2026-06-11 10:00:00']);
});

describe('PrinterMaintenanceModel', () => {
    it('computes the odometer from completed print time', () => {
        expect(PrinterMaintenanceModel.odometerHours('m1')).toBeCloseTo(250, 1);
    });

    it('flags a task as due when interval is exceeded since last done', () => {
        const task = PrinterMaintenanceModel.create({ printer_id: 'm1', task: 'Lubricate rails', interval_hours: 200, hours_at_last_done: 0 });
        expect(task.hours_since_done).toBeCloseTo(250, 1);
        expect(task.due).toBe(true);
        expect(task.percent_used).toBe(100);
    });

    it('is not due when plenty of interval remains', () => {
        const task = PrinterMaintenanceModel.create({ printer_id: 'm1', task: 'Replace nozzle', interval_hours: 500, hours_at_last_done: 0 });
        expect(task.due).toBe(false);
        expect(task.hours_until_due).toBeCloseTo(250, 1);
    });

    it('markDone resets the baseline to the current odometer', () => {
        const task = PrinterMaintenanceModel.create({ printer_id: 'm1', task: 'Clean bed', interval_hours: 100, hours_at_last_done: 0 });
        expect(task.due).toBe(true);
        const done = PrinterMaintenanceModel.markDone(task.id);
        expect(done.hours_at_last_done).toBeCloseTo(250, 1);
        expect(done.hours_since_done).toBeCloseTo(0, 1);
        expect(done.due).toBe(false);
        expect(done.last_done_at).toBeTruthy();
    });

    it('lists only due tasks with dueOnly', () => {
        const due = PrinterMaintenanceModel.findAll({ printerId: 'm1', dueOnly: true });
        expect(due.every((t) => t.due)).toBe(true);
        // "Lubricate rails" (interval 200) is due; "Replace nozzle" (interval 500) is not.
        expect(due.some((t) => t.task === 'Lubricate rails')).toBe(true);
        expect(due.some((t) => t.task === 'Replace nozzle')).toBe(false);
    });
});
