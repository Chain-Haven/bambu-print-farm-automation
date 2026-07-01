import { createHttpError, publicOk } from './merchantApiV2.js';
import {
    getAuthenticatedMerchant,
    normalizeLimit,
    normalizeOptionalTimestamp,
    optionalString,
    redactPublicValue,
    requiredString,
    safeObject,
} from './merchantPublicProjections.js';

const INVOICE_STATUSES = new Set(['draft', 'issued', 'void']);

function requiredInvoiceId(value) {
    return requiredString(value, 'invoice_id');
}

function normalizeInvoiceStatus(value) {
    const status = optionalString(value);
    if (!status) return null;
    const normalized = status.toLowerCase();
    if (!INVOICE_STATUSES.has(normalized)) {
        throw createHttpError(400, 'invalid_payload', 'status must be a valid invoice status');
    }
    return normalized;
}

function numericAmount(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function money(value) {
    return Math.round(numericAmount(value) * 100) / 100;
}

function publicRateCard(rateCard) {
    const response = {
        rate_card_id: rateCard.rate_card_id,
        currency: rateCard.currency || 'USD',
        status: rateCard.status || 'active',
        rates: Array.isArray(rateCard.rates) ? redactPublicValue(rateCard.rates) : [],
    };
    for (const key of ['name', 'provider', 'effective_at', 'expires_at', 'created_at', 'updated_at']) {
        if (rateCard[key] !== undefined && rateCard[key] !== null) response[key] = rateCard[key];
    }
    const metadata = redactPublicValue(safeObject(rateCard.metadata));
    if (Object.keys(metadata).length > 0) response.metadata = metadata;
    return response;
}

function publicUsageEvent(event) {
    const metrics = redactPublicValue(safeObject(event.metrics));
    const response = {
        usage_event_id: event.usage_event_id,
        event_type: event.event_type,
        quantity: numericAmount(event.quantity, 0),
    };
    for (const key of ['job_id', 'file_id', 'created_at']) {
        if (event[key] !== undefined && event[key] !== null) response[key] = event[key];
    }
    if (event.metrics?.order_id !== undefined && event.metrics?.order_id !== null) {
        response.order_id = event.metrics.order_id;
    }
    if (Object.keys(metrics).length > 0) response.metrics = metrics;
    return response;
}

function summarizeUsage(events) {
    const summary = {
        event_count: events.length,
        total_quantity: 0,
        by_event_type: {},
    };
    for (const event of events) {
        const eventType = String(event.event_type || 'unknown');
        const quantity = numericAmount(event.quantity, 0);
        summary.total_quantity += quantity;
        if (!summary.by_event_type[eventType]) {
            summary.by_event_type[eventType] = { event_count: 0, quantity: 0 };
        }
        summary.by_event_type[eventType].event_count += 1;
        summary.by_event_type[eventType].quantity += quantity;
    }
    summary.total_quantity = money(summary.total_quantity);
    for (const item of Object.values(summary.by_event_type)) {
        item.quantity = money(item.quantity);
    }
    return summary;
}

function publicInvoiceLine(line) {
    const response = {
        invoice_line_id: line.invoice_line_id,
        description: line.description,
        quantity: numericAmount(line.quantity, 0),
        unit_amount: money(line.unit_amount),
        total_amount: money(line.total_amount),
    };
    for (const key of [
        'invoice_id',
        'order_id',
        'job_id',
        'file_id',
        'shipment_id',
        'slice_job_id',
        'created_at',
        'updated_at',
    ]) {
        if (line[key] !== undefined && line[key] !== null) response[key] = line[key];
    }
    const metadata = redactPublicValue(safeObject(line.metadata));
    if (Object.keys(metadata).length > 0) response.metadata = metadata;
    return response;
}

function publicInvoice(invoice, lines = null) {
    const response = {
        invoice_id: invoice.invoice_id,
        status: invoice.status,
        currency: invoice.currency || 'USD',
        subtotal: money(invoice.subtotal),
        total: money(invoice.total),
    };
    for (const key of [
        'period_start',
        'period_end',
        'issued_at',
        'voided_at',
        'created_at',
        'updated_at',
    ]) {
        if (invoice[key] !== undefined && invoice[key] !== null) response[key] = invoice[key];
    }
    const metadata = redactPublicValue(safeObject(invoice.metadata));
    if (Object.keys(metadata).length > 0) response.metadata = metadata;
    if (Array.isArray(lines)) response.lines = lines.map(publicInvoiceLine);
    return response;
}

function usageFilters(body = {}) {
    const source = safeObject(body);
    return {
        jobId: optionalString(source.job_id),
        orderId: optionalString(source.order_id),
        fileId: optionalString(source.file_id),
        createdFrom: normalizeOptionalTimestamp(source.created_from || source.from, 'created_from'),
        createdTo: normalizeOptionalTimestamp(source.created_to || source.to, 'created_to'),
        limit: normalizeLimit(source.limit, 50, 100),
    };
}

function rateMap(rateCard) {
    const map = new Map();
    for (const rate of Array.isArray(rateCard?.rates) ? rateCard.rates : []) {
        const code = optionalString(rate.code);
        if (!code) continue;
        const cents = Number(rate.amount_cents);
        const amount = Number.isFinite(cents) ? cents / 100 : numericAmount(rate.amount || rate.unit_amount, 0);
        map.set(code, {
            description: optionalString(rate.description) || code,
            unit: optionalString(rate.unit) || 'event',
            amount: money(amount),
        });
    }
    return map;
}

function previewLine(event, rate, index) {
    const quantity = numericAmount(event.quantity, 0);
    const unitAmount = rate?.amount ?? 0;
    return {
        invoice_line_id: `preview_line_${index + 1}`,
        order_id: event.metrics?.order_id || null,
        job_id: event.job_id || null,
        file_id: event.file_id || null,
        description: rate?.description || event.event_type,
        quantity,
        unit_amount: unitAmount,
        total_amount: money(quantity * unitAmount),
        metadata: {
            event_type: event.event_type,
            unit: rate?.unit || 'event',
            usage_event_id: event.usage_event_id || null,
        },
    };
}

export function createBillingHandlers({
    store,
    authenticateMerchant,
    adapters = {},
} = {}) {
    if (!store) throw new Error('store is required');

    async function activeRateCard(merchant) {
        const stored = typeof store.getMerchantRateCard === 'function'
            ? await store.getMerchantRateCard({ merchantId: merchant.merchant_id })
            : null;
        if (stored) return stored;
        if (!adapters?.billing || typeof adapters.billing.getRateCard !== 'function') {
            throw new Error('billing adapter is required');
        }
        return adapters.billing.getRateCard({ merchant });
    }

    async function getRateCard(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const rateCard = await activeRateCard(merchant);
        return publicOk({ rate_card: publicRateCard(rateCard) }, requestId);
    }

    async function listUsage(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const filters = usageFilters(body);
        const events = await store.listMerchantUsageEvents({
            merchantId: merchant.merchant_id,
            ...filters,
        });
        return publicOk({
            usage: events.map(publicUsageEvent),
            summary: summarizeUsage(events),
        }, requestId);
    }

    async function listInvoices(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const source = safeObject(body);
        const invoices = await store.listMerchantInvoices({
            merchantId: merchant.merchant_id,
            status: normalizeInvoiceStatus(source.status),
            limit: normalizeLimit(source.limit, 50, 100),
        });
        return publicOk({ invoices: invoices.map((invoice) => publicInvoice(invoice)) }, requestId);
    }

    async function getInvoice(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const invoiceId = requiredInvoiceId(safeObject(body).invoice_id);
        const invoice = await store.getMerchantInvoice({
            merchantId: merchant.merchant_id,
            invoiceId,
        });
        if (!invoice) throw createHttpError(404, 'invoice_not_found', 'Invoice not found');
        const lines = await store.listMerchantInvoiceLines({
            merchantId: merchant.merchant_id,
            invoiceId,
            limit: 100,
        });
        return publicOk({ invoice: publicInvoice(invoice, lines) }, requestId);
    }

    async function previewInvoice(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const filters = usageFilters({ ...safeObject(body), limit: safeObject(body).limit || 100 });
        const [rateCard, events] = await Promise.all([
            activeRateCard(merchant),
            store.listMerchantUsageEvents({
                merchantId: merchant.merchant_id,
                ...filters,
            }),
        ]);
        const rates = rateMap(rateCard);
        const lines = events.map((event, index) => previewLine(event, rates.get(event.event_type), index));
        const subtotal = money(lines.reduce((sum, line) => sum + line.total_amount, 0));
        return publicOk({
            invoice_preview: {
                status: 'preview',
                currency: rateCard.currency || 'USD',
                subtotal,
                total: subtotal,
                lines: lines.map(publicInvoiceLine),
                usage_summary: summarizeUsage(events),
            },
        }, requestId);
    }

    return {
        getRateCard,
        listUsage,
        listInvoices,
        getInvoice,
        previewInvoice,
    };
}
