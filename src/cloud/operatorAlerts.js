// src/cloud/operatorAlerts.js — push farm events to the operator.
//
// An unattended farm makes decisions worth knowing about: a job failed its
// last retry, a filament order parked over budget, a customer paid, an order
// shipped. Channels come from the existing `farm_integrations.alerts` list:
//   { "type": "discord", "url": "https://discord.com/api/webhooks/…" }
//   { "type": "slack",   "url": "https://hooks.slack.com/services/…" }
//   { "type": "webhook", "url": "https://…" }        (raw JSON POST)
//   { "type": "email",   "email": "ops@farm.com" }    (Resend mailer)
// Every send is best-effort and bounded — alerting must never break the
// pipeline that triggered it.

const FARM_INTEGRATIONS_KEY = 'farm_integrations';
const MAX_CHANNELS = 8;

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

export function formatAlertText(event) {
    const title = event?.title || 'Farm event';
    const detail = event?.detail ? `\n${event.detail}` : '';
    return `[PrintKinetix] ${title}${detail}`;
}

async function postJson(fetchImpl, url, body) {
    const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`alert webhook HTTP ${response.status}`);
}

/**
 * Fan an event out to every configured alert channel.
 * event: { kind, title, detail?, severity? ('info'|'warning'|'critical') }
 * Returns { delivered, failed } counts; never throws.
 */
export async function sendOperatorAlert({
    store,
    event,
    fetchImpl = fetch,
    mailer = null,
} = {}) {
    if (!store || typeof store.getPlatformSetting !== 'function' || !event) {
        return { delivered: 0, failed: 0 };
    }

    let channels = [];
    try {
        const integrations = await store.getPlatformSetting(FARM_INTEGRATIONS_KEY, {});
        channels = asArray(isPlainObject(integrations) ? integrations.alerts : [])
            .filter((channel) => isPlainObject(channel) && channel.enabled !== false)
            .slice(0, MAX_CHANNELS);
    } catch {
        return { delivered: 0, failed: 0 };
    }
    if (channels.length === 0) return { delivered: 0, failed: 0 };

    const text = formatAlertText(event);
    let delivered = 0;
    let failed = 0;

    for (const channel of channels) {
        try {
            const type = String(channel.type || '').toLowerCase();
            if (type === 'discord' && channel.url) {
                await postJson(fetchImpl, channel.url, { content: text.slice(0, 1900) });
            } else if (type === 'slack' && channel.url) {
                await postJson(fetchImpl, channel.url, { text });
            } else if (type === 'webhook' && channel.url) {
                await postJson(fetchImpl, channel.url, {
                    source: 'printkinetix',
                    kind: event.kind || 'farm.event',
                    severity: event.severity || 'info',
                    title: event.title,
                    detail: event.detail || null,
                    occurred_at: new Date().toISOString(),
                });
            } else if (type === 'email' && channel.email && mailer) {
                await mailer.send({
                    to: channel.email,
                    subject: `[PrintKinetix] ${event.title}`,
                    text: event.detail || event.title,
                });
            } else {
                continue; // unknown/misconfigured channel — skip silently
            }
            delivered += 1;
        } catch {
            failed += 1; // one broken channel must not stop the rest
        }
    }

    return { delivered, failed };
}
