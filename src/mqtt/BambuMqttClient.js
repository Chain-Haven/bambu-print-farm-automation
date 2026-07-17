// src/mqtt/BambuMqttClient.js — Bambu-specific MQTT client
// Handles TLS connection to Bambu printers on port 8883

import { createLogger } from '../utils/logger.js';

const log = createLogger('BambuMQTT');

export class BambuMqttClient {
    constructor(printer, authData) {
        this.printerId = printer.printer_id;
        this.host = printer.ip_hostname;
        this.port = 8883;
        this.serial = authData?.serial || '';
        this.accessCode = authData?.access_code || '';
        this.client = null;
        this.connected = false;
        this.statusCallback = null;
        this.reconnectTimer = null;
        this.reconnectInterval = parseInt(process.env.MQTT_RECONNECT_INTERVAL_MS) || 5000;
        this.consecutiveErrors = 0;
        this.maxLoggedErrors = 5; // After this, only log at debug level
    }

    /**
     * Connect to the Bambu printer MQTT broker.
     */
    async connect() {
        try {
            const mqtt = await import('mqtt');
            const clientId = `antigravity_${this.printerId.slice(0, 8)}`;

            this.client = mqtt.default.connect(`mqtts://${this.host}:${this.port}`, {
                clientId,
                username: 'bblp',
                password: this.accessCode,
                rejectUnauthorized: false, // Bambu uses self-signed certs
                // Jitter the reconnect so a fleet of hundreds of printers doesn't
                // reconnect in lockstep after a network blip (thundering herd).
                reconnectPeriod: this.reconnectInterval + Math.floor(Math.random() * 2000),
                connectTimeout: 10000,
            });

            this.client.on('connect', () => {
                this.connected = true;
                this.consecutiveErrors = 0; // Reset error counter on success
                this._loggedDisconnect = false; // allow one disconnect log next time it drops
                log.info(`Connected to printer ${this.printerId} @ ${this.host}`);
                // Subscribe to printer status reports
                const topic = `device/${this.serial}/report`;
                this.client.subscribe(topic, (err) => {
                    if (err) log.error(`Subscribe error: ${err.message}`);
                    else {
                        log.info(`Subscribed to ${topic}`);
                        // Request full status dump
                        this.requestStatus();
                    }
                });
            });

            this.client.on('message', (_topic, message) => {
                try {
                    const data = JSON.parse(message.toString());
                    if (this.statusCallback) {
                        this.statusCallback(data);
                    }
                } catch (e) {
                    log.warn(`Failed to parse printer message: ${e.message}`);
                }
            });

            this.client.on('error', (err) => {
                this.consecutiveErrors++;
                if (this.consecutiveErrors <= this.maxLoggedErrors) {
                    log.error(`MQTT error for ${this.printerId}: ${err.message}`);
                    if (this.consecutiveErrors === this.maxLoggedErrors) {
                        log.warn(`Suppressing further MQTT errors for ${this.printerId} (printer unreachable)`);
                    }
                }
            });

            this.client.on('close', () => {
                this.connected = false;
                // Log only the FIRST close after a successful connection. The mqtt client
                // auto-retries every few seconds; without this guard an unreachable printer
                // floods the terminal with identical "disconnected" lines forever.
                if (!this._loggedDisconnect) {
                    log.warn(`MQTT disconnected from ${this.printerId} (will keep retrying quietly)`);
                    this._loggedDisconnect = true;
                }
            });

            this.client.on('reconnect', () => {
                log.debug(`MQTT reconnecting to ${this.printerId}`);
            });

        } catch (err) {
            log.error(`MQTT connect failed for ${this.printerId}: ${err.message}`);
            throw err; // Re-throw to caller
        }
    }

    /**
     * Send a command to the printer.
     */
    publish(command) {
        if (!this.client || !this.connected) {
            log.warn(`Cannot publish: not connected to ${this.printerId}`);
            return false;
        }
        const topic = `device/${this.serial}/request`;
        this.client.publish(topic, JSON.stringify(command));
        return true;
    }

    /**
     * Request a status push from the printer.
     */
    requestStatus() {
        return this.publish({
            pushing: { sequence_id: '0', command: 'pushall' }
        });
    }

    /**
     * Clear a stale print_error from the printer.
     * Bambu printers can retain error codes even after the problem resolves.
     */
    cleanPrintError() {
        log.info(`Sending clean_print_error to printer ${this.printerId}`);
        return this.publish({
            print: { sequence_id: '0', command: 'clean_print_error' }
        });
    }

