// src/services/NotificationService.js — fan farm events out to human channels.
//
// Subscribes to the printer.alert event bus (the same one AlertDispatcher uses)
// and delivers a formatted message to every enabled channel subscribed to that
// event: Discord / Slack / Telegram / generic webhook. Channel URLs are
// SSRF-guarded; Telegram targets its fixed API host.
import systemEvents from '../utils/SystemEvents.js';
import { NotificationChannelModel } from '../models/NotificationChannel.js';
import { assertSafeWebhookUrl } from '../cloud/urlGuard.js';
import { createLogger } from '../utils/logger.js';

// Build the HTTP request for a channel + notification. Pure + exported for tests.
export function formatChannelMessage(channel, notification) {
    const title = notification.title || 'PrintKinetix';
    const message = notification.message || '';
    const config = channel.config || {};

    switch (channel.type) {
        case 'discord':
            return { url: config.url, body: { content: `**${title}**\n${message}` } };
        case 'slack':
            return { url: config.url, body: { text: `*${title}*\n${message}` } };
        case 'telegram':
            return {
                url: `https://api.telegram.org/bot${config.bot_token}/sendMessage`,
                body: { chat_id: config.chat_id, text: `${title}\n${message}` },
            };
        case 'webhook':
        default:
            return {
                url: config.url,
                body: {
                    event: notification.event,
                    title,
                    message,
                    severity: notification.severity || 'info',
                    data: notification.data || null,
                },
            };
    }
}

function alertToNotification(alert) {
    const printer = alert?.printer_name || alert?.printer_id || 'a printer';
    const canceled = alert?.kind === 'auto_canceled';
    return {
        event: canceled ? 'printer.auto_canceled' : 'printer.alert',
        title: canceled ? `Print auto-canceled on ${printer}` : `Printer alert: ${printer}`,
        message: alert?.message || alert?.kind || 'A printer reported a fault.',
        severity: alert?.severity || 'critical',
        data: alert,
    };
}

export function createNotificationDispatcher({
    fetchImpl = globalThis.fetch,
    events = systemEvents,
    model = NotificationChannelModel,
    timeoutMs = Number.parseInt(process.env.NOTIFY_TIMEOUT_MS || '', 10) || 8000,
    logger = createLogger('Notifications'),
} = {}) {
    async function deliverOne(channel, notification) {
        const { url, body } = formatChannelMessage(channel, notification);
        if (!url) return { channel_id: channel.channel_id, type: channel.type, ok: false, error: 'no_url' };

        // Guard operator-supplied URLs against SSRF. Telegram is a fixed host.
        if (channel.type !== 'telegram') {
            try { assertSafeWebhookUrl(url); }
            catch (error) { return { channel_id: channel.channel_id, type: channel.type, ok: false, error: error.message }; }
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetchImpl(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            const ok = !!(res && (res.ok || (res.status >= 200 && res.status < 300)));
            return { channel_id: channel.channel_id, type: channel.type, ok, status: res?.status };
        } catch (error) {
            return { channel_id: channel.channel_id, type: channel.type, ok: false, error: error.message };
        } finally {
            clearTimeout(timer);
        }
    }

    async function dispatch(notification) {
        const channels = model.findForEvent(notification.event);
        if (!channels.length) return [];
        return Promise.all(channels.map((c) => deliverOne(c, notification)));
    }

    const handler = (alert) => {
        dispatch(alertToNotification(alert)).catch((error) => logger.warn(`notify failed: ${error.message}`));
    };

    return {
        dispatch,          // notify programmatically / in tests
        deliverOne,        // exposed for tests
        start() {
            events.on('printer.alert', handler);
            logger.info('Notification dispatcher active (Discord/Slack/Telegram/webhook)');
            return this;
        },
        stop() { events.off('printer.alert', handler); },
    };
}

export default createNotificationDispatcher;
