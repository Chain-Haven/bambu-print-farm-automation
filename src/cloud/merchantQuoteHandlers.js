import { parseJsonBody } from './agentProtocol.js';
import {
    MerchantAuthError,
    authenticateMerchantRequest,
} from './merchantAuth.js';
import { routeMerchantPrintJob } from './merchantRouting.js';
import { buildPrintPreflight, estimatePrintQuote } from './quoteEstimator.js';
import { classifyFileName, normalizeRoutingStrategy } from './printIntake.js';

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

function getMaxBuildVolume(overview = {}) {
    const max = { x: 0, y: 0, z: 0 };
    for (const printer of Array.isArray(overview.printers) ? overview.printers : []) {
        const capabilities = printer.capabilities || {};
        max.x = Math.max(max.x, Number(capabilities.max_x || capabilities.maxX || capabilities.build_volume_mm?.x) || 0);
        max.y = Math.max(max.y, Number(capabilities.max_y || capabilities.maxY || capabilities.build_volume_mm?.y) || 0);
        max.z = Math.max(max.z, Number(capabilities.max_z || capabilities.maxZ || capabilities.build_volume_mm?.z) || 0);
    }
    return max;
}

async function recordQuoteUsage({ store, merchant, eventType, quote }) {
    if (typeof store.createMerchantUsageEvent !== 'function') return;
    await store.createMerchantUsageEvent({
        org_id: merchant.org_id,
        merchant_id: merchant.merchant_id,
        job_id: null,
        file_id: null,
        event_type: eventType,
        quantity: 1,
        metrics: {
            routing_status: quote.routing_status,
            estimated_total_cents: quote.totals.estimated_total_cents,
        },
    });
}

export function createMerchantQuoteHandler({
    store,
    pepper = process.env.MERCHANT_API_KEY_PEPPER || process.env.NODE_TOKEN_PEPPER,
    now = () => new Date(),
}) {
    if (!store) throw new Error('store is required');

    return async function merchantQuoteHandler(req, res) {
        if (req.method && req.method !== 'POST') return methodNotAllowed(res, 'POST');

        try {
            const context = await authenticateMerchantRequest(req, { store, pepper, now });
            const body = parseJsonBody(req.body);
            const requirements = body.requirements || {};
            const strategy = normalizeRoutingStrategy(body.options?.routing_strategy || body.routing_strategy);
            const overview = await store.getCloudOverview({ orgId: context.merchant.org_id, limit: 100 });
            const routing = routeMerchantPrintJob({ overview, requirements, strategy });
            const quote = estimatePrintQuote({ requirements, routing, now });
            await recordQuoteUsage({ store, merchant: context.merchant, eventType: 'quote.created', quote });

            return sendJson(res, 200, { ok: true, quote, routing });
        } catch (error) {
            const handled = handleMerchantAuthError(res, error);
            if (handled) return handled;
            return sendJson(res, 400, { ok: false, error: 'quote_failed', message: error.message });
        }
    };
}

export function createMerchantPreflightHandler({
    store,
    pepper = process.env.MERCHANT_API_KEY_PEPPER || process.env.NODE_TOKEN_PEPPER,
    now = () => new Date(),
}) {
    if (!store) throw new Error('store is required');

    return async function merchantPreflightHandler(req, res) {
        if (req.method && req.method !== 'POST') return methodNotAllowed(res, 'POST');

        try {
            const context = await authenticateMerchantRequest(req, { store, pepper, now });
            const body = parseJsonBody(req.body);
            const requirements = body.requirements || {};
            const fileName = body.file?.name || body.file?.filename || 'part.gcode.3mf';
            const file = {
                name: fileName,
                byte_size: Number(body.file?.byte_size || body.file?.byteSize) || 0,
                file_mode: classifyFileName(fileName),
            };
            const strategy = normalizeRoutingStrategy(body.options?.routing_strategy || body.routing_strategy);
            const overview = await store.getCloudOverview({ orgId: context.merchant.org_id, limit: 100 });
            const routing = routeMerchantPrintJob({ overview, requirements, strategy });
            const preflight = buildPrintPreflight({
                file,
                requirements,
                route: routing,
                maxBuildVolume: getMaxBuildVolume(overview),
                now,
            });

            return sendJson(res, 200, { ok: true, preflight, routing });
        } catch (error) {
            const handled = handleMerchantAuthError(res, error);
            if (handled) return handled;
            return sendJson(res, 400, { ok: false, error: 'preflight_failed', message: error.message });
        }
    };
}
