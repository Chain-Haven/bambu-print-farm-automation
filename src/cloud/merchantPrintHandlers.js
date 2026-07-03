import { createHash } from 'node:crypto';
import { parseJsonBody } from './agentProtocol.js';
import { createRequestId } from './httpServerUtils.js';
import {
    MerchantAuthError,
    authenticateMerchantRequest,
} from './merchantAuth.js';
import { reserveFilamentForJob } from './filamentReservations.js';
import { classifyPrintFile, normalizeRoutingStrategy } from './printIntake.js';
import {
    loadRoutableOverview as loadDispatchOverview,
    queuePrintDispatchCommand,
    routeJobFile,
} from './printDispatch.js';
import { deliverMerchantWebhook } from './webhooks.js';
import { deliverMerchantWebhookEvent } from './merchantWebhookDelivery.js';

const MAX_JSON_FILE_BYTES = 25 * 1024 * 1024;
const FARM_FILAMENT_INVENTORY_KEY = 'farm_filament_inventory';

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sendJson(res, statusCode, payload) {
    if (typeof res.status === 'function' && typeof res.json === 'function') {
        return res.status(statusCode).json(payload);
    }

    res.statusCode = statusCode;
    if (typeof res.setHeader === 'function') {
        res.setHeader('Content-Type', 'application/json');
    }
    return res.end(JSON.stringify(payload));
}

function methodNotAllowed(res, methods, requestId = createRequestId()) {
    if (typeof res.setHeader === 'function') {
        res.setHeader('Allow', methods);
    }
    return sendJson(res, 405, {
        ok: false,
        error: 'method_not_allowed',
        message: 'Method not allowed',
        request_id: requestId,
    });
}

