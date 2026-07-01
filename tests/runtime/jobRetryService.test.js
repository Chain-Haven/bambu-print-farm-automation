import { beforeAll, describe, expect, it } from 'vitest';
import { shouldRetry, isNonRetryableError } from '../../src/services/JobRetryService.js';

process.env.MOCK_MODE = 'true';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.DB_PATH = '/tmp/job-retry-test.db';

let dbRun;
let JobModel;
let JobRetryService;

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
    ({ JobRetryService } = await import('../../src/services/JobRetryService.js'));

    dbRun('INSERT INTO printers (printer_id, name, model, ip_hostname) VALUES (?, ?, ?, ?)',
        ['rp1', 'Retry One', 'Bambu P1S', '10.0.0.5']);
});

describe('shouldRetry (pure)', () => {
    it('is off by default (retries disabled)', () => {
        expect(shouldRetry({ attemptCount: 1, maxRetries: 0, error: 'boom' }).retry).toBe(false);
    });
    it('retries while attempts remain', () => {
        expect(shouldRetry({ attemptCount: 1, maxRetries: 2, error: 'timeout' }).retry).toBe(true);
        expect(shouldRetry({ attemptCount: 2, maxRetries: 2, error: 'timeout' }).retry).toBe(true);
        expect(shouldRetry({ attemptCount: 3, maxRetries: 2, error: 'timeout' }).retry).toBe(false);
    });
    it('never retries known-blocking hardware faults', () => {
        expect(isNonRetryableError('0500-C010 (MicroSD card read/write exception)')).toBe(true);
        expect(shouldRetry({ attemptCount: 1, maxRetries: 5, error: 'MicroSD card read/write exception' }).retry).toBe(false);
    });
    it('force overrides everything', () => {
        expect(shouldRetry({ attemptCount: 9, maxRetries: 0, error: 'SD card', force: true }).retry).toBe(true);
    });
});

describe('JobRetryService.maybeRequeue', () => {
    function seedFailedJob({ maxRetries = 0, attempts = 1 }) {
        const job = JobModel.create({ name: 'j', printer_id: 'rp1', max_retries: maxRetries });
        JobModel.update(job.job_id, { status: 'failed' });
        for (let i = 0; i < attempts; i++) {
            dbRun('INSERT INTO job_runs (run_id, job_id, printer_id, status) VALUES (?, ?, ?, ?)',
                [`${job.job_id}-r${i}`, job.job_id, 'rp1', 'failed']);
        }
        return job;
    }

    it('does not requeue when retries are disabled', () => {
        const job = seedFailedJob({ maxRetries: 0, attempts: 1 });
        const r = JobRetryService.maybeRequeue(job.job_id, { error: 'timeout' });
        expect(r.requeued).toBe(false);
        expect(JobModel.findById(job.job_id).status).toBe('failed');
    });

    it('requeues an eligible job back to queued', () => {
        const job = seedFailedJob({ maxRetries: 2, attempts: 1 });
        const r = JobRetryService.maybeRequeue(job.job_id, { error: 'ftps timeout' });
        expect(r.requeued).toBe(true);
        expect(r.attempt).toBe(1);
        expect(JobModel.findById(job.job_id).status).toBe('queued');
    });

    it('stops after exhausting retries', () => {
        const job = seedFailedJob({ maxRetries: 2, attempts: 3 });
        const r = JobRetryService.maybeRequeue(job.job_id, { error: 'timeout' });
        expect(r.requeued).toBe(false);
        expect(r.reason).toBe('retries_exhausted');
    });

    it('skips requeue for blocking hardware faults even with retries left', () => {
        const job = seedFailedJob({ maxRetries: 5, attempts: 1 });
        const r = JobRetryService.maybeRequeue(job.job_id, { error: '0500-C010 MicroSD card read/write exception' });
        expect(r.requeued).toBe(false);
        expect(r.reason).toBe('non_retryable_error');
    });
});
