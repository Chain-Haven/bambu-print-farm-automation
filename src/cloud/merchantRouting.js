const ACTIVE_JOB_STATUSES = new Set([
    'queued',
    'assigned',
    'transforming',
    'uploading',
    'printing',
    'waiting_for_capacity',
]);

const NODE_READY_STATUSES = new Set(['online', 'degraded']);
const PRINTER_UNAVAILABLE_STATUSES = new Set(['offline', 'disconnected', 'error', 'failed']);
const BUSY_PRINTER_STATES = new Set([
    'printing',
    'running',
    'prepare',
    'preparing',
    'pause',
    'paused',
    'slicing',
    'uploading',
]);

function asArray(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string' && value.trim()) return [value];
    return [];
}

function normalizeMaterial(value) {
    return typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : null;
}

function normalizeMaterials(value) {
    return new Set(asArray(value).map(normalizeMaterial).filter(Boolean));
}

function normalizeColor(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const raw = value.trim().replace(/^#/, '').toUpperCase();
    const expanded = raw.length === 3 ? raw.split('').map((char) => `${char}${char}`).join('') : raw;
    const hex = expanded.slice(0, 6);
    return /^[0-9A-F]{6}$/.test(hex) ? `#${hex}` : null;
}

function normalizeColors(value) {
    return new Set(asArray(value).map(normalizeColor).filter(Boolean));
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getNumber(...values) {
    for (const value of values) {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return null;
}

function getBuildVolume(capabilities = {}) {
    const volume = capabilities.build_volume_mm
        || capabilities.build_volume
        || capabilities.buildVolumeMm
        || capabilities.buildVolume
        || {};

    return {
        x: getNumber(capabilities.max_x, capabilities.maxX, volume.x, volume.max_x, volume.width),
        y: getNumber(capabilities.max_y, capabilities.maxY, volume.y, volume.max_y, volume.depth),
        z: getNumber(capabilities.max_z, capabilities.maxZ, volume.z, volume.max_z, volume.height),
    };
}

function getRequiredDimensions(requirements = {}) {
    const dimensions = requirements.dimensions_mm || requirements.dimensions || {};
    const x = getNumber(dimensions.x, dimensions.width);
    const y = getNumber(dimensions.y, dimensions.depth);
    const z = getNumber(dimensions.z, dimensions.height);
    if (!x && !y && !z) return null;
    return { x, y, z };
}

function fitsBuildVolume(printer, requirements) {
    const required = getRequiredDimensions(requirements);
    if (!required) return true;

    const volume = getBuildVolume(printer.capabilities || {});
    return ['x', 'y', 'z'].every((axis) => !required[axis] || (volume[axis] && volume[axis] >= required[axis]));
}

function collectTrayLikeValues(source, trays = []) {
    if (!source) return trays;
    if (Array.isArray(source)) {
        for (const item of source) collectTrayLikeValues(item, trays);
        return trays;
    }
    if (!isPlainObject(source)) return trays;

    const possibleMaterial = source.material || source.tray_type || source.type || source.tray_sub_brands;
    const possibleColor = source.color || source.color_hex || source.tray_color || source.colour;
    if (possibleMaterial || possibleColor) {
        trays.push({
            material: possibleMaterial,
            color: possibleColor,
        });
    }

    for (const key of ['tray', 'trays', 'ams', 'ams_trays', 'filaments', 'slots']) {
        collectTrayLikeValues(source[key], trays);
    }

    return trays;
}

function getAvailableMaterials(printer) {
    const capabilities = printer.capabilities || {};
    const direct = [
        ...asArray(capabilities.materials),
        ...asArray(capabilities.available_materials),
        ...asArray(capabilities.filaments),
    ];
    const trays = [
        ...collectTrayLikeValues(capabilities.ams_trays),
        ...collectTrayLikeValues(capabilities.trays),
        ...collectTrayLikeValues(printer.status_snapshot?.ams),
    ];

    return new Set([
        ...direct.map(normalizeMaterial),
        ...trays.map((tray) => normalizeMaterial(tray.material)),
    ].filter(Boolean));
}

function getAvailableColors(printer) {
    const capabilities = printer.capabilities || {};
    const direct = [
        ...asArray(capabilities.colors),
        ...asArray(capabilities.available_colors),
        ...asArray(capabilities.colours),
    ];
    const trays = [
        ...collectTrayLikeValues(capabilities.ams_trays),
        ...collectTrayLikeValues(capabilities.trays),
        ...collectTrayLikeValues(printer.status_snapshot?.ams),
    ];

    return new Set([
        ...direct.map(normalizeColor),
        ...trays.map((tray) => normalizeColor(tray.color)),
    ].filter(Boolean));
}

function allRequiredPresent(required, available) {
    for (const value of required) {
        if (!available.has(value)) return false;
    }
    return true;
}

function getPrinterState(printer) {
    const snapshot = printer.status_snapshot || {};
    const raw = snapshot.print?.gcode_state
        || snapshot.gcode_state
        || snapshot.state
        || snapshot.printer_state
        || printer.state
        || 'unknown';
    return String(raw).trim().toLowerCase();
}

function isPrinterBusy(printer) {
    const state = getPrinterState(printer);
    if (state === 'unknown' || state === 'idle' || state === 'ready' || state === 'standby' || state === 'finish') {
        return false;
    }
    return BUSY_PRINTER_STATES.has(state);
}

function countActiveJobs(printer, jobs = []) {
    return jobs.filter((job) => (
        job?.printer_id === printer.printer_id
        && ACTIVE_JOB_STATUSES.has(String(job.status || '').toLowerCase())
    )).length;
}

function jobMaterials(job) {
    const requirements = job.requirements || job.options?.requirements || job.routing_summary?.requirements || {};
    return normalizeMaterials(requirements.materials || requirements.material);
}

function countMaterialBatchMatches(printer, jobs = [], requirements = {}) {
    const requiredMaterials = normalizeMaterials(requirements.materials || requirements.material);
    if (requiredMaterials.size === 0) return 0;
    return jobs.filter((job) => (
        job?.printer_id === printer.printer_id
        && ACTIVE_JOB_STATUSES.has(String(job.status || '').toLowerCase())
        && allRequiredPresent(requiredMaterials, jobMaterials(job))
    )).length;
}

function getPrinterWearHours(printer) {
    const capabilities = printer.capabilities || {};
    return getNumber(
        capabilities.print_hours,
        capabilities.total_print_hours,
        capabilities.lifetime_print_hours,
        capabilities.maintenance?.print_hours,
        printer.status_snapshot?.print_hours,
    ) || 0;
}

function getEstimatedPrintMinutes(requirements = {}) {
    return getNumber(
        requirements.estimated_print_minutes,
        requirements.print_minutes,
        requirements.duration_minutes,
        requirements.estimated_duration_minutes,
    ) || 60;
}

function getEstimatedMaterialGrams(requirements = {}) {
    return getNumber(
        requirements.estimated_material_grams,
        requirements.material_grams,
        requirements.estimated_grams,
        requirements.grams,
        requirements.weight_grams,
    ) || 50;
}

function getPrinterCostCents(printer, requirements = {}) {
    const capabilities = printer.capabilities || {};
    const pricing = capabilities.pricing || {};
    const directCost = getNumber(
        capabilities.estimated_cost_cents,
        capabilities.cost_cents,
        capabilities.price_cents,
        capabilities.cost_per_job_cents,
        capabilities.job_cost_cents,
        pricing.estimated_cost_cents,
        pricing.cost_cents,
        pricing.price_cents,
        pricing.cost_per_job_cents,
        pricing.job_cost_cents,
    );
    if (directCost) return Math.ceil(directCost);

    const hourlyCost = getNumber(
        capabilities.cost_per_hour_cents,
        capabilities.hourly_rate_cents,
        capabilities.machine_rate_cents,
        capabilities.print_hour_cents,
        pricing.cost_per_hour_cents,
        pricing.hourly_rate_cents,
        pricing.machine_rate_cents,
        pricing.print_hour_cents,
    );
    const materialCost = getNumber(
        capabilities.cost_per_gram_cents,
        capabilities.material_rate_cents,
        capabilities.material_cents_per_gram,
        pricing.cost_per_gram_cents,
        pricing.material_rate_cents,
        pricing.material_cents_per_gram,
    );

    let total = 0;
    if (hourlyCost) {
        total += Math.ceil((getEstimatedPrintMinutes(requirements) / 60) * hourlyCost);
    }
    if (materialCost) {
        total += Math.ceil(getEstimatedMaterialGrams(requirements) * materialCost);
    }
    return total || 1000;
}

function countExtraMaterials(availableMaterials, requiredMaterials) {
    let extra = 0;
    for (const material of availableMaterials) {
        if (!requiredMaterials.has(material)) extra += 1;
    }
    return extra;
}

function scoreSortWeight({
    strategy,
    queueDepth,
    nodePenalty,
    materialBatchMatches,
    printerWearHours,
    estimatedCostCents,
    materialExtraCount,
    exactMaterialMatch,
}) {
    if (strategy === 'cheapest') {
        return estimatedCostCents + queueDepth * 10 + nodePenalty * 100;
    }
    if (strategy === 'exact_material_match') {
        return (exactMaterialMatch ? 0 : 1000) + materialExtraCount * 50 + queueDepth * 100 + nodePenalty;
    }
    if (strategy === 'batch_by_material' || strategy === 'smart_material_queue') {
        // smart_material_queue: the farm autopilot's material-aware planner —
        // prefer printers already running the same material to minimize swaps.
        return queueDepth * 100 + nodePenalty - materialBatchMatches * 150;
    }
    if (strategy === 'least_printer_wear') {
        return queueDepth * 100 + nodePenalty + printerWearHours * 0.1;
    }
    if (strategy === 'ship_cutoff') {
        return queueDepth * 160 + nodePenalty;
    }
    return queueDepth * 100 + nodePenalty;
}

function evaluatePrinter({ node, printer, jobs, requirements }) {
    const reasons = [];

    if (!node || !NODE_READY_STATUSES.has(String(node.status || '').toLowerCase())) {
        reasons.push('node_unavailable');
        return { ok: false, reasons };
    }

    if (PRINTER_UNAVAILABLE_STATUSES.has(String(printer.status || '').toLowerCase())) {
        reasons.push('printer_unavailable');
        return { ok: false, reasons };
    }

    if (isPrinterBusy(printer)) {
        reasons.push('printer_busy');
        return { ok: false, reasons };
    }

    if (!fitsBuildVolume(printer, requirements)) {
        reasons.push('build_volume_too_small');
    }

    const requiredMaterials = normalizeMaterials(requirements.materials || requirements.material);
    const availableMaterials = getAvailableMaterials(printer);
    if (requiredMaterials.size > 0 && !allRequiredPresent(requiredMaterials, availableMaterials)) {
        reasons.push('missing_material');
    }

    const requiredColors = normalizeColors(requirements.colors || requirements.colours || requirements.color);
    const availableColors = getAvailableColors(printer);
    if (requiredColors.size > 0 && !allRequiredPresent(requiredColors, availableColors)) {
        reasons.push('missing_color');
    }

    if (reasons.length > 0) {
        return { ok: false, reasons };
    }

    const queueDepth = countActiveJobs(printer, jobs);
    const nodeStatus = String(node.status || 'unknown').toLowerCase();
    const nodePenalty = nodeStatus === 'degraded' ? 1 : 0;

    const materialBatchMatches = countMaterialBatchMatches(printer, jobs, requirements);
    const printerWearHours = getPrinterWearHours(printer);
    const materialExtraCount = requiredMaterials.size > 0
        ? countExtraMaterials(availableMaterials, requiredMaterials)
        : 0;
    const exactMaterialMatch = requiredMaterials.size > 0 && materialExtraCount === 0;
    const estimatedCostCents = getPrinterCostCents(printer, requirements);

    return {
        ok: true,
        score: {
            queue_depth: queueDepth,
            node_status: nodeStatus,
            printer_state: getPrinterState(printer),
            material_matches: requiredMaterials.size,
            color_matches: requiredColors.size,
            material_batch_matches: materialBatchMatches,
            printer_wear_hours: printerWearHours,
            estimated_cost_cents: estimatedCostCents,
            exact_material_match: exactMaterialMatch,
            material_extra_count: materialExtraCount,
            sort_weight: queueDepth * 100 + nodePenalty,
        },
    };
}

export function routeMerchantPrintJob({
    overview,
    requirements = {},
    strategy = 'fastest_fulfillment',
} = {}) {
    const nodes = Array.isArray(overview?.nodes) ? overview.nodes : [];
    const printers = Array.isArray(overview?.printers) ? overview.printers : [];
    const jobs = Array.isArray(overview?.jobs) ? overview.jobs : [];
    const nodesById = new Map(nodes.map((node) => [node.node_id, node]));
    const accepted = [];
    const rejected = [];

    for (const printer of printers) {
        const node = nodesById.get(printer.node_id);
        const evaluation = evaluatePrinter({ node, printer, jobs, requirements });
        if (!evaluation.ok) {
            rejected.push({
                node_id: printer.node_id || null,
                printer_id: printer.printer_id || null,
                reasons: evaluation.reasons,
            });
            continue;
        }

        accepted.push({
            node,
            printer,
            score: {
                ...evaluation.score,
                sort_weight: scoreSortWeight({
                    strategy,
                    queueDepth: evaluation.score.queue_depth,
                    nodePenalty: evaluation.score.node_status === 'degraded' ? 1 : 0,
                    materialBatchMatches: evaluation.score.material_batch_matches,
                    printerWearHours: evaluation.score.printer_wear_hours,
                    estimatedCostCents: evaluation.score.estimated_cost_cents,
                    materialExtraCount: evaluation.score.material_extra_count,
                    exactMaterialMatch: evaluation.score.exact_material_match,
                }),
            },
        });
    }

    accepted.sort((a, b) => (
        a.score.sort_weight - b.score.sort_weight
        || String(a.printer.printer_id).localeCompare(String(b.printer.printer_id))
    ));

    const selected = accepted[0] || null;

    return {
        status: selected ? 'routed' : 'no_capacity',
        strategy,
        selected_node_id: selected?.node?.node_id || null,
        selected_printer_id: selected?.printer?.printer_id || null,
        // The LOCAL printer id is what node commands (start/stop) need — the
        // cloud printer_id is a cloud-side UUID the node knows nothing about.
        selected_local_printer_id: selected?.printer?.local_printer_id || null,
        selected_printer_name: selected?.printer?.name || null,
        score: selected ? selected.score : null,
        rejected_candidates: rejected,
    };
}

function trayGlobalIndex(tray, fallbackIndex) {
    const amsId = Number.parseInt(tray?.ams_id, 10);
    const trayId = Number.parseInt(tray?.tray_id, 10);
    if (Number.isFinite(amsId) && Number.isFinite(trayId)) return amsId * 4 + trayId;
    if (Number.isFinite(trayId)) return trayId;
    return fallbackIndex;
}

/**
 * Build the Bambu ams_mapping array (slicer filament slot → global AMS tray
 * index) for the selected printer from its synced AMS tray data. Filament i
 * takes requirements.materials[i] / colors[i] (falling back to the primary
 * value when one list is shorter). Returns [] when no complete mapping exists —
 * the printer then falls back to its default tray selection.
 */
export function buildAmsMappingForPrinter(printer, requirements = {}) {
    const trays = Array.isArray(printer?.capabilities?.ams_trays) ? printer.capabilities.ams_trays : [];
    if (trays.length === 0) return [];

    const materials = asArray(requirements.materials || requirements.material).map(normalizeMaterial);
    const colors = asArray(requirements.colors || requirements.colours || requirements.color).map(normalizeColor);
    const filamentCount = Math.max(materials.length, colors.length);
    if (filamentCount === 0) return [];

    const used = new Set();
    const mapping = [];

    for (let i = 0; i < filamentCount; i += 1) {
        const material = materials[i] ?? materials[0] ?? null;
        const color = colors[i] ?? colors[0] ?? null;

        const matchIndex = trays.findIndex((tray, index) => {
            if (used.has(index)) return false;
            const trayMaterial = normalizeMaterial(tray.material);
            const trayBase = normalizeMaterial(tray.material_base);
            const trayColor = normalizeColor(tray.color_hex || tray.color);
            if (material && trayMaterial !== material && trayBase !== material) return false;
            if (color && trayColor !== color) return false;
            return true;
        });

        if (matchIndex === -1) return [];
        used.add(matchIndex);
        mapping.push(trayGlobalIndex(trays[matchIndex], matchIndex));
    }

    return mapping;
}
