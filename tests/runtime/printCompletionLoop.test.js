import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The hands-off production loop: a printer reporting FINISH must resolve the
// active job (PrinterWorker completion detection) and drive
// JobOrchestrator.onJobCompleted — ejection, repeat, auto-start-next. These
// tests cover the completion producer and the orchestrator consumer that were
// previously orphaned (finished prints stayed "printing" forever).

process.env.MOCK_MODE = 'true';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.DB_PATH = '/tmp/print-completion-loop-test.db';

let PrinterWorker;
let JobOrchestrator;
let JobModel;
let systemEvents;
let executeEjectionSequence;

beforeAll(async () => {
    const db = await import('../../src/db/database.js');
    await db.initDb();
    db.runMigrations();
    ({ PrinterWorker } = await import('../../src/runtime/PrinterWorker.js'));
    ({ JobOrchestrator } = await import('../../src/services/JobOrchestrator.js'));
    ({ JobModel } = await import('../../src/models/Job.js'));
    ({ default: systemEvents } = await import('../../src/utils/SystemEvents.js'));
    ({ executeEjectionSequence } = await import('../../src/services/EjectionService.js'));
});

afterAll(() => {
    systemEvents.removeAllListeners();
});

function makeWorker(id) {
    const worker = new PrinterWorker({ printer_id: id, name: `Test-${id}`, model: 'Bambu A1' });
    const finishes = [];
    worker.onJobFinished = (finish) => finishes.push(finish);
    return { worker, finishes };
}

describe('PrinterWorker completion detection', () => {
    it('fires onJobFinished(completed) when a print we started reports FINISH', () => {
        const { worker, finishes } = makeWorker('cw1');
        worker.state = 'printing';
        worker.activeJobId = 'job-1';

        worker._handleStatus({ print: { gcode_state: 'FINISH' } });

        expect(finishes).toEqual([{ job_id: 'job-1', printer_id: 'cw1', outcome: 'completed' }]);
        expect(worker.activeJobId).toBeNull();
    });

    it('classifies idle-without-FINISH as an abort (stopped on-device)', () => {
        const { worker, finishes } = makeWorker('cw2');
        worker.state = 'printing';
        worker.activeJobId = 'job-2';

        worker._handleStatus({ print: { gcode_state: 'IDLE' } });

        expect(finishes).toEqual([{ job_id: 'job-2', printer_id: 'cw2', outcome: 'aborted' }]);
    });

    it('classifies FAILED with an active error code as a failure', () => {
        const { worker, finishes } = makeWorker('cw3');
        worker.state = 'printing';
        worker.activeJobId = 'job-3';

        worker._handleStatus({ print: { gcode_state: 'FAILED', print_error: 83935248 } });

        expect(finishes).toEqual([{ job_id: 'job-3', printer_id: 'cw3', outcome: 'failed' }]);
    });

    it('treats FAILED with NO active error as a dismissed cancel: worker reads idle, job aborts', () => {
        // Bambu holds gcode_state=FAILED after any cancel until the screen is
        // tapped. With no active print_error that is residue, not a fault —
        // the printer must read as available (idle) or the whole farm queue
        // would wait on a human tap.
        const { worker, finishes } = makeWorker('cw3b');
        worker.state = 'printing';
        worker.activeJobId = 'job-3b';

        worker._handleStatus({ print: { gcode_state: 'FAILED' } });

        expect(worker.state).toBe('idle');
        expect(finishes).toEqual([{ job_id: 'job-3b', printer_id: 'cw3b', outcome: 'aborted' }]);
    });

    it('keeps the job active across an offline transition (MQTT drop mid-print)', () => {
        const { worker, finishes } = makeWorker('cw4');
        worker.state = 'printing';
        worker.activeJobId = 'job-4';

        worker._transitionState('offline');

        expect(finishes).toEqual([]);
        expect(worker.activeJobId).toBe('job-4');
    });

    it('does not fire when no job was started by the orchestrator', () => {
        const { worker, finishes } = makeWorker('cw5');
        worker.state = 'printing';
        worker.activeJobId = null;

        worker._handleStatus({ print: { gcode_state: 'FINISH' } });

        expect(finishes).toEqual([]);
    });
});

describe('JobOrchestrator completion handling', () => {
    function createPrintingJob(overrides = {}) {
        const job = JobModel.create({
            name: 'loop-test',
            printer_id: 'printer-x',
            profile_id: null, // no profile → ejection step skipped (covered separately)
            source_file_name: 'part.gcode.3mf',
            ams_roles: null,
            repeat_total: overrides.repeat_total || 1,
        });
        JobModel.update(job.job_id, { status: 'printing', ...overrides.updates });
        return JobModel.findById(job.job_id);
    }

    it('marks a finished single job completed and emits job.completed', async () => {
        const job = createPrintingJob();
        const completed = [];
        const listener = (payload) => completed.push(payload);
        systemEvents.on('job.completed', listener);

        await JobOrchestrator.onJobCompleted(job.job_id, 'printer-x');

        systemEvents.off('job.completed', listener);
        const after = JobModel.findById(job.job_id);
        expect(after.status).toBe('completed');
        expect(after.repeat_remaining).toBe(0);
        expect(completed).toHaveLength(1);
        expect(completed[0].job.job_id).toBe(job.job_id);
    });

    it('restarts the job for remaining repeats instead of completing', async () => {
        const job = createPrintingJob({ repeat_total: 3 });
        const startJob = vi.spyOn(JobOrchestrator, 'startJob').mockResolvedValue({});

        await JobOrchestrator.onJobCompleted(job.job_id, 'printer-x');

        const after = JobModel.findById(job.job_id);
        expect(after.status).toBe('assigned');
        expect(after.repeat_remaining).toBe(2);
        expect(startJob).toHaveBeenCalledWith(job.job_id);
        startJob.mockRestore();
    });

    it('ignores duplicate completion signals (idempotency)', async () => {
        const job = createPrintingJob();
        await JobOrchestrator.onJobCompleted(job.job_id, 'printer-x');
        const startJob = vi.spyOn(JobOrchestrator, 'startJob').mockResolvedValue({});

        await JobOrchestrator.onJobCompleted(job.job_id, 'printer-x'); // duplicate

        expect(JobModel.findById(job.job_id).status).toBe('completed');
        expect(startJob).not.toHaveBeenCalled();
        startJob.mockRestore();
    });

    it('marks an aborted print failed and does not auto-start the next job', async () => {
        const job = createPrintingJob();
        const failed = [];
        const listener = (payload) => failed.push(payload);
        systemEvents.on('job.failed', listener);
        const startJob = vi.spyOn(JobOrchestrator, 'startJob').mockResolvedValue({});

        await JobOrchestrator.onJobAborted(job.job_id, 'printer-x', 'aborted');

        systemEvents.off('job.failed', listener);
        expect(JobModel.findById(job.job_id).status).toBe('failed');
        expect(startJob).not.toHaveBeenCalled();
        expect(failed).toHaveLength(1);
        startJob.mockRestore();
    });
});

describe('EjectionService without a hardware ejector', () => {
    it('returns immediately (skipped) instead of polling the cool-down loop', async () => {
        const started = Date.now();
        const result = await executeEjectionSequence({
            job_id: 'job-eject-1',
            printer_id: 'printer-without-ejector',
            profile: { release_bed_temp_c: 27, max_cool_wait_minutes: 45 },
        });

        expect(result.success).toBe(false);
        expect(result.skipped).toBe(true);
        // must not have entered the 5s-interval cool-down polling loop
        expect(Date.now() - started).toBeLessThan(2000);
    });
});
