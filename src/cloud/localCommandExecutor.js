import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { collectLocalPrinterRecords } from './localPrinterSnapshot.js';
import { automatorModelKey, normalizeModel } from '../models/PrinterModels.js';

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function buildGcode3mf(gcode) {
    const zip = new AdmZip();
    const gcodeBuffer = Buffer.from(gcode, 'utf8');
    const md5 = createHash('md5').update(gcodeBuffer).digest('hex');
    const contentTypes = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="gcode" ContentType="text/x.gcode"/>
</Types>`;
    const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;
    const model = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
 <resources/>
 <build/>
</model>`;
    const sliceInfo = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header>
    <header_item key="X-BBL-Client-Type" value="slicer"/>
    <header_item key="X-BBL-Client-Version" value="PrintKinetix Cloud"/>
  </header>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="nozzle_diameters" value="0.4"/>
  </plate>
</config>`;

    zip.addFile('[Content_Types].xml', Buffer.from(contentTypes, 'utf8'));
    zip.addFile('_rels/.rels', Buffer.from(rels, 'utf8'));
    zip.addFile('3D/3dmodel.model', Buffer.from(model, 'utf8'));
    zip.addFile('Metadata/plate_1.gcode', gcodeBuffer);
    zip.addFile('Metadata/plate_1.gcode.md5', Buffer.from(md5, 'utf8'));
    zip.addFile('Metadata/slice_info.config', Buffer.from(sliceInfo, 'utf8'));
    return zip.toBuffer();
}

function requiredString(value, name) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${name} is required`);
    }
    return value.trim();
}

async function getRequiredWorker(localPrinterId, deps) {
    const worker = await deps.getWorker?.(localPrinterId);
    if (!worker) throw new Error(`Local printer worker not found: ${localPrinterId}`);
    return worker;
}

function normalizeAmsSlotRef(payload = {}) {
    let amsId = Number.parseInt(payload.ams_id ?? 0, 10);
    let trayId = Number.parseInt(payload.tray_id, 10);
    if (!Number.isFinite(amsId) || amsId < 0) amsId = 0;
    if (!Number.isFinite(trayId) || trayId < 0 || trayId > 15) {
        throw new Error('payload.tray_id must be 0-15');
    }
    // A flat slot index (4..15) addresses (unit, slot-within-unit); explicit
    // ams_id + tray_id 0-3 addresses the pair directly.
    if (trayId > 3) {
        amsId = Math.floor(trayId / 4);
        trayId = trayId % 4;
    }
    return { amsId, trayId };
}

async function executeAmsAction(command, deps) {
    const payload = command.payload || {};
    const localPrinterId = requiredString(payload.local_printer_id, 'payload.local_printer_id');
    const amsService = await deps.getAmsService();

    if (command.command_type === 'printer.ams.get') {
        return amsService.getFullStatus(localPrinterId);
    }

    const { amsId, trayId } = normalizeAmsSlotRef(payload);

    if (command.command_type === 'printer.ams.clear') {
        amsService.clearTray(localPrinterId, amsId, trayId);
        return { ok: true, cleared: { ams_id: amsId, tray_id: trayId }, status: amsService.getFullStatus(localPrinterId) };
    }

    // printer.ams.set — persist the operator's slot assignment, then push it to
    // the printer when it is reachable so the AMS display matches.
    const material = requiredString(payload.material, 'payload.material');
    const updated = amsService.setTray(localPrinterId, amsId, trayId, {
        material,
        colorHex: typeof payload.color_hex === 'string' && payload.color_hex.trim() ? payload.color_hex.trim() : 'FFFFFFFF',
        colorName: typeof payload.color_name === 'string' && payload.color_name.trim() ? payload.color_name.trim() : 'White',
    });

    let pushedToPrinter = false;
    let pushError = null;
    if (payload.push_to_printer !== false) {
        try {
            const worker = await deps.getWorker?.(localPrinterId);
            if (worker?.mqttClient?.connected) {
                await amsService.syncToDevice(localPrinterId, worker.mqttClient);
                pushedToPrinter = true;
            }
        } catch (error) {
            pushError = error.message;
        }
    }

    return {
        ok: true,
        updated,
        pushed_to_printer: pushedToPrinter,
        push_error: pushError,
        status: amsService.getFullStatus(localPrinterId),
    };
}

