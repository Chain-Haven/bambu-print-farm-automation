import crypto from 'node:crypto';
import { createHttpError, merchantScope, publicOk } from './merchantApiV2.js';
import {
    getAuthenticatedMerchant,
    optionalString,
    redactPublicValue,
    requiredString,
    safeObject,
} from './merchantPublicProjections.js';

const INSPECTION_STATUSES = new Set(['pending', 'passed', 'failed', 'manual_review']);
const INSPECTION_DECISIONS = new Set(['accepted', 'rejected', 'manual_review']);

function requiredJobId(value) {
    return requiredString(value, 'job_id');
}

function requiredInspectionId(value) {
    return requiredString(value, 'inspection_id');
}

function withHttpStatus(payload, statusCode) {
    Object.defineProperty(payload, '_http_status', {
        value: statusCode,
        enumerable: false,
    });
    return payload;
}

function normalizeInspectionStatus(value, fallback = 'manual_review') {
    const status = String(value || '').trim().toLowerCase();
    return INSPECTION_STATUSES.has(status) ? status : fallback;
}

function normalizeDecision(value) {
    const decision = String(value || '').trim().toLowerCase();
    return INSPECTION_DECISIONS.has(decision) ? decision : null;
}

function publicInspection(inspection) {
    const response = {
        inspection_id: inspection.inspection_id,
        job_id: inspection.job_id,
        provider: inspection.provider,
        status: inspection.status,
        decision: inspection.decision ?? null,
        inspected_at: inspection.inspected_at ?? null,
    };
    for (const key of ['order_id', 'created_at', 'updated_at']) {
        if (inspection[key] !== undefined && inspection[key] !== null) response[key] = inspection[key];
    }
    const metadata = redactPublicValue(safeObject(inspection.metadata));
    if (Object.keys(metadata).length > 0) response.metadata = metadata;
    return response;
}

async function requireMerchantPrintJob(store, merchant, jobId) {
    const job = await store.getMerchantPrintJob({
        merchantId: merchant.merchant_id,
        jobId,
    });
    if (!job) throw createHttpError(404, 'print_job_not_found', 'Print job not found');
    return job;
}

function inspectionMetadata(adapterInspection) {
    const metadata = { ...safeObject(adapterInspection?.metadata) };
    if (adapterInspection?.summary !== undefined && adapterInspection.summary !== null) {
        metadata.summary = adapterInspection.summary;
    }
    if (adapterInspection?.findings !== undefined && adapterInspection.findings !== null) {
        metadata.findings = adapterInspection.findings;
    }
    return metadata;
}

async function runInspectionAdapter({ adapters, merchant, job, now }) {
    if (typeof adapters?.inspection?.getInspection !== 'function') {
        return {
            provider: 'manual_review',
            status: 'manual_review',
            inspected_at: now().toISOString(),
            metadata: { reason: 'inspection_adapter_unavailable' },
        };
    }

    try {
        const adapterInspection = await adapters.inspection.getInspection({ merchant, job });
        return {
            provider: optionalString(adapterInspection?.provider) || 'inspection_adapter',
            status: normalizeInspectionStatus(adapterInspection?.status),
            decision: normalizeDecision(adapterInspection?.decision),
            inspected_at: optionalString(adapterInspection?.inspected_at)
                || (normalizeInspectionStatus(adapterInspection?.status) === 'pending' ? null : now().toISOString()),
            metadata: inspectionMetadata(adapterInspection),
        };
    } catch {
        return {
            provider: 'manual_review',
            status: 'manual_review',
            inspected_at: now().toISOString(),
            metadata: { reason: 'inspection_adapter_unavailable' },
        };
    }
}

async function recordInspectionEvent({
    store,
    scope,
    inspection,
    eventType,
    message,
    occurredAt,
}) {
    if (typeof store.recordMerchantJobEvent !== 'function') return;
    await store.recordMerchantJobEvent({
        ...scope,
        event_id: crypto.randomUUID(),
        job_id: inspection.job_id || null,
        order_id: inspection.order_id || null,
        event_type: eventType,
        message,
        payload: {
            inspection_id: inspection.inspection_id,
            provider: inspection.provider,
            status: inspection.status,
            decision: inspection.decision ?? null,
        },
        occurred_at: occurredAt,
    });
}

async function recordInspectionEventBestEffort(options) {
    try {
        await recordInspectionEvent(options);
    } catch {
        // Durable inspection state should not fail because audit-event persistence failed.
    }
}