    /**
     * Send print start command (Bambu LAN protocol).
     * After uploading a .3mf to /cache/ via FTPS, this tells the printer to open it.
     *
     * url: the FTPS root IS the SD card, so `ftp:///sdcard/cache/x` points at a
     * nonexistent /sdcard/sdcard/... path and the firmware reports a bogus
     * 0500-C010 "MicroSD card" error. `file:///sdcard/cache/x` is the PRIMARY
     * form — the `ftp:///cache/x` form makes the firmware re-fetch the file
     * and chokes the same way on multi-MB files (3.2MB failed, 117KB fine;
     * hardware-verified 2026-07-07). Callers may pass an explicit url to try
     * the alternate form on retry.
     *
     * flowCali/vibrationCali default OFF: Bambu bakes the saved K-factor into
     * sliced gcode, so a per-print recalibration is redundant — and flow-cali
     * extrudes test filament at start (looks like "nozzle in the air, filament
     * falling"). bed_leveling stays on (ABL finds the plate).
     */
    startPrint({ filename, plateNumber = 1, useAms = true, amsMapping = [], url = null, flowCali = false, vibrationCali = false }) {
        const payload = {
            print: {
                sequence_id: String(Date.now()),
                command: 'project_file',
                param: `Metadata/plate_${plateNumber}.gcode`,
                subtask_name: filename.replace(/\.gcode\.3mf$/i, '').replace(/\.3mf$/i, ''),
                url: url || `file:///sdcard/cache/${filename}`,
                bed_type: 'auto',
                timelapse: false,
                bed_leveling: true,
                flow_cali: flowCali === true,
                vibration_cali: vibrationCali === true,
                layer_inspect: false,
                use_ams: useAms,
                ams_mapping: amsMapping,
                profile_id: '0',
                project_id: '0',
                subtask_id: '0',
                task_id: '0',
            }
        };
        log.info(`Starting print: ${filename} (plate ${plateNumber}, url ${payload.print.url})`);
        return this.publish(payload);
    }

    /**
     * Override what the printer thinks is in an AMS tray.
     * This sets the filament type, color, and settings for a specific slot.
     * @param {Object} payload - Pre-built payload from FilamentCatalog.buildTrayPayload()
     */
    setAmsTrayFilament(payload) {
        const p = payload.print || payload;
        log.info(`Setting AMS[${p.ams_id}] tray ${p.tray_id} → ${p.tray_type} color=${p.tray_color} setting=${p.setting_id}`);
        return this.publish(payload);
    }

    /**
     * Pause print.
     */
    pausePrint() {
        return this.publish({ print: { sequence_id: '0', command: 'pause' } });
    }

    /**
     * Resume print.
     */
    resumePrint() {
        return this.publish({ print: { sequence_id: '0', command: 'resume' } });
    }

    /**
     * Stop print.
     */
    stopPrint() {
        return this.publish({ print: { sequence_id: '0', command: 'stop' } });
    }

    /**
     * Send G-code directly.
     */
    sendGcode(gcodeLines) {
        return this.publish({
            print: {
                sequence_id: '0',
                command: 'gcode_line',
                param: Array.isArray(gcodeLines) ? gcodeLines.join('\n') : gcodeLines,
            }
        });
    }

    /**
     * Set status callback.
     */
    onStatus(callback) {
        this.statusCallback = callback;
    }

    // ═══════════════════════════════════════════
    //  Manual Printer Controls
    // ═══════════════════════════════════════════

    /** Toggle chamber light on/off */
    setLight(on) {
        log.info(`Light → ${on ? 'ON' : 'OFF'}`);
        return this.publish({
            system: {
                sequence_id: String(Date.now()),
                command: 'ledctrl',
                led_node: 'chamber_light',
                led_mode: on ? 'on' : 'off',
                led_on_time: 500,
                led_off_time: 500,
                loop_times: 0,
                interval_time: 0,
            }
        });
    }

    /** Set fan speed. fan: 1=part, 2=aux, 3=chamber. speed: 0-255. */
    setFan(fan, speed) {
        const clamped = Math.max(0, Math.min(255, Math.round(speed)));
        const names = { 1: 'part', 2: 'aux', 3: 'chamber' };
        log.info(`Fan ${names[fan] || fan} → ${clamped}/255`);
        return this.sendGcode(`M106 P${fan} S${clamped}`);
    }

    /** Set nozzle target temperature (°C). 0 = off. */
    setNozzleTemp(temp) {
        const t = Math.max(0, Math.min(300, Math.round(temp)));
        log.info(`Nozzle temp → ${t}°C`);
        return this.sendGcode(`M104 S${t}`);
    }

    /** Set bed target temperature (°C). 0 = off. */
    setBedTemp(temp) {
        const t = Math.max(0, Math.min(120, Math.round(temp)));
        log.info(`Bed temp → ${t}°C`);
        return this.sendGcode(`M140 S${t}`);
    }

