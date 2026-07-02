// src/cloud/localPrinterSnapshot.js — builds the printer records the local node
// reports to the cloud control plane (heartbeat + cloud.printers.sync).
//
// Each record mirrors one local printer into cloud_printers, including the
// merged AMS filament view (operator-assigned slot config from printer_ams_config
// overlaid on live MQTT telemetry) so cloud routing and the merchant filament
// API see what is actually loaded in each slot.
import { getFilamentType } from '../services/FilamentCatalog.js';

/** Rough Bambu build volumes (mm) so cloud routing can do fit checks. */
const BUILD_VOLUMES = {
    default: { x: 256, y: 256, z: 256 },
    mini: { x: 180, y: 180, z: 180 },
};

export function getBuildVolumeForModel(model) {
    const normalized = String(model || '').toLowerCase();
    if (normalized.includes('mini')) return BUILD_VOLUMES.mini;
    return BUILD_VOLUMES.default;
}

function countAmsTrays(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return 0;
    if (Array.isArray(snapshot.ams?.trays)) return snapshot.ams.trays.length;
    if (Array.isArray(snapshot.ams?.ams)) {
        return snapshot.ams.ams.reduce((count, unit) => count + (Array.isArray(unit.tray) ? unit.tray.length : 0), 0);
    }
    if (Array.isArray(snapshot.ams?.tray)) return snapshot.ams.tray.length;
    return 0;
}

/**
 * Merged AMS trays for a printer: operator-assigned config wins, live telemetry
 * fills the gaps. Shape is intentionally compatible with the cloud router's
 * tray matching (material/color_hex) and carries ams_id/tray_id so the cloud
 * can build ams_mapping arrays for starts.
 */
