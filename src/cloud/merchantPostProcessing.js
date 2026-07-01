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

function requiredTaskId(value) {
    return requiredString(value, 'task_id');
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
        await requireMerchantPrintJob(store, merchant, jobId);
        await requireMerchantOrder(store, merchant, orderId);
        const task = await store.createMerchantPostProcessingTask({
            ...merchantScope(merchant),
            task_id: crypto.randomUUID(),
            job_id: jobId,
            order_id: orderId,
            task_type: requiredString(source.task_type, 'task_type'),
            status: 'pending',
            assigned_to: optionalString(source.assigned_to),
            started_at: null,
            completed_at: null,
            metadata: safeObject(source.metadata),
            created_at: now().toISOString(),
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
        fields,
    }) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const taskId = requiredTaskId(safeObject(body).task_id);
        const current = await getCurrentTask(store, merchant, taskId);
        ensureTransitionAllowed(current.status, allowedStatuses);
        const task = await store.updateMerchantPostProcessingTaskIfStatus({
            merchantId: merchant.merchant_id,
            taskId,
            allowedStatuses,
            fields: fields({ current, source: safeObject(body), now }),
        });
        if (!task) transitionConflict();
        return publicOk(publicTask(task), requestId);
    }

    const startTask = (body = {}, request = null, requestId = undefined) => transitionTask({
        body,
        request,
        requestId,
        allowedStatuses: ['pending'],
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
