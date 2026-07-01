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

    return {
        ok: true,
        score: {
            queue_depth: queueDepth,
            node_status: nodeStatus,
            printer_state: getPrinterState(printer),
            material_matches: requiredMaterials.size,
            color_matches: requiredColors.size,
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
            score: evaluation.score,
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
        score: selected ? selected.score : null,
        rejected_candidates: rejected,
    };
}
