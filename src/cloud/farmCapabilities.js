import { buildPublicFilamentAvailability } from './filamentAvailability.js';
import {
    READY_EXTENSIONS,
    ROUTING_STRATEGIES,
    SOURCE_EXTENSIONS,
} from './printIntake.js';

function maxNumber(current, next) {
    const parsed = Number(next);
    return Number.isFinite(parsed) && parsed > 0 ? Math.max(current || 0, parsed) : current;
}

function getBuildVolume(printer) {
    const capabilities = printer.capabilities || {};
    const volume = capabilities.build_volume_mm
        || capabilities.build_volume
        || capabilities.buildVolume
        || {};
    return {
        x: capabilities.max_x || capabilities.maxX || volume.x || volume.width || volume.max_x,
        y: capabilities.max_y || capabilities.maxY || volume.y || volume.depth || volume.max_y,
        z: capabilities.max_z || capabilities.maxZ || volume.z || volume.height || volume.max_z,
    };
}

function hasEnabledIntegration(integrations = {}, group, type) {
    const entries = Array.isArray(integrations[group]) ? integrations[group] : [];
    return entries.some((entry) => entry?.enabled !== false && String(entry.type || '').toLowerCase() === type);
}

export function buildPublicFarmCapabilities({
    overview = {},
    settings = {},
} = {}) {
    const printers = Array.isArray(overview.printers) ? overview.printers : [];
    const jobs = Array.isArray(overview.jobs) ? overview.jobs : [];
    const onlinePrinters = printers.filter((printer) => String(printer.status || '').toLowerCase() === 'online');
    const policy = settings.policy || {};
    const integrations = settings.integrations || {};
    const maxBuildVolume = { x: 0, y: 0, z: 0 };

    for (const printer of onlinePrinters) {
        const volume = getBuildVolume(printer);
        maxBuildVolume.x = maxNumber(maxBuildVolume.x, volume.x);
        maxBuildVolume.y = maxNumber(maxBuildVolume.y, volume.y);
        maxBuildVolume.z = maxNumber(maxBuildVolume.z, volume.z);
    }

    const filaments = buildPublicFilamentAvailability({ inventory: settings.inventory || {}, overview });
    const autoEjectCapable = onlinePrinters.some((printer) => {
        const capabilities = printer.capabilities || {};
        return capabilities.auto_eject === true
            || capabilities.auto_ejector === true
            || capabilities.ejection?.enabled === true;
    });
    const failureDetectionCapable = onlinePrinters.some((printer) => {
        const capabilities = printer.capabilities || {};
        return capabilities.failure_detection === true || capabilities.vision?.failure_detection === true;
    });

    return {
        accepting_jobs: onlinePrinters.length > 0,
        file_types: {
            ready_to_print: READY_EXTENSIONS,
            source_model: SOURCE_EXTENSIONS,
            max_json_file_mb: 25,
        },
        routing_strategies: ROUTING_STRATEGIES,
        max_build_volume_mm: maxBuildVolume,
        fleet: {
            printer_count: printers.length,
            online_printer_count: onlinePrinters.length,
            active_job_count: jobs.length,
        },
        features: {
            smart_queue: policy.smart_queue_enabled !== false,
            auto_ejection: Boolean(policy.auto_eject_enabled && autoEjectCapable),
            filament_inventory: filaments.materials.length > 0,
            failure_detection: Boolean(policy.failure_detection_enabled && failureDetectionCapable),
            webhooks: true,
            shopify: hasEnabledIntegration(integrations, 'ecommerce', 'shopify'),
            woocommerce: hasEnabledIntegration(integrations, 'ecommerce', 'woocommerce'),
            shipstation: hasEnabledIntegration(integrations, 'shipping', 'shipstation'),
            slack_alerts: hasEnabledIntegration(integrations, 'alerts', 'slack'),
            zapier: true,
            make: true,
        },
        filaments,
    };
}
