// src/api/routes/printers.js — Printer CRUD + operations endpoints
import { Router } from 'express';
import { PrinterRegistry } from '../../services/PrinterRegistry.js';
import { AmsService } from '../../services/AmsService.js';
import { requireAuth, requireAdmin } from '../../auth/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = Router();

// Overlay LIVE worker connection state onto persisted printer records, so the UI
// reflects real-time connectivity (e.g. "offline" when MQTT is down) instead of the
// last-saved DB snapshot. Accepts a single printer or an array.
async function withLiveState(printers) {
    const { RuntimeSupervisor } = await import('../../runtime/RuntimeSupervisor.js');
    const sup = RuntimeSupervisor.getInstance();
    const mock = process.env.MOCK_MODE === 'true';
    const list = Array.isArray(printers) ? printers : [printers];
    const enriched = list.map(p => {
        if (!p) return p;
        const w = sup?.getWorker(p.printer_id);
        const connected = mock ? true : !!w?.connected;
        const snap = { ...(p.status_snapshot || {}) };
        if (!connected) snap.state = 'offline';
        else if (w?.state && w.state !== 'unknown') snap.state = w.state;
        return { ...p, connected, status_snapshot: snap };
    });
    return Array.isArray(printers) ? enriched : enriched[0];
}

// List all printers
router.get('/', requireAuth, asyncHandler(async (req, res) => {
    res.json(await withLiveState(PrinterRegistry.findAll()));
}));

// Discover printers on the network via SSDP
router.get('/discover', requireAuth, asyncHandler(async (req, res) => {
    const { RuntimeSupervisor } = await import('../../runtime/RuntimeSupervisor.js');
    const supervisor = RuntimeSupervisor.getInstance();
    if (!supervisor?.discovery) return res.json([]);
    supervisor._syncDiscoverySerials();
    res.json(supervisor.discovery.getDiscovered());
}));

// Fleet filament — aggregate AMS/loaded filament across every printer, optionally
// filtered by material/color (for routing a color-critical job to a ready printer).
// NOTE: registered before '/:id' so it isn't captured as a printer id.
router.get('/ams', requireAuth, asyncHandler(async (req, res) => {
    const { material, color } = req.query;
    const m = material ? String(material).toUpperCase() : null;
    const c = color ? String(color).toUpperCase() : null;
    const fleet = PrinterRegistry.findAll().map((p) => {
        let ams = null;
        try { ams = AmsService.getFullStatus(p.printer_id); } catch { ams = null; }
        return { printer_id: p.printer_id, name: p.name, model: p.model, ams };
    });
    const matches = (f) => (f.ams?.slots || []).some((s) => {
        const sm = String(s.live_type || s.configured_material || '').toUpperCase();
        const sc = String(s.live_color || s.configured_color || '').toUpperCase();
        return (!m || sm.includes(m)) && (!c || sc.includes(c));
    });
    const printers = (m || c) ? fleet.filter(matches) : fleet;
    res.json({ count: printers.length, printers });
}));

// Bulk control across the fleet — pause-all / resume-all / stop-all / clear-all-errors
// / lights. Body: { action, printer_ids? (default all), params? }.
router.post('/bulk/control', requireAdmin, asyncHandler(async (req, res) => {
    const { RuntimeSupervisor } = await import('../../runtime/RuntimeSupervisor.js');
    const supervisor = RuntimeSupervisor.getInstance();
    const { action } = req.body || {};
    if (!action) return res.status(400).json({ error: 'action is required' });
    const ids = Array.isArray(req.body?.printer_ids) && req.body.printer_ids.length
        ? req.body.printer_ids
        : PrinterRegistry.findAll().map((p) => p.printer_id);
    const results = [];
    for (const id of ids) {
        const worker = supervisor?.getWorker(id);
        if (!worker?.canControl?.()) { results.push({ printer_id: id, ok: false, error: 'not_controllable' }); continue; }
        try {
            let ok;
            switch (action) {
                case 'pause':       ok = !!worker._pausePrint(); break;
                case 'resume':      ok = !!worker._resumePrint(); break;
                case 'stop':        ok = !!worker._stopPrint(); break;
                case 'clear_error': ok = worker.clearPrintError() !== false; break;
                case 'light_on':    ok = worker.mqttClient?.setLight(true) ?? false; break;
                case 'light_off':   ok = worker.mqttClient?.setLight(false) ?? false; break;
                default: return res.status(400).json({ error: `Unsupported bulk action: ${action}` });
            }
            results.push({ printer_id: id, ok: !!ok });
        } catch (err) {
            results.push({ printer_id: id, ok: false, error: err.message });
        }
    }
    res.json({ action, total: ids.length, succeeded: results.filter((r) => r.ok).length, results });
}));