// Single JPEG frame from the printer camera, base64-encoded so it can ride the
// durable command-result channel back to the cloud console. In MOCK_MODE a
// generated placeholder SVG is returned so the remote-camera flow stays
// testable without hardware.
async function defaultCaptureCameraFrame(localPrinterId) {
    const [{ PrinterModel }] = await Promise.all([import('../models/Printer.js')]);
    const printer = PrinterModel.findById(localPrinterId);
    if (!printer) throw new Error(`Local printer not found: ${localPrinterId}`);

    if (process.env.MOCK_MODE === 'true') {
        const stamp = new Date().toISOString().slice(11, 19);
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240">`
            + '<rect width="320" height="240" fill="#10201a"/>'
            + '<rect x="60" y="70" width="200" height="110" rx="8" fill="none" stroke="#2f8f6d" stroke-width="3"/>'
            + '<circle cx="160" cy="125" r="26" fill="none" stroke="#2f8f6d" stroke-width="3"/>'
            + `<text x="160" y="215" text-anchor="middle" fill="#9fd6be" font-family="monospace" font-size="14">MOCK CAM · ${printer.name || localPrinterId} · ${stamp} UTC</text>`
            + '</svg>';
        return {
            content_type: 'image/svg+xml',
            image_base64: Buffer.from(svg, 'utf8').toString('base64'),
            mock: true,
        };
    }

    const { default: cameraProxy } = await import('../services/CameraProxy.js');
    const auth = PrinterModel.getAuth(localPrinterId) || {};
    if (!auth.access_code) {
        throw new Error(`No LAN access code stored for ${printer.name || localPrinterId} — the camera cannot authenticate. Edit the printer and add its access code.`);
    }
    if (!cameraProxy.isRunning(localPrinterId)) {
        await cameraProxy.start(localPrinterId, printer.ip_hostname, auth.access_code, printer.model);
    }

    let frame = cameraProxy.getFrame(localPrinterId);
    for (let attempt = 0; attempt < 20 && !frame; attempt += 1) {
        await wait(150);
        frame = cameraProxy.getFrame(localPrinterId);
    }
    if (!frame) {
        throw new Error(cameraProxy.getError(localPrinterId) || 'Camera frame not yet available');
    }
    return {
        content_type: 'image/jpeg',
        image_base64: frame.toString('base64'),
        mock: false,
    };
}

async function executeCameraSnapshot(command, deps) {
    const localPrinterId = requiredString(command.payload?.local_printer_id, 'payload.local_printer_id');
    const frame = await deps.captureCameraFrame(localPrinterId);
    return {
        ok: true,
        local_printer_id: localPrinterId,
        captured_at: new Date().toISOString(),
        ...frame,
    };
}

// Hardware eject sequence driven by the cloud auto-eject policy. Uses the same
// EjectionService the local completion loop uses: if the printer has no
// eject_printhead accessory it returns { skipped: true } immediately (the
// in-gcode sweep, when configured, already ran inside the print file), so a
// cloud-triggered eject can never fight the in-file ejection.
async function defaultEjectPrinter(localPrinterId, options = {}) {
    const [{ PrinterModel }, ejection] = await Promise.all([
        import('../models/Printer.js'),
        import('../services/EjectionService.js'),
    ]);
    const printer = PrinterModel.findById(localPrinterId);
    if (!printer) throw new Error(`Local printer not found: ${localPrinterId}`);

    return ejection.executeEjectionSequence({
        job_id: options.command_id || `cloud-eject-${localPrinterId}`,
        printer_id: localPrinterId,
        profile: {
            eject_params: {
                ...(Number.isFinite(options.max_eject_attempts)
                    ? { max_eject_attempts: options.max_eject_attempts }
                    : {}),
            },
        },
        ...(Number.isFinite(options.release_temperature_c)
            ? { release_temp_c: options.release_temperature_c }
            : {}),
    });
}