export function createInspectionHandlers({
    store,
    adapters = {},
    authenticateMerchant,
    now = () => new Date(),
} = {}) {
    if (!store) throw new Error('store is required');

    async function getInspectionForJob(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const jobId = requiredJobId(safeObject(body).job_id);
        await requireMerchantPrintJob(store, merchant, jobId);
        const inspection = await store.getMerchantInspectionByJob({
            merchantId: merchant.merchant_id,
            jobId,
        });
        if (!inspection) throw createHttpError(404, 'inspection_not_found', 'Inspection not found');
        return publicOk(publicInspection(inspection), requestId);
    }

    async function requestInspection(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const source = safeObject(body);
        const jobId = requiredJobId(source.job_id);
        const job = await requireMerchantPrintJob(store, merchant, jobId);
        const current = await store.getMerchantInspectionByJob({
            merchantId: merchant.merchant_id,
            jobId,
        });
        if (current) return withHttpStatus(publicOk(publicInspection(current), requestId), 200);

        const scope = merchantScope(merchant);
        const timestamp = now().toISOString();
        const adapterInspection = await runInspectionAdapter({ adapters, merchant, job, now });
        const inspectionPayload = {
            ...scope,
            inspection_id: crypto.randomUUID(),
            job_id: job.job_id,
            order_id: optionalString(source.order_id) || optionalString(job.order_id),
            provider: adapterInspection.provider,
            status: adapterInspection.status,
            decision: adapterInspection.decision || null,
            inspected_at: adapterInspection.inspected_at,
            metadata: adapterInspection.metadata,
            created_at: timestamp,
            updated_at: timestamp,
        };

        let inspection;
        try {
            inspection = await store.createMerchantInspection(inspectionPayload);
        } catch (error) {
            const duplicate = await store.getMerchantInspectionByJob({
                merchantId: merchant.merchant_id,
                jobId,
            });
            if (duplicate) return withHttpStatus(publicOk(publicInspection(duplicate), requestId), 200);
            throw error;
        }

        await recordInspectionEventBestEffort({
            store,
            scope,
            inspection,
            eventType: 'inspection.requested',
            message: 'Inspection requested',
            occurredAt: timestamp,
        });
        if (inspection.status !== 'pending') {
            await recordInspectionEventBestEffort({
                store,
                scope,
                inspection,
                eventType: 'inspection.completed',
                message: 'Inspection completed',
                occurredAt: inspection.inspected_at || timestamp,
            });
        }
        return withHttpStatus(publicOk(publicInspection(inspection), requestId), 201);
    }

    async function setInspectionDecision({
        body = {},
        request = null,
        requestId = undefined,
        decision,
        status,
    }) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const inspectionId = requiredInspectionId(safeObject(body).inspection_id);
        const current = await store.getMerchantInspection({
            merchantId: merchant.merchant_id,
            inspectionId,
        });
        if (!current) throw createHttpError(404, 'inspection_not_found', 'Inspection not found');

        const timestamp = now().toISOString();
        const inspection = await store.updateMerchantInspection({
            merchantId: merchant.merchant_id,
            inspectionId,
            fields: {
                status,
                decision,
                inspected_at: current.inspected_at || timestamp,
                updated_at: timestamp,
            },
        });
        if (!inspection) throw createHttpError(404, 'inspection_not_found', 'Inspection not found');
        await recordInspectionEventBestEffort({
            store,
            scope: merchantScope(merchant),
            inspection,
            eventType: 'inspection.decision',
            message: `Inspection ${decision}`,
            occurredAt: timestamp,
        });
        return publicOk(publicInspection(inspection), requestId);
    }

    const acceptInspection = (body = {}, request = null, requestId = undefined) => setInspectionDecision({
        body,
        request,
        requestId,
        decision: 'accepted',
        status: 'passed',
    });

    const rejectInspection = (body = {}, request = null, requestId = undefined) => setInspectionDecision({
        body,
        request,
        requestId,
        decision: 'rejected',
        status: 'failed',
    });

    const manualReviewInspection = (body = {}, request = null, requestId = undefined) => setInspectionDecision({
        body,
        request,
        requestId,
        decision: 'manual_review',
        status: 'manual_review',
    });

    return {
        getInspectionForJob,
        requestInspection,
        acceptInspection,
        rejectInspection,
        manualReviewInspection,
    };
}
