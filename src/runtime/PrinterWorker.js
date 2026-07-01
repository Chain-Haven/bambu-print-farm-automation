// src/runtime/PrinterWorker.js — Per-printer worker with state machine
import { BambuMqttClient } from '../mqtt/BambuMqttClient.js';
import { PrinterModel } from '../models/Printer.js';
import { CommandBus } from '../services/CommandBus.js';
import { EventModel } from '../models/Event.js';
import { createLogger } from '../utils/logger.js';
import { decodePrintError, formatErrorCode, isBlockingError } from '../utils/PrinterErrors.js';

const log = createLogger('PrinterWorker');

// Printer state machine: idle → printing → paused → completed/failed
const VALID_TRANSITIONS = {
    unknown: ['idle', 'printing', 'paused', 'error', 'offline'],
    offline: ['idle', 'unknown'],
    idle: ['printing', 'offline', 'error'],
    printing: ['paused', 'idle', 'error', 'offline'], // idle = completed
    paused: ['printing', 'idle', 'error', 'offline'],
    error: ['idle', 'offline', 'unknown'],
};

export class PrinterWorker {
    constructor(printer) {
        this.printerId = printer.printer_id;
        this.printer = printer;
        this.state = 'unknown';
        this.connected = false;
        this.mqttClient = null;
        this.latestStatus = {};
        this.onStatusUpdate = null; // callback
        this.onAlert = null; // callback(alert) — fired on detected failures (set by supervisor)
        this.mockMode = process.env.MOCK_MODE === 'true';
        this.activeJobId = null; // Track if current print was started by Antigravity
        this.lastReportTime = null; // Timestamp of last MQTT report
        this._alertedErrorCode = 0; // de-dupe: last print_error we already alerted on
        // Self-healing state
        this._reconnectAttempts = 0;
        this._lastReconnectAt = 0;
        this._staleNudged = false;
        this.staleReportMs = parseInt(process.env.PRINTER_STALE_REPORT_MS) || 120000; // 2min
    }

    /**
     * Get preflight status for the send pipeline.
     * @returns {{ ok: boolean, errors: string[], warnings: string[], state: string, connected: boolean, lastReportAge: number }}
     */
    getPreflightStatus() {
        const errors = [];
        const warnings = [];

        // Check connection
        if (!this.connected) errors.push('Printer is not connected (MQTT offline)');

        // Check last report age
        const reportAgeMs = this.lastReportTime ? (Date.now() - this.lastReportTime) : Infinity;
        if (reportAgeMs > 10000) warnings.push(`Last status report was ${Math.round(reportAgeMs / 1000)}s ago`);

        // Check print_error — may be stale on Bambu printers
        const printError = this.latestStatus?.print_error;
        const decodedError = decodePrintError(printError);
        if (decodedError) {
            // If the printer is idle and connected, treat as a warning (likely stale)
            // If the printer is printing or in error state, treat as blocking
            if (this.state === 'idle' && this.connected) {
                warnings.push(`Stale error detected: ${decodedError.message} [${decodedError.formatted}] (will auto-clear)`);
                // Auto-attempt to clear stale error
                this._tryClearPrintError();
            } else {
                errors.push(`BLOCKED: ${decodedError.message} [${decodedError.formatted}]`);
            }
        }

        // Check state
        if (this.state !== 'idle') {
            if (this.state === 'printing') errors.push('Printer is currently printing');
            else if (this.state === 'error') errors.push('Printer is in error state');
            else if (this.state === 'offline') errors.push('Printer is offline');
            else warnings.push(`Printer state is "${this.state}" (expected idle)`);
        }

        // Check HMS errors (SD-related)
        const hms = this.latestStatus?.hms_errors;
        if (hms && Array.isArray(hms) && hms.length > 0) {
            for (const h of hms) {
                const code = h.attr?.toString(16) || '';
                const msg = h.code || '';
                if (code.includes('0300') || msg.toLowerCase().includes('sd') || msg.toLowerCase().includes('storage') || msg.toLowerCase().includes('micro')) {
                    errors.push(`SD/Storage error detected: HMS ${code} — Format SD in printer or replace card`);
                }
            }
        }

        return {
            ok: errors.length === 0,
            errors,
            warnings,
            state: this.state,
            connected: this.connected,
            lastReportAge: Math.round(reportAgeMs / 1000),
            nozzle_temp: this.latestStatus?.nozzle_temp,
            bed_temp: this.latestStatus?.bed_temp,
            print_error: decodedError,  // structured error info (null if no error)
        };
    }

