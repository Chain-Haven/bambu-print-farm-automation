import { parseJsonBody } from './agentProtocol.js';
import { releaseFilamentReservation } from './filamentReservations.js';
import {
    MerchantAuthError,
    authenticateMerchantRequest,
} from './merchantAuth.js';
import { deliverMerchantWebhook } from './webhooks.js';

const FARM_FILAMENT_INVENTORY_KEY = 'farm_filament_inventory';

function sendJson(res, statusCode, payload) {
    if (typeof res.status === 'function' && typeof res.json === 'function') {
        return res.status(statusCode).json(payload);
    }
    res.statusCode = statusCode;
    if (typeof res.setHeader === 'function') res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(payload));
}

function methodNotAllowed(res, methods) {
    if (typeof res.setHeader === 'function') res.setHeader('Allow', methods);
    return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
}

function requiredString(value, name) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
    return value.trim();
}

function optionalString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function handleMerchantAuthError(res, error) {
    if (error instanceof MerchantAuthError) {
        return sendJson(res, error.statusCode, { ok: false, error: error.code });
    }
    return null;
}

async function recordLifecycleUsage({ store, merchant, job, eventType, now }) {
    if (typeof store.createMerchantUsageEvent !== 'function') return;
    await store.createMerchantUsageEvent({
        org_id: merchant.org_id,
        merchant_id: merchant.merchant_id,
        job_id: job.job_id,
        file_id: job.file_id || null,
        event_type: eventType,
        quantity: 1,
        metrics: { status: job.status, recorded_at: now().toISOString() },
    });
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

export function createMerchantPrintJobLifecycleHandler({
    store,
    action,
    pepper = process.env.MERCHANT_API_KEY_PEPPER || process.env.NODE_TOKEN_PEPPER,
    now = () => new Date(),
    fetchImpl = globalThis.fetch,
}) {
    if (!store) throw new Error('store is required');
    if (!['approve', 'cancel', 'reprint'].includes(action)) throw new Error('unsupported lifecycle action');

    return async function merchantPrintJobLifecycleHandler(req, res) {
        if (req.method && req.method !== 'POST') {
            return methodNotAllowed(res, 'POST');
        }

        try {
            const context = await authenticateMerchantRequest(req, { store, pepper, now });
            const body = parseJsonBody(req.body);
            const jobId = requiredString(body.job_id, 'job_id');
            const job = await store.getMerchantPrintJob({
                merchantId: context.merchant.merchant_id,
                jobId,
            });
            if (!job) return sendJson(res, 404, { ok: false, error: 'print_job_not_found' });

            if (action === 'approve') {
                const updated = await store.updatePrintJob(job.job_id, {
                    status: job.status === 'needs_approval' ? 'queued' : job.status,
                    options: {
                        ...(job.options || {}),
                        approved_at: now().toISOString(),
                    },
                });
                await recordLifecycleUsage({ store, merchant: context.merchant, job: updated, eventType: 'job.approved', now });
                await deliverMerchantWebhook({ merchant: context.merchant, eventType: 'job.approved', data: { job: updated }, fetchImpl, now });
                return sendJson(res, 200, { ok: true, job: updated });
            }

            if (action === 'cancel') {
                const updated = await store.updatePrintJob(job.job_id, {
                    status: 'canceled',
                    options: {
                        ...(job.options || {}),
                        canceled_at: now().toISOString(),
                        cancel_reason: optionalString(body.reason),
                    },
                });
                // Best-effort: tell the node that owns this job to stop the print, so
                // canceling in the storefront actually halts the printer. Guarded so a
                // dispatch failure never blocks the cancel + reservation release.
                let stop_dispatched = false;
                if (job.node_id && typeof store.createNodeCommand === 'function') {
                    try {
                        await store.createNodeCommand({
                            org_id: context.merchant.org_id,
                            node_id: job.node_id,
                            printer_id: job.printer_id || null,
                            job_id: job.job_id,
                            command_type: 'printer.stop',
                            payload: {
                                local_printer_id: job.routing_summary?.local_printer_id || job.printer_id || null,
                                job_id: job.job_id,
                                reason: optionalString(body.reason),
                            },
                        });
                        stop_dispatched = true;
                    } catch { /* node dispatch is best-effort */ }
                }
                const reservation_release = await releaseReservationIfNeeded({ store, job });
                await recordLifecycleUsage({ store, merchant: context.merchant, job: updated, eventType: 'job.canceled', now });
                await deliverMerchantWebhook({ merchant: context.merchant, eventType: 'job.canceled', data: { job: updated }, fetchImpl, now });
                return sendJson(res, 200, { ok: true, job: updated, reservation_release, stop_dispatched });
            }

            const reprint = await store.createPrintJob({
                org_id: context.merchant.org_id,
                merchant_id: context.merchant.merchant_id,
                node_id: null,
                printer_id: null,
                file_id: job.file_id,
                name: `Reprint: ${job.name || job.job_id}`,
                status: 'reprint_requested',
                options: {
                    ...(job.options || {}),
                    source_job_id: job.job_id,
                    reprint_reason: optionalString(body.reason),
                    requested_at: now().toISOString(),
                },
                routing_summary: {
                    status: 'reprint_requested',
                    source_job_id: job.job_id,
                },
            });
            await recordLifecycleUsage({ store, merchant: context.merchant, job: reprint, eventType: 'job.reprint_requested', now });
            await deliverMerchantWebhook({ merchant: context.merchant, eventType: 'job.reprint_requested', data: { job: reprint }, fetchImpl, now });
            return sendJson(res, 201, { ok: true, job: reprint });
        } catch (error) {
            const handled = handleMerchantAuthError(res, error);
            if (handled) return handled;
            return sendJson(res, 400, {
                ok: false,
                error: `${action}_print_job_failed`,
                request_id: req.headers?.['x-vercel-id'] || null,
                message: error.message,
            });
        }
    };
}