function collectAmsTrays(amsStatus) {
    if (!amsStatus || !Array.isArray(amsStatus.slots)) return [];
    return amsStatus.slots
        .map((slot) => {
            const material = slot.configured_material || slot.live_type || null;
            const colorHex = slot.configured_color || (slot.live_color ? String(slot.live_color).replace(/^#/, '') : null);
            if (!material && !colorHex) return null;
            // Base tray type ("PLA Silk" → "PLA") so requirement matching works
            // for subtypes on both the router and the AMS-mapping builder.
            const materialBase = material ? (getFilamentType(material)?.trayType || material) : null;
            return {
                ams_id: slot.ams_id,
                tray_id: slot.tray_id,
                material,
                material_base: materialBase,
                color_hex: colorHex,
                color_name: slot.configured_color_name || null,
                source: slot.configured_material ? 'configured' : 'live',
                live_remaining: slot.live_remaining ?? null,
                in_sync: slot.in_sync !== false,
            };
        })
        .filter(Boolean);
}

/**
 * Live "what is printing right now" view for a printer: job identity, progress,
 * remaining time, layers, and a visual preview (slicer plate render or
 * isometric toolpath SVG) so the cloud fleet view can show the model inside the
 * printer card. Everything is best-effort — a printer with no active job (or a
 * failed preview) still syncs.
 */
export function buildCurrentJobView(worker, activeJob, preview = null) {
    const status = worker?.latestStatus || {};
    const printingState = String(status.gcode_state || status.state || '').toLowerCase();
    if (!activeJob && !['printing', 'running', 'pause', 'paused', 'prepare'].includes(printingState)) {
        return null;
    }

    const progress = Number(status.progress);
    const remaining = Number(status.remaining_time);

    return {
        job_id: activeJob?.job_id || null,
        name: activeJob?.name || status.subtask_name || status.gcode_file || null,
        state: printingState || 'printing',
        progress_percent: Number.isFinite(progress) ? Math.max(0, Math.min(progress, 100)) : null,
        remaining_minutes: Number.isFinite(remaining) ? Math.max(0, remaining) : null,
        layer: Number.isFinite(Number(status.layer)) ? Number(status.layer) : null,
        total_layers: Number.isFinite(Number(status.total_layers)) ? Number(status.total_layers) : null,
        preview: typeof preview === 'string' && preview.startsWith('data:') ? preview : null,
    };
}

export function buildSyncedPrinterRecord(printer, worker, options = {}, amsStatus = null) {
    const statusSnapshot = printer.status_snapshot && typeof printer.status_snapshot === 'object'
        ? { ...printer.status_snapshot }
        : {};
    const liveState = worker?.state && worker.state !== 'unknown'
        ? worker.state
        : statusSnapshot.state;
    const status = worker?.connected
        ? (liveState || 'online')
        : (liveState || 'offline');

    const record = {
        local_printer_id: printer.printer_id,
        name: printer.name || printer.printer_id,
        model: printer.model || null,
        ip_hostname: printer.ip_hostname || null,
        status,
        connected: !!worker?.connected,
        capabilities: { ...(printer.capabilities || {}) },
        last_seen: printer.last_seen || null,
    };

    if (!record.capabilities.build_volume_mm) {
        record.capabilities.build_volume_mm = getBuildVolumeForModel(printer.model);
    }

    // Mirror the LAN address inside capabilities too: the heartbeat normalizer
    // only keeps capabilities/status_snapshot, and the cloud fleet view needs
    // the IP to match discovered printers against already-adopted ones.
    if (printer.ip_hostname && !record.capabilities.ip_hostname) {
        record.capabilities.ip_hostname = printer.ip_hostname;
    }

    // Cloud-routed prints run through the JobOrchestrator transform, which
    // bakes cool-release + sweep ejection into the print file — so every
    // orchestrated printer is auto-eject capable without extra hardware.
    if (record.capabilities.auto_eject === undefined) {
        record.capabilities.auto_eject = true;
        record.capabilities.ejection = { enabled: true, strategy: 'in_gcode_sweep' };
    }

    if (options.sync_ams || options.sync_filament) {
        record.status_snapshot = statusSnapshot;
    }

    if (options.sync_ams) {
        record.ams_tray_count = countAmsTrays(statusSnapshot);
    }

    if (options.sync_filament && amsStatus) {
        const trays = collectAmsTrays(amsStatus);
        record.capabilities.ams_trays = trays;
        record.capabilities.materials = [...new Set(
            trays.flatMap((tray) => [tray.material, tray.material_base]).filter(Boolean),
        )];
        record.capabilities.colors = [...new Set(trays.map((tray) => tray.color_hex).filter(Boolean))];
    }

    return record;
}

/**
 * Collect cloud-ready records for every registered local printer.
 * Defaults include AMS + filament data so the cloud mirror is routing-complete.
 */
export async function collectLocalPrinterRecords(options = {}) {
    const effective = {
        include_saved_printers: options.include_saved_printers !== false,
        sync_ams: options.sync_ams !== false,
        sync_filament: options.sync_filament !== false,
        ...options,
    };

    const [{ PrinterModel }, { RuntimeSupervisor }, { AmsService }, { JobModel }, jobPreview] = await Promise.all([
        import('../models/Printer.js'),
        import('../runtime/RuntimeSupervisor.js'),
        import('../services/AmsService.js'),
        import('../models/Job.js'),
        import('../services/JobPreview.js'),
    ]);

    const supervisor = RuntimeSupervisor.getInstance();
    const registeredPrinters = effective.include_saved_printers === false ? [] : PrinterModel.findAll();

    return registeredPrinters.map((printer) => {
        let amsStatus = null;
        if (effective.sync_filament) {
            try {
                amsStatus = AmsService.getFullStatus(printer.printer_id);
            } catch { /* AMS data is best-effort — a printer without AMS still syncs */ }
        }
        const worker = supervisor?.getWorker?.(printer.printer_id);
        const record = buildSyncedPrinterRecord(printer, worker, effective, amsStatus);

        // Attach the live job view (progress + remaining time + model preview).
        try {
            const activeJob = worker?.activeJobId
                ? JobModel.findById(worker.activeJobId)
                : (JobModel.findAll({ printer_id: printer.printer_id, status: 'printing', limit: 1 })[0] || null);
            const currentJob = buildCurrentJobView(worker, activeJob, activeJob ? jobPreview.getJobPreview(activeJob) : null);
            if (currentJob) record.current_job = currentJob;
        } catch { /* current-job view is best-effort */ }

        return record;
    });
}

export default { buildSyncedPrinterRecord, collectLocalPrinterRecords, getBuildVolumeForModel };