    /**
     * Try to clear a stale print_error via MQTT.
     */
    _tryClearPrintError() {
        if (this.mqttClient && this.mqttClient.connected) {
            log.info(`Auto-clearing stale print_error on ${this.printer.name}`);
            this.mqttClient.cleanPrintError();
            // Request fresh status after a short delay
            setTimeout(() => {
                if (this.mqttClient) this.mqttClient.requestStatus();
            }, 2000);
        }
    }

    /**
     * Manually clear print error (exposed for API).
     */
    clearPrintError() {
        return this._tryClearPrintError();
    }

    async start() {
        if (this.mockMode) {
            // In mock mode, simulate an idle printer
            this.state = 'idle';
            this.connected = true;
            this.latestStatus = { state: 'idle', bed_temp: 25, nozzle_temp: 25, progress: 0 };
            PrinterModel.updateStatus(this.printerId, this.latestStatus);
            log.info(`MockMode: printer ${this.printer.name} marked idle`);
            return;
        }

        // Real connection
        const authData = PrinterModel.getAuth(this.printerId);
        if (!authData) {
            log.warn(`No auth configured for printer ${this.printer.name}`);
            this.state = 'offline';
            return;
        }

        this.mqttClient = new BambuMqttClient(this.printer, authData);
        this.mqttClient.onStatus((data) => this._handleStatus(data));
        await this.mqttClient.connect();
    }

    async stop() {
        if (this.mqttClient) {
            this.mqttClient.disconnect();
            this.mqttClient = null;
        }
        this.connected = false;
    }

    /**
     * Execute a command on this printer.
     */
    async executeCommand(cmd) {
        CommandBus.markSent(cmd.command_id);

        try {
            let result;
            switch (cmd.action) {
                case 'printer.start':
                    result = await this._startPrint(cmd.params);
                    break;
                case 'printer.pause':
                    result = this._pausePrint();
                    break;
                case 'printer.resume':
                    result = this._resumePrint();
                    break;
                case 'printer.stop':
                    result = this._stopPrint();
                    break;
                case 'printer.gcode':
                    result = this._sendGcode(cmd.params.gcode);
                    break;
                case 'printer.status':
                    result = { status: this.latestStatus };
                    break;
                default:
                    throw new Error(`Unknown printer action: ${cmd.action}`);
            }

            CommandBus.markDone(cmd.command_id, result);
            return result;
        } catch (err) {
            CommandBus.markFailed(cmd.command_id, err.message);
            throw err;
        }
    }

    async _startPrint(params) {
        if (this.state !== 'idle') {
            throw new Error(`Cannot start print: printer is ${this.state} (must be idle)`);
        }

        if (this.mockMode) {
            this._transitionState('printing');
            this.latestStatus = { ...this.latestStatus, state: 'printing', progress: 0 };
            // Simulate print progress
            this._simulatePrint(params);
            return { started: true, mock: true };
        }

        if (this.mqttClient) {
            // publish() returns false when the MQTT socket is not connected. If we
            // ignored it we would report a print as started that the printer never
            // received (e.g. an MQTT drop during the multi-minute FTPS upload).
            const published = this.mqttClient.startPrint(params);
            if (published === false) {
                throw new Error('MQTT not connected: start command was not delivered to the printer');
            }
            return { started: true };
        }
        throw new Error('MQTT client not available');
    }

    _pausePrint() {
        if (this.mockMode) {
            this._transitionState('paused');
            return { paused: true, mock: true };
        }
        if (this.mqttClient) { this.mqttClient.pausePrint(); return { paused: true }; }
        throw new Error('MQTT client not available');
    }

    _resumePrint() {
        if (this.mockMode) {
            this._transitionState('printing');
            return { resumed: true, mock: true };
        }
        if (this.mqttClient) { this.mqttClient.resumePrint(); return { resumed: true }; }
        throw new Error('MQTT client not available');
    }

    _stopPrint() {
        if (this.mockMode) {
            this._transitionState('idle');
            return { stopped: true, mock: true };
        }
        if (this.mqttClient) { this.mqttClient.stopPrint(); return { stopped: true }; }
        throw new Error('MQTT client not available');
    }

