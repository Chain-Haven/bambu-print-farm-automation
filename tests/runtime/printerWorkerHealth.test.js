import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

process.env.MOCK_MODE = 'true';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.DB_PATH = process.env.DB_PATH || '/tmp/pw-health-test.db';

let PrinterWorker;

beforeAll(async () => {
    const db = await import('../../src/db/database.js');
    await db.initDb();
    db.runMigrations();
    ({ PrinterWorker } = await import('../../src/runtime/PrinterWorker.js'));
});

afterAll(() => { delete process.env.PRINTER_STALE_REPORT_MS; });

function makeWorker(id = 'ph') {
    const w = new PrinterWorker({ printer_id: id, name: `Test-${id}`, model: 'Bambu P1S' });
    w.mockMode = false; // exercise the real health path
    return w;
}

describe('PrinterWorker self-healing health check', () => {
    it('nudges a hung printer (socket up, stale reports) with a status refresh', async () => {
        const w = makeWorker('ph1');
        const requestStatus = vi.fn().mockReturnValue(true);
        w.mqttClient = { connected: true, requestStatus };
        w.connected = true;
        w.staleReportMs = 1000;
        w.lastReportTime = Date.now() - 5000; // 5s stale

        await w.healthCheck();
        expect(requestStatus).toHaveBeenCalled();
    });

    it('does not nudge a healthy printer reporting recently', async () => {
        const w = makeWorker('ph2');
        const requestStatus = vi.fn();
        w.mqttClient = { connected: true, requestStatus };
        w.connected = true;
        w.staleReportMs = 60000;
        w.lastReportTime = Date.now(); // fresh

        await w.healthCheck();
        expect(requestStatus).not.toHaveBeenCalled();
    });

    it('marks a dropped printer offline and notifies the UI', async () => {
        const w = makeWorker('ph3');
        w.mqttClient = { connected: false };
        w.connected = true; // was connected
        const updates = [];
        w.onStatusUpdate = (s) => updates.push(s);

        await w.healthCheck();
        expect(w.connected).toBe(false);
        expect(w.state).toBe('offline');
        expect(updates.at(-1)).toMatchObject({ state: 'offline' });
    });

    it('attempts self-heal reconnect but creates no client without auth', async () => {
        const w = makeWorker('ph4'); // no printer row -> getAuth returns null
        w.mqttClient = null;

        await w.healthCheck();
        expect(w.mqttClient).toBeNull(); // nothing to connect with; no crash
        expect(w._lastReconnectAt).toBeGreaterThan(0); // throttle timestamp recorded
    });
});
