import { parseJsonBody } from './agentProtocol.js';
import { createRequestId, getRequestId } from './httpServerUtils.js';
import { authenticateAdmin } from './adminHandlers.js';
import { recordAdminAudit } from './adminAudit.js';
import { redispatchWaitingJobs } from './printDispatch.js';
import { releaseFilamentReservation } from './filamentReservations.js';

// Platform-wide operations endpoints for the operator console:
//   /api/cloud/jobs  — list every print job (filterable) + cancel / redispatch
//   /api/cloud/stats — accurate aggregate counts for the dashboard tiles
//   /api/cloud/audit — the admin audit trail (who did what, when)

const FARM_FILAMENT_INVENTORY_KEY = 'farm_filament_inventory';
const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'canceled']);

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

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

function sendInternalError(res, req, fallbackCode) {
    return sendJson(res, 500, {
        ok: false,
        error: fallbackCode,
        message: 'Unexpected server error',
        request_id: getRequestId(req),
    });
}

function requiredString(value, name) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
    return value.trim();
}

function optionalString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseLimit(query = {}, fallback = 50, max = 100) {
    const raw = Number.parseInt(query.limit, 10);
    if (!Number.isFinite(raw)) return fallback;
    return Math.max(1, Math.min(raw, max));
}

function parseOffset(query = {}) {
    const raw = Number.parseInt(query.offset, 10);
    if (!Number.isFinite(raw)) return 0;
    return Math.max(0, raw);
}

function parseStatusList(value) {
    return String(value || '')
        .split(',')
        .map((status) => status.trim().toLowerCase())
        .filter(Boolean);
}

async function releaseReservationIfNeeded({ store, job }) {
    if (typeof store.getPlatformSetting !== 'function' || typeof store.upsertPlatformSetting !== 'function') return null;
    const inventory = await store.getPlatformSetting(FARM_FILAMENT_INVENTORY_KEY, { spools: [] });
    const result = releaseFilamentReservation({ inventory, jobId: job.job_id });
    if (result.released.length > 0) {
        await store.upsertPlatformSetting(FARM_FILAMENT_INVENTORY_KEY, result.inventory);
    }
    return result;
}

/**
 * GET  /api/cloud/jobs?status=&merchant_id=&org_id=&q=&limit=&offset=
 * POST /api/cloud/jobs { action: 'cancel'|'redispatch', job_id?, reason?, org_id? }
 */
export function createCloudJobsHandler({
    store,
    adminToken = process.env.CLOUD_ADMIN_TOKEN,
    now = () => new Date(),
}) {
    if (!store) throw new Error('store is required');

    async function handleCancel({ auth, body, res }) {
        const jobId = requiredString(body.job_id, 'job_id');
        const job = await store.getPrintJobById(jobId);
        if (!job) return sendJson(res, 404, { ok: false, error: 'job_not_found' });

        const currentStatus = String(job.status || '').toLowerCase();
        if (TERMINAL_JOB_STATUSES.has(currentStatus)) {
            return sendJson(res, 409, {
                ok: false,
                error: 'job_not_cancelable',
                message: `Job is already ${currentStatus}.`,
            });
        }

        const reason = optionalString(body.reason);
        const updated = await store.updatePrintJob(job.job_id, {
            status: 'canceled',
            options: {
                ...(job.options || {}),
                canceled_at: now().toISOString(),
                cancel_reason: reason,
                canceled_by: auth?.adminUser?.email || 'admin',
            },
        });

        // Best-effort: halt the printer that owns this job. Guarded so a node
        // dispatch failure never blocks the cancel + reservation release.
        let stopDispatched = false;
        if (job.node_id && typeof store.createNodeCommand === 'function') {
            try {
                await store.createNodeCommand({
                    org_id: job.org_id,
                    node_id: job.node_id,
                    printer_id: job.printer_id || null,
                    job_id: job.job_id,
                    command_type: 'printer.stop',
                    payload: {
                        // routing_summary carries the node-side printer id; the
                        // cloud printer_id UUID means nothing to the local node.
                        local_printer_id: job.routing_summary?.selected_local_printer_id
                            || job.routing_summary?.local_printer_id
                            || job.printer_id
                            || null,
                        job_id: job.job_id,
                        reason,
                    },
                });
                stopDispatched = true;
            } catch { /* node dispatch is best-effort */ }
        }

        const reservationRelease = await releaseReservationIfNeeded({ store, job });
        await recordAdminAudit({
            store,
            actor: auth,
            action: 'job.cancel',
            targetType: 'job',
            targetId: job.job_id,
            detail: {
                name: job.name,
                previous_status: currentStatus,
                reason,
                stop_dispatched: stopDispatched,
            },
            now,
        });

        return sendJson(res, 200, {
            ok: true,
            job: updated,
            stop_dispatched: stopDispatched,
            reservation_release: reservationRelease,
        });
    }

    async function handleRedispatch({ auth, body, res }) {
        const jobId = optionalString(body.job_id);
        let orgId = optionalString(body.org_id);

        if (jobId) {
            const job = await store.getPrintJobById(jobId);
            if (!job) return sendJson(res, 404, { ok: false, error: 'job_not_found' });
            if (String(job.status || '').toLowerCase() !== 'waiting_for_capacity') {
                return sendJson(res, 409, {
                    ok: false,
                    error: 'job_not_waiting',
                    message: 'Only jobs waiting for capacity can be redispatched.',
                });
            }
            orgId = job.org_id || orgId;
        }

        const result = await redispatchWaitingJobs({ store, orgId: orgId || null, now, limit: 20 });
        const job = jobId ? await store.getPrintJobById(jobId) : null;

        await recordAdminAudit({
            store,
            actor: auth,
            action: 'job.redispatch',
            targetType: jobId ? 'job' : 'org',
            targetId: jobId || orgId || 'all',
            detail: { dispatched: result.dispatched },
            now,
        });

        return sendJson(res, 200, {
            ok: true,
            dispatched: result.dispatched,
            ...(job ? { job } : {}),
        });
    }

    return async function cloudJobsHandler(req, res) {
        if (req.method === 'GET') {
            try {
                if (!(await authenticateAdmin(req, res, adminToken, store))) return null;
                const query = req.query || {};
                const filters = {
                    orgId: optionalString(query.org_id),
                    merchantId: optionalString(query.merchant_id),
                    statuses: parseStatusList(query.status),
                    search: optionalString(query.q),
                    limit: parseLimit(query),
                    offset: parseOffset(query),
                };
                const jobs = typeof store.listPrintJobsAdmin === 'function'
                    ? await store.listPrintJobsAdmin(filters)
                    : [];
                return sendJson(res, 200, {
                    ok: true,
                    jobs,
                    paging: { limit: filters.limit, offset: filters.offset, returned: jobs.length },
                });
            } catch (error) {
                return sendInternalError(res, req, 'list_jobs_failed');
            }
        }

        if (req.method && req.method !== 'POST') {
            return methodNotAllowed(res, 'GET, POST');
        }

        try {
            const auth = await authenticateAdmin(req, res, adminToken, store);
            if (!auth) return null;
            const body = parseJsonBody(req.body);
            const action = requiredString(isPlainObject(body) ? body.action : null, 'action');

            if (action === 'cancel') return await handleCancel({ auth, body, res });
            if (action === 'redispatch') return await handleRedispatch({ auth, body, res });

            return sendJson(res, 400, {
                ok: false,
                error: 'invalid_job_action',
                message: 'action must be cancel or redispatch',
            });
        } catch (error) {
            return sendJson(res, 400, {
                ok: false,
                error: 'job_action_failed',
                message: error.message,
            });
        }
    };
}

