import { beforeAll, describe, expect, it } from 'vitest';
import { AmsService } from '../../src/services/AmsService.js';

process.env.MOCK_MODE = 'true';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.DB_PATH = process.env.DB_PATH || '/tmp/pw-control-test.db';

let PrinterWorker;

beforeAll(async () => {
    const db = await import('../../src/db/database.js');
    await db.initDb();
    db.runMigrations();
    ({ PrinterWorker } = await import('../../src/runtime/PrinterWorker.js'));
});

describe('preflight HMS handling', () => {
    it('does not throw on numeric HMS codes and flags an SD/storage fault', () => {
        const w = new PrinterWorker({ printer_id: 'ctl1', name: 'Ctl', model: 'Bambu P1S' });
        w.state = 'printing';
        w.connected = true;
        // Bambu sends numeric attr/code — previously .toLowerCase() threw here.
        w.latestStatus = { hms_errors: [{ attr: 0x03000300, code: 196869 }], print_error: 83935248 };
        let pf;
        expect(() => { pf = w.getPreflightStatus(); }).not.toThrow();
        expect(pf.errors.some((e) => /SD|Storage|BLOCKED/i.test(e))).toBe(true);
    });
});

describe('AmsService._configMatchesLive', () => {
    it('treats a subtype config as in-sync with its base live tray type', () => {
        // "PLA Silk" (config) loaded as tray type "PLA" (live) — in sync.
        expect(AmsService._configMatchesLive({ material: 'PLA Silk' }, { type: 'PLA' })).toBe(true);
        expect(AmsService._configMatchesLive({ material: 'PETG HF' }, { type: 'PETG' })).toBe(true);
    });

    it('flags a genuine material mismatch as out-of-sync', () => {
        expect(AmsService._configMatchesLive({ material: 'PETG' }, { type: 'PLA' })).toBe(false);
    });

    it('is in-sync when nothing is configured or nothing is loaded', () => {
        expect(AmsService._configMatchesLive(null, { type: 'PLA' })).toBe(true);
        expect(AmsService._configMatchesLive({ material: 'PLA' }, {})).toBe(true);
    });
});

describe('PrinterWorker.canControl', () => {
    it('is controllable in mock mode and when the mqtt client is connected', () => {
        const w = new PrinterWorker({ printer_id: 'ctl2', name: 'Ctl2', model: 'Bambu P1S' });
        expect(w.canControl()).toBe(true); // mock
        w.mockMode = false;
        w.mqttClient = null;
        expect(w.canControl()).toBe(false);
        w.mqttClient = { connected: true };
        expect(w.canControl()).toBe(true);
    });
});