    _sendGcode(gcode) {
        if (this.mockMode) return { sent: true, mock: true };
        if (this.mqttClient) { this.mqttClient.sendGcode(gcode); return { sent: true }; }
        throw new Error('MQTT client not available');
    }

    /** Handle incoming MQTT status data. */
    _handleStatus(data) {
        this.connected = true;
        this.lastReportTime = Date.now();
        const print = data.print || {};

        // Capture prior error state so we can log transitions to the event log below.
        const priorPrintError = this.latestStatus?.print_error || 0;
        const priorHms = Array.isArray(this.latestStatus?.hms_errors) ? this.latestStatus.hms_errors : [];

        // Merge incremental updates (Bambu sends partial reports)
        const update = {};
        if (print.gcode_state !== undefined || print.mc_print_stage !== undefined) {
            update.state = this._mapBambuState(print.gcode_state || print.mc_print_stage);
        }
        if (print.bed_temper !== undefined) update.bed_temp = Math.round(print.bed_temper * 10) / 10;
        if (print.bed_target_temper !== undefined) update.bed_target = Math.round(print.bed_target_temper * 10) / 10;
        if (print.nozzle_temper !== undefined) update.nozzle_temp = Math.round(print.nozzle_temper * 10) / 10;
        if (print.nozzle_target_temper !== undefined) update.nozzle_target = Math.round(print.nozzle_target_temper * 10) / 10;
        if (print.mc_percent !== undefined) update.progress = print.mc_percent;
        if (print.mc_remaining_time !== undefined) update.remaining_time = print.mc_remaining_time;
        if (print.layer_num !== undefined) update.layer = print.layer_num;
        if (print.total_layer_num !== undefined) update.total_layers = print.total_layer_num;
        if (print.ams !== undefined) update.ams = print.ams;
        if (print.big_fan1_speed !== undefined) update.fan_speed = print.big_fan1_speed;
        if (print.spd_lvl !== undefined) update.speed_level = print.spd_lvl;
        if (print.wifi_signal !== undefined) update.wifi_signal = print.wifi_signal;
        if (print.lights_report !== undefined) update.lights = print.lights_report;
        if (print.hms !== undefined) update.hms_errors = print.hms;
        if (print.print_error !== undefined) {
            update.print_error = print.print_error;
            // Log error state changes
            const prevError = this.latestStatus?.print_error;
            if (print.print_error !== prevError) {
                if (print.print_error !== 0) {
                    const decoded = decodePrintError(print.print_error);
                    log.warn(`Printer ${this.printer.name}: print_error=${decoded.formatted} (${decoded.message})`);
                } else if (prevError && prevError !== 0) {
                    log.info(`Printer ${this.printer.name}: print_error cleared (was ${formatErrorCode(prevError)})`);
                }
            }
        }
        if (print.sdcard !== undefined) update.sdcard = print.sdcard;
        if (print.print_type !== undefined) update.print_type = print.print_type;
        if (print.gcode_state !== undefined) update.gcode_state = print.gcode_state;
        if (print.subtask_name !== undefined) update.subtask_name = print.subtask_name;
        if (print.gcode_file !== undefined) update.gcode_file = print.gcode_file;

        // Merge into existing status (preserve fields from prior reports)
        this.latestStatus = { ...this.latestStatus, ...update, last_update: new Date().toISOString() };

        const newState = this.latestStatus.state;
        if (newState && newState !== this.state) {
            this._transitionState(newState);
        }

        PrinterModel.updateStatus(this.printerId, this.latestStatus);
        if (this.onStatusUpdate) this.onStatusUpdate(this.latestStatus);

        // Persist error transitions as a queryable per-printer error log.
        this._logErrorTransitions(priorPrintError, priorHms);

        // Camera/logs/motor-stat driven safety: react to a NEW blocking fault mid-print.
        this._checkForFailures();
    }