// Get single printer with full detail
router.get('/:id', requireAuth, asyncHandler(async (req, res) => {
    const printer = PrinterRegistry.getFullDetail(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });
    res.json(await withLiveState(printer));
}));

// Create printer
router.post('/', requireAdmin, asyncHandler(async (req, res) => {
    const { name, model, ip_hostname, auth, camera_url } = req.body;
    if (!name || !model || !ip_hostname) {
        return res.status(400).json({ error: 'name, model, and ip_hostname are required' });
    }
    const printer = PrinterRegistry.create({ name, model, ip_hostname, auth, camera_url });
    res.status(201).json(printer);
}));

// Update printer
router.patch('/:id', requireAdmin, asyncHandler(async (req, res) => {
    const printer = PrinterRegistry.update(req.params.id, req.body);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });
    res.json(printer);
}));

// Delete printer
router.delete('/:id', requireAdmin, asyncHandler(async (req, res) => {
    const printer = PrinterRegistry.delete(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });
    res.json({ deleted: true });
}));

// Test connection — actually probes the printer (MQTT control channel + FTPS file transfer)
router.post('/:id/test-connection', requireAuth, asyncHandler(async (req, res) => {
    const printer = PrinterRegistry.findById(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });

    if (process.env.MOCK_MODE === 'true') {
        return res.json({ success: true, message: 'Connection OK (mock mode)', mock: true });
    }

    // Live MQTT state from the running worker (this is the control channel)
    const { RuntimeSupervisor } = await import('../../runtime/RuntimeSupervisor.js');
    const worker = RuntimeSupervisor.getInstance()?.getWorker(req.params.id);
    const mqttConnected = !!worker?.connected;
    const lastReportAge = worker?.lastReportTime
        ? Math.round((Date.now() - worker.lastReportTime) / 1000)
        : null;

    // FTPS reachability probe (port 990 — used for file uploads)
    let ftpsReachable = false;
    try {
        const auth = PrinterRegistry.getAuth?.(req.params.id);
        const { BambuFtpsClient } = await import('../../services/BambuFtpsClient.js');
        const ftps = new BambuFtpsClient({ ip: printer.ip_hostname, accessCode: auth?.access_code || '', printerId: req.params.id });
        ftpsReachable = await ftps.isReachable();
    } catch { /* treat as unreachable */ }

    const success = mqttConnected;
    const message = mqttConnected
        ? `Connected — MQTT control channel live${lastReportAge !== null ? ` (last report ${lastReportAge}s ago)` : ''}. File transfer (FTPS port 990) ${ftpsReachable ? 'reachable' : 'NOT reachable'}.`
        : `Not connected — no MQTT control channel at ${printer.ip_hostname}:8883. File transfer (FTPS) ${ftpsReachable ? 'is reachable, so the printer is on the network — check the Access Code and Serial' : 'also unreachable — check the printer is powered on, on this network, and has LAN/Developer mode enabled'}.`;

    // Always 200 so the frontend can read the message; `success` carries the verdict.
    res.json({ success, message, mqtt_connected: mqttConnected, ftps_reachable: ftpsReachable, last_report_age: lastReportAge });
}));

