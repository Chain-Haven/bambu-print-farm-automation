import { AdminAuthError, authenticateCloudAdmin } from './adminAuth.js';
import { parseJsonBody } from './agentProtocol.js';
import { createRequestId } from './httpServerUtils.js';
import { normalizeUpload } from './merchantPrintHandlers.js';
import { buildAmsMappingForPrinter, routeMerchantPrintJob } from './merchantRouting.js';
import { normalizeRoutingStrategy } from './printIntake.js';
import { augmentOverviewWithInventory, normalizeFarmAutomationSettings } from './farmAutomation.js';

// Operator drop-in printing: POST a 3MF / STL / gcode file to the cloud
// console and it auto-routes to an available printer on one of the farm
// nodes. Ready files ride the existing cloud.print.ready pipeline; source
// models (STL/OBJ/STEP, unsliced 3MF) are routed to a printer and sliced ON
// the target node via the new cloud.print.source command (OrcaSlicer CLI),
// so no artifact round-trip to the cloud is needed.

const SIGNED_URL_TTL_SECONDS = 3600;
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

async function loadRoutableOverview({ store, orgId }) {
    const overview = await store.getCloudOverview({ orgId, limit: 100 });
    if (typeof store.getPlatformSetting !== 'function') return overview;
    try {
        const inventory = await store.getPlatformSetting(FARM_FILAMENT_INVENTORY_KEY, { spools: [] });
        const settings = normalizeFarmAutomationSettings({ inventory });
        return augmentOverviewWithInventory(overview, settings.inventory);
    } catch {
        return overview;
    }
}

function findSelectedPrinter(overview, route) {
    return (overview.printers || []).find((printer) => printer.printer_id === route.selected_printer_id) || null;
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

            // Route. Source models prefer nodes that advertise a slicer.
            let routingOverview = overview;
            if (isSource) {
                const slicerNodeIds = new Set(
                    (overview.nodes || [])
                        .filter((node) => node.capabilities?.can_slice === true)
                        .map((node) => node.node_id),
                );
                if (slicerNodeIds.size > 0) {
                    routingOverview = {
                        ...overview,
                        printers: (overview.printers || []).filter((printer) => slicerNodeIds.has(printer.node_id)),
                    };
                }
            }

            const route = routeMerchantPrintJob({
                overview: routingOverview,
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
                const selectedPrinter = findSelectedPrinter(routingOverview, route);
                const downloadUrl = await store.createSignedPrintArtifactUrl(storagePath, SIGNED_URL_TTL_SECONDS);
                const amsMapping = buildAmsMappingForPrinter(selectedPrinter, upload.requirements);
                command = await store.createNodeCommand({
                    org_id: orgId,
                    node_id: route.selected_node_id,
                    printer_id: route.selected_printer_id,
                    job_id: job.job_id,
                    command_type: isSource ? 'cloud.print.source' : 'cloud.print.ready',
                    payload: {
                        print_job_id: job.job_id,
                        name: upload.name,
                        local_printer_id: selectedPrinter?.local_printer_id || selectedPrinter?.printer_id || route.selected_printer_id,
                        download_url: downloadUrl,
                        storage_path: storagePath,
                        original_name: file.original_name,
                        content_type: file.content_type,
                        file_mode: file.file_mode,
                        requirements: upload.requirements,
                        options: upload.options,
                        ams_mapping: amsMapping,
                        use_ams: amsMapping.length > 0,
                        ...(isSource ? {
                            printer_model: selectedPrinter?.model || null,
                            slice_settings: isPlainObject(body.slice_settings) ? body.slice_settings : null,
                        } : {}),
                        issued_at: now().toISOString(),
                    },
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
