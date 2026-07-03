import { createRequestId } from './httpServerUtils.js';
import { getSupportedIntegrations } from './webhooks.js';

// NOTE: the legacy v1 webhook *config* handler (merchants.metadata.webhook)
// was retired — webhook endpoints are managed via the v2 API at
// /api/public/webhooks/*. Outbound v1 deliveries (deliverMerchantWebhook)
// still honor any previously-stored metadata.webhook config.

function sendJson(res, statusCode, payload) {
    if (typeof res.status === 'function' && typeof res.json === 'function') {
        return res.status(statusCode).json(payload);
    }
    res.statusCode = statusCode;
    if (typeof res.setHeader === 'function') res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(payload));
}

function methodNotAllowed(res, methods, requestId = createRequestId()) {
    if (typeof res.setHeader === 'function') res.setHeader('Allow', methods);
    return sendJson(res, 405, {
        ok: false,
        error: 'method_not_allowed',
        message: 'Method not allowed',
        request_id: requestId,
    });
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
