import crypto from 'node:crypto';
import { createHttpError, merchantScope, publicOk } from './merchantApiV2.js';
import {
    getAuthenticatedMerchant,
    normalizeLimit,
    optionalString,
    redactPublicValue,
    requiredString,
    safeObject,
} from './merchantPublicProjections.js';

const TASK_STATUSES = new Set(['pending', 'running', 'completed', 'skipped', 'failed']);
const TERMINAL_TASK_STATUSES = new Set(['completed', 'skipped', 'failed']);
const TASK_TYPES = new Set(['auto_eject', 'bed_clear', 'support_removal', 'packing', 'labeling']);

function requiredTaskId(value) {
    return requiredString(value, 'task_id');
}

function normalizeTaskType(value) {
    const taskType = requiredString(value, 'task_type');
    if (!TASK_TYPES.has(taskType)) {
        throw createHttpError(400, 'invalid_payload', 'task_type must be a valid post-processing task type');
    }
    return taskType;
}

function normalizeTaskStatus(value, name = 'status') {
    const status = optionalString(value);
    if (!status) return null;
    const normalized = status.toLowerCase();
    if (!TASK_STATUSES.has(normalized)) {
        throw createHttpError(400, 'invalid_payload', `${name} must be a valid post-processing status`);
    }
    return normalized;
}

function publicTask(task) {
    const response = {
        task_id: task.task_id,
        task_type: task.task_type,
        status: task.status,
    };
    for (const key of [
        'job_id',
        'order_id',
        'assigned_to',
        'started_at',
        'completed_at',
        'created_at',
        'updated_at',
    ]) {
        if (task[key] !== undefined && task[key] !== null) response[key] = task[key];
    }
    const metadata = redactPublicValue(safeObject(task.metadata));
    if (Object.keys(metadata).length > 0) response.metadata = metadata;
    return response;
}

function withHttpStatus(payload, statusCode) {
    Object.defineProperty(payload, '_http_status', {
        value: statusCode,
        enumerable: false,
    });
    return payload;
}

function relationId(source, keys) {
    for (const key of keys) {
        const value = optionalString(source?.[key]);
        if (value) return value;
    }
    return null;
}

async function requireMerchantPrintJob(store, merchant, jobId) {
    if (!jobId) return null;
    const job = await store.getMerchantPrintJob({
        merchantId: merchant.merchant_id,
        jobId,
    });
    if (!job) throw createHttpError(404, 'print_job_not_found', 'Print job not found');
    return job;
}

async function requireMerchantOrder(store, merchant, orderId) {
    if (!orderId) return null;
    const order = await store.getMerchantOrder({
        merchantId: merchant.merchant_id,
        orderId,
    });
    if (!order) throw createHttpError(404, 'order_not_found', 'Order not found');
    return order;
}

function validateTaskReferences({ job, order, jobId, orderId }) {
    if (!job || !order) return;
    const jobOrderId = relationId(job, ['order_id'])
        || relationId(safeObject(job.options), ['order_id'])
        || relationId(safeObject(job.metadata), ['order_id']);
    const orderJobId = relationId(order, ['job_id'])
        || relationId(safeObject(order.metadata), ['job_id']);
    if ((jobOrderId && jobOrderId !== orderId) || (orderJobId && orderJobId !== jobId)) {
        throw createHttpError(
            409,
            'post_processing_reference_mismatch',
            'Post-processing job and order references do not match',
        );
    }
}

async function getCurrentTask(store, merchant, taskId) {
    const task = await store.getMerchantPostProcessingTask({
        merchantId: merchant.merchant_id,
        taskId,
    });
    if (!task) throw createHttpError(404, 'post_processing_task_not_found', 'Post-processing task not found');
    return task;
}

function ensureTransitionAllowed(currentStatus, allowedStatuses) {
    const status = String(currentStatus || '').toLowerCase();
    if (TERMINAL_TASK_STATUSES.has(status) || !allowedStatuses.includes(status)) {
        throw createHttpError(
            409,
            'post_processing_transition_invalid',
            'Post-processing task cannot transition from its current status',
        );
    }
}

function transitionConflict() {
    throw createHttpError(
        409,
        'post_processing_transition_invalid',
        'Post-processing task cannot transition from its current status',
    );
}

async function recordPostProcessingEvent({
    store,
    merchant,
    task,
    eventType,
    message,
    occurredAt,
}) {
    if (typeof store.recordMerchantJobEvent !== 'function') return;
    await store.recordMerchantJobEvent({
        ...merchantScope(merchant),
        event_id: crypto.randomUUID(),
        job_id: task.job_id || null,
        order_id: task.order_id || null,
        event_type: eventType,
        message,
        payload: {
            task_id: task.task_id,
            task_type: task.task_type,
            status: task.status,
        },
        occurred_at: occurredAt,
    });
}

async function recordPostProcessingEventBestEffort(options) {
    try {
        await recordPostProcessingEvent(options);
    } catch {
        // Durable task state should not fail because timeline-event persistence failed.
    }
}