async function executePrinterEject(command, deps) {
    const localPrinterId = requiredString(command.payload?.local_printer_id, 'payload.local_printer_id');
    const result = await deps.ejectPrinter(localPrinterId, {
        command_id: command.command_id,
        release_temperature_c: Number(command.payload?.release_temperature_c),
        max_eject_attempts: Number(command.payload?.max_eject_attempts),
    });
    return {
        ok: true,
        local_printer_id: localPrinterId,
        ...result,
    };
}

async function executePrinterAction(command, deps) {
    if (command.command_type.startsWith('printer.ams.')) {
        return executeAmsAction(command, deps);
    }

    if (command.command_type === 'printer.camera.snapshot') {
        return executeCameraSnapshot(command, deps);
    }

    if (command.command_type === 'printer.eject') {
        return executePrinterEject(command, deps);
    }

    const localPrinterId = requiredString(command.payload?.local_printer_id, 'payload.local_printer_id');
    const worker = await getRequiredWorker(localPrinterId, deps);

    switch (command.command_type) {
        case 'printer.status':
            return {
                state: worker.state,
                connected: !!worker.connected,
                status: worker.latestStatus || {},
                preflight: typeof worker.getPreflightStatus === 'function' ? worker.getPreflightStatus() : null,
            };
        case 'printer.pause':
            return worker._pausePrint();
        case 'printer.resume':
            return worker._resumePrint();
        case 'printer.stop':
            return worker._stopPrint();
        case 'printer.gcode':
            return worker._sendGcode(requiredString(command.payload?.gcode, 'payload.gcode'));
        default:
            throw new Error(`Unsupported printer command: ${command.command_type}`);
    }
}

async function executeJobAction(command, deps) {
    if (command.command_type !== 'job.start') {
        throw new Error(`Unsupported job command: ${command.command_type}`);
    }
    const localJobId = requiredString(command.payload?.local_job_id, 'payload.local_job_id');
    if (typeof deps.startJob !== 'function') throw new Error('startJob dependency is required');
    return deps.startJob(localJobId);
}

function safeRemoteFileName(value) {
    return requiredString(value, 'payload.original_name')
        .split(/[\\/]/)
        .pop()
        .replace(/[^A-Za-z0-9._-]/g, '_');
}

function prepareReadyPrintArtifact({ buffer, originalName }) {
    if (originalName.toLowerCase().endsWith('.gcode')) {
        return {
            buffer: buildGcode3mf(buffer.toString('utf8')),
            remoteFileName: originalName.replace(/\.gcode$/i, '.gcode.3mf'),
        };
    }

    if (!originalName.toLowerCase().endsWith('.3mf')) {
        throw new Error('Ready print artifacts must be .gcode, .3mf, or .gcode.3mf');
    }

    return {
        buffer,
        remoteFileName: originalName,
    };
}

function assertPreflightOk(worker) {
    if (typeof worker.getPreflightStatus !== 'function') return;
    const preflight = worker.getPreflightStatus();
    if (preflight?.ok === false) {
        const message = Array.isArray(preflight.errors) && preflight.errors.length > 0
            ? preflight.errors.join('; ')
            : 'printer preflight failed';
        throw new Error(`Preflight failed: ${message}`);
    }
}

async function defaultDownloadArtifact(downloadUrl) {
    const response = await fetch(downloadUrl);
    if (!response.ok) {
        throw new Error(`Artifact download failed (${response.status})`);
    }
    return Buffer.from(await response.arrayBuffer());
}

async function defaultUploadToPrinter({ localPrinterId, buffer, remoteFileName }) {
    const [{ PrinterModel }, { BambuFtpsClient }] = await Promise.all([
        import('../models/Printer.js'),
        import('../services/BambuFtpsClient.js'),
    ]);
    const printer = PrinterModel.findById(localPrinterId);
    if (!printer) throw new Error(`Local printer not found: ${localPrinterId}`);
    const auth = PrinterModel.getAuth(localPrinterId);
    if (!auth?.access_code) throw new Error('Upload failed: No access code');

    const ftpsClient = new BambuFtpsClient({
        ip: printer.ip_hostname,
        accessCode: auth.access_code,
        printerId: localPrinterId,
    });
    const ftpsReachable = await ftpsClient.isReachable();
    if (!ftpsReachable) throw new Error('Upload failed: FTPS not reachable');

    const uploadResult = await ftpsClient.upload(buffer, remoteFileName);
    if (uploadResult?.success === false) {
        throw new Error(`Upload failed: ${uploadResult.error || 'unknown error'}`);
    }
    return uploadResult;
}