    /**
     * Write a durable, queryable error-history entry whenever the printer's
     * print_error or HMS set changes. Fires only on transitions (not every report),
     * so the events table stays bounded. Queryable via GET /events/printer/:id or
     * GET /printers/:id/errors.
     */
    _logErrorTransitions(priorPrintError, priorHms) {
        try {
            const err = this.latestStatus?.print_error || 0;
            if (err && err !== priorPrintError) {
                const decoded = decodePrintError(err);
                EventModel.create({
                    entity_type: 'printer', entity_id: this.printerId,
                    event_type: 'printer.error',
                    payload: {
                        code: err, formatted: decoded?.formatted, message: decoded?.message,
                        severity: decoded?.severity, state: this.state,
                    },
                });
            } else if (!err && priorPrintError) {
                EventModel.create({
                    entity_type: 'printer', entity_id: this.printerId,
                    event_type: 'printer.error_cleared',
                    payload: { previous_code: priorPrintError, formatted: formatErrorCode(priorPrintError) },
                });
            }

            const hms = Array.isArray(this.latestStatus?.hms_errors) ? this.latestStatus.hms_errors : [];
            const keyOf = (h) => `${h?.attr}-${h?.code}`;
            const priorKeys = new Set((priorHms || []).map(keyOf));
            for (const h of hms.filter((x) => !priorKeys.has(keyOf(x)))) {
                const hex = `${(h?.attr ?? 0).toString(16).toUpperCase()}_${(h?.code ?? 0).toString(16).toUpperCase()}`;
                EventModel.create({
                    entity_type: 'printer', entity_id: this.printerId,
                    event_type: 'printer.hms',
                    payload: { attr: h?.attr, code: h?.code, hms: hex, state: this.state },
                });
            }
        } catch { /* error logging must never break status handling */ }
    }

    _autoCancelEnabled() {
        // Default ON: a blocking print_error means the job can't succeed anyway.
        return process.env.AUTO_CANCEL_ON_FAILURE !== 'false';
    }

    /**
     * Detect a new blocking failure during an active print and alert (and, unless
     * disabled, auto-cancel). Fires once per distinct error code; resets when the
     * error clears so a later fault alerts again.
     */
    _checkForFailures() {
        const code = this.latestStatus?.print_error || 0;

        if (!code || !isBlockingError(code)) {
            this._alertedErrorCode = 0;
            return;
        }
        if (this._alertedErrorCode === code) return; // already handled this fault

        // Only auto-act while a print is (or should be) running. Idle stale errors
        // are handled by the health-check auto-clear path, not by cancelling.
        const activePrint = this.state === 'printing' || this.state === 'paused' || !!this.activeJobId;
        if (!activePrint) return;

        this._alertedErrorCode = code;
        const decoded = decodePrintError(code);
        const alert = {
            printer_id: this.printerId,
            printer_name: this.printer.name,
            severity: 'critical',
            kind: 'print_error',
            code,
            formatted: decoded?.formatted,
            message: decoded?.message,
            remediation: decoded?.remediation,
            job_id: this.activeJobId,
            state: this.state,
            at: new Date().toISOString(),
        };

        log.error(`Printer ${this.printer.name}: FAILURE during print — ${decoded?.formatted} (${decoded?.message}); auto_cancel=${this._autoCancelEnabled()}`);
        try {
            EventModel.create({
                entity_type: 'printer', entity_id: this.printerId,
                event_type: 'printer.failure_detected', payload: alert,
            });
        } catch { /* persistence best-effort */ }
        if (this.onAlert) { try { this.onAlert(alert); } catch { /* ignore */ } }

        // Auto-cancel the doomed print (opt out with AUTO_CANCEL_ON_FAILURE=false).
        if (this._autoCancelEnabled() && this.state !== 'idle') {
            try {
                this._stopPrint();
                EventModel.create({
                    entity_type: 'printer', entity_id: this.printerId,
                    event_type: 'printer.auto_canceled',
                    payload: { reason: decoded?.formatted, message: decoded?.message, job_id: this.activeJobId },
                });
                if (this.onAlert) {
                    this.onAlert({ ...alert, kind: 'auto_canceled', message: `Auto-canceled: ${decoded?.message}` });
                }
            } catch (e) {
                log.error(`Auto-cancel failed for ${this.printer.name}: ${e.message}`);
            }
        }
    }

    _mapBambuState(bambuState) {
        const map = {
            'IDLE': 'idle', 'FINISH': 'idle', 'FAILED': 'error',
            'RUNNING': 'printing', 'PAUSE': 'paused', 'PREPARE': 'printing',
        };
        return map[bambuState] || 'unknown';
    }