export function createPostProcessingHandlers({
    store,
    authenticateMerchant,
    now = () => new Date(),
} = {}) {
    if (!store) throw new Error('store is required');

    async function createTask(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const source = safeObject(body);
        const jobId = optionalString(source.job_id);
        const orderId = optionalString(source.order_id);
        const job = await requireMerchantPrintJob(store, merchant, jobId);
        const order = await requireMerchantOrder(store, merchant, orderId);
        validateTaskReferences({ job, order, jobId, orderId });
        const timestamp = now().toISOString();
        const task = await store.createMerchantPostProcessingTask({
            ...merchantScope(merchant),
            task_id: crypto.randomUUID(),
            job_id: jobId,
            order_id: orderId,
            task_type: normalizeTaskType(source.task_type),
            status: 'pending',
            assigned_to: optionalString(source.assigned_to),
            started_at: null,
            completed_at: null,
            metadata: safeObject(source.metadata),
            created_at: timestamp,
        });
        await recordPostProcessingEventBestEffort({
            store,
            merchant,
            task,
            eventType: 'post_processing.created',
            message: 'Post-processing task created',
            occurredAt: timestamp,
        });
        return withHttpStatus(publicOk(publicTask(task), requestId), 201);
    }

    async function listTasks(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const source = safeObject(body);
        const tasks = await store.listMerchantPostProcessingTasks({
            merchantId: merchant.merchant_id,
            jobId: optionalString(source.job_id),
            orderId: optionalString(source.order_id),
            status: normalizeTaskStatus(source.status),
            limit: normalizeLimit(source.limit, 50, 100),
        });
        return publicOk({ tasks: tasks.map(publicTask) }, requestId);
    }

    async function getTask(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const taskId = requiredTaskId(safeObject(body).task_id);
        const task = await getCurrentTask(store, merchant, taskId);
        return publicOk(publicTask(task), requestId);
    }

    async function transitionTask({
        body = {},
        request = null,
        requestId = undefined,
        allowedStatuses,
        desiredStatus,
        eventType,
        message,
        fields,
    }) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const taskId = requiredTaskId(safeObject(body).task_id);
        const current = await getCurrentTask(store, merchant, taskId);
        if (String(current.status || '').toLowerCase() === desiredStatus) {
            return publicOk(publicTask(current), requestId);
        }
        ensureTransitionAllowed(current.status, allowedStatuses);
        const task = await store.updateMerchantPostProcessingTaskIfStatus({
            merchantId: merchant.merchant_id,
            taskId,
            allowedStatuses,
            fields: fields({ current, source: safeObject(body), now }),
        });
        if (!task) transitionConflict();
        await recordPostProcessingEventBestEffort({
            store,
            merchant,
            task,
            eventType,
            message,
            occurredAt: now().toISOString(),
        });
        return publicOk(publicTask(task), requestId);
    }

    const startTask = (body = {}, request = null, requestId = undefined) => transitionTask({
        body,
        request,
        requestId,
        allowedStatuses: ['pending'],
        desiredStatus: 'running',
        eventType: 'post_processing.started',
        message: 'Post-processing task started',
        fields: ({ now: transitionNow }) => ({
            status: 'running',
            started_at: transitionNow().toISOString(),
        }),
    });

    const completeTask = (body = {}, request = null, requestId = undefined) => transitionTask({
        body,
        request,
        requestId,
        allowedStatuses: ['running'],
        desiredStatus: 'completed',
        eventType: 'post_processing.completed',
        message: 'Post-processing task completed',
        fields: ({ now: transitionNow }) => ({
            status: 'completed',
            completed_at: transitionNow().toISOString(),
        }),
    });

    const skipTask = (body = {}, request = null, requestId = undefined) => transitionTask({
        body,
        request,
        requestId,
        allowedStatuses: ['pending'],
        desiredStatus: 'skipped',
        eventType: 'post_processing.skipped',
        message: 'Post-processing task skipped',
        fields: ({ now: transitionNow }) => ({
            status: 'skipped',
            completed_at: transitionNow().toISOString(),
        }),
    });

    const failTask = (body = {}, request = null, requestId = undefined) => transitionTask({
        body,
        request,
        requestId,
        allowedStatuses: ['pending', 'running'],
        desiredStatus: 'failed',
        eventType: 'post_processing.failed',
        message: 'Post-processing task failed',
        fields: ({ current, source, now: transitionNow }) => {
            const metadata = {
                ...safeObject(current.metadata),
                ...safeObject(source.metadata),
            };
            const error = optionalString(source.error);
            const errorCode = optionalString(source.error_code);
            if (error) metadata.error = error;
            if (errorCode) metadata.error_code = errorCode;
            return {
                status: 'failed',
                completed_at: transitionNow().toISOString(),
                metadata,
            };
        },
    });

    return {
        createTask,
        listTasks,
        getTask,
        startTask,
        completeTask,
        skipTask,
        failTask,
    };
}