/** GET /api/cloud/stats?org_id= — accurate aggregate counts for dashboard tiles. */
export function createCloudStatsHandler({
    store,
    adminToken = process.env.CLOUD_ADMIN_TOKEN,
    now = () => new Date(),
}) {
    if (!store) throw new Error('store is required');

    return async function cloudStatsHandler(req, res) {
        if (req.method && req.method !== 'GET') {
            return methodNotAllowed(res, 'GET');
        }

        try {
            if (!(await authenticateAdmin(req, res, adminToken, store))) return null;
            const stats = typeof store.getCloudStats === 'function'
                ? await store.getCloudStats({ orgId: optionalString((req.query || {}).org_id) })
                : null;
            if (!stats) {
                return sendJson(res, 200, { ok: true, stats: null, supported: false });
            }
            return sendJson(res, 200, {
                ok: true,
                stats: { ...stats, generated_at: now().toISOString() },
            });
        } catch (error) {
            return sendInternalError(res, req, 'stats_failed');
        }
    };
}

/** GET /api/cloud/audit?limit=&action=&target_type=&target_id=&actor= */
export function createCloudAuditLogHandler({
    store,
    adminToken = process.env.CLOUD_ADMIN_TOKEN,
}) {
    if (!store) throw new Error('store is required');

    return async function cloudAuditLogHandler(req, res) {
        if (req.method && req.method !== 'GET') {
            return methodNotAllowed(res, 'GET');
        }

        try {
            if (!(await authenticateAdmin(req, res, adminToken, store))) return null;
            const query = req.query || {};

            if (typeof store.listAuditLogEntries !== 'function') {
                return sendJson(res, 200, { ok: true, entries: [], supported: false });
            }

            try {
                const entries = await store.listAuditLogEntries({
                    limit: parseLimit(query),
                    action: optionalString(query.action),
                    targetType: optionalString(query.target_type),
                    targetId: optionalString(query.target_id),
                    actorEmail: optionalString(query.actor),
                });
                return sendJson(res, 200, { ok: true, entries });
            } catch (error) {
                // The audit table ships in migration 20260706090000 — deployments
                // that haven't applied it yet get an empty log, not a hard error.
                if (error?.name === 'SupabaseMissingTableError' || /admin_audit_log/.test(String(error?.message))) {
                    return sendJson(res, 200, { ok: true, entries: [], pending_migration: true });
                }
                throw error;
            }
        } catch (error) {
            return sendInternalError(res, req, 'audit_log_failed');
        }
    };
}