// Test connection parameters (before saving)
router.post('/test-connection-params', requireAdmin, asyncHandler(async (req, res) => {
    const { ip_hostname, access_code, serial } = req.body;
    if (!ip_hostname) return res.status(400).json({ error: 'IP/Hostname is required' });
    if (!serial) return res.status(400).json({ error: 'Serial Number is required' });

    if (process.env.MOCK_MODE === 'true') {
        return res.json({ success: true, message: 'Connection test passed (mock)' });
    }

    // Use new BambuClient with diagnostics
    const { BambuClient } = await import('../../mqtt/BambuClient.js');

    // Check if we have a trusted fingerprint (if editing existing printer, ideally we'd look it up,
    // but for "add new" we operate in TOFU mode usually)
    // For now, let's treat "Test" as a discovery probe that returns the cert for user approval if needed.

    const client = new BambuClient({
        ip: ip_hostname,
        access_code,
        serial,
        printer_id: `test_${Date.now()}`
    });

    try {
        const result = await client.connect(true); // trustNewCert=true for testing/TOFU
        client.disconnect();

        if (result.success) {
            res.json({
                success: true,
                message: 'Connection successful',
                diagnostics: result.diagnostics,
                cert_fingerprint: result.fingerprint
            });
        } else {
            res.status(400).json({
                error: 'Connection failed',
                diagnostics: result.diagnostics
            });
        }

    } catch (err) {
        res.status(400).json({ error: `System error: ${err.message}` });
    }
}));

// Get AMS data (config + live + catalog)
router.get('/:id/ams', requireAuth, asyncHandler(async (req, res) => {
    const status = AmsService.getFullStatus(req.params.id);
    res.json(status);
}));

// Preflight check for send pipeline
router.get('/:id/preflight', requireAuth, asyncHandler(async (req, res) => {
    const { RuntimeSupervisor } = await import('../../runtime/RuntimeSupervisor.js');
    const worker = RuntimeSupervisor.getInstance()?.getWorker(req.params.id);
    if (!worker) return res.status(404).json({ error: 'Printer worker not found' });

    const preflight = worker.getPreflightStatus();

    // Also check FTPS reachability
    const printer = PrinterRegistry.findById(req.params.id);
    const auth = PrinterRegistry.getAuth?.(req.params.id);
    let ftpsReachable = false;
    if (printer) {
        const { BambuFtpsClient } = await import('../../services/BambuFtpsClient.js');
        const ftps = new BambuFtpsClient({ ip: printer.ip_hostname, accessCode: auth?.access_code || '', printerId: req.params.id });
        ftpsReachable = await ftps.isReachable();
    }

    res.json({ ...preflight, ftps_reachable: ftpsReachable });
}));

// Connection Doctor / Diagnostics
router.get('/:id/diagnostics', requireAuth, asyncHandler(async (req, res) => {
    const { RuntimeSupervisor } = await import('../../runtime/RuntimeSupervisor.js');
    const worker = RuntimeSupervisor.getInstance()?.getWorker(req.params.id);
    const printer = PrinterRegistry.findById(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });

    const auth = PrinterRegistry.getAuth?.(req.params.id);

    // FTPS check
    let ftpsReachable = false;
    try {
        const { BambuFtpsClient } = await import('../../services/BambuFtpsClient.js');
        const ftps = new BambuFtpsClient({ ip: printer.ip_hostname, accessCode: auth?.access_code || '', printerId: req.params.id });
        ftpsReachable = await ftps.isReachable();
    } catch { /* */ }

    const diag = {
        printer_id: req.params.id,
        name: printer.name,
        model: printer.model,
        ip: printer.ip_hostname,
        mqtt: {
            connected: worker?.connected || false,
            last_report_age: worker?.lastReportTime ? Math.round((Date.now() - worker.lastReportTime) / 1000) : null,
            state: worker?.state || 'unknown',
        },
        ftps: {
            reachable: ftpsReachable,
            port: 990,
        },
        sd_health: {
            hms_errors: worker?.latestStatus?.hms_errors || [],
            has_sd_error: false,
        },
        latest_status: worker?.latestStatus || {},
        active_job_id: worker?.activeJobId || null,
    };

    // Check for SD errors
    if (diag.sd_health.hms_errors.length > 0) {
        for (const h of diag.sd_health.hms_errors) {
            const code = h.attr?.toString(16) || '';
            const msg = String(h.code ?? '').toLowerCase(); // numeric on Bambu — coerce before string ops
            if (code.includes('0300') || msg.includes('sd') || msg.includes('storage')) {
                diag.sd_health.has_sd_error = true;
            }
        }
    }
    // Also flag an SD fault from a standing print_error (e.g. 0x0500C010 MicroSD
    // read/write). The HMS list is often empty while print_error persists.
    {
        const pe = worker?.latestStatus?.print_error;
        if (pe) {
            const { decodePrintError } = await import('../../utils/PrinterErrors.js');
            const decoded = decodePrintError(pe);
            const hex = (decoded?.hex || '').toLowerCase();
            if (hex.includes('0500c01') || /sd|storage|micro/i.test(decoded?.message || '')) {
                diag.sd_health.has_sd_error = true;
                diag.sd_health.print_error = { code: pe, formatted: decoded?.formatted, message: decoded?.message };
            }
        }
    }

    res.json(diag);
}));

