import { beforeAll, describe, expect, it, vi } from 'vitest';

process.env.MOCK_MODE = 'true';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.DB_PATH = '/tmp/notification-service-test.db';

let NotificationChannelModel;
let createNotificationDispatcher;
let formatChannelMessage;

beforeAll(async () => {
    const fs = await import('node:fs');
    for (const ext of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(process.env.DB_PATH + ext); } catch { /* fresh db */ }
    }
    const db = await import('../../src/db/database.js');
    await db.initDb();
    db.runMigrations();
    ({ NotificationChannelModel } = await import('../../src/models/NotificationChannel.js'));
    ({ createNotificationDispatcher, formatChannelMessage } = await import('../../src/services/NotificationService.js'));
});

describe('notification formatting', () => {
    it('shapes payloads per platform', () => {
        const n = { event: 'printer.alert', title: 'Alert', message: 'Printer down', severity: 'critical', data: { x: 1 } };
        expect(formatChannelMessage({ type: 'discord', config: { url: 'https://discord.com/api/webhooks/1/a' } }, n))
            .toEqual({ url: 'https://discord.com/api/webhooks/1/a', body: { content: '**Alert**\nPrinter down' } });
        expect(formatChannelMessage({ type: 'slack', config: { url: 'https://hooks.slack.com/x' } }, n))
            .toEqual({ url: 'https://hooks.slack.com/x', body: { text: '*Alert*\nPrinter down' } });
        const tg = formatChannelMessage({ type: 'telegram', config: { bot_token: 'TOK', chat_id: '42' } }, n);
        expect(tg.url).toBe('https://api.telegram.org/botTOK/sendMessage');
        expect(tg.body).toEqual({ chat_id: '42', text: 'Alert\nPrinter down' });
        const wh = formatChannelMessage({ type: 'webhook', config: { url: 'https://example.com/h' } }, n);
        expect(wh.url).toBe('https://example.com/h');
        expect(wh.body).toMatchObject({ event: 'printer.alert', title: 'Alert', severity: 'critical' });
    });
});

describe('notification dispatch', () => {
    it('delivers only to enabled channels subscribed to the event', async () => {
        const discord = NotificationChannelModel.create({ type: 'discord', config: { url: 'https://discord.com/api/webhooks/1/a' }, events: ['all'] });
        const slack = NotificationChannelModel.create({ type: 'slack', config: { url: 'https://hooks.slack.com/x' }, events: ['printer.alert'] });
        NotificationChannelModel.create({ type: 'webhook', config: { url: 'https://example.com/other' }, events: ['some.other.event'] });
        NotificationChannelModel.create({ type: 'discord', config: { url: 'https://discord.com/api/webhooks/2/b' }, events: ['all'], enabled: false });

        const calls = [];
        const fetchImpl = vi.fn(async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 204 }; });
        const dispatcher = createNotificationDispatcher({ fetchImpl });

        const results = await dispatcher.dispatch({ event: 'printer.alert', title: 'Down', message: 'p1 failed' });

        // discord (all) + slack (printer.alert) only — not the other-event webhook, not the disabled channel.
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        const urls = calls.map((c) => c.url).sort();
        expect(urls).toEqual(['https://discord.com/api/webhooks/1/a', 'https://hooks.slack.com/x']);
        expect(results.filter((r) => r.ok)).toHaveLength(2);
        expect(results.map((r) => r.channel_id).sort()).toEqual([discord.channel_id, slack.channel_id].sort());
    });

    it('refuses to deliver to an SSRF-unsafe channel URL', async () => {
        const bad = NotificationChannelModel.create({ type: 'webhook', config: { url: 'https://192.168.1.10/hook' }, events: ['test'] });
        const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
        const dispatcher = createNotificationDispatcher({ fetchImpl });

        const result = await dispatcher.deliverOne(NotificationChannelModel.findById(bad.channel_id), { event: 'test', title: 't', message: 'm' });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/private|internal|https/i);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