/**
 * Legacy raw fulfillment: upload the artifact and fire a one-shot MQTT start.
 * No transform, no ACK wait, no job tracking. Kept for payload.pipeline='raw'.
 */
async function executeCloudPrintReadyRaw({ payload, localPrinterId, worker, buffer, remoteFileName }, deps) {
    assertPreflightOk(worker);

    const uploaded = await deps.uploadToPrinter({
        localPrinterId,
        buffer,
        remoteFileName,
        contentType: payload.content_type || 'application/octet-stream',
    });
    const amsMapping = Array.isArray(payload.ams_mapping) ? payload.ams_mapping : [];
    const startResult = await worker._startPrint({
        filename: remoteFileName,
        plateNumber: Number.parseInt(payload.plate_number || payload.plateNumber, 10) || 1,
        useAms: typeof payload.use_ams === 'boolean' ? payload.use_ams : amsMapping.length > 0,
        amsMapping,
    });

    return {
        pipeline: 'raw',
        started: startResult?.started === true,
        remote_file_name: remoteFileName,
        uploaded,
        start_result: startResult,
    };
}

// Orchestrated submit shared by cloud.print.ready and cloud.print.source:
// routes through JobOrchestrator so cloud prints get the full farm pipeline —
// transform (cool-release ejection + optional loops), preflight, verified FTPS
// upload, MQTT start with ACK wait, and completion tracking (auto-eject /
// repeat / auto-start-next + cloud status forwarding via job metadata).
async function submitOrchestratedPrint({ command, payload, localPrinterId, worker, buffer, remoteFileName, originalName, extraResult = {} }, deps) {
    const amsMapping = Array.isArray(payload.ams_mapping) ? payload.ams_mapping : [];
    const slotMap = {};
    amsMapping.forEach((value, index) => { slotMap[index] = value; });

    // A busy printer queues the job instead of failing the command: the
    // completion hook auto-starts the next assigned job once the bed is clear.
    const printerBusy = worker.state === 'printing' || worker.state === 'paused';
    if (!printerBusy) assertPreflightOk(worker);

    const loops = Number.parseInt(payload.loops ?? payload.n_loops, 10);
    const job = await deps.submitJob({
        name: typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : originalName,
        printer_id: localPrinterId,
        repeat_total: Number.parseInt(payload.repeat_total, 10) || 1,
        ams_roles: amsMapping.length > 0 ? { slot_map: slotMap } : null,
        fileName: remoteFileName,
        fileContent: buffer,
        rawBuffer3mf: buffer,
        originalFileName3mf: remoteFileName,
        transform_mode: payload.skip_transform === true ? 'skip' : 'optional',
        transform_overrides: {
            ...(isPlainObject(payload.transform_overrides) ? payload.transform_overrides : {}),
            ...(Number.isFinite(loops) && loops > 0 ? { n_loops: loops } : {}),
        },
        auto_start: !printerBusy,
        metadata: {
            origin: 'cloud',
            cloud_job_id: command.job_id || payload.print_job_id || null,
            cloud_command_id: command.command_id || null,
            org_id: command.org_id || null,
            merchant_requirements: isPlainObject(payload.requirements) ? payload.requirements : null,
        },
    });

    return {
        pipeline: 'orchestrated',
        started: job.status === 'printing',
        queued: job.status !== 'printing',
        local_job_id: job.job_id,
        job_status: job.status,
        remote_file_name: job.transformed_file_name || remoteFileName,
        transform: {
            applied: job.transform_report?.skipped !== true,
            error: job.transform_report?.transform_error || null,
            loops: job.diff_summary?.loops || 1,
        },
        ...extraResult,
    };
}

