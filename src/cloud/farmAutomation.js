import { routeMerchantPrintJob } from './merchantRouting.js';
import { buildPlatformStrategy } from './platformStrategy.js';

const ACTIVE_JOB_STATUSES = new Set([
    'queued',
    'assigned',
    'transforming',
    'uploading',
    'printing',
    'waiting_for_capacity',
]);

const FINISHED_PRINT_STATES = new Set(['finish', 'finished', 'completed', 'complete']);

const DEFAULT_POLICY = {
    smart_queue_enabled: true,
    auto_eject_enabled: true,
    bed_clear_verification: 'camera_or_operator',
    release_temperature_c: 27,
    max_eject_attempts: 3,
    failure_detection_enabled: true,
    failure_detection_provider: 'camera_ai_webhook',
    batch_by_material_enabled: true,
    prefer_loaded_filament: true,
    low_spool_threshold_grams: 150,
    remote_access_enabled: true,
    // Heartbeat sweep turns submitted-but-unprinted merchant order items
    // (job_id null) into print jobs automatically. Off = only items that
    // explicitly requested auto_submit are picked up.
    auto_print_submitted_orders: true,
    // One automatic re-route + reprint after a failure before a human is
    // alerted (transient failures clear themselves; the retry may land on a
    // different printer).
    auto_retry_failed_jobs: true,
    auto_retry_max: 1,
    // Operator maintenance nudge every N completed prints per printer.
    maintenance_alert_every_prints: 200,
};

const DEFAULT_INTEGRATIONS = {
    ecommerce: [],
    alerts: [],
    vision: [],
    shipping: [],
    remote_access: [],
};

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string' && value.trim()) return [value];
    return [];
}

function normalizeBoolean(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}

function normalizePositiveNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeMaterial(value) {
    return typeof value === 'string' && value.trim() ? value.trim().toUpperCase() : null;
}

