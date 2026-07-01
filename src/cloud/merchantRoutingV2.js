import { createHttpError, publicOk } from './merchantApiV2.js';
import { routeMerchantPrintJob } from './merchantRouting.js';
import { estimatePrintQuote } from './quoteEstimator.js';

export const ROUTING_V2_STRATEGIES = [
    'fastest_fulfillment',
    'batch_by_material',
    'least_printer_wear',
    'ship_cutoff',
];

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeObject(value) {
    return isPlainObject(value) ? value : {};
}

function normalizeStrategy(value) {
    return ROUTING_V2_STRATEGIES.includes(value) ? value : 'fastest_fulfillment';
}

function numberOrNull(...values) {
    for (const value of values) {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return null;
}

async function getAuthenticatedMerchant(authenticateMerchant, request) {
    if (typeof authenticateMerchant !== 'function') {
        throw new Error('authenticateMerchant is required');
    }
    const context = await authenticateMerchant(request);
    const merchant = context?.merchant || context;
    if (!merchant?.org_id || !merchant?.merchant_id) {
        throw createHttpError(403, 'merchant_scope_missing', 'Merchant scope is unavailable');
    }
    return merchant;
}

function uniqueRejectionReasons(route) {
    const reasons = new Set();
    for (const candidate of Array.isArray(route?.rejected_candidates) ? route.rejected_candidates : []) {
        for (const reason of Array.isArray(candidate?.reasons) ? candidate.reasons : []) {
            if (typeof reason === 'string' && reason.trim()) reasons.add(reason.trim());
        }
    }
    return [...reasons];
}

function confidenceForRoute(route) {
    if (route.status !== 'routed') return 'low';
    const queueDepth = Number(route.score?.queue_depth) || 0;
    const nodeStatus = String(route.score?.node_status || '').toLowerCase();
    if (queueDepth === 0 && nodeStatus === 'online') return 'high';
    return queueDepth <= 2 ? 'medium' : 'low';
}

function estimatePrintMinutes(requirements, quote) {
    return numberOrNull(
        requirements.estimated_print_minutes,
        requirements.print_minutes,
        requirements.duration_minutes,
        requirements.estimated_duration_minutes,
        quote.estimates?.print_minutes,
    ) || 30;
}

function shipByWindow(body, quote) {
    const options = safeObject(body.options);
    return (
        (typeof body.ship_by_window === 'string' && body.ship_by_window.trim())
        || (typeof body.ship_by === 'string' && body.ship_by.trim())
        || (typeof options.ship_by_window === 'string' && options.ship_by_window.trim())
        || quote.lead_time?.earliest_ready_at
        || null
    );
}

function publicEstimate({ body, route, quote, strategy }) {
    const requirements = safeObject(body.requirements);
    const queueMinutes = Math.max(0, Number(quote.estimates?.queue_minutes) || 0);
    const printMinutes = estimatePrintMinutes(requirements, quote);
    const handlingMinutes = Math.max(0, Number(quote.estimates?.handling_minutes) || 0);
    const rejectionReasons = uniqueRejectionReasons(route);

    return {
        strategy,
        confidence: confidenceForRoute(route),
        eta: {
            queue_minutes: queueMinutes,
            print_minutes: printMinutes,
            lead_time_minutes: queueMinutes + printMinutes + handlingMinutes,
            ship_by_window: shipByWindow(body, quote),
        },
        price_estimate: {
            currency: quote.currency || 'USD',
            material_cents: quote.totals?.material_cents || 0,
            machine_cents: quote.totals?.machine_cents || 0,
            setup_cents: quote.totals?.setup_cents || 0,
            estimated_total_cents: quote.totals?.estimated_total_cents || 0,
        },
        compatible: route.status === 'routed',
        rejection_reasons: rejectionReasons,
    };
}

export function createRoutingV2Handlers({
    store,
    authenticateMerchant,
    now = () => new Date(),
} = {}) {
    if (!store) throw new Error('store is required');

    async function getRoutingOptions(_body = {}, request = null, requestId = undefined) {
        await getAuthenticatedMerchant(authenticateMerchant, request);
        return publicOk({
            strategies: [...ROUTING_V2_STRATEGIES],
            default_strategy: 'fastest_fulfillment',
        }, requestId);
    }

    async function estimateRouting(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const source = safeObject(body);
        const options = safeObject(source.options);
        const strategy = normalizeStrategy(source.strategy || source.routing_strategy || options.routing_strategy);
        const requirements = safeObject(source.requirements);
        const overview = await store.getCloudOverview({ orgId: merchant.org_id, limit: 100 });
        const route = routeMerchantPrintJob({
            overview,
            requirements,
            strategy,
        });
        const quote = estimatePrintQuote({
            requirements,
            routing: route,
            now,
        });

        return publicOk(publicEstimate({
            body: source,
            route,
            quote,
            strategy,
        }), requestId);
    }

    return {
        getRoutingOptions,
        estimateRouting,
    };
}
