import { parseJsonBody } from './agentProtocol.js';
import {
    MerchantAuthError,
    authenticateMerchantRequest,
} from './merchantAuth.js';
import {
    getSupportedIntegrations,
    normalizeWebhookConfig,
    redactWebhookConfig,
} from './webhooks.js';

function sendJson(res, statusCode, payload) {
    if (typeof res.status === 'function' && typeof res.json === 'function') {
        return res.status(statusCode).json(payload);
    }
    res.statusCode = statusCode;
    if (typeof res.setHeader === 'function') res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(payload));
}

function methodNotAllowed(res, methods) {
    if (typeof res.setHeader === 'function') res.setHeader('Allow', methods);
    return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
}

function handleMerchantAuthError(res, error) {
    if (error instanceof MerchantAuthError) {
        return sendJson(res, error.statusCode, { ok: false, error: error.code });
    }
    return null;
}

export function createMerchantWebhooksHandler({
    store,
    pepper = process.env.MERCHANT_API_KEY_PEPPER || process.env.NODE_TOKEN_PEPPER,
    now = () => new Date(),
}) {
    if (!store) throw new Error('store is required');

    return async function merchantWebhooksHandler(req, res) {
        if (req.method && !['GET', 'POST'].includes(req.method)) {
            return methodNotAllowed(res, 'GET, POST');
        }

        try {
            const context = await authenticateMerchantRequest(req, { store, pepper, now });
            const current = context.merchant.metadata?.webhook || {};

            if (req.method === 'GET') {
                return sendJson(res, 200, {
                    ok: true,
                    webhook: redactWebhookConfig(current),
                });
            }

            const body = parseJsonBody(req.body);
            const webhook = normalizeWebhookConfig(body, current);
            const metadata = {
                ...(context.merchant.metadata || {}),
                webhook,
            };
            await store.updateMerchantMetadata(context.merchant.merchant_id, metadata);

            return sendJson(res, 200, {
                ok: true,
                webhook: redactWebhookConfig(webhook),
            });
        } catch (error) {
            const handled = handleMerchantAuthError(res, error);
            if (handled) return handled;
            return sendJson(res, 400, {
                ok: false,
                error: 'merchant_webhook_failed',
                message: error.message,
            });
        }
    };
}

export function createMerchantIntegrationsHandler() {
    return async function merchantIntegrationsHandler(req, res) {
        if (req.method && req.method !== 'GET') {
            return methodNotAllowed(res, 'GET');
        }

        return sendJson(res, 200, {
            ok: true,
            integrations: getSupportedIntegrations(),
        });
    };
}
