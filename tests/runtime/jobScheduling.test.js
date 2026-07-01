import { beforeAll, describe, expect, it } from 'vitest';

process.env.MOCK_MODE = 'true';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.DB_PATH = '/tmp/job-scheduling-test.db';

let dbRun;
let JobModel;

const NOW = new Date('2026-06-15T12:00:00.000Z');
const PAST = new Date('2026-06-14T12:00:00.000Z').toISOString();
const FUTURE = new Date('2026-06-16T12:00:00.000Z').toISOString();

beforeAll(async () => {
    const fs = await import('node:fs');
    for (const ext of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(process.env.DB_PATH + ext); } catch { /* fresh db */ }
    }
    const db = await import('../../src/db/database.js');
    await db.initDb();
    db.runMigrations();
    dbRun = db.dbRun;
    ({ JobModel } = await import('../../src/models/Job.js'));

    dbRun('INSERT INTO printers (printer_id, name, model, ip_hostname) VALUES (?, ?, ?, ?)',
        ['q1', 'Queue One', 'Bambu P1S', '10.0.0.7']);
});

describe('Job scheduling + priority', () => {
    it('stores priority and scheduled_for on create', () => {
        const job = JobModel.create({ name: 'A', printer_id: 'q1', priority: 3, scheduled_for: FUTURE });
        expect(job.priority).toBe(3);
        expect(job.scheduled_for).toBe(FUTURE);
    });

    it('isReady excludes future-scheduled jobs', () => {
        const future = JobModel.create({ name: 'future', printer_id: 'q1', scheduled_for: FUTURE });
        const past = JobModel.create({ name: 'past', printer_id: 'q1', scheduled_for: PAST });
        const immediate = JobModel.create({ name: 'now', printer_id: 'q1' });
        expect(JobModel.isReady(future, NOW)).toBe(false);
        expect(JobModel.isReady(past, NOW)).toBe(true);
        expect(JobModel.isReady(immediate, NOW)).toBe(true);
    });

    it('ready queue orders by priority and excludes future jobs', () => {
        // Fresh printer to isolate ordering.
        dbRun('INSERT INTO printers (printer_id, name, model, ip_hostname) VALUES (?, ?, ?, ?)',
            ['q2', 'Queue Two', 'Bambu P1S', '10.0.0.8']);
        const low = JobModel.create({ name: 'low', printer_id: 'q2', priority: 0 });
        const high = JobModel.create({ name: 'high', printer_id: 'q2', priority: 10 });
        const deferred = JobModel.create({ name: 'deferred', printer_id: 'q2', priority: 99, scheduled_for: FUTURE });
        const dueNow = JobModel.create({ name: 'dueNow', printer_id: 'q2', priority: 5, scheduled_for: PAST });

        const ready = JobModel.getReadyQueue('q2', NOW);
        const names = ready.map((j) => j.name);

        // deferred (future) is excluded despite priority 99.
        expect(names).not.toContain('deferred');
        // priority order: high(10) > dueNow(5) > low(0)
        expect(names).toEqual(['high', 'dueNow', 'low']);
        expect(ready.map((j) => j.job_id)).toContain(dueNow.job_id);
        expect(high.priority).toBe(10);
    });
});
