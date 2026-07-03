import { AdminAuthError, authenticateCloudAdmin } from './adminAuth.js';
import { parseJsonBody } from './agentProtocol.js';
import { createRequestId } from './httpServerUtils.js';
import { normalizeUpload } from './merchantPrintHandlers.js';
import { normalizeRoutingStrategy } from './printIntake.js';
import {
    loadRoutableOverview,
    queuePrintDispatchCommand,
    routeJobFile,
} from './printDispatch.js';

// Operator drop-in printing: POST a 3MF / STL / gcode file to the cloud
// console and it auto-routes to an available printer on one of the farm
// nodes. Ready files ride the existing cloud.print.ready pipeline; source
// models (STL/OBJ/STEP, unsliced 3MF) are routed to a printer and sliced ON
// the target node via the cloud.print.source command (OrcaSlicer CLI), so no
// artifact round-trip to the cloud is needed. Shares src/cloud/printDispatch.js
// with the merchant print API.

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
    if (typeof res.setHeader === 'function') res.setHeader('Allow', methods);
    return sendJson(res, 405, {
        ok: false,
        error: 'method_not_allowed',
        message: 'Method not allowed',
        request_id: requestId,
    });
}

async function authenticateAdmin(req, res, adminToken, store) {
    if (!adminToken) {
        sendJson(res, 500, { ok: false, error: 'cloud_not_configured' });
        return false;
    }
    try {
        await authenticateCloudAdmin(req, {
            store,
            bootstrapToken: adminToken,
            pepper: process.env.ADMIN_SESSION_PEPPER || process.env.NODE_TOKEN_PEPPER,
        });
        return true;
    } catch (error) {
        if (error instanceof AdminAuthError) {
            sendJson(res, error.statusCode, { ok: false, error: error.code });
            return false;
        }
        throw error;
    }
}

export function createCloudPrintFilesHandler({
    store,
    adminToken = process.env.CLOUD_ADMIN_TOKEN,
    now = () => new Date(),
}) {
    if (!store) throw new Error('store is required');

    return async function cloudPrintFilesHandler(req, res) {
        if (req.method && req.method !== 'POST') {
            return methodNotAllowed(res, 'POST');
        }

        try {
            if (!(await authenticateAdmin(req, res, adminToken, store))) return null;

            const body = parseJsonBody(req.body);
            const upload = normalizeUpload(body);
            upload.options = {
                ...upload.options,
                routing_strategy: normalizeRoutingStrategy(upload.options.routing_strategy || body.routing_strategy),
                submitted_by: 'operator_console',
            };

            // Resolve the target org: explicit, else the org of the first
            // online node (single-org farms never have to think about this).
            let orgId = typeof body.org_id === 'string' && body.org_id.trim() ? body.org_id.trim() : null;
            let overview = await loadRoutableOverview({ store, orgId });
            if (!orgId) {
                const anyNode = (overview.nodes || []).find((node) => node.org_id) || null;
                if (!anyNode) {
                    return sendJson(res, 409, {
                        ok: false,
                        error: 'no_nodes',
                        message: 'No farm nodes are registered yet — provision a node before dropping files.',
                    });
                }
                orgId = anyNode.org_id;
                overview = await loadRoutableOverview({ store, orgId });
            }

            // Upload the artifact.
            const stamp = now().toISOString().replace(/[-:.]/g, '');
            const storagePath = `${orgId}/operator/${stamp}-${upload.file.checksum.slice(0, 12)}-${upload.file.originalName}`;
            await store.uploadPrintArtifact(storagePath, upload.file.buffer, upload.file.contentType);

            const file = await store.createJobFile({
                org_id: orgId,
                merchant_id: null,
                storage_path: storagePath,
                original_name: upload.file.originalName,
                content_type: upload.file.contentType,
                byte_size: upload.file.byteSize,
                checksum_sha256: upload.file.checksum,
                file_mode: upload.file.fileMode,
                requirements: upload.requirements,
            });

            const isSource = upload.file.fileMode === 'source_model';
            if (isSource && isPlainObject(body.slice_settings)) {
                upload.options = { ...upload.options, slice_settings: body.slice_settings };
            }

            // Route (source models prefer slicer-capable nodes) — same shared
            // dispatch the merchant API uses.
            const { route, routingOverview } = routeJobFile({
                overview,
                file,
                requirements: upload.requirements,
                strategy: upload.options.routing_strategy,
            });

            const jobStatus = route.status === 'routed' ? 'queued' : 'waiting_for_capacity';
            const job = await store.createPrintJob({
                org_id: orgId,
                merchant_id: null,
                node_id: route.selected_node_id,
                printer_id: route.selected_printer_id,
                file_id: file.file_id,
                name: upload.name,
                status: jobStatus,
                options: upload.options,
                routing_summary: route,
            });

            await store.createRoutingDecision({
                org_id: orgId,
                merchant_id: null,
                job_id: job.job_id,
                selected_node_id: route.selected_node_id,
                selected_printer_id: route.selected_printer_id,
                status: route.status,
                strategy: route.strategy,
                score: route.score,
                rejected_candidates: route.rejected_candidates,
            });

            let command = null;
            if (route.status === 'routed') {
                command = await queuePrintDispatchCommand({
                    store,
                    orgId,
                    job,
                    file,
                    route,
                    overview: routingOverview,
                    requirements: upload.requirements,
                    options: upload.options,
                    now,
                });
            }

            return sendJson(res, 201, {
                ok: true,
                file,
                job,
                routing: route,
                command_id: command?.command_id || null,
                ...(isSource ? { will_slice_on_node: route.status === 'routed' } : {}),
            });
        } catch (error) {
            return sendJson(res, 400, {
                ok: false,
                error: 'operator_print_failed',
                message: error.message,
            });
        }
    };
}
