import { createHash } from 'node:crypto';
import { parseJsonBody } from './agentProtocol.js';
import { createRequestId } from './httpServerUtils.js';
import {
    MerchantAuthError,
    authenticateMerchantRequest,
} from './merchantAuth.js';
import { buildAmsMappingForPrinter, routeMerchantPrintJob } from './merchantRouting.js';
import { reserveFilamentForJob } from './filamentReservations.js';
import { normalizeRoutingStrategy } from './printIntake.js';
import { augmentOverviewWithInventory, normalizeFarmAutomationSettings } from './farmAutomation.js';
import { deliverMerchantWebhook } from './webhooks.js';

const MAX_JSON_FILE_BYTES = 25 * 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 3600;
const FARM_FILAMENT_INVENTORY_KEY = 'farm_filament_inventory';

const READY_EXTENSIONS = ['.gcode.3mf', '.3mf', '.gcode'];
const SOURCE_EXTENSIONS = ['.stl', '.obj', '.step', '.stp'];

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

function classifyFile(fileName) {
    const lower = fileName.toLowerCase();
    if (READY_EXTENSIONS.some((extension) => lower.endsWith(extension))) return 'ready_to_print';
    if (SOURCE_EXTENSIONS.some((extension) => lower.endsWith(extension))) return 'source_model';
    throw new Error('file.name must end in .gcode, .3mf, .gcode.3mf, .stl, .obj, .step, or .stp');
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

function normalizeUpload(body) {
    const source = isPlainObject(body) ? body : {};
    const file = optionalObject(source.file);
    const originalName = safeFileName(file.name || file.filename);
    const buffer = decodeBase64(file.base64 || file.content_base64);
    const fileMode = classifyFile(originalName);
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

function findSelectedPrinter(overview, route) {
    return (overview.printers || []).find((printer) => printer.printer_id === route.selected_printer_id) || null;
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

async function loadRoutableOverview({ store, merchant }) {
    const overview = await store.getCloudOverview({ orgId: merchant.org_id, limit: 100 });
    if (typeof store.getPlatformSetting !== 'function') return overview;

    // Merge operator-entered spool inventory into printer capabilities so a
    // material/color that lives only in the filament inventory (not in the
    // printer's synced AMS data) still routes instead of "missing_material".
    try {
        const inventory = await store.getPlatformSetting(FARM_FILAMENT_INVENTORY_KEY, { spools: [] });
        const settings = normalizeFarmAutomationSettings({ inventory });
        return augmentOverviewWithInventory(overview, settings.inventory);
    } catch {
        return overview;
    }
}

async function createReadyPrintJob({ store, merchant, upload, file, now }) {
    const overview = await loadRoutableOverview({ store, merchant });
    const strategy = normalizeRoutingStrategy(upload.options.routing_strategy || upload.requirements.routing_strategy);
    const route = routeMerchantPrintJob({
        overview,
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
        const selectedPrinter = findSelectedPrinter(overview, route);
        const downloadUrl = await store.createSignedPrintArtifactUrl(file.storage_path, SIGNED_URL_TTL_SECONDS);
        // Map the job's required material/color onto the selected printer's AMS
        // trays so the print pulls from the right slot(s), not the default.
        const amsMapping = buildAmsMappingForPrinter(selectedPrinter, upload.requirements);
        await store.createNodeCommand({
            org_id: merchant.org_id,
            node_id: route.selected_node_id,
            printer_id: route.selected_printer_id,
            job_id: job.job_id,
            command_type: 'cloud.print.ready',
            payload: {
                print_job_id: job.job_id,
                name: upload.name,
                local_printer_id: selectedPrinter?.local_printer_id || selectedPrinter?.printer_id || route.selected_printer_id,
                download_url: downloadUrl,
                storage_path: file.storage_path,
                original_name: file.original_name,
                content_type: file.content_type,
                file_mode: file.file_mode,
                requirements: upload.requirements,
                options: upload.options,
                ams_mapping: amsMapping,
                use_ams: amsMapping.length > 0,
                issued_at: now().toISOString(),
            },
        });
    }

    return { job, routing: route, reservation };
}

async function createSourceModelJob({ store, merchant, upload, file }) {
    const job = await store.createPrintJob({
        org_id: merchant.org_id,
        merchant_id: merchant.merchant_id,
        node_id: null,
        printer_id: null,
        file_id: file.file_id,
        name: upload.name,
        status: 'needs_slicing',
        options: upload.options,
        routing_summary: {
            status: 'needs_slicing',
            strategy: 'source_model_slicing_required',
        },
    });

    return { job, routing: null, reservation: null };
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

    const result = upload.file.fileMode === 'source_model'
        ? await createSourceModelJob({ store, merchant, upload, file })
        : await createReadyPrintJob({ store, merchant, upload, file, now });

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
