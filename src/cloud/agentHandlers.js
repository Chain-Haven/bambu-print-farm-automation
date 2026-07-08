import {
    getBearerToken,
    hashNodeToken,
    normalizeAgentEvents,
    normalizeCommandResult,
    normalizeHeartbeat,
    parseJsonBody,
} from './agentProtocol.js';
import {
    getRequestId,
    methodNotAllowed as sharedMethodNotAllowed,
    sendHandlerError,
    sendJson,
    sendClientError,
} from './httpServerUtils.js';
import { releaseFilamentReservation } from './filamentReservations.js';
import { planAutoEjectCommands } from './farmAutomation.js';
import { evaluateFilamentReorders } from './filamentReorder.js';
import { redispatchWaitingJobs } from './printDispatch.js';
import { deliverMerchantWebhook } from './webhooks.js';
import { deliverMerchantWebhookEvent } from './merchantWebhookDelivery.js';

const FARM_FILAMENT_INVENTORY_KEY = 'farm_filament_inventory';
const FARM_AUTOMATION_POLICY_KEY = 'farm_automation_policy';
const PENDING_COMMAND_STATUSES = new Set(['queued', 'claimed', 'running']);
// After an eject command finishes, do not re-enqueue another one for the same
// printer within this window (the printer usually stays in FINISH state until
// the next print starts, so without this every heartbeat would re-eject).
const AUTO_EJECT_COOLDOWN_MS = 30 * 60 * 1000;

// Node-reported job lifecycle → cloud print_jobs status. Terminal statuses are
// never overwritten (duplicate/out-of-order event delivery is expected).
const JOB_LIFECYCLE_EVENTS = {
    'print_job.started': { status: 'printing', webhook: 'job.started', terminal: false },
    'print_job.completed': { status: 'completed', webhook: 'job.completed', terminal: true },
    'print_job.failed': { status: 'failed', webhook: 'job.failed', terminal: true },
};
const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'canceled']);

async function releaseJobReservation(store, jobId) {
    if (typeof store.getPlatformSetting !== 'function' || typeof store.upsertPlatformSetting !== 'function') return;
    const inventory = await store.getPlatformSetting(FARM_FILAMENT_INVENTORY_KEY, { spools: [] });
    const result = releaseFilamentReservation({ inventory, jobId });
    if (result.released.length > 0) {
        await store.upsertPlatformSetting(FARM_FILAMENT_INVENTORY_KEY, result.inventory);
    }
}

/**
 * Apply node-reported merchant job lifecycle events to print_jobs: move the
 * status, release the filament reservation on terminal states (so the router
 * sees the spool again), and fire the merchant webhook. Best-effort per event —
 * a bad event must never fail the whole batch.
 */
async function processJobLifecycleEvents({ store, node, events, now, fetchImpl }) {
    if (typeof store.updatePrintJob !== 'function' || typeof store.getPrintJobById !== 'function') {
        return { processed: 0 };
    }

    const nodeOrgId = node.organization_id || node.org_id || null;
    let processed = 0;

    for (const event of events) {
        const lifecycle = JOB_LIFECYCLE_EVENTS[event.event_type];
        const jobId = event.payload?.print_job_id;
        if (!lifecycle || typeof jobId !== 'string' || !jobId.trim()) continue;

        try {
            const job = await store.getPrintJobById(jobId.trim());
            if (!job) continue;
            // A node may only move jobs that belong to its own organization.
            if (nodeOrgId && job.org_id && job.org_id !== nodeOrgId) continue;
            if (TERMINAL_JOB_STATUSES.has(String(job.status || '').toLowerCase())) continue;

            const updated = await store.updatePrintJob(job.job_id, {
                status: lifecycle.status,
                options: {
                    ...(job.options || {}),
                    [`${lifecycle.status}_at`]: now().toISOString(),
                    ...(event.payload?.reason ? { node_reported_reason: event.payload.reason } : {}),
                    node_local_job_id: event.payload?.local_job_id || job.options?.node_local_job_id || null,
                },
            });
            processed += 1;

            if (lifecycle.terminal) {
                try {
                    await releaseJobReservation(store, job.job_id);
                } catch { /* reservation release is best-effort */ }
            }

            if (job.merchant_id && typeof store.findMerchantById === 'function') {
                try {
                    const merchant = await store.findMerchantById(job.merchant_id);
                    if (merchant) {
                        await deliverMerchantWebhook({
                            merchant,
                            eventType: lifecycle.webhook,
                            data: { job: updated || { ...job, status: lifecycle.status } },
                            fetchImpl,
                            now,
                        });
                        // Fan out to v2 webhook endpoints (persisted deliveries +
                        // retries). No-op when no v2 endpoints are configured.
                        await deliverMerchantWebhookEvent({
                            store,
                            merchant,
                            eventType: lifecycle.webhook,
                            data: { job: updated || { ...job, status: lifecycle.status } },
                            fetchImpl,
                            now,
                        });
                    }
                } catch { /* webhook delivery is best-effort */ }
            }
        } catch { /* per-event isolation */ }
    }

    return { processed };
}

