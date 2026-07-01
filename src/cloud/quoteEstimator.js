import {
    classifyFileName,
    getEstimatedGrams,
    getPrimaryMaterial,
    getRequiredDimensions,
    normalizeRoutingStrategy,
} from './printIntake.js';

const MATERIAL_MULTIPLIERS = {
    PLA: 1,
    PETG: 1.15,
    ABS: 1.2,
    ASA: 1.25,
    TPU: 1.35,
    NYLON: 1.6,
    PA: 1.6,
};

function addMinutes(date, minutes) {
    return new Date(date.getTime() + minutes * 60 * 1000);
}

function materialMultiplier(requirements = {}) {
    const material = getPrimaryMaterial(requirements) || 'PLA';
    return MATERIAL_MULTIPLIERS[material] || 1.1;
}

export function estimatePrintQuote({
    requirements = {},
    routing = {},
    now = () => new Date(),
} = {}) {
    const grams = getEstimatedGrams(requirements);
    const dimensions = getRequiredDimensions(requirements) || {};
    const multiplier = materialMultiplier(requirements);
    const queueDepth = Math.max(0, Number(routing.score?.queue_depth) || 0);
    const queueMinutes = queueDepth * 45;
    const printMinutes = Math.max(30, Math.ceil(grams * 1.5 + (dimensions.z || 0) * 1.5));
    const handlingMinutes = 40;
    const totalMinutes = queueMinutes + printMinutes + handlingMinutes;
    const materialCents = Math.ceil(grams * 8 * multiplier);
    const machineCents = Math.ceil((printMinutes / 60) * 250);
    const setupCents = 400;

    return {
        currency: 'USD',
        routing_status: routing.status || 'unknown',
        routing_strategy: normalizeRoutingStrategy(routing.strategy),
        estimates: {
            material_grams: grams,
            print_minutes: printMinutes,
            queue_minutes: queueMinutes,
            handling_minutes: handlingMinutes,
        },
        totals: {
            material_cents: materialCents,
            machine_cents: machineCents,
            setup_cents: setupCents,
            estimated_total_cents: materialCents + machineCents + setupCents,
        },
        lead_time: {
            earliest_ready_at: addMinutes(now(), totalMinutes).toISOString(),
            confidence: routing.status === 'routed' ? 'standard' : 'needs_review',
        },
    };
}

function dimensionsFit(required, maxBuildVolume) {
    if (!required) return true;
    return ['x', 'y', 'z'].every((axis) => !required[axis] || !maxBuildVolume?.[axis] || required[axis] <= maxBuildVolume[axis]);
}

export function buildPrintPreflight({
    file = {},
    requirements = {},
    route = {},
    maxBuildVolume = null,
    now = () => new Date(),
} = {}) {
    const warnings = [];
    const fileName = file.name || file.original_name || 'part.gcode.3mf';
    const fileMode = file.file_mode || classifyFileName(fileName);
    const requiredDimensions = getRequiredDimensions(requirements);

    if (fileMode === 'source_model') {
        warnings.push({
            code: 'source_model_requires_slicing',
            severity: 'review',
            message: 'Source models are accepted but require slicing before automatic routing.',
        });
    }
    if (maxBuildVolume && !dimensionsFit(requiredDimensions, maxBuildVolume)) {
        warnings.push({
            code: 'build_volume_too_small',
            severity: 'blocker',
            message: 'The requested dimensions exceed current public farm build volume.',
        });
    }
    if (route.status === 'no_capacity') {
        warnings.push({
            code: 'no_current_capacity',
            severity: 'review',
            message: 'No currently online printer can satisfy this request.',
            rejected_candidates: route.rejected_candidates || [],
        });
    }

    const quote = estimatePrintQuote({ requirements, routing: route, now });

    return {
        accepted: !warnings.some((warning) => warning.severity === 'blocker') && route.status !== 'no_capacity',
        review_required: fileMode === 'source_model' || route.status !== 'routed' || warnings.some((warning) => warning.severity === 'review'),
        file_mode: fileMode,
        warnings,
        quote,
    };
}
