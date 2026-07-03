import { buildAmsMappingForPrinter, routeMerchantPrintJob } from './merchantRouting.js';
import { augmentOverviewWithInventory, normalizeFarmAutomationSettings } from './farmAutomation.js';
import { normalizeRoutingStrategy } from './printIntake.js';

// Shared print-dispatch plumbing used by the merchant print API
// (merchantPrintHandlers.js), the operator drop-in endpoint
// (adminPrintHandlers.js), and the heartbeat re-dispatcher (agentHandlers.js):
// route a stored job file to an available printer and queue the node command
// (cloud.print.ready for sliced artifacts, cloud.print.source for STL/OBJ/
// STEP/unsliced-3MF which the TARGET node slices before printing).

const SIGNED_URL_TTL_SECONDS = 3600;
const FARM_FILAMENT_INVENTORY_KEY = 'farm_filament_inventory';

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isSourceModelFile(file) {
    return String(file?.file_mode || '') === 'source_model';
}

/** Overview with the operator's spool inventory merged into printer capabilities. */
export async function loadRoutableOverview({ store, orgId = null, limit = 100 }) {
    const overview = await store.getCloudOverview({ orgId, limit });
    if (typeof store.getPlatformSetting !== 'function') return overview;
    try {
        const inventory = await store.getPlatformSetting(FARM_FILAMENT_INVENTORY_KEY, { spools: [] });
        const settings = normalizeFarmAutomationSettings({ inventory });
        return augmentOverviewWithInventory(overview, settings.inventory);
    } catch {
        return overview;
    }
}

/**
 * Source models must be sliced on the node that prints them, so when at least
 * one node advertises a slicer (capabilities.can_slice from its heartbeat),
 * restrict routing to those nodes' printers. When none advertise it, keep the
 * whole overview — the node reports a clear slicer error if it can't.
 */
export function preferSlicerNodes(overview) {
    const slicerNodeIds = new Set(
        (overview.nodes || [])
            .filter((node) => node.capabilities?.can_slice === true)
            .map((node) => node.node_id),
    );
    if (slicerNodeIds.size === 0) return overview;
    return {
        ...overview,
        printers: (overview.printers || []).filter((printer) => slicerNodeIds.has(printer.node_id)),
    };
}

export function findSelectedPrinter(overview, route) {
    return (overview.printers || []).find((printer) => printer.printer_id === route.selected_printer_id) || null;
}

/**
 * Route a job file against the current overview. Returns { route, overview }
 * where overview is the (possibly slicer-filtered) view the route came from.
 */
export function routeJobFile({ overview, file, requirements = {}, strategy = null }) {
    const routingOverview = isSourceModelFile(file) ? preferSlicerNodes(overview) : overview;
    const route = routeMerchantPrintJob({
        overview: routingOverview,
        requirements,
        strategy: normalizeRoutingStrategy(strategy),
    });
    return { route, routingOverview };
}

/**
 * Queue the node command that makes the routed job print: signed download URL,
 * AMS mapping for the selected printer, and cloud.print.source extras
 * (printer model for slicer presets + optional slice settings).
 */
export async function queuePrintDispatchCommand({
    store,
    orgId,
    job,
    file,
    route,
    overview,
    requirements = {},
    options = {},
    now = () => new Date(),
}) {
    const isSource = isSourceModelFile(file);
    const selectedPrinter = findSelectedPrinter(overview, route);
    const downloadUrl = await store.createSignedPrintArtifactUrl(file.storage_path, SIGNED_URL_TTL_SECONDS);
    const amsMapping = buildAmsMappingForPrinter(selectedPrinter, requirements);

    return store.createNodeCommand({
        org_id: orgId,
        node_id: route.selected_node_id,
        printer_id: route.selected_printer_id,
        job_id: job.job_id,
        command_type: isSource ? 'cloud.print.source' : 'cloud.print.ready',
        payload: {
            print_job_id: job.job_id,
            name: job.name,
            local_printer_id: selectedPrinter?.local_printer_id || selectedPrinter?.printer_id || route.selected_printer_id,
            download_url: downloadUrl,
            storage_path: file.storage_path,
            original_name: file.original_name,
            content_type: file.content_type,
            file_mode: file.file_mode,
            requirements,
            options,
            ams_mapping: amsMapping,
            use_ams: amsMapping.length > 0,
            ...(isSource ? {
                printer_model: selectedPrinter?.model || null,
                slice_settings: isPlainObject(options.slice_settings) ? options.slice_settings : null,
            } : {}),
            issued_at: now().toISOString(),
        },
    });
}

/**
 * Give queued-but-unplaced jobs (waiting_for_capacity) another routing pass.
 * Runs from the heartbeat path — the cloud's periodic entry point — so a
 * printer finishing a print or a new node coming online pulls the backlog
 * automatically. Claim-then-dispatch: store.claimWaitingPrintJob only
 * transitions jobs still in waiting_for_capacity, so concurrent heartbeats
 * cannot double-dispatch one job. Best-effort per job.
 */
export async function redispatchWaitingJobs({ store, orgId, now = () => new Date(), limit = 10 }) {
    if (typeof store.listPrintJobsByStatus !== 'function'
        || typeof store.getJobFileById !== 'function'
        || typeof store.claimWaitingPrintJob !== 'function') {
        return { dispatched: 0 };
    }

    const waiting = await store.listPrintJobsByStatus({
        orgId,
        statuses: ['waiting_for_capacity'],
        limit,
    });
    if (!Array.isArray(waiting) || waiting.length === 0) return { dispatched: 0 };

    const overview = await loadRoutableOverview({ store, orgId });
    // Track printers placed during THIS pass so two waiting jobs don't both
    // land on the printer that just freed up.
    const placedPrinters = new Set();
    let dispatched = 0;

    for (const job of waiting) {
        try {
            if (!job.file_id) continue;
            const file = await store.getJobFileById(job.file_id);
            if (!file?.storage_path) continue;

            const requirements = isPlainObject(file.requirements) ? file.requirements : {};
            const passOverview = {
                ...overview,
                printers: (overview.printers || []).filter((printer) => !placedPrinters.has(printer.printer_id)),
            };
            const { route, routingOverview } = routeJobFile({
                overview: passOverview,
                file,
                requirements,
                strategy: job.options?.routing_strategy,
            });
            if (route.status !== 'routed') continue;

            const claimed = await store.claimWaitingPrintJob(job.job_id, {
                node_id: route.selected_node_id,
                printer_id: route.selected_printer_id,
                status: 'queued',
                routing_summary: route,
            });
            if (!claimed) continue; // someone else dispatched it first

            await store.createRoutingDecision({
                org_id: job.org_id,
                merchant_id: job.merchant_id || null,
                job_id: job.job_id,
                selected_node_id: route.selected_node_id,
                selected_printer_id: route.selected_printer_id,
                status: route.status,
                strategy: route.strategy,
                score: route.score,
                rejected_candidates: route.rejected_candidates,
            });

            await queuePrintDispatchCommand({
                store,
                orgId: job.org_id,
                job: claimed,
                file,
                route,
                overview: routingOverview,
                requirements,
                options: isPlainObject(job.options) ? job.options : {},
                now,
            });

            placedPrinters.add(route.selected_printer_id);
            dispatched += 1;
        } catch { /* per-job isolation — the next heartbeat retries */ }
    }

    return { dispatched };
}