/**
 * Turn the farm-automation auto-eject policy into durable `printer.eject`
 * node commands. Runs on every heartbeat (the cloud's only periodic entry
 * point) and is strictly best-effort: any failure here must never fail the
 * heartbeat. Deduped against pending and recently-finished eject commands so
 * a printer sitting in FINISH state is not re-ejected every 30 seconds.
 */
async function maybeQueueAutoEjectCommands({ store, node, printers, now }) {
    if (typeof store.createNodeCommand !== 'function'
        || typeof store.listNodeCommands !== 'function'
        || typeof store.getPlatformSetting !== 'function') {
        return { queued: 0 };
    }

    const policy = await store.getPlatformSetting(FARM_AUTOMATION_POLICY_KEY, null);
    if (!policy || policy.auto_eject_enabled !== true) return { queued: 0 };

    const plan = planAutoEjectCommands({ printers, settings: { policy } });
    if (plan.length === 0) return { queued: 0 };

    const recent = await store.listNodeCommands({
        nodeId: node.node_id,
        commandType: 'printer.eject',
        limit: 50,
    });
    const nowMs = now().getTime();
    const blockedPrinters = new Set();
    for (const command of recent) {
        const localPrinterId = command.payload?.local_printer_id;
        if (!localPrinterId) continue;
        if (PENDING_COMMAND_STATUSES.has(String(command.status || '').toLowerCase())) {
            blockedPrinters.add(localPrinterId);
            continue;
        }
        const finishedAt = command.finished_at ? new Date(command.finished_at).getTime() : null;
        if (finishedAt && nowMs - finishedAt < AUTO_EJECT_COOLDOWN_MS) {
            blockedPrinters.add(localPrinterId);
        }
    }

    let queued = 0;
    for (const item of plan) {
        if (blockedPrinters.has(item.local_printer_id)) continue;
        try {
            await store.createNodeCommand({
                org_id: node.organization_id || node.org_id,
                node_id: node.node_id,
                command_type: 'printer.eject',
                payload: {
                    local_printer_id: item.local_printer_id,
                    release_temperature_c: item.release_temperature_c,
                    max_eject_attempts: item.max_eject_attempts,
                    verification: item.verification,
                    source: 'auto_eject_policy',
                },
            });
            queued += 1;
        } catch { /* best-effort */ }
    }

    return { queued };
}

async function authenticateNode(req, res, { store, pepper, requestId }) {
    const token = getBearerToken(req.headers || {});
    if (!token) {
        sendClientError(res, 401, 'missing_agent_token', 'Agent bearer token is required', requestId);
        return null;
    }
    if (!pepper) {
        sendClientError(res, 503, 'cloud_not_configured', 'Cloud is not configured', requestId);
        return null;
    }

    const tokenHash = hashNodeToken(token, pepper);
    const node = await store.findNodeByTokenHash(tokenHash);
    if (!node) {
        sendClientError(res, 403, 'unknown_agent_token', 'Unknown agent token', requestId);
        return null;
    }

    return node;
}

function parseCommandLimit(query = {}) {
    const raw = Number.parseInt(query.limit, 10);
    if (!Number.isFinite(raw)) return 10;
    return Math.max(1, Math.min(raw, 50));
}

