import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createAlertDispatcher } from '../../src/services/AlertDispatcher.js';

const silentLogger = { info() {}, warn() {}, error() {} };
const alert = {
    printer_id: 'p1', printer_name: 'CamTest', severity: 'critical',
    kind: 'print_error', code: 83935248, message: 'MicroSD card read/write exception',
};

describe('AlertDispatcher', () => {
    it('delivers alerts to a configured HTTPS webhook with a signature', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
        const d = createAlertDispatcher({
            webhookUrl: 'https://hooks.example.com/alerts',
            secret: 'whsec_test',
            fetchImpl,
            events: new EventEmitter(),
            logger: silentLogger,
            now: () => new Date('2026-07-01T00:00:00.000Z'),
        });
        expect(d.enabled).toBe(true);

        const result = await d.deliver(alert);
        expect(result.delivered).toBe(true);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, opts] = fetchImpl.mock.calls[0];
        expect(url).toBe('https://hooks.example.com/alerts');
        expect(opts.method).toBe('POST');
        expect(opts.headers['X-Alert-Signature']).toMatch(/^v1=[a-f0-9]{64}$/);
        expect(JSON.parse(opts.body).alert.code).toBe(83935248);
    });

    it('fires on a printer.alert system event once started', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
        const events = new EventEmitter();
        const d = createAlertDispatcher({
            webhookUrl: 'https://hooks.example.com/alerts', secret: 's',
            fetchImpl, events, logger: silentLogger,
        });
        d.start();
        events.emit('printer.alert', alert);
        await new Promise((r) => setTimeout(r, 0));
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        d.stop();
        events.emit('printer.alert', alert);
        await new Promise((r) => setTimeout(r, 0));
        expect(fetchImpl).toHaveBeenCalledTimes(1); // no delivery after stop
    });

    it('rejects an internal/SSRF webhook URL and stays log-only', async () => {
        const fetchImpl = vi.fn();
        const d = createAlertDispatcher({
            webhookUrl: 'http://169.254.169.254/', fetchImpl,
            events: new EventEmitter(), logger: silentLogger,
        });
        expect(d.enabled).toBe(false);
        const result = await d.deliver(alert);
        expect(result.delivered).toBe(false);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('is inert (log-only) with no webhook configured', async () => {
        const fetchImpl = vi.fn();
        const d = createAlertDispatcher({
            webhookUrl: '', fetchImpl, events: new EventEmitter(), logger: silentLogger,
        });
        expect(d.enabled).toBe(false);
        const result = await d.deliver(alert);
        expect(result.delivered).toBe(false);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