// Recheck printer status (triggers pushall, waits for response, returns updated preflight)
router.post('/:id/recheck', requireAuth, asyncHandler(async (req, res) => {
    const { RuntimeSupervisor } = await import('../../runtime/RuntimeSupervisor.js');
    const worker = RuntimeSupervisor.getInstance()?.getWorker(req.params.id);
    if (!worker) return res.status(404).json({ error: 'Printer worker not found' });

    // Request a full status refresh from the printer
    const sent = worker.requestStatusRefresh();
    if (!sent) {
        return res.status(503).json({ error: 'Cannot reach printer (MQTT disconnected)' });
    }

    // Wait 3 seconds for the pushall response to arrive via MQTT
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Return updated preflight status
    const preflight = worker.getPreflightStatus();
    res.json(preflight);
}));

// ===== AMS FILAMENT CONFIGURATION =====

// Set filament for a specific AMS tray
router.put('/:id/ams/:trayId', requireAdmin, asyncHandler(async (req, res) => {
    const { AmsService } = await import('../../services/AmsService.js');
    const { material, color_hex, color_name } = req.body;
    if (!material) return res.status(400).json({ error: 'material is required' });

    const amsId = parseInt(req.body.ams_id) || 0;
    const trayId = parseInt(req.params.trayId);
    if (trayId < 0 || trayId > 15) return res.status(400).json({ error: 'tray_id must be 0-15' });

    const result = AmsService.setTray(req.params.id, amsId, trayId, {
        material,
        colorHex: color_hex || 'FFFFFFFF',
        colorName: color_name || 'White',
    });
    res.json(result);
}));

// Clear a specific AMS tray
router.delete('/:id/ams/:trayId', requireAdmin, asyncHandler(async (req, res) => {
    const { AmsService } = await import('../../services/AmsService.js');
    const amsId = parseInt(req.query.ams_id) || 0;
    AmsService.clearTray(req.params.id, amsId, parseInt(req.params.trayId));
    res.json({ ok: true });
}));

// Sync all configured trays to the printer via MQTT
router.post('/:id/ams/sync', requireAdmin, asyncHandler(async (req, res) => {
    const { RuntimeSupervisor } = await import('../../runtime/RuntimeSupervisor.js');
    const { AmsService } = await import('../../services/AmsService.js');
    const supervisor = RuntimeSupervisor.getInstance();
    const worker = supervisor?.getWorker(req.params.id);
    if (!worker?.mqttClient?.connected) {
        return res.status(503).json({ error: 'Printer MQTT not connected' });
    }

    const results = await AmsService.syncToDevice(req.params.id, worker.mqttClient);
    res.json({ synced: results });
}));

// ===== MANUAL PRINTER CONTROLS =====

