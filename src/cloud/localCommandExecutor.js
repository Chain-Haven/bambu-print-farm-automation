import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';

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

async function executePrinterAction(command, deps) {
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

async function executeCloudPrintReady(command, deps) {
    const payload = command.payload || {};
    const localPrinterId = requiredString(payload.local_printer_id, 'payload.local_printer_id');
    const downloadUrl = requiredString(payload.download_url, 'payload.download_url');
    const originalName = safeRemoteFileName(payload.original_name);
    const worker = await getRequiredWorker(localPrinterId, deps);

    assertPreflightOk(worker);

    const downloaded = await deps.downloadArtifact(downloadUrl);
    const { buffer, remoteFileName } = prepareReadyPrintArtifact({
        buffer: Buffer.isBuffer(downloaded) ? downloaded : Buffer.from(downloaded),
        originalName,
    });

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
        started: startResult?.started === true,
        remote_file_name: remoteFileName,
        uploaded,
        start_result: startResult,
    };
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

function countAmsTrays(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return 0;
    if (Array.isArray(snapshot.ams?.trays)) return snapshot.ams.trays.length;
    if (Array.isArray(snapshot.ams?.ams)) {
        return snapshot.ams.ams.reduce((count, unit) => count + (Array.isArray(unit.tray) ? unit.tray.length : 0), 0);
    }
    if (Array.isArray(snapshot.ams?.tray)) return snapshot.ams.tray.length;
    return 0;
}

function buildSyncedPrinterRecord(printer, worker, options) {
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
        capabilities: printer.capabilities || {},
        last_seen: printer.last_seen || null,
    };

    if (options.sync_ams || options.sync_filament) {
        record.status_snapshot = statusSnapshot;
    }

    if (options.sync_ams) {
        record.ams_tray_count = countAmsTrays(statusSnapshot);
    }

    return record;
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
    const [{ PrinterModel }, { RuntimeSupervisor }, { collectNetworkInterfaces }] = await Promise.all([
        import('../models/Printer.js'),
        import('../runtime/RuntimeSupervisor.js'),
        import('./localNetwork.js'),
    ]);
    const supervisor = RuntimeSupervisor.getInstance();
    const registeredPrinters = options.include_saved_printers === false ? [] : PrinterModel.findAll();
    const printers = registeredPrinters.map((printer) => (
        buildSyncedPrinterRecord(printer, supervisor?.getWorker?.(printer.printer_id), options)
    ));
    const online = printers.filter((printer) => printer.connected || String(printer.status).toLowerCase() === 'online').length;
    const amsTrays = printers.reduce((count, printer) => count + (Number(printer.ams_tray_count) || 0), 0);

    return {
        printers,
        summary: {
            registered: registeredPrinters.length,
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

async function executeCloudAction(command, deps) {
    if (command.command_type === 'cloud.print.ready') {
        return executeCloudPrintReady(command, deps);
    }
    if (command.command_type === 'cloud.printers.discover') {
        return executePrinterDiscovery(command, deps);
    }
    if (command.command_type === 'cloud.printers.sync') {
        return executePrinterSync(command, deps);
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
        downloadArtifact: defaultDownloadArtifact,
        uploadToPrinter: defaultUploadToPrinter,
        discoverPrinters: defaultDiscoverPrinters,
        syncPrinters: defaultSyncPrinters,
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
