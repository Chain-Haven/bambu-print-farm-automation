// AlertDispatcher — delivers printer failure alerts off-screen.
//
// PrinterWorker emits `printer.alert` on SystemEvents when a blocking fault is
// detected mid-print (and again when it auto-cancels). Without a subscriber those
// alerts only reach a dashboard someone happens to be watching. This service
// subscribes and forwards each alert to an operator-configured webhook
// (Slack/Discord/email relay/etc.), HMAC-signed and SSRF-guarded, so an
// unattended farm actually notifies someone.
//
// Config (all optional; dispatcher is inert if no URL is set):
//   ALERT_WEBHOOK_URL     — HTTPS endpoint to POST alerts to
//   ALERT_WEBHOOK_SECRET  — HMAC-SHA256 signing secret (falls back to a warning)
//   ALERT_WEBHOOK_TIMEOUT_MS (default 8000)

import systemEvents from '../utils/SystemEvents.js';
import { signWebhookPayload } from '../cloud/webhooks.js';
import { assertSafeWebhookUrl } from '../cloud/urlGuard.js';
import { createLogger } from '../utils/logger.js';

export function createAlertDispatcher({
    webhookUrl = process.env.ALERT_WEBHOOK_URL,
    secret = process.env.ALERT_WEBHOOK_SECRET,
    timeoutMs = Number.parseInt(process.env.ALERT_WEBHOOK_TIMEOUT_MS || '', 10) || 8000,
    fetchImpl = globalThis.fetch,
    events = systemEvents,
    logger = createLogger('AlertDispatcher'),
    now = () => new Date(),
} = {}) {
    let safeUrl = null;
    if (webhookUrl) {
        try {
            safeUrl = assertSafeWebhookUrl(webhookUrl);
        } catch (error) {
            logger.warn(`ALERT_WEBHOOK_URL rejected (${error.message}); webhook alerts disabled.`);
        }
    }

    async function deliver(alert) {
        // Always log — this is the last-resort record even with no webhook.
        const line = `ALERT [${alert?.severity || 'critical'}] ${alert?.printer_name || alert?.printer_id}: ${alert?.message || alert?.kind}`;
        logger.warn(line);

        if (!safeUrl || typeof fetchImpl !== 'function') return { delivered: false, reason: 'no_sink' };

        const timestamp = Math.floor(now().getTime() / 1000).toString();
        const body = JSON.stringify({ type: 'printer.alert', alert, sent_at: now().toISOString() });
        const headers = { 'Content-Type': 'application/json', 'X-Alert-Timestamp': timestamp };
        if (secret) {
            headers['X-Alert-Signature'] = signWebhookPayload({ secret, timestamp, body });
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const res = await fetchImpl(safeUrl, { method: 'POST', headers, body, signal: controller.signal });
            const ok = !!(res && (res.ok || (res.status >= 200 && res.status < 300)));
            if (!ok) logger.warn(`Alert webhook returned ${res?.status}`);
            return { delivered: ok, status: res?.status };
        } catch (error) {
            logger.warn(`Alert webhook delivery failed: ${error.message}`);
            return { delivered: false, reason: error.message };
        } finally {
            clearTimeout(timer);
        }
    }

    const handler = (alert) => { deliver(alert).catch(() => { /* logged in deliver */ }); };

    return {
        deliver, // exposed for tests / manual dispatch
        enabled: !!safeUrl,
        start() {
            events.on('printer.alert', handler);
            logger.info(safeUrl ? `Alert dispatcher active → ${safeUrl}` : 'Alert dispatcher active (log-only; set ALERT_WEBHOOK_URL to notify externally)');
            return this;
        },
        stop() { events.off('printer.alert', handler); },
    };
}