async function executeCloudPrintReady(command, deps) {
    const payload = command.payload || {};
    const localPrinterId = requiredString(payload.local_printer_id, 'payload.local_printer_id');
    const downloadUrl = requiredString(payload.download_url, 'payload.download_url');
    const originalName = safeRemoteFileName(payload.original_name);
    const worker = await getRequiredWorker(localPrinterId, deps);

    const downloaded = await deps.downloadArtifact(downloadUrl);
    const { buffer, remoteFileName } = prepareReadyPrintArtifact({
        buffer: Buffer.isBuffer(downloaded) ? downloaded : Buffer.from(downloaded),
        originalName,
    });

    if (payload.pipeline === 'raw') {
        return executeCloudPrintReadyRaw({ payload, localPrinterId, worker, buffer, remoteFileName }, deps);
    }

    return submitOrchestratedPrint({
        command,
        payload,
        localPrinterId,
        worker,
        buffer,
        remoteFileName,
        originalName,
    }, deps);
}

// Slice a source model (STL / OBJ / STEP / unsliced 3MF) on this node, then
// run the sliced .gcode.3mf through the same orchestrated print pipeline. The
// slicer runs on the SAME node that prints, so no artifact upload-back to the
// cloud is needed.
async function defaultSliceSourceModel({ buffer, originalName, printerModel, settings }) {
    const { SliceService } = await import('../services/SliceService.js');

    if (process.env.MOCK_MODE === 'true') {
        // MOCK_MODE: produce a minimal printable gcode so the full
        // upload → route → slice → print loop stays testable without a slicer.
        const gcode = [
            `; mock-sliced from ${originalName}`,
            'G28',
            'G1 X10 Y10 F3000',
            'M400',
            '; MACHINE_END_GCODE_START',
            'M140 S0',
            '; EXECUTABLE_BLOCK_END',
            '',
        ].join('\n');
        return {
            ok: true,
            gcode3mf: buildGcode3mf(gcode),
            outputName: originalName.replace(/\.[^.]+$/i, '.gcode.3mf'),
            report: { backend: 'mock' },
        };
    }

    return SliceService.slice({
        modelBuffer: buffer,
        modelName: originalName,
        profile: {},
        options: {
            // ORCA_PRESETS keys match the Automator geometry ids (P1S, X1, …).
            printer_model: automatorModelKey(printerModel),
            ...(isPlainObject(settings) ? settings : {}),
        },
    });
}

async function executeCloudPrintSource(command, deps) {
    const payload = command.payload || {};
    const localPrinterId = requiredString(payload.local_printer_id, 'payload.local_printer_id');
    const downloadUrl = requiredString(payload.download_url, 'payload.download_url');
    const originalName = safeRemoteFileName(payload.original_name);
    const worker = await getRequiredWorker(localPrinterId, deps);

    const downloaded = await deps.downloadArtifact(downloadUrl);
    const sliced = await deps.sliceSourceModel({
        buffer: Buffer.isBuffer(downloaded) ? downloaded : Buffer.from(downloaded),
        originalName,
        printerModel: payload.printer_model || null,
        settings: payload.slice_settings || null,
    });

    if (!sliced?.ok || !sliced.gcode3mf) {
        throw new Error(`Slicing failed: ${sliced?.error || 'no slicer backend available on this node'}`);
    }

    const remoteFileName = safeRemoteFileName(sliced.outputName || originalName.replace(/\.[^.]+$/i, '.gcode.3mf'));
    return submitOrchestratedPrint({
        command,
        payload,
        localPrinterId,
        worker,
        buffer: Buffer.isBuffer(sliced.gcode3mf) ? sliced.gcode3mf : Buffer.from(sliced.gcode3mf),
        remoteFileName,
        originalName,
        extraResult: {
            sliced: true,
            slice_report: sliced.report || null,
        },
    }, deps);
}

function normalizeStringList(value) {
    if (Array.isArray(value)) {
        return value.map((item) => String(item || '').trim()).filter(Boolean);
    }
    return String(value || '')
        .split(/[\n,;]+/)
        .map((item) => item.trim())
        .filter(Boolean);
}