    /** Home axes. axes: 'all', 'XY', 'Z' */
    homeAxes(axes = 'all') {
        log.info(`Homing: ${axes}`);
        if (axes === 'XY') return this.sendGcode('G28 X Y');
        if (axes === 'Z') return this.sendGcode('G28 Z');
        return this.sendGcode('G28');
    }

    /** Move to absolute position. x/y/z in mm, speed in mm/min. */
    moveAxis({ x, y, z, speed = 3000 } = {}) {
        const parts = ['G90']; // absolute mode
        let cmd = 'G1';
        if (x !== undefined) cmd += ` X${x}`;
        if (y !== undefined) cmd += ` Y${y}`;
        if (z !== undefined) cmd += ` Z${z}`;
        cmd += ` F${speed}`;
        parts.push(cmd);
        log.info(`Move → ${cmd}`);
        return this.sendGcode(parts.join('\n'));
    }

    /** Start auto bed leveling. */
    startBedLeveling() {
        log.info('Starting bed leveling (G29)');
        return this.sendGcode('G29');
    }

    /** Extrude filament. mm: length in mm, speed: mm/min (default 300 = 5mm/s). */
    extrude(mm = 10, speed = 300) {
        log.info(`Extrude ${mm}mm at F${speed}`);
        return this.sendGcode(`M83\nG1 E${Math.abs(mm)} F${speed}`);
    }

    /** Retract filament. mm: length in mm, speed: mm/min. */
    retract(mm = 10, speed = 300) {
        log.info(`Retract ${mm}mm at F${speed}`);
        return this.sendGcode(`M83\nG1 E-${Math.abs(mm)} F${speed}`);
    }

    /** Load filament - heats nozzle then feeds filament in. */
    loadFilament(temp = 220) {
        log.info(`Loading filament at ${temp}°C`);
        return this.sendGcode([
            `M104 S${temp}`,
            `M109 S${temp}`,
            'M83',
            'G1 E30 F300',
        ].join('\n'));
    }

    /** Unload filament - heats nozzle then retracts filament out. */
    unloadFilament(temp = 220) {
        log.info(`Unloading filament at ${temp}°C`);
        return this.sendGcode([
            `M104 S${temp}`,
            `M109 S${temp}`,
            'M83',
            'G1 E-100 F1500',
        ].join('\n'));
    }

    /**
     * Real AMS filament change (cut + retract + feed) — the procedure the
     * printer's own screen uses. target = GLOBAL tray index, 255 = unload.
     * (The load/unloadFilament helpers above are naive gcode that never touch
     * the AMS.)
     */
    amsChangeFilament(target = 255, currTemp = 220, tarTemp = 220) {
        log.info(`AMS filament change → ${target === 255 ? 'UNLOAD' : `tray ${target + 1}`} (curr ${currTemp}°C, tar ${tarTemp}°C)`);
        return this.publish({
            print: {
                sequence_id: '0',
                command: 'ams_change_filament',
                target,
                curr_temp: currTemp,
                tar_temp: tarTemp,
            },
        });
    }

    /** Set speed profile. level: 1=silent, 2=standard, 3=sport, 4=ludicrous */
    setSpeedProfile(level) {
        const names = { 1: 'Silent', 2: 'Standard', 3: 'Sport', 4: 'Ludicrous' };
        log.info(`Speed profile → ${names[level] || level}`);
        return this.publish({
            print: {
                sequence_id: String(Date.now()),
                command: 'print_speed',
                param: String(level),
            }
        });
    }

    /** Set speed override percentage via M220. percent: 50-200. */
    setSpeedOverride(percent) {
        const p = Math.max(10, Math.min(300, Math.round(percent)));
        log.info(`Speed override → ${p}%`);
        return this.sendGcode(`M220 S${p}`);
    }

    /** Set flow rate override percentage via M221. percent: 50-200. */
    setFlowOverride(percent) {
        const p = Math.max(50, Math.min(200, Math.round(percent)));
        log.info(`Flow override → ${p}%`);
        return this.sendGcode(`M221 S${p}`);
    }

    /** Baby-step Z-offset adjustment during print. offset in mm (e.g. -0.05). */
    setZOffset(offset) {
        const z = Number.isFinite(Number(offset)) ? Number(offset) : 0;
        log.info(`Z offset adjustment -> ${z}mm`);
        return this.sendGcode(`M290 Z${z.toFixed(3)}`);
    }

    disconnect() {
        if (this.client) {
            this.client.end(true);
            this.client = null;
        }
        this.connected = false;
    }
}

export default BambuMqttClient;
