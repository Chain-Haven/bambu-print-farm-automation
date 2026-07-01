import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// Camera/logs/motor-stat driven safety: a NEW blocking print_error during an
// active print must alert and (by default) auto-cancel. These tests exercise
// PrinterWorker._checkForFailures through the real _handleStatus path.

process.env.MOCK_MODE = 'true';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.DB_PATH = process.env.DB_PATH || '/tmp/pw-failure-test.db';

let PrinterWorker;

beforeAll(async () => {
    const db = await import('../../src/db/database.js');
    await db.initDb();
    db.runMigrations();
    ({ PrinterWorker } = await import('../../src/runtime/PrinterWorker.js'));
});

afterAll(() => {
    delete process.env.AUTO_CANCEL_ON_FAILURE;
});

const SD_ERROR = 83935248; // 0x0500C010 — MicroSD read/write exception (blocking)
const SD_ERROR_2 = 83935249; // a different blocking code

function makeWorker(id = 'p-fail') {
    const w = new PrinterWorker({ printer_id: id, name: `Test-${id}`, model: 'Bambu P1S' });
    const alerts = [];
    w.onAlert = (a) => alerts.push(a);
    return { w, alerts };
}

describe('PrinterWorker failure detection', () => {
    beforeEach(() => {
        delete process.env.AUTO_CANCEL_ON_FAILURE;
    });

    it('alerts and auto-cancels on a blocking error during an active print', () => {
        const { w, alerts } = makeWorker('p1');
        w.state = 'printing';
        w.activeJobId = 'job-1';

        w._handleStatus({ print: { print_error: SD_ERROR } });

        expect(alerts.some((a) => a.kind === 'print_error')).toBe(true);
        expect(alerts.some((a) => a.kind === 'auto_canceled')).toBe(true);
        expect(w.state).toBe('idle'); // stopped
        const first = alerts.find((a) => a.kind === 'print_error');
        expect(first.severity).toBe('critical');
        expect(first.message).toBeTruthy();
        expect(Array.isArray(first.remediation)).toBe(true);
    });

    it('does not fire twice for the same unchanged error code', () => {
        const { w, alerts } = makeWorker('p2');
        w.state = 'printing';
        w.activeJobId = 'job-2';
        w._handleStatus({ print: { print_error: SD_ERROR } });
        const count = alerts.length;
        w.state = 'printing';
        w._handleStatus({ print: { print_error: SD_ERROR } });
        expect(alerts.length).toBe(count);
    });

    it('re-alerts after the error clears and a new fault appears', () => {
        const { w, alerts } = makeWorker('p3');
        w.state = 'printing';
        w.activeJobId = 'job-3';
        w._handleStatus({ print: { print_error: SD_ERROR } });
        const count = alerts.length;
        w._handleStatus({ print: { print_error: 0 } }); // cleared
        w.state = 'printing';
        w._handleStatus({ print: { print_error: SD_ERROR_2 } });
        expect(alerts.length).toBeGreaterThan(count);
    });

    it('does not auto-cancel an idle printer (stale error path)', () => {
        const { w, alerts } = makeWorker('p4');
        w.state = 'idle';
        w.activeJobId = null;
        w._handleStatus({ print: { print_error: SD_ERROR } });
        expect(alerts.length).toBe(0);
    });

    it('alerts but does not cancel when AUTO_CANCEL_ON_FAILURE=false', () => {
        process.env.AUTO_CANCEL_ON_FAILURE = 'false';
        const { w, alerts } = makeWorker('p5');
        w.state = 'printing';
        w.activeJobId = 'job-5';
        w._handleStatus({ print: { print_error: SD_ERROR } });
        expect(alerts.some((a) => a.kind === 'print_error')).toBe(true);
        expect(alerts.some((a) => a.kind === 'auto_canceled')).toBe(false);
        expect(w.state).toBe('printing');
    });
});
