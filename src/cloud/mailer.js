// Outbound email for auth flows (password resets, admin invites). No SMTP
// dependency: uses the Resend HTTP API when RESEND_API_KEY + EMAIL_FROM are
// set, otherwise runs disabled and logs the message so self-hosted operators
// can still find reset links in the server output. Callers must treat email as
// best-effort: auth responses never reveal whether a message was actually sent.

export function createMailer({
    apiKey = process.env.RESEND_API_KEY,
    from = process.env.EMAIL_FROM || process.env.MAIL_FROM,
    fetchImpl = globalThis.fetch,
    logger = console,
} = {}) {
    const enabled = Boolean(apiKey && from);

    return {
        enabled,
        async send({ to, subject, text, html = null }) {
            if (!to || !subject || !text) {
                throw new Error('mailer requires to, subject, and text');
            }

            if (!enabled) {
                if (typeof logger?.log === 'function') {
                    logger.log(`[mailer disabled] to=${to} subject="${subject}"\n${text}`);
                }
                return { sent: false, reason: 'mailer_not_configured' };
            }

            const response = await fetchImpl('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    from,
                    to: [to],
                    subject,
                    text,
                    ...(html ? { html } : {}),
                }),
            });

            if (!response.ok) {
                const detail = await response.text().catch(() => '');
                throw new Error(`mailer send failed (${response.status}): ${detail.slice(0, 200)}`);
            }

            return { sent: true };
        },
    };
}