    _transitionState(newState) {
        if (VALID_TRANSITIONS[this.state]?.includes(newState) || this.state === 'unknown') {
            const oldState = this.state;
            this.state = newState;
            EventModel.create({
                entity_type: 'printer', entity_id: this.printerId,
                event_type: 'printer.state_changed',
                payload: { from: oldState, to: newState },
            });
            log.info(`Printer ${this.printer.name}: ${oldState} → ${newState}`);
        }
    }

    /** Simulate a print (mock mode only). */
    _simulatePrint(params) {
        let progress = 0;
        const interval = setInterval(() => {
            if (this.state !== 'printing') { clearInterval(interval); return; }
            progress += 10;
            this.latestStatus.progress = Math.min(progress, 100);
            this.latestStatus.bed_temp = 60;
            this.latestStatus.nozzle_temp = 210;
            PrinterModel.updateStatus(this.printerId, this.latestStatus);
            if (this.onStatusUpdate) this.onStatusUpdate(this.latestStatus);
            if (progress >= 100) {
                clearInterval(interval);
                this._transitionState('idle');
                this.latestStatus.state = 'idle';
                this.latestStatus.bed_temp = 60; // Start cooling
                PrinterModel.updateStatus(this.printerId, this.latestStatus);
            }
        }, 3000); // updates every 3s, finishes in 30s
    }

    async healthCheck() {
        if (this.mockMode) {
            this.connected = true;
            return;
        }
        const live = !!(this.mqttClient && this.mqttClient.connected);

        if (!this.mqttClient) {
            // No transport at all (e.g. started before auth was configured, or a
            // previous connect threw). Self-heal by re-attempting on a backoff
            // instead of staying offline forever. A client that merely dropped is
            // left to the mqtt library's own auto-reconnect (don't recreate it).
            await this._attemptReconnect();
        } else if (live) {
            // Connected at the socket level — detect a hung printer (socket open
            // but no fresh status reports) and nudge it with a status request.
            const age = this.lastReportTime ? Date.now() - this.lastReportTime : Infinity;
            if (age > this.staleReportMs) {
                if (!this._staleNudged) {
                    log.warn(`Printer ${this.printer.name}: no status for ${Math.round(age / 1000)}s — requesting refresh`);
                    this._staleNudged = true;
                }
                this.requestStatusRefresh();
            } else {
                this._staleNudged = false;
            }
        }

        if (!live && this.connected !== false) {
            // Just went offline — update state and notify the UI so the dashboard
            // reflects the disconnection without waiting for a manual refresh.
            this.connected = false;
            this._transitionState('offline');
            this.latestStatus = { ...this.latestStatus, state: 'offline' };
            if (this.onStatusUpdate) this.onStatusUpdate(this.latestStatus);
        }
    }

    /**
     * Self-healing (re)connect for a worker with no live MQTT transport, throttled
     * with exponential backoff (5s → 80s). Only recreates when there is no client;
     * a disconnected-but-present client is handled by the mqtt library.
     */
    async _attemptReconnect() {
        const now = Date.now();
        const backoff = Math.min(80000, 5000 * 2 ** Math.min(this._reconnectAttempts, 4));
        if (this._lastReconnectAt && (now - this._lastReconnectAt) < backoff) return;
        this._lastReconnectAt = now;

        const authData = PrinterModel.getAuth(this.printerId);
        if (!authData) return; // still unconfigured — nothing to connect with

        this._reconnectAttempts += 1;
        try {
            log.info(`Self-heal: (re)connecting ${this.printer.name} (attempt ${this._reconnectAttempts})`);
            this.mqttClient = new BambuMqttClient(this.printer, authData);
            this.mqttClient.onStatus((data) => this._handleStatus(data));
            await this.mqttClient.connect();
            this._reconnectAttempts = 0; // success resets the backoff
        } catch (err) {
            log.warn(`Self-heal reconnect failed for ${this.printer.name}: ${err.message}`);
            this.mqttClient = null; // drop the half-built client so we retry cleanly
        }
    }

    /**
     * Request a fresh printer status report.
     */
    requestStatusRefresh() {
        if (this.mockMode) {
            this.latestStatus = { ...this.latestStatus, state: this.state, last_update: new Date().toISOString() };
            if (this.onStatusUpdate) this.onStatusUpdate(this.latestStatus);
            return true;
        }
        return this.mqttClient?.requestStatus?.() || false;
    }
}

export default PrinterWorker;