function requiredString(value, name) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${name} is required`);
    }
    return value.trim();
}

function optionalObject(value) {
    return isPlainObject(value) ? value : {};
}

function parseLimit(query = {}) {
    const raw = Number.parseInt(query.limit, 10);
    if (!Number.isFinite(raw)) return 50;
    return Math.max(1, Math.min(raw, 100));
}

function handleMerchantAuthError(res, error, requestId = createRequestId()) {
    if (error instanceof MerchantAuthError) {
        return sendJson(res, error.statusCode, {
            ok: false,
            error: error.code,
            message: 'Authentication failed',
            request_id: requestId,
        });
    }
    return null;
}

function getHeader(headers = {}, name) {
    const lowerName = name.toLowerCase();
    for (const [key, value] of Object.entries(headers || {})) {
        if (String(key).toLowerCase() === lowerName) return value;
    }
    return null;
}

function getIdempotencyKey(req) {
    const value = getHeader(req.headers || {}, 'idempotency-key');
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeFileName(name) {
    const baseName = requiredString(name, 'file.name').split(/[\\/]/).pop();
    return baseName.replace(/[^A-Za-z0-9._-]/g, '_');
}

// Buffer-aware: an unsliced project .3mf (no embedded plate gcode) is a
// source model even though the extension looks "ready".
function classifyFile(fileName, buffer = null) {
    return classifyPrintFile(fileName, buffer);
}

function normalizeStorageContentType(value, fileMode) {
    const raw = typeof value === 'string' && value.trim() ? value.trim() : 'application/octet-stream';
    const lower = raw.toLowerCase();

    if (fileMode === 'source_model') return 'application/octet-stream';
    if (lower.startsWith('model/')) return 'application/octet-stream';
    if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:[a-z0-9!#$&^_.+-]*)?(?:\s*;\s*[-a-z0-9_]+=[-a-z0-9_.+]+)*$/i.test(raw)) {
        return 'application/octet-stream';
    }
    return raw;
}

function decodeBase64(value) {
    const source = requiredString(value, 'file.base64');
    const buffer = Buffer.from(source, 'base64');
    if (buffer.length === 0) throw new Error('file.base64 decoded to an empty file');
    if (buffer.length > MAX_JSON_FILE_BYTES) {
        throw new Error(`file.base64 exceeds ${MAX_JSON_FILE_BYTES} bytes`);
    }
    return buffer;
}

// Shared with the admin drop-in endpoint (adminPrintHandlers.js).
export function normalizeUpload(body) {
    const source = isPlainObject(body) ? body : {};
    const file = optionalObject(source.file);
    const originalName = safeFileName(file.name || file.filename);
    const buffer = decodeBase64(file.base64 || file.content_base64);
    const fileMode = classifyFile(originalName, buffer);
    const rawContentType = typeof file.content_type === 'string' && file.content_type.trim()
        ? file.content_type.trim()
        : (typeof file.contentType === 'string' && file.contentType.trim() ? file.contentType.trim() : 'application/octet-stream');
    const contentType = normalizeStorageContentType(rawContentType, fileMode);

    return {
        name: typeof source.name === 'string' && source.name.trim() ? source.name.trim() : originalName,
        file: {
            originalName,
            contentType,
            buffer,
            byteSize: buffer.length,
            checksum: createHash('sha256').update(buffer).digest('hex'),
            fileMode,
        },
        requirements: optionalObject(source.requirements),
        options: optionalObject(source.options),
    };
}

function buildStoragePath({ merchant, file, now }) {
    const stamp = now().toISOString().replace(/[-:.]/g, '');
    return `${merchant.org_id}/${merchant.merchant_id}/${stamp}-${file.checksum.slice(0, 12)}-${file.originalName}`;
}

function redactedFile(file) {
    return file;
}

function redactedJob(job) {
    return job;
}

async function recordUsage({ store, merchant, file, job }) {
    if (typeof store.createMerchantUsageEvent !== 'function') return;

    await store.createMerchantUsageEvent({
        org_id: merchant.org_id,
        merchant_id: merchant.merchant_id,
        job_id: job.job_id,
        file_id: file.file_id,
        event_type: 'file.uploaded',
        quantity: file.byte_size || 0,
        metrics: {
            byte_size: file.byte_size || 0,
            file_mode: file.file_mode,
            content_type: file.content_type,
        },
    });

    await store.createMerchantUsageEvent({
        org_id: merchant.org_id,
        merchant_id: merchant.merchant_id,
        job_id: job.job_id,
        file_id: file.file_id,
        event_type: 'job.submitted',
        quantity: 1,
        metrics: {
            status: job.status,
            file_mode: file.file_mode,
        },
    });
}

async function reserveFilamentIfPossible({ store, job, upload }) {
    if (
        typeof store.getPlatformSetting !== 'function'
        || typeof store.upsertPlatformSetting !== 'function'
        || typeof store.updatePrintJob !== 'function'
    ) {
        return null;
    }

    const inventory = await store.getPlatformSetting(FARM_FILAMENT_INVENTORY_KEY, { spools: [] });
    const result = reserveFilamentForJob({
        inventory,
        jobId: job.job_id,
        requirements: upload.requirements,
    });

    if (result.status !== 'reserved') return result;

    await store.upsertPlatformSetting(FARM_FILAMENT_INVENTORY_KEY, result.inventory);
    const updatedJob = await store.updatePrintJob(job.job_id, {
        options: {
            ...(job.options || {}),
            filament_reservation: result.reservation,
        },
    });

    return {
        ...result,
        job: updatedJob ? { ...job, ...updatedJob } : job,
    };
}

// One routed path for BOTH ready artifacts and source models. Ready files
// dispatch cloud.print.ready; source models (STL/OBJ/STEP, unsliced 3MF)
// dispatch cloud.print.source — the TARGET node downloads, slices (OrcaSlicer
// CLI), and submits through the same orchestrated pipeline, so merchant
// uploads of any accepted format print fully automatically. Jobs that can't
// place right now park as waiting_for_capacity and are re-dispatched from the
// heartbeat path (printDispatch.redispatchWaitingJobs) when capacity frees.
async function createRoutedPrintJob({ store, merchant, upload, file, now }) {
    const overview = await loadDispatchOverview({ store, orgId: merchant.org_id });
    const strategy = normalizeRoutingStrategy(upload.options.routing_strategy || upload.requirements.routing_strategy);
    const { route, routingOverview } = routeJobFile({
        overview,
        file,
        requirements: upload.requirements,
        strategy,
    });

    const jobStatus = route.status === 'routed' ? 'queued' : 'waiting_for_capacity';
    let job = await store.createPrintJob({
        org_id: merchant.org_id,
        merchant_id: merchant.merchant_id,
        node_id: route.selected_node_id,
        printer_id: route.selected_printer_id,
        file_id: file.file_id,
        name: upload.name,
        status: jobStatus,
        options: upload.options,
        routing_summary: route,
    });
    const reservation = route.status === 'routed'
        ? await reserveFilamentIfPossible({ store, job, upload })
        : null;
    if (reservation?.job) job = reservation.job;

    await store.createRoutingDecision({
        org_id: merchant.org_id,
        merchant_id: merchant.merchant_id,
        job_id: job.job_id,
        selected_node_id: route.selected_node_id,
        selected_printer_id: route.selected_printer_id,
        status: route.status,
        strategy: route.strategy,
        score: route.score,
        rejected_candidates: route.rejected_candidates,
    });

    if (route.status === 'routed') {
        await queuePrintDispatchCommand({
            store,
            orgId: merchant.org_id,
            job,
            file,
            route,
            overview: routingOverview,
            requirements: upload.requirements,
            options: upload.options,
            now,
        });
    }

    return { job, routing: route, reservation };
}

async function createPrintJob({ store, merchant, upload, now }) {
    const storagePath = buildStoragePath({ merchant, file: upload.file, now });
    await store.uploadPrintArtifact(storagePath, upload.file.buffer, upload.file.contentType);

    const file = await store.createJobFile({
        org_id: merchant.org_id,
        merchant_id: merchant.merchant_id,
        storage_path: storagePath,
        original_name: upload.file.originalName,
        content_type: upload.file.contentType,
        byte_size: upload.file.byteSize,
        checksum_sha256: upload.file.checksum,
        file_mode: upload.file.fileMode,
        requirements: upload.requirements,
    });

    const result = await createRoutedPrintJob({ store, merchant, upload, file, now });

    await recordUsage({ store, merchant, file, job: result.job });
    return { file, ...result };
}

export function createMerchantPrintJobsHandler({
    store,
    pepper = process.env.MERCHANT_API_KEY_PEPPER || process.env.NODE_TOKEN_PEPPER,
    now = () => new Date(),
    fetchImpl = globalThis.fetch,
}) {
    if (!store) throw new Error('store is required');

    return async function merchantPrintJobsHandler(req, res) {
        if (req.method === 'GET') {
            try {
                const context = await authenticateMerchantRequest(req, { store, pepper, now });
                const jobs = await store.listMerchantPrintJobs({
                    merchantId: context.merchant.merchant_id,
                    limit: parseLimit(req.query || {}),
                });
                return sendJson(res, 200, { ok: true, jobs: jobs.map(redactedJob) });
            } catch (error) {
                const handled = handleMerchantAuthError(res, error);
                if (handled) return handled;
                return sendJson(res, 500, {
                    ok: false,
                    error: 'list_print_jobs_failed',
                    message: error.message,
                });
            }
        }

        if (req.method && req.method !== 'POST') {
            return methodNotAllowed(res, 'GET, POST');
        }

        try {
            const context = await authenticateMerchantRequest(req, { store, pepper, now });
            const body = parseJsonBody(req.body);
            const idempotencyKey = getIdempotencyKey(req);
            if (idempotencyKey && typeof store.findMerchantPrintJobByIdempotencyKey === 'function') {
                const existing = await store.findMerchantPrintJobByIdempotencyKey({
                    merchantId: context.merchant.merchant_id,
                    idempotencyKey,
                });
                if (existing) {
                    return sendJson(res, 200, {
                        ok: true,
                        idempotent_replay: true,
                        job: redactedJob(existing),
                    });
                }
            }

            const upload = normalizeUpload(body);
            if (idempotencyKey) {
                upload.options = {
                    ...upload.options,
                    idempotency_key: idempotencyKey,
                };
            }
            upload.options = {
                ...upload.options,
                routing_strategy: normalizeRoutingStrategy(upload.options.routing_strategy || body.routing_strategy),
            };
            const result = await createPrintJob({
                store,
                merchant: context.merchant,
                upload,
                now,
            });
            await deliverMerchantWebhook({
                merchant: context.merchant,
                eventType: result.job.status === 'needs_approval' ? 'job.needs_approval' : 'job.accepted',
                data: {
                    job: redactedJob(result.job),
                    routing: result.routing,
                    reservation: result.reservation,
                },
                fetchImpl,
                now,
            });
            await deliverMerchantWebhookEvent({
                store,
                merchant: context.merchant,
                eventType: result.job.status === 'needs_approval' ? 'job.needs_approval' : 'job.accepted',
                data: {
                    job: redactedJob(result.job),
                    routing: result.routing,
                    reservation: result.reservation,
                },
                fetchImpl,
                now,
            });
            if (result.reservation?.status === 'unavailable') {
                await deliverMerchantWebhook({
                    merchant: context.merchant,
                    eventType: 'filament.unavailable',
                    data: { job: redactedJob(result.job), requirements: upload.requirements },
                    fetchImpl,
                    now,
                });
            }

            return sendJson(res, 201, {
                ok: true,
                file: redactedFile(result.file),
                job: redactedJob(result.job),
                routing: result.routing,
                reservation: result.reservation,
            });
        } catch (error) {
            const handled = handleMerchantAuthError(res, error);
            if (handled) return handled;
            return sendJson(res, 400, {
                ok: false,
                error: 'create_print_job_failed',
                message: error.message,
            });
        }
    };
}

export function createMerchantPrintJobStatusHandler({
    store,
    pepper = process.env.MERCHANT_API_KEY_PEPPER || process.env.NODE_TOKEN_PEPPER,
    now = () => new Date(),
}) {
    if (!store) throw new Error('store is required');

    return async function merchantPrintJobStatusHandler(req, res) {
        if (req.method && req.method !== 'GET') {
            return methodNotAllowed(res, 'GET');
        }

        try {
            const context = await authenticateMerchantRequest(req, { store, pepper, now });
            const jobId = requiredString((req.query || {}).job_id || parseJsonBody(req.body).job_id, 'job_id');
            const job = await store.getMerchantPrintJob({
                merchantId: context.merchant.merchant_id,
                jobId,
            });

            if (!job) {
                return sendJson(res, 404, { ok: false, error: 'print_job_not_found' });
            }

            return sendJson(res, 200, {
                ok: true,
                job: redactedJob(job),
            });
        } catch (error) {
            const handled = handleMerchantAuthError(res, error);
            if (handled) return handled;
            return sendJson(res, 400, {
                ok: false,
                error: 'print_job_status_failed',
                message: error.message,
            });
        }
    };
}