function normalizeColor(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const raw = value.trim().replace(/^#/, '').toUpperCase();
    const expanded = raw.length === 3 ? raw.split('').map((char) => `${char}${char}`).join('') : raw;
    const hex = expanded.slice(0, 6);
    return /^[0-9A-F]{6}$/.test(hex) ? `#${hex}` : null;
}

function normalizeSpool(spool, index) {
    const source = isPlainObject(spool) ? spool : {};
    const material = normalizeMaterial(source.material || source.type || source.tray_type) || 'PLA';
    const color = normalizeColor(source.color_hex || source.color || source.tray_color) || '#FFFFFF';

    return {
        spool_id: typeof source.spool_id === 'string' && source.spool_id.trim()
            ? source.spool_id.trim()
            : `spool-${index + 1}`,
        material,
        color_hex: color,
        color_name: typeof source.color_name === 'string' ? source.color_name.trim() : null,
        brand: typeof source.brand === 'string' ? source.brand.trim() : null,
        lot_code: typeof source.lot_code === 'string' ? source.lot_code.trim() : null,
        grams_remaining: Math.max(0, Number(source.grams_remaining) || 0),
        reorder_threshold_grams: Math.max(0, Number(source.reorder_threshold_grams) || DEFAULT_POLICY.low_spool_threshold_grams),
        dry_status: typeof source.dry_status === 'string' && source.dry_status.trim() ? source.dry_status.trim() : 'unknown',
        storage_location: typeof source.storage_location === 'string' && source.storage_location.trim()
            ? source.storage_location.trim()
            : null,
        printer_id: typeof source.printer_id === 'string' && source.printer_id.trim() ? source.printer_id.trim() : null,
        local_printer_id: typeof source.local_printer_id === 'string' && source.local_printer_id.trim()
            ? source.local_printer_id.trim()
            : null,
        ams_id: Number.isInteger(Number(source.ams_id)) ? Number(source.ams_id) : null,
        tray_id: Number.isInteger(Number(source.tray_id)) ? Number(source.tray_id) : null,
        reserved_for_job_id: typeof source.reserved_for_job_id === 'string' && source.reserved_for_job_id.trim()
            ? source.reserved_for_job_id.trim()
            : null,
    };
}

function normalizePolicy(policy = {}) {
    const source = isPlainObject(policy) ? policy : {};

    return {
        smart_queue_enabled: normalizeBoolean(source.smart_queue_enabled, DEFAULT_POLICY.smart_queue_enabled),
        auto_eject_enabled: normalizeBoolean(source.auto_eject_enabled, DEFAULT_POLICY.auto_eject_enabled),
        bed_clear_verification: typeof source.bed_clear_verification === 'string' && source.bed_clear_verification.trim()
            ? source.bed_clear_verification.trim()
            : DEFAULT_POLICY.bed_clear_verification,
        release_temperature_c: normalizePositiveNumber(source.release_temperature_c, DEFAULT_POLICY.release_temperature_c),
        max_eject_attempts: Math.max(1, Math.min(Number.parseInt(source.max_eject_attempts, 10) || DEFAULT_POLICY.max_eject_attempts, 10)),
        failure_detection_enabled: normalizeBoolean(source.failure_detection_enabled, DEFAULT_POLICY.failure_detection_enabled),
        failure_detection_provider: typeof source.failure_detection_provider === 'string' && source.failure_detection_provider.trim()
            ? source.failure_detection_provider.trim()
            : DEFAULT_POLICY.failure_detection_provider,
        batch_by_material_enabled: normalizeBoolean(source.batch_by_material_enabled, DEFAULT_POLICY.batch_by_material_enabled),
        prefer_loaded_filament: normalizeBoolean(source.prefer_loaded_filament, DEFAULT_POLICY.prefer_loaded_filament),
        low_spool_threshold_grams: normalizePositiveNumber(source.low_spool_threshold_grams, DEFAULT_POLICY.low_spool_threshold_grams),
        remote_access_enabled: normalizeBoolean(source.remote_access_enabled, DEFAULT_POLICY.remote_access_enabled),
        auto_print_submitted_orders: normalizeBoolean(source.auto_print_submitted_orders, DEFAULT_POLICY.auto_print_submitted_orders),
        auto_retry_failed_jobs: normalizeBoolean(source.auto_retry_failed_jobs, DEFAULT_POLICY.auto_retry_failed_jobs),
        auto_retry_max: Number.isFinite(Number.parseInt(source.auto_retry_max, 10))
            ? Math.max(0, Math.min(Number.parseInt(source.auto_retry_max, 10), 3))
            : DEFAULT_POLICY.auto_retry_max,
        maintenance_alert_every_prints: normalizePositiveNumber(source.maintenance_alert_every_prints, DEFAULT_POLICY.maintenance_alert_every_prints),
    };
}

function normalizeIntegrationList(value) {
    return asArray(value).flatMap((entry) => {
        if (!isPlainObject(entry)) return [];
        return [{
            type: typeof entry.type === 'string' && entry.type.trim() ? entry.type.trim() : 'webhook',
            enabled: entry.enabled !== false,
            name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : null,
            url: typeof entry.url === 'string' && entry.url.trim() ? entry.url.trim() : null,
            metadata: isPlainObject(entry.metadata) ? entry.metadata : {},
        }];
    });
}

function normalizeIntegrations(integrations = {}) {
    const source = isPlainObject(integrations) ? integrations : {};

    return {
        ecommerce: normalizeIntegrationList(source.ecommerce),
        alerts: normalizeIntegrationList(source.alerts),
        vision: normalizeIntegrationList(source.vision),
        shipping: normalizeIntegrationList(source.shipping),
        remote_access: normalizeIntegrationList(source.remote_access),
    };
}

export function normalizeFarmAutomationSettings({
    policy = {},
    inventory = {},
    integrations = {},
} = {}) {
    return {
        policy: normalizePolicy(policy),
        inventory: {
            spools: asArray(isPlainObject(inventory) ? inventory.spools : []).map(normalizeSpool),
        },
        integrations: normalizeIntegrations(integrations),
    };
}

function collectTrayLikeValues(source, trays = []) {
    if (!source) return trays;
    if (Array.isArray(source)) {
        for (const item of source) collectTrayLikeValues(item, trays);
        return trays;
    }
    if (!isPlainObject(source)) return trays;

    const material = source.material || source.tray_type || source.type || source.tray_sub_brands;
    const color = source.color || source.color_hex || source.tray_color || source.colour;
    if (material || color) {
        trays.push({
            material: normalizeMaterial(material),
            color_hex: normalizeColor(color),
            ams_id: source.ams_id ?? source.amsId ?? null,
            tray_id: source.tray_id ?? source.trayId ?? source.id ?? null,
        });
    }

    for (const key of ['tray', 'trays', 'ams', 'ams_trays', 'filaments', 'slots']) {
        collectTrayLikeValues(source[key], trays);
    }

    return trays;
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

function printerSupportsAutoEject(printer) {
    const capabilities = printer.capabilities || {};
    return capabilities.auto_eject === true
        || capabilities.auto_ejector === true
        || capabilities.ejection?.enabled === true
        || capabilities.ejector === true;
}

function isBedClear(printer) {
    const capabilities = printer.capabilities || {};
    if (typeof capabilities.bed_clear === 'boolean') return capabilities.bed_clear;
    if (typeof capabilities.bed_clear_verified === 'boolean') return capabilities.bed_clear_verified;
    if (typeof printer.status_snapshot?.bed_clear === 'boolean') return printer.status_snapshot.bed_clear;
    return !FINISHED_PRINT_STATES.has(getPrinterState(printer));
}

function getLoadedFilaments(printer, inventory) {
    const snapshotTrays = [
        ...collectTrayLikeValues(printer.capabilities?.ams_trays),
        ...collectTrayLikeValues(printer.capabilities?.trays),
        ...collectTrayLikeValues(printer.status_snapshot?.ams),
    ].filter((tray) => tray.material || tray.color_hex);
    const assignedSpools = inventory.spools.filter((spool) => (
        spool.printer_id === printer.printer_id
        || (spool.local_printer_id && spool.local_printer_id === printer.local_printer_id)
    ));

    return [
        ...snapshotTrays.map((tray) => ({
            source: 'live_ams',
            material: tray.material,
            color_hex: tray.color_hex,
            ams_id: tray.ams_id,
            tray_id: tray.tray_id,
        })),
        ...assignedSpools.map((spool) => ({
            source: 'inventory',
            spool_id: spool.spool_id,
            material: spool.material,
            color_hex: spool.color_hex,
            ams_id: spool.ams_id,
            tray_id: spool.tray_id,
            grams_remaining: spool.grams_remaining,
            dry_status: spool.dry_status,
        })),
    ];
}

function getJobRequirements(job) {
    return job?.requirements
        || job?.options?.requirements
        || job?.routing_summary?.requirements
        || {};
}

export function augmentOverviewWithInventory(overview, inventory) {
    const printers = Array.isArray(overview.printers) ? overview.printers : [];
    const spoolsByPrinter = new Map();

    for (const spool of inventory.spools || []) {
        const key = spool.printer_id || spool.local_printer_id;
        if (!key) continue;
        if (!spoolsByPrinter.has(key)) spoolsByPrinter.set(key, []);
        spoolsByPrinter.get(key).push(spool);
    }

    return {
        ...overview,
        printers: printers.map((printer) => {
            const assignedSpools = [
                ...(spoolsByPrinter.get(printer.printer_id) || []),
                ...(printer.local_printer_id ? (spoolsByPrinter.get(printer.local_printer_id) || []) : []),
            ];
            if (assignedSpools.length === 0) return printer;

            const capabilities = printer.capabilities || {};
            return {
                ...printer,
                capabilities: {
                    ...capabilities,
                    materials: [
                        ...asArray(capabilities.materials),
                        ...assignedSpools.map((spool) => spool.material),
                    ],
                    colors: [
                        ...asArray(capabilities.colors),
                        ...assignedSpools.map((spool) => spool.color_hex),
                    ],
                    ams_trays: [
                        ...asArray(capabilities.ams_trays),
                        ...assignedSpools.map((spool) => ({
                            spool_id: spool.spool_id,
                            material: spool.material,
                            color_hex: spool.color_hex,
                            tray_id: spool.tray_id,
                            ams_id: spool.ams_id,
                        })),
                    ],
                },
            };
        }),
    };
}

function isActiveJob(job) {
    return ACTIVE_JOB_STATUSES.has(String(job?.status || '').toLowerCase());
}

function addAlert(alerts, alert) {
    alerts.push({
        severity: alert.severity || 'info',
        type: alert.type,
        message: alert.message,
        ...Object.fromEntries(Object.entries(alert).filter(([key]) => !['severity', 'type', 'message'].includes(key))),
    });
}

function buildFeatureMap(settings) {
    const integrations = settings.integrations;

    return {
        central_dashboard: true,
        smart_queue: settings.policy.smart_queue_enabled,
        auto_ejection: settings.policy.auto_eject_enabled,
        ams_filament_mapping: true,
        filament_inventory: true,
        failure_detection_hooks: settings.policy.failure_detection_enabled || integrations.vision.some((entry) => entry.enabled),
        ecommerce_hooks: integrations.ecommerce.length > 0,
        remote_access_hooks: settings.policy.remote_access_enabled || integrations.remote_access.length > 0,
        alerting_hooks: integrations.alerts.length > 0,
        batch_by_material: settings.policy.batch_by_material_enabled,
    };
}

function buildEjectionQueue({ printers, settings }) {
    return printers.flatMap((printer) => {
        const state = getPrinterState(printer);
        if (!FINISHED_PRINT_STATES.has(state)) return [];

        if (!settings.policy.auto_eject_enabled) {
            return [{
                printer_id: printer.printer_id,
                action: 'manual_clear_required',
                reason: 'auto_eject_disabled',
            }];
        }

        if (!printerSupportsAutoEject(printer)) {
            return [{
                printer_id: printer.printer_id,
                action: 'manual_clear_required',
                reason: 'no_auto_eject_capability',
            }];
        }

        if (isBedClear(printer)) {
            return [{
                printer_id: printer.printer_id,
                action: 'verify_bed_clear',
                verification: settings.policy.bed_clear_verification,
            }];
        }

        return [{
            printer_id: printer.printer_id,
            node_id: printer.node_id || null,
            action: 'auto_eject',
            release_temperature_c: settings.policy.release_temperature_c,
            max_eject_attempts: settings.policy.max_eject_attempts,
            verification: settings.policy.bed_clear_verification,
        }];
    });
}

/**
 * Actionable auto-eject plan for one node's heartbeat printers. Unlike the
 * advisory ejection_queue (which reports manual-clear/verify states too), this
 * returns ONLY the printers that should receive a durable `printer.eject`
 * node command right now: print finished, bed not clear, auto-eject enabled
 * and the printer advertises an eject capability.
 */
export function planAutoEjectCommands({ printers = [], settings = {} } = {}) {
    const normalized = normalizeFarmAutomationSettings(settings);
    if (!normalized.policy.auto_eject_enabled) return [];

    return (Array.isArray(printers) ? printers : []).flatMap((printer) => {
        const state = getPrinterState(printer);
        if (!FINISHED_PRINT_STATES.has(state)) return [];
        if (!printerSupportsAutoEject(printer)) return [];
        if (isBedClear(printer)) return [];

        const localPrinterId = printer.local_printer_id || printer.printer_id;
        if (!localPrinterId) return [];

        return [{
            local_printer_id: localPrinterId,
            release_temperature_c: normalized.policy.release_temperature_c,
            max_eject_attempts: normalized.policy.max_eject_attempts,
            verification: normalized.policy.bed_clear_verification,
        }];
    });
}

function buildJobRecommendations({ overview, settings }) {
    if (!settings.policy.smart_queue_enabled) return [];
    const routableOverview = augmentOverviewWithInventory(overview, settings.inventory);
    const jobs = Array.isArray(routableOverview.jobs) ? routableOverview.jobs : [];
    const actionableJobs = jobs.filter((job) => ['queued', 'waiting_for_capacity'].includes(String(job.status || '').toLowerCase()));

    return actionableJobs.map((job) => {
        const result = routeMerchantPrintJob({
            overview: routableOverview,
            requirements: getJobRequirements(job),
            strategy: 'smart_material_queue',
        });

        return {
            job_id: job.job_id,
            job_name: job.name || null,
            strategy: 'smart_material_queue',
            status: result.status,
            selected_node_id: result.selected_node_id,
            selected_printer_id: result.selected_printer_id,
            score: result.score,
            rejected_candidates: result.rejected_candidates,
        };
    });
}

export function buildFarmAutomationPlan({
    overview = {},
    settings = normalizeFarmAutomationSettings(),
} = {}) {
    const normalizedSettings = normalizeFarmAutomationSettings(settings);
    const nodes = Array.isArray(overview.nodes) ? overview.nodes : [];
    const printers = Array.isArray(overview.printers) ? overview.printers : [];
    const jobs = Array.isArray(overview.jobs) ? overview.jobs : [];
    const alerts = [];
    const ejectionQueue = buildEjectionQueue({ printers, settings: normalizedSettings });
    const jobRecommendations = buildJobRecommendations({ overview, settings: normalizedSettings });

    for (const spool of normalizedSettings.inventory.spools) {
        if (spool.grams_remaining <= spool.reorder_threshold_grams) {
            addAlert(alerts, {
                severity: spool.grams_remaining === 0 ? 'critical' : 'warning',
                type: 'low_filament',
                spool_id: spool.spool_id,
                material: spool.material,
                color_hex: spool.color_hex,
                message: `${spool.material} ${spool.color_hex} is below reorder threshold`,
            });
        }
        if (spool.dry_status && ['wet', 'needs_drying'].includes(String(spool.dry_status).toLowerCase())) {
            addAlert(alerts, {
                severity: 'warning',
                type: 'filament_needs_drying',
                spool_id: spool.spool_id,
                message: `${spool.spool_id} needs drying before use`,
            });
        }
    }

    for (const printer of printers) {
        if (String(printer.status || '').toLowerCase() === 'offline') {
            addAlert(alerts, {
                severity: 'critical',
                type: 'printer_offline',
                printer_id: printer.printer_id,
                message: `${printer.name || printer.printer_id} is offline`,
            });
        }
    }

    for (const ejection of ejectionQueue) {
        if (ejection.action === 'manual_clear_required') {
            addAlert(alerts, {
                severity: 'warning',
                type: 'manual_bed_clear',
                printer_id: ejection.printer_id,
                message: `Printer ${ejection.printer_id} needs manual bed clearing`,
            });
        }
    }

    const printerPlans = printers.map((printer) => ({
        printer_id: printer.printer_id,
        node_id: printer.node_id || null,
        name: printer.name || printer.local_printer_id || printer.printer_id,
        status: printer.status || 'unknown',
        printer_state: getPrinterState(printer),
        auto_eject_capable: printerSupportsAutoEject(printer),
        bed_clear: isBedClear(printer),
        loaded_filaments: getLoadedFilaments(printer, normalizedSettings.inventory),
        recommended_action: ejectionQueue.find((item) => item.printer_id === printer.printer_id)?.action || 'available',
    }));

    const lowSpoolCount = normalizedSettings.inventory.spools
        .filter((spool) => spool.grams_remaining <= spool.reorder_threshold_grams)
        .length;

    const featureMap = buildFeatureMap(normalizedSettings);
    const summary = {
        nodes_total: nodes.length,
        nodes_online: nodes.filter((node) => String(node.status || '').toLowerCase() === 'online').length,
        printers_total: printers.length,
        printers_online: printers.filter((printer) => String(printer.status || '').toLowerCase() === 'online').length,
        active_job_count: jobs.filter(isActiveJob).length,
        spools_total: normalizedSettings.inventory.spools.length,
        low_spool_count: lowSpoolCount,
        auto_eject_ready_count: ejectionQueue.filter((item) => item.action === 'auto_eject').length,
        alert_count: alerts.length,
    };
    const automationPlan = {
        feature_map: featureMap,
        summary,
        printers: printerPlans,
        job_recommendations: jobRecommendations,
        ejection_queue: ejectionQueue,
        alerts,
    };

    return {
        ...automationPlan,
        platform_strategy: buildPlatformStrategy({ overview, automationPlan }),
    };
}
