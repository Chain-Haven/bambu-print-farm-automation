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
        // Seed from the persisted snapshot so a restart doesn't re-log already-known
        // HMS/print_error state as brand-new error events (phantom spam).
        this.latestStatus = (printer.status_snapshot && typeof printer.status_snapshot === 'object')
            ? { ...printer.status_snapshot }
            : {};
        this.onStatusUpdate = null; // callback
        this.onAlert = null; // callback(alert) — fired on detected failures (set by supervisor)
        this.onJobFinished = null; // callback({ job_id, printer_id, outcome }) — fired when the active job's print ends (set by supervisor)
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
            else if (this.state === 'paused') {
                // A paused print is still ACTIVE — starting (or clear+home
                // "recovery") on top of it would wreck the print on the bed.
                errors.push('Printer has a paused print — resume or stop it first');
            }
            else if (this.state === 'error') {
                // Bambu keeps gcode_state=FAILED after a canceled/failed print
                // until the on-screen dialog is dismissed — but the firmware
                // accepts a new print from that state (Bambu Studio does this).
                // With no ACTIVE error code it is startable; a human tap must
                // never be required on a farm. Active error = still blocked.
                if (printError && printError !== 0) errors.push('Printer is in error state');
                else warnings.push('Printer shows a dismissed/failed-print screen (no active error) — starting anyway, like Bambu Studio');
            }
            else if (this.state === 'offline') errors.push('Printer is offline');
            else warnings.push(`Printer state is "${this.state}" (expected idle)`);
        }

        // Check HMS errors (SD-related). h.attr/h.code arrive as NUMBERS from
        // the firmware — coerce before string ops (a numeric code crashed the
        // whole preflight/start pipeline). attr hex needs zero-padding or the
        // module prefix check silently never matches (0x0500xxxx → "500xxxx").
        // Storage module is 0500 (cf. the classic 0500-C010 SD error); 0300
        // is motion/mechanical and must NOT be flagged as an SD fault.
        const hms = this.latestStatus?.hms_errors;
        if (hms && Array.isArray(hms) && hms.length > 0) {
            for (const h of hms) {
                const code = (h.attr ?? 0).toString(16).padStart(8, '0');
                const msg = String(h.code ?? '');
                if (code.startsWith('0500') || /sd|storage|micro/i.test(msg)) {
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

    /**
     * Full error recovery — the software equivalent of tapping OK/Retry on
     * the printer screen. Dismisses the error dialog (clean_print_error);
     * if the firmware re-asserts a homing failure (A1 holds 0300-40xx until
     * a home actually SUCCEEDS — dismissing does nothing, verified on
     * hardware 2026-07-08), re-homes and waits for the error to drop.
     * Returns { recovered, steps, preflight }.
     */
    async recoverFromError({ homeWaitMs = 35000 } = {}) {
        const steps = [];
        const waitFor = async (pred, ms, pollMs = 1500) => {
            const until = Date.now() + ms;
            while (Date.now() < until) {
                if (pred()) return true;
                await new Promise(r => setTimeout(r, pollMs));
            }
            return pred();
        };

        // A PAUSED print holds its error until resumed or stopped — clearing
        // or homing here would move axes over a live print. The right options
        // are the ones on the printer screen: Resume or Stop.
        if (this.state === 'paused' || this.state === 'printing' || this.latestStatus?.gcode_state === 'PAUSE') {
            const preflight = this.getPreflightStatus();
            log.info(`Recovery on ${this.printer.name}: skipped — print is ${this.state} (resume or stop it instead)`);
            return { recovered: false, steps: ['skipped_active_print'], preflight };
        }

        if (this.latestStatus?.print_error && this.mqttClient?.connected) {
            steps.push('clean_print_error');
            this.mqttClient.cleanPrintError();
            setTimeout(() => { if (this.mqttClient) this.mqttClient.requestStatus(); }, 1500);
            await waitFor(() => !this.latestStatus?.print_error, 10000);
        }

        const remaining = this.latestStatus?.print_error;
        if (remaining && this.mqttClient?.connected) {
            const hex = formatErrorCode(remaining);
            // Homing/motion failure family: the retry IS a re-home. If the bed
            // is still obstructed the home fails again and the error stays —
            // recovery reports not-recovered, same as tapping Retry on screen.
            if (hex.startsWith('0300-40')) {
                steps.push('home');
                log.info(`Recovery on ${this.printer.name}: re-homing to clear ${hex}`);
                this.mqttClient.homeAxes('all');
                await waitFor(() => !this.latestStatus?.print_error, homeWaitMs, 2000);
                this.mqttClient.requestStatus();
                await new Promise(r => setTimeout(r, 3000));
            }
        }

        const preflight = this.getPreflightStatus();
        log.info(`Recovery on ${this.printer.name}: steps=[${steps.join(',')}] → ${preflight.ok ? 'RECOVERED (idle)' : 'still blocked: ' + preflight.errors.join('; ')}`);
        return { recovered: preflight.ok, steps, preflight };
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

    /** Whether the printer can currently accept control commands (mock-aware). */
    canControl() {
        return this.mockMode || !!(this.mqttClient && this.mqttClient.connected);
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
            this.latestStatus = { ...this.latestStatus, state: 'printing', gcode_state: 'RUNNING', progress: 0 };
            this._transitionState('printing');
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
            // gcode_state IDLE (not FINISH) so completion detection classifies
            // this as an abort, mirroring a real on-device stop.
            this.latestStatus = { ...this.latestStatus, gcode_state: 'IDLE' };
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
        // Bambu sends ams incrementally — a mid-print push can be just
        // {tray_tar:1}. A shallow replace wiped the tray inventory (and
        // tray_now) from the last full push, losing all live spool data
        // until the next pushall. Merge instead; the `ams.ams` unit array
        // is only replaced when a push actually carries it.
        if (print.ams !== undefined) update.ams = { ...(this.latestStatus?.ams || {}), ...print.ams };
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

        // Bambu keeps gcode_state=FAILED after a canceled/stopped print until
        // the on-screen dialog is dismissed — that's a "last print didn't
        // finish" note, not a fault. With no ACTIVE error code the printer is
        // ready: report it as idle so the UI, failover and queue treat it as
        // available. A real fault (print_error set) still reads as 'error'.
        if (this.latestStatus.gcode_state === 'FAILED' && !(this.latestStatus.print_error > 0)) {
            this.latestStatus.state = 'idle';
        }

        const newState = this.latestStatus.state;
        if (newState && newState !== this.state) {
            this._transitionState(newState);
        }

        // once per printing session: re-adopt a job orphaned by a server
        // restart (_readoptActiveJob sets the one-shot flag itself, and only
        // once it actually had a filename to match against)
        if (this.state === 'printing' && !this.activeJobId && !this._readoptTried) {
            this._readoptActiveJob();
        }
        if (this.state !== 'printing') this._readoptTried = false;

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

            // RECONNECT/BOOT RECONCILIATION: a print that ENDED while the
            // server was offline never fires the completion hook (the
            // transition seen here is offline/unknown → idle, not printing →
            // idle) and its job stays 'printing' forever. Settle those now.
            if ((oldState === 'offline' || oldState === 'unknown') && (newState === 'idle' || newState === 'error')) {
                this._reconcileOrphanedJobs(newState).catch(err => log.error(`Orphan reconcile failed on ${this.printer.name}: ${err.message}`));
            }

            this._maybeFinishActiveJob(oldState, newState);
        }
    }

    /**
     * Settle jobs stranded in 'printing' after the printer ended a print
     * while we were offline. gcode_state FINISH + a matching (or sole)
     * orphan → late completion (bookkeeping only — no ejection, no
     * auto-starts; hours may have passed). Anything else → the outcome is
     * unknown → aborted/failed (retryable). A print still RUNNING on
     * reconnect is handled by _readoptActiveJob, not here.
     */
    async _reconcileOrphanedJobs(newState) {
        const { JobModel } = await import('../models/Job.js');
        // Do NOT exclude the in-memory active job: a print that ENDS while
        // MQTT is down (no restart involved) arrives here as offline→idle
        // with activeJobId still set — _maybeFinishActiveJob never fires for
        // that transition and _readoptActiveJob only covers the post-restart
        // (activeJobId=null) case. Excluding it left the job 'printing'
        // forever.
        const orphans = JobModel.findAll({ status: 'printing', printer_id: this.printerId, limit: 20 });
        if (!orphans.length) return;
        const { JobOrchestrator } = await import('../services/JobOrchestrator.js');
        const gs = this.latestStatus?.gcode_state;
        const subtask = this.latestStatus?.subtask_name || '';
        for (const j of orphans) {
            const base = (j.transformed_file_name || '').replace(/\.gcode\.3mf$/i, '').replace(/\.gcode$/i, '');
            const nameMatches = !!subtask && !!base && subtask === base;
            if (gs === 'FINISH' && (nameMatches || orphans.length === 1)) {
                log.info(`Printer ${this.printer.name}: job "${j.name}" [${j.job_id.slice(0, 8)}] finished while the server was offline — completing it now (bookkeeping only)`);
                await JobOrchestrator.onJobCompleted(j.job_id, this.printerId, { reconcile: true });
            } else {
                log.warn(`Printer ${this.printer.name}: job "${j.name}" [${j.job_id.slice(0, 8)}] was 'printing' but the printer reports ${gs || newState} — outcome unknown, marked failed (retryable)`);
                await JobOrchestrator.onJobAborted(j.job_id, this.printerId, 'ended_while_server_offline');
            }
            if (this.activeJobId === j.job_id) this.activeJobId = null;
        }
    }

    /**
     * RE-ASSOCIATE after a server restart: if this printer is printing and a
     * job record says 'printing' on this printer with a matching gcode file,
     * adopt it as the active job so completion/repeat tracking survives
     * restarts (activeJobId is in-memory only).
     */
    _readoptActiveJob() {
        if (this.activeJobId || this.state !== 'printing') return;
        // gcode_file arrives only in FULL status pushes — after a reconnect the
        // in-memory status may never carry it, so fall back to the snapshot
        // persisted in the DB before the restart.
        let gcodeFile = this.latestStatus?.gcode_file;
        if (!gcodeFile) {
            try { gcodeFile = PrinterModel.findById(this.printerId)?.status_snapshot?.gcode_file; } catch { /* ignore */ }
        }
        if (!gcodeFile) return; // no filename yet — try again on a later report
        this._readoptTried = true;
        import('../models/Job.js').then(({ JobModel }) => {
            const mine = JobModel.findAll({ status: 'printing', printer_id: this.printerId, limit: 10 }).find(j =>
                j.transformed_file_name && gcodeFile === j.transformed_file_name);
            if (mine) {
                this.activeJobId = mine.job_id;
                log.info(`Printer ${this.printer.name}: re-adopted running job "${mine.name}" [${mine.job_id.slice(0, 8)}] after restart`);
            } else {
                log.info(`Printer ${this.printer.name}: printing "${gcodeFile}" but no matching system job — treating as external print`);
            }
        }).catch(() => { /* best effort */ });
    }

    /**
     * Completion detection: when a print we started ends (printing/paused → idle
     * or error), resolve the active job and notify the supervisor. This is the
     * producer for JobOrchestrator.onJobCompleted — without it, ejection,
     * repeat-loops, and auto-start-next never run and jobs stay "printing".
     *
     * Outcomes:
     *  - completed: printer reports FINISH (a real finished print)
     *  - aborted:   printer went idle without FINISH (stopped/canceled on-device)
     *  - failed:    printer entered the error state mid-print
     * An offline transition is NOT terminal — Bambu printers keep printing
     * through an MQTT drop, so the job stays active until a real end state.
     */
    _maybeFinishActiveJob(oldState, newState) {
        if (!this.activeJobId) return;
        if (oldState !== 'printing' && oldState !== 'paused') return;

        let outcome = null;
        if (newState === 'idle') {
            outcome = this.latestStatus?.gcode_state === 'FINISH' ? 'completed' : 'aborted';
        } else if (newState === 'error') {
            outcome = 'failed';
        }
        if (!outcome) return;

        const jobId = this.activeJobId;
        this.activeJobId = null; // clear first so duplicate reports can't double-fire

        log.info(`Printer ${this.printer.name}: active job ${jobId} ${outcome}`);
        EventModel.create({
            entity_type: 'job', entity_id: jobId,
            event_type: 'job.print_finished',
            payload: { printer_id: this.printerId, outcome, gcode_state: this.latestStatus?.gcode_state || null },
        });

        if (this.onJobFinished) {
            Promise.resolve(this.onJobFinished({ job_id: jobId, printer_id: this.printerId, outcome }))
                .catch((err) => log.error(`onJobFinished handler failed for job ${jobId}: ${err.message}`));
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
                // Mark FINISH before transitioning so completion detection sees a
                // real finished print (mirrors the Bambu gcode_state contract).
                this.latestStatus.state = 'idle';
                this.latestStatus.gcode_state = 'FINISH';
                this.latestStatus.bed_temp = 25; // cooled — lets ejection cool-wait pass immediately
                this._transitionState('idle');
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