router.post('/:id/control', requireAdmin, asyncHandler(async (req, res) => {
    const { RuntimeSupervisor } = await import('../../runtime/RuntimeSupervisor.js');
    const supervisor = RuntimeSupervisor.getInstance();
    const worker = supervisor?.getWorker(req.params.id);
    if (!worker?.canControl?.()) {
        return res.status(503).json({ error: 'Printer MQTT not connected' });
    }

    const { action } = req.body;

    // Job-lifecycle controls go through the worker so its state machine stays in
    // sync with the cloud/CommandBus path (avoids UI vs. real-state drift).
    if (action === 'pause' || action === 'resume' || action === 'stop') {
        const result = action === 'pause' ? worker._pausePrint()
            : action === 'resume' ? worker._resumePrint()
                : worker._stopPrint();
        return res.json({ ok: true, action, ...result });
    }
    if (action === 'clear_error') {
        const ok = worker.clearPrintError();
        return res.json({ ok: ok !== false, action });
    }

    const mqtt = worker.mqttClient;
    if (!mqtt) return res.status(503).json({ error: 'Printer MQTT not connected' });
    let ok = false;

    switch (action) {
        case 'light_on':  ok = mqtt.setLight(true); break;
        case 'light_off': ok = mqtt.setLight(false); break;
        case 'set_fan':   ok = mqtt.setFan(req.body.fan || 1, req.body.speed ?? 128); break;
        case 'set_nozzle_temp': ok = mqtt.setNozzleTemp(req.body.temp ?? 0); break;
        case 'set_bed_temp':    ok = mqtt.setBedTemp(req.body.temp ?? 0); break;
        case 'home':      ok = mqtt.homeAxes(req.body.axes || 'all'); break;
        case 'move':      ok = mqtt.moveAxis({ x: req.body.x, y: req.body.y, z: req.body.z, speed: req.body.speed }); break;
        case 'bed_level':  ok = mqtt.startBedLeveling(); break;
        case 'extrude':    ok = mqtt.extrude(req.body.mm || 10, req.body.speed || 300); break;
        case 'retract':    ok = mqtt.retract(req.body.mm || 10, req.body.speed || 300); break;
        case 'load_filament':   ok = mqtt.loadFilament(req.body.temp || 220); break;
        case 'unload_filament': ok = mqtt.unloadFilament(req.body.temp || 220); break;
        case 'set_speed_profile':  ok = mqtt.setSpeedProfile(req.body.level || 2); break;
        case 'set_speed_override': ok = mqtt.setSpeedOverride(req.body.percent || 100); break;
        case 'set_flow_override':  ok = mqtt.setFlowOverride(req.body.percent || 100); break;
        case 'set_z_offset':       ok = mqtt.setZOffset(req.body.offset || 0); break;
        default:
            return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    res.json({ ok, action });
}));

// ===== PRINTER OVERRIDES (saved settings) =====

router.get('/:id/overrides', requireAuth, asyncHandler(async (req, res) => {
    const { dbAll } = await import('../../db/database.js');
    const rows = dbAll('SELECT setting_key, setting_value FROM printer_overrides WHERE printer_id = ?', [req.params.id]);
    const overrides = {};
    for (const r of rows) overrides[r.setting_key] = r.setting_value;
    res.json(overrides);
}));

router.put('/:id/overrides', requireAdmin, asyncHandler(async (req, res) => {
    const { dbRun } = await import('../../db/database.js');
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'key is required' });

    // Delete then insert (sql.js upsert workaround)
    dbRun('DELETE FROM printer_overrides WHERE printer_id = ? AND setting_key = ?', [req.params.id, key]);
    if (value !== null && value !== undefined && value !== '') {
        dbRun(
            'INSERT INTO printer_overrides (printer_id, setting_key, setting_value) VALUES (?, ?, ?)',
            [req.params.id, key, String(value)],
        );
    }
    res.json({ ok: true, key, value });
}));

router.delete('/:id/overrides/:key', requireAdmin, asyncHandler(async (req, res) => {
    const { dbRun } = await import('../../db/database.js');
    dbRun('DELETE FROM printer_overrides WHERE printer_id = ? AND setting_key = ?', [req.params.id, req.params.key]);
    res.json({ ok: true });
}));