function normalizeBoolean(value, fallback) {
    if (typeof value === 'boolean') return value;
    return fallback;
}

function normalizeDiscoveryOptions(payload = {}) {
    const waitMs = Number.parseInt(payload.wait_ms ?? payload.waitMs ?? 1500, 10);
    return {
        scan_cidrs: normalizeStringList(payload.scan_cidrs || payload.scanCidrs),
        wait_ms: Number.isFinite(waitMs) ? Math.max(0, Math.min(waitMs, 10000)) : 1500,
    };
}

function normalizePrinterSyncOptions(payload = {}) {
    return {
        scan_cidrs: normalizeStringList(payload.scan_cidrs || payload.scanCidrs),
        include_saved_printers: normalizeBoolean(payload.include_saved_printers, true),
        sync_ams: normalizeBoolean(payload.sync_ams, true),
        sync_filament: normalizeBoolean(payload.sync_filament, true),
    };
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultDiscoverPrinters(options = {}) {
    const [{ RuntimeSupervisor }, { getDiscoveryInstance }] = await Promise.all([
        import('../runtime/RuntimeSupervisor.js'),
        import('../services/BambuDiscovery.js'),
    ]);
    const supervisor = RuntimeSupervisor.getInstance();
    const discovery = supervisor?.discovery || getDiscoveryInstance();
    supervisor?._syncDiscoverySerials?.();
    discovery.start?.();

    if (options.wait_ms > 0) {
        await wait(options.wait_ms);
    }

    return discovery.getDiscovered?.() || [];
}

async function defaultSyncPrinters(options = {}) {
    const { collectNetworkInterfaces } = await import('./localNetwork.js');
    const printers = await collectLocalPrinterRecords(options);
    const online = printers.filter((printer) => printer.connected || String(printer.status).toLowerCase() === 'online').length;
    const amsTrays = printers.reduce((count, printer) => count + (Number(printer.ams_tray_count) || 0), 0);

    return {
        printers,
        summary: {
            registered: printers.length,
            online,
            ams_trays: amsTrays,
            network_interface_count: collectNetworkInterfaces().length,
            scan_cidrs: options.scan_cidrs,
        },
    };
}

async function executePrinterDiscovery(command, deps) {
    const options = normalizeDiscoveryOptions(command.payload || {});
    const result = await deps.discoverPrinters(options);
    const printers = Array.isArray(result) ? result : (Array.isArray(result?.printers) ? result.printers : []);
    return {
        discovered: printers.length,
        printers,
        scan_cidrs: options.scan_cidrs,
    };
}

async function executePrinterSync(command, deps) {
    const options = normalizePrinterSyncOptions(command.payload || {});
    const result = await deps.syncPrinters(options);
    const printers = Array.isArray(result) ? result : (Array.isArray(result?.printers) ? result.printers : []);
    return {
        synced: printers.length,
        printers,
        summary: result?.summary || {
            registered: printers.length,
            online: printers.filter((printer) => String(printer.status || '').toLowerCase() === 'online' || printer.connected === true).length,
            ams_trays: printers.reduce((count, printer) => count + (Number(printer.ams_tray_count) || 0), 0),
        },
    };
}

// Register ("adopt") a printer discovered on the LAN. SSDP discovery yields
// ip/serial/model but never the access code — that comes from the operator in
// the adopt dialog. PrinterRegistry.create emits printer.created, which the
// RuntimeSupervisor picks up to spawn a worker immediately, so the printer
// shows in the next heartbeat without a restart.
async function defaultAdoptPrinter({ name, model, ip_hostname, access_code, serial }) {
    const [{ PrinterModel }, { PrinterRegistry }] = await Promise.all([
        import('../models/Printer.js'),
        import('../services/PrinterRegistry.js'),
    ]);

    const existing = PrinterModel.findAll().find((printer) => (
        printer.ip_hostname === ip_hostname
    ));
    if (existing) {
        return { already_added: true, printer: existing };
    }

    const printer = PrinterRegistry.create({
        name,
        model,
        ip_hostname,
        auth: {
            ...(access_code ? { access_code } : {}),
            ...(serial ? { serial } : {}),
        },
    });
    return { already_added: false, printer };
}

function normalizeAdoptModel(value) {
    const raw = String(value || '').trim();
    if (!raw) return 'P1S';
    const model = normalizeModel(raw);
    return model ? model.short : raw;
}

async function executePrinterAdopt(command, deps) {
    const payload = command.payload || {};
    const ipHostname = requiredString(payload.ip_hostname || payload.ip, 'payload.ip_hostname');
    const name = requiredString(payload.name, 'payload.name');
    const model = normalizeAdoptModel(payload.model);
    const accessCode = typeof payload.access_code === 'string' && payload.access_code.trim()
        ? payload.access_code.trim()
        : null;
    const serial = typeof payload.serial === 'string' && payload.serial.trim() ? payload.serial.trim() : null;

    const adoption = await deps.adoptPrinter({
        name,
        model,
        ip_hostname: ipHostname,
        access_code: accessCode,
        serial,
    });

    // Push the fresh inventory back with the same result so the console updates
    // without waiting for the next heartbeat.
    let synced = null;
    try {
        synced = await deps.syncPrinters({ sync_ams: true, sync_filament: true });
    } catch { /* sync is best-effort */ }

    return {
        ok: true,
        already_added: adoption.already_added === true,
        printer: {
            local_printer_id: adoption.printer?.printer_id || adoption.printer?.local_printer_id || null,
            name: adoption.printer?.name || name,
            model: adoption.printer?.model || model,
            ip_hostname: ipHostname,
        },
        synced_printer_count: Array.isArray(synced?.printers) ? synced.printers.length : null,
    };
}

async function executeCloudAction(command, deps) {
    if (command.command_type === 'cloud.print.ready') {
        return executeCloudPrintReady(command, deps);
    }
    if (command.command_type === 'cloud.print.source') {
        return executeCloudPrintSource(command, deps);
    }
    if (command.command_type === 'cloud.printers.discover') {
        return executePrinterDiscovery(command, deps);
    }
    if (command.command_type === 'cloud.printers.sync') {
        return executePrinterSync(command, deps);
    }
    if (command.command_type === 'cloud.printers.adopt') {
        return executePrinterAdopt(command, deps);
    }
    throw new Error(`Unsupported cloud command: ${command.command_type}`);
}

function getDefaultDeps() {
    return {
        async getWorker(printerId) {
            const { RuntimeSupervisor } = await import('../runtime/RuntimeSupervisor.js');
            return RuntimeSupervisor.getInstance()?.getWorker(printerId) || null;
        },
        async startJob(jobId) {
            const { JobOrchestrator } = await import('../services/JobOrchestrator.js');
            return JobOrchestrator.startJob(jobId);
        },
        async submitJob(params) {
            const { JobOrchestrator } = await import('../services/JobOrchestrator.js');
            return JobOrchestrator.submit(params);
        },
        async getAmsService() {
            const { AmsService } = await import('../services/AmsService.js');
            return AmsService;
        },
        downloadArtifact: defaultDownloadArtifact,
        uploadToPrinter: defaultUploadToPrinter,
        discoverPrinters: defaultDiscoverPrinters,
        syncPrinters: defaultSyncPrinters,
        adoptPrinter: defaultAdoptPrinter,
        captureCameraFrame: defaultCaptureCameraFrame,
        ejectPrinter: defaultEjectPrinter,
        sliceSourceModel: defaultSliceSourceModel,
    };
}

export async function executeCloudCommand(command, deps = {}) {
    const effectiveDeps = { ...getDefaultDeps(), ...deps };
    const commandType = requiredString(command?.command_type, 'command.command_type');

    if (commandType.startsWith('printer.')) {
        return executePrinterAction({ ...command, command_type: commandType }, effectiveDeps);
    }

    if (commandType.startsWith('job.')) {
        return executeJobAction({ ...command, command_type: commandType }, effectiveDeps);
    }

    if (commandType.startsWith('cloud.')) {
        return executeCloudAction({ ...command, command_type: commandType }, effectiveDeps);
    }

    throw new Error(`Unsupported cloud command: ${commandType}`);
}
