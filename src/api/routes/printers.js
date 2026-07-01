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
            const msg = h.code || '';
            if (code.includes('0300') || msg.toLowerCase().includes('sd') || msg.toLowerCase().includes('storage')) {
                diag.sd_health.has_sd_error = true;
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
    if (!worker?.mqttClient?.isConnected) {
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
    if (!worker?.mqttClient?.isConnected) {
        return res.status(503).json({ error: 'Printer MQTT not connected' });
    }

    const mqtt = worker.mqttClient;
    const { action } = req.body;
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

export default router;
