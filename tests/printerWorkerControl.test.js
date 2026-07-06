import { describe, expect, it, beforeEach, afterEach } from 'vitest';

// Run the worker in mock mode so manualControl exercises its gating without
// touching MQTT/DB. MOCK_MODE is read in the constructor.
let PrinterWorker;
beforeEach(async () => {
    process.env.MOCK_MODE = 'true';
    ({ PrinterWorker } = await import('../src/runtime/PrinterWorker.js'));
});
afterEach(() => { delete process.env.MOCK_MODE; });

function worker(state = 'idle') {
    const w = new PrinterWorker({ printer_id: 'p1', name: 'A1' });
    w.state = state;
    return w;
}

describe('PrinterWorker.manualControl (unified, state-gated)', () => {
    it('allows safe controls when idle', () => {
        expect(worker('idle').manualControl({ action: 'light_on' })).toMatchObject({ ok: true, action: 'light_on' });
    });

    it('refuses motion/temperature actions while printing', () => {
        for (const action of ['home', 'move', 'set_nozzle_temp', 'load_filament', 'bed_level']) {
            expect(() => worker('printing').manualControl({ action })).toThrow(/while the printer is printing/);
        }
    });

    it('allows mid-print-safe actions while printing', () => {
        const w = worker('printing');
        for (const action of ['set_speed_override', 'set_flow_override', 'set_z_offset', 'light_on', 'set_xcam', 'skip_objects']) {
            expect(w.manualControl({ action, obj_list: [1] }).ok).toBe(true);
        }
    });

    it('rejects an unknown action (even in mock mode)', () => {
        expect(() => worker('idle').manualControl({ action: 'launch_rocket' })).toThrow(/Unknown control action/);
        expect(() => worker('idle').manualControl({})).toThrow(/required/);
    });
});