export function createHeartbeatHandler({ store, pepper, now = () => new Date() }) {
    if (!store) throw new Error('store is required');

    return async function heartbeatHandler(req, res) {
        const requestId = getRequestId(req);
        if (req.method && req.method !== 'POST') {
            return sharedMethodNotAllowed(res, 'POST', requestId);
        }

        try {
            const node = await authenticateNode(req, res, { store, pepper, requestId });
            if (!node) return null;

            const heartbeat = normalizeHeartbeat(parseJsonBody(req.body), now);
            await store.recordNodeHeartbeat(node.node_id, heartbeat);

            // Mirror the node's printers into cloud_printers. This is the ONLY
            // writer of that table — the admin console printer list and the
            // merchant router both depend on it being fresh.
            let printersSynced = 0;
            if (heartbeat.printers.length > 0 && typeof store.upsertCloudPrinters === 'function') {
                await store.upsertCloudPrinters(node, heartbeat.printers, heartbeat.last_seen_at);
                printersSynced = heartbeat.printers.length;
            }

            // Auto-eject policy → durable printer.eject commands (best-effort).
            let autoEject = { queued: 0 };
            if (heartbeat.printers.length > 0) {
                try {
                    autoEject = await maybeQueueAutoEjectCommands({
                        store,
                        node,
                        printers: heartbeat.printers,
                        now,
                    });
                } catch { /* never fail a heartbeat over eject planning */ }
            }

            // Waiting jobs get another routing pass now that this node's fresh
            // printer states are mirrored — a print finishing or a printer
            // coming online pulls the waiting_for_capacity backlog
            // automatically (best-effort, claim-guarded against races).
            let redispatch = { dispatched: 0 };
            try {
                redispatch = await redispatchWaitingJobs({
                    store,
                    orgId: node.organization_id || node.org_id || null,
                    now,
                });
            } catch { /* never fail a heartbeat over re-dispatch */ }

            // Filament restocking: compare spool inventory against the reorder
            // rules (Amazon Business). Internally throttled to one evaluation
            // per 5 minutes and idempotent at the vendor via externalId, so
            // running it on every heartbeat is safe and cheap (best-effort).
            let reorders = { created: 0, placed: 0 };
            try {
                reorders = await evaluateFilamentReorders({ store, now });
            } catch { /* never fail a heartbeat over restocking */ }

            return sendJson(res, 200, {
                ok: true,
                request_id: requestId,
                node_id: node.node_id,
                organization_id: node.organization_id || node.org_id,
                status: heartbeat.status,
                printers_synced: printersSynced,
                ...(autoEject.queued > 0 ? { auto_eject_commands_queued: autoEject.queued } : {}),
                ...(redispatch.dispatched > 0 ? { waiting_jobs_dispatched: redispatch.dispatched } : {}),
                ...(reorders.created > 0 ? { filament_reorders_created: reorders.created, filament_reorders_placed: reorders.placed } : {}),
            });
        } catch (error) {
            return sendHandlerError(res, error, requestId, { fallbackCode: 'heartbeat_failed' });
        }
    };
}

export function createClaimCommandsHandler({ store, pepper }) {
    if (!store) throw new Error('store is required');

    return async function claimCommandsHandler(req, res) {
        const requestId = getRequestId(req);
        if (req.method && req.method !== 'GET') {
            return sharedMethodNotAllowed(res, 'GET', requestId);
        }

        try {
            const node = await authenticateNode(req, res, { store, pepper, requestId });
            if (!node) return null;

            const limit = parseCommandLimit(req.query || {});
            const commands = await store.claimNodeCommands(node.node_id, limit);

            return sendJson(res, 200, {
                ok: true,
                request_id: requestId,
                node_id: node.node_id,
                commands,
            });
        } catch (error) {
            return sendHandlerError(res, error, requestId, { fallbackCode: 'claim_commands_failed' });
        }
    };
}

export function createEventsHandler({ store, pepper, now = () => new Date(), fetchImpl = globalThis.fetch }) {
    if (!store) throw new Error('store is required');

    return async function eventsHandler(req, res) {
        const requestId = getRequestId(req);
        if (req.method && req.method !== 'POST') {
            return sharedMethodNotAllowed(res, 'POST', requestId);
        }

        try {
            const node = await authenticateNode(req, res, { store, pepper, requestId });
            if (!node) return null;

            const events = normalizeAgentEvents(parseJsonBody(req.body), now);
            if (events.length === 0) {
                return sendClientError(res, 400, 'no_valid_events', 'No valid events in request', requestId);
            }

            await store.recordNodeEvents(node, events);

            // Node-reported merchant job lifecycle (started/completed/failed):
            // update print_jobs, release filament reservations, fire webhooks.
            const lifecycle = await processJobLifecycleEvents({ store, node, events, now, fetchImpl });

            return sendJson(res, 200, {
                ok: true,
                request_id: requestId,
                accepted: events.length,
                job_updates: lifecycle.processed,
            });
        } catch (error) {
            return sendHandlerError(res, error, requestId, { fallbackCode: 'record_events_failed' });
        }
    };
}

export function createCommandResultHandler({ store, pepper, now = () => new Date() }) {
    if (!store) throw new Error('store is required');

    return async function commandResultHandler(req, res) {
        const requestId = getRequestId(req);
        if (req.method && req.method !== 'POST') {
            return sharedMethodNotAllowed(res, 'POST', requestId);
        }

        try {
            const node = await authenticateNode(req, res, { store, pepper, requestId });
            if (!node) return null;

            const result = normalizeCommandResult(parseJsonBody(req.body), now);
            await store.recordCommandResult(node.node_id, result);

            return sendJson(res, 200, {
                ok: true,
                request_id: requestId,
                command_id: result.command_id,
                status: result.status,
            });
        } catch (error) {
            return sendHandlerError(res, error, requestId, { fallbackCode: 'record_command_result_failed' });
        }
    };
}