// Per-printer error log — decoded print_error / HMS / failure history.
router.get('/:id/errors', requireAuth, asyncHandler(async (req, res) => {
    const printer = PrinterRegistry.findById(req.params.id);
    if (!printer) return res.status(404).json({ error: 'Printer not found' });
    const { EventLog } = await import('../../services/EventLog.js');
    const { decodePrintError } = await import('../../utils/PrinterErrors.js');
    const ERROR_TYPES = new Set([
        'printer.error', 'printer.error_cleared', 'printer.hms',
        'printer.failure_detected', 'printer.auto_canceled',
    ]);
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    // Pull a window of entity events and keep the error-related ones.
    const events = EventLog.getByEntity('printer', req.params.id, { limit: limit * 3, offset: 0 }) || [];
    const errors = events
        .filter((e) => ERROR_TYPES.has(e.event_type))
        .slice(0, limit)
        .map((e) => {
            const p = typeof e.payload === 'string' ? (() => { try { return JSON.parse(e.payload); } catch { return {}; } })() : (e.payload || {});
            const decoded = p.code ? decodePrintError(p.code) : null;
            return {
                event_id: e.event_id,
                type: e.event_type,
                created_at: e.created_at,
                code: p.code ?? null,
                formatted: p.formatted ?? decoded?.formatted ?? p.hms ?? null,
                message: p.message ?? decoded?.message ?? null,
                severity: p.severity ?? decoded?.severity ?? (e.event_type === 'printer.error_cleared' ? 'info' : 'error'),
                remediation: decoded?.remediation ?? null,
                state: p.state ?? null,
            };
        });
    res.json({ printer_id: req.params.id, count: errors.length, errors });
}));

// ─── Camera feed ────────────────────────────────────────────────────
// The SPA's camera widget calls these (authenticated via ?token= for <img>/MJPEG,
// which requireAuth supports). The CameraProxy handles model-specific transport
// (P1 JPEG on :6000, X1 RTSPS on :322). Auth (access code) comes from the
// encrypted printer record.
async function ensureCameraProxy(printerId) {
    const printer = PrinterRegistry.findById(printerId);
    if (!printer) return { error: 'Printer not found', status: 404 };
    if (process.env.MOCK_MODE === 'true') {
        return { error: 'Camera feed is unavailable in mock mode (no physical printer).', status: 503 };
    }
    const { default: cameraProxy } = await import('../../services/CameraProxy.js');
    const auth = PrinterRegistry.getAuth?.(printerId) || {};
    if (!cameraProxy.isRunning(printerId)) {
        await cameraProxy.start(printerId, printer.ip_hostname, auth.access_code || '', printer.model);
    }
    return { cameraProxy };
}

// Snapshot — returns the most recent JPEG frame (starts the proxy on first call).
router.get('/:id/camera/snapshot', requireAuth, asyncHandler(async (req, res) => {
    const result = await ensureCameraProxy(req.params.id);
    if (result.error) return res.status(result.status).json({ error: result.error });
    const { cameraProxy } = result;

    // Give a freshly-started proxy a moment to produce the first frame.
    let frame = cameraProxy.getFrame(req.params.id);
    for (let i = 0; i < 20 && !frame; i++) {
        await new Promise((r) => setTimeout(r, 150));
        frame = cameraProxy.getFrame(req.params.id);
    }
    if (!frame) {
        const err = cameraProxy.getError(req.params.id) || 'Camera frame not yet available';
        return res.status(503).json({ error: err });
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.send(frame);
}));

// Live MJPEG stream (multipart/x-mixed-replace) — usable directly as an <img> src.
router.get('/:id/camera/stream', requireAuth, asyncHandler(async (req, res) => {
    const result = await ensureCameraProxy(req.params.id);
    if (result.error) return res.status(result.status).json({ error: result.error });
    const { cameraProxy } = result;

    res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Connection: 'keep-alive',
        Pragma: 'no-cache',
    });
    const added = cameraProxy.addStreamClient(req.params.id, res);
    if (!added) {
        const err = cameraProxy.getError(req.params.id) || 'Camera stream unavailable';
        return res.end(`--frame\r\nContent-Type: text/plain\r\n\r\n${err}\r\n`);
    }
    // Response is held open by the proxy; it removes the client on 'close'.
}));

export default router;
