import { createHttpError, publicOk } from './merchantApiV2.js';
import {
    getAuthenticatedMerchant,
    normalizeLimit,
    optionalString,
    redactPublicValue,
    requiredString,
    safeObject,
} from './merchantPublicProjections.js';

function requiredJobId(value) {
    return requiredString(value, 'job_id');
}

function publicEvent(event) {
    const response = {
        event_id: event.event_id,
        event_type: event.event_type,
    };
    for (const key of ['job_id', 'order_id', 'batch_id', 'file_id', 'message', 'occurred_at', 'created_at']) {
        if (event[key] !== undefined && event[key] !== null) response[key] = event[key];
    }
    if (event.slice_job_id !== undefined && event.slice_job_id !== null) response.slice_id = event.slice_job_id;
    const payload = redactPublicValue(safeObject(event.payload));
    if (Object.keys(payload).length > 0) response.payload = payload;
    const metadata = redactPublicValue(safeObject(event.metadata));
    if (Object.keys(metadata).length > 0) response.metadata = metadata;
    return response;
}

function publicArtifact(artifact) {
    const response = {
        artifact_id: artifact.artifact_id,
        artifact_type: artifact.artifact_type,
        provider: artifact.provider,
    };
    for (const key of ['job_id', 'file_id', 'created_at', 'updated_at']) {
        if (artifact[key] !== undefined && artifact[key] !== null) response[key] = artifact[key];
    }
    const payload = redactPublicValue(safeObject(artifact.payload));
    if (Object.keys(payload).length > 0) response.payload = payload;
    const metadata = redactPublicValue(safeObject(artifact.metadata));
    if (Object.keys(metadata).length > 0) response.metadata = metadata;
    return response;
}

function queryOptions(body = {}) {
    const source = safeObject(body);
    return {
        jobId: requiredJobId(source.job_id),
        orderId: optionalString(source.order_id),
        batchId: optionalString(source.batch_id),
        fileId: optionalString(source.file_id),
        sliceId: optionalString(source.slice_id) || optionalString(source.slice_job_id),
        eventType: optionalString(source.event_type),
        artifactType: optionalString(source.artifact_type),
        cursor: optionalString(source.cursor),
        limit: normalizeLimit(source.limit, 50, 100),
    };
}

async function requireMerchantPrintJob(store, merchant, jobId) {
    const job = await store.getMerchantPrintJob({
        merchantId: merchant.merchant_id,
        jobId,
    });
    if (!job) throw createHttpError(404, 'print_job_not_found', 'Print job not found');
    return job;
}

function nextCursor(rows, limit, key) {
    if (!Array.isArray(rows) || rows.length < limit) return null;
    const last = rows[rows.length - 1];
    return last?.[key] || null;
}

export function createTimelineHandlers({
    store,
    authenticateMerchant,
} = {}) {
    if (!store) throw new Error('store is required');

    async function listJobEvents(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const options = queryOptions(body);
        await requireMerchantPrintJob(store, merchant, options.jobId);
        const events = await store.listMerchantJobEvents({
            merchantId: merchant.merchant_id,
            jobId: options.jobId,
            orderId: options.orderId,
            batchId: options.batchId,
            fileId: options.fileId,
            sliceId: options.sliceId,
            eventType: options.eventType,
            cursor: options.cursor,
            limit: options.limit,
        });
        return publicOk({
            job_id: options.jobId,
            events: events.map(publicEvent),
            next_cursor: nextCursor(events, options.limit, 'occurred_at'),
        }, requestId);
    }

    async function listJobArtifacts(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const options = queryOptions(body);
        await requireMerchantPrintJob(store, merchant, options.jobId);
        const artifacts = await store.listMerchantJobArtifacts({
            merchantId: merchant.merchant_id,
            jobId: options.jobId,
            fileId: options.fileId,
            artifactType: options.artifactType,
            cursor: options.cursor,
            limit: options.limit,
        });
        return publicOk({
            job_id: options.jobId,
            artifacts: artifacts.map(publicArtifact),
            next_cursor: nextCursor(artifacts, options.limit, 'created_at'),
        }, requestId);
    }

    return {
        listJobEvents,
        listJobArtifacts,
    };
}
