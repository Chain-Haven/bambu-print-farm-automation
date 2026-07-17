// src/services/JobOrchestrator.js — Job lifecycle management
import { JobModel } from '../models/Job.js';
import { JobRunModel } from '../models/JobRun.js';
import { GcodeProfileModel } from '../models/GcodeProfile.js';
import { PrinterModel } from '../models/Printer.js';
import { EventModel } from '../models/Event.js';
import { CommandBus } from './CommandBus.js';
import { automate } from '../gcode/Automator.js';
import { automatorModelKey, normalizeModel, modelFromSliceInfoId } from '../models/PrinterModels.js';
import { extractGcodeFrom3mf, repack3mf } from '../gcode/AutomatorZip.js';
import { executeEjectionSequence } from './EjectionService.js';
import { createLogger } from '../utils/logger.js';
import { decodePrintError } from '../utils/PrinterErrors.js';
import { JobRetryService } from './JobRetryService.js';
import systemEvents from '../utils/SystemEvents.js';
import fs from 'node:fs';
import path from 'node:path';
import { getUploadRoot } from '../utils/uploadPaths.js';

const log = createLogger('JobOrchestrator');
const UPLOADS_DIR = getUploadRoot();

/**
 * What printer model was this .gcode.3mf sliced for? Reads printer_model_id
 * from Metadata/slice_info.config and resolves it through the model registry.
 * Returns the registry id ('A1', 'P1S', 'X1C', …) or null when undeclared /
 * unknown (minimal 3MFs have no slice_info — the guard then simply skips).
 */
async function detectFileModel(rawBuffer3mf) {
    if (!rawBuffer3mf) return null;
    try {
        const AdmZip = (await import('adm-zip')).default;
        const si = new AdmZip(rawBuffer3mf).readAsText('Metadata/slice_info.config');
        const m = si?.match(/printer_model_id" value="([^"]+)"/);
        if (!m) return null;
        return modelFromSliceInfoId(m[1])?.id || null;
    } catch { return null; }
}

export class JobOrchestrator {
    static wsBroadcast = null;
    static _activePipelines = new Set(); // pipeline lock: prevents double-trigger

    static setWsBroadcast(fn) {
        this.wsBroadcast = fn;
    }

    static _broadcast(type, payload) {
        if (this.wsBroadcast) {
            this.wsBroadcast({ type, data: payload });
        }
    }

    /**
     * Submit a new job: upload → transform → store → optionally start.
     *
     * transform_mode (only meaningful with a 3MF input):
     *  - 'required' (default): transform failure fails the job.
     *  - 'optional': transform failure falls back to printing the original
     *    artifact untouched (used for cloud/merchant files we didn't slice).
     *  - 'skip': never transform; print the original artifact as-is.
     * auto_start: when a printer is assigned, false leaves the job 'assigned'
     * (queued for that printer) instead of starting it immediately.
     */
    static async submit({ name, printer_id, profile_id, repeat_total, ams_roles, fileContent, fileName, skip_transform = false, transform_overrides = null, rawBuffer3mf = null, originalFileName3mf = null, transform_mode = 'required', auto_start = true, metadata = null }) {
        // Ensure uploads directory exists
        if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

        // Resolve profile
        let profile;
        if (profile_id) {
            profile = GcodeProfileModel.findById(profile_id);
        }
        if (!profile) {
            profile = GcodeProfileModel.findByName('universal');
        }
        if (!profile) {
            // Last resort: any wildcard-model profile (see seed default_profiles.js)
            profile = GcodeProfileModel.findByModel('*')[0] || null;
        }
        if (!profile) {
            throw new Error('No G-code transform profile found');
        }

        // Create job record
        const job = JobModel.create({
            name, printer_id, profile_id: profile.profile_id,
            source_file_name: fileName, ams_roles, repeat_total: repeat_total || 1,
            metadata,
        });

        log.info(`Job created: ${job.name} [${job.job_id}]`);

        try {
            // Save original file
            const sourcePath = path.join(UPLOADS_DIR, `${job.job_id}_${fileName}`);
            fs.writeFileSync(sourcePath, fileContent);

            // What printer model was this FILE sliced for? Drives the
            // transform dialect and the start-time file↔printer guard.
            const fileModel = await detectFileModel(rawBuffer3mf);
            if (fileModel) log.info(`File declares printer model: ${fileModel}`);

            if (skip_transform) {
                // === RAW MODE: Skip transform, use file as-is ===
                const rawFileName = fileName.replace(/\.gcode$/i, '.AG.gcode');
                const rawPath = path.join(UPLOADS_DIR, `${job.job_id}_${rawFileName}`);
                fs.writeFileSync(rawPath, fileContent);

                JobModel.update(job.job_id, {
                    transformed_file_name: rawFileName,
                    transform_report: { skipped: true, reason: 'User requested raw upload', file_model: fileModel, allow_model_mismatch: transform_overrides?.allow_model_mismatch },
                    diff_summary: { sections_changed: [], raw_mode: true },
                    status: printer_id ? 'assigned' : 'queued',
                });

                EventModel.create({
                    entity_type: 'job', entity_id: job.job_id,
                    event_type: 'job.submitted',
                    payload: { raw_mode: true },
                });

                log.info(`Job submitted (raw mode, no transform): ${rawFileName}`);
            } else {
                // === TRANSFORM MODE (Automator v3) ===
                // Enforce safety limits (prevents Z=2 bug from old profiles/cache)
                // USER REQUEST: Do not clamp. Trust user input.
                // The UI bug in app.js that sent bad values is fixed.

                // Build automator config from profile + overrides
                // NOTE: loopsN (in-file looping) and repeat_total (job-level restarts) are
                // INDEPENDENT mechanisms. loopsN must NOT fall back to repeat_total, or the
                // two would multiply (loopsN × repeat_total copies). Loop count comes only
                // from an explicit override or the profile, defaulting to 1.
                // Resolve the model through the canonical registry so DB names
                // like "Bambu X1C" map to their real Automator geometry key
                // ("X1") instead of silently falling back to P1S. A wildcard
                // profile ('*') defers to the assigned printer's model.
                // Precedence: explicit override > the FILE's own declared
                // model (slice_info printer_model_id — the purge anchors and
                // eject dialect are properties of the FILE, so this beats
                // profile/printer guesses) > profile > assigned printer.
                const printerRow = printer_id ? PrinterModel.findById(printer_id) : null;
                const rawModel = transform_overrides?.printer_model
                    || fileModel
                    || (profile.printer_model && profile.printer_model !== '*' ? profile.printer_model : null)
                    || printerRow?.model
                    || 'P1S';
                const automatorConfig = {
                    printerModel: automatorModelKey(rawModel),
                    loopsN: transform_overrides?.n_loops || profile.n_loops || 1,
                    // Cooldown mode: 'temperature' (cool-to-temp) or 'time' (fixed dwell).
                    // Exactly one runs — never both.
                    cooldownMode: transform_overrides?.cooldown_mode || profile.cooldown_mode || 'temperature',
                    releaseTempC: transform_overrides?.release_temp_c || profile.release_bed_temp_c || 27,
                    maxWaitMin: transform_overrides?.max_wait_min || profile.max_cool_wait_minutes || 60,
                    coolTimeMin: transform_overrides?.cool_time_min || profile.cool_time_minutes || null,
                    sweepZMm: transform_overrides?.sweep_z_mm ?? 4,
                    zClearTravelMm: transform_overrides?.z_clear_travel_mm || profile.z_clear_travel_mm || 200,
                };

                // Guard: if both multipliers are >1 the printer would run
                // loopsN × repeat_total copies — almost always unintended.
                const jobRepeats = repeat_total || 1;
                let doubleLoopWarning = null;
                if (automatorConfig.loopsN > 1 && jobRepeats > 1) {
                    doubleLoopWarning = `Double-loop guard: n_loops=${automatorConfig.loopsN} AND repeat_total=${jobRepeats} → ${automatorConfig.loopsN * jobRepeats} total prints. Verify this is intended.`;
                    log.warn(`[${job.job_id}] ${doubleLoopWarning}`);
                }


                // LOG EVERYTHING for debugging
                log.info(`=== AUTOMATOR CONFIG (diagnostic) ===`);
                log.info(`  raw overrides: ${JSON.stringify(transform_overrides)}`);
                log.info(`  resolved config: ${JSON.stringify(automatorConfig)}`);
                log.info(`  profile.n_loops=${profile.n_loops}, repeat_total=${repeat_total}`);
                log.info(`=====================================`);

                // Determine gcode text to transform
                let gcodeText = fileContent;
                let gcodeEntryName = null;

                // If input is 3MF, extract the gcode first
                if (rawBuffer3mf) {
                    const extracted = extractGcodeFrom3mf(rawBuffer3mf);
                    gcodeText = extracted.gcodeText;
                    gcodeEntryName = extracted.gcodeEntryName;
                    log.info(`Extracted gcode from 3MF: ${gcodeEntryName}`);
                }

                // Run the automator. In 'optional' mode (cloud/merchant files we
                // didn't slice) a transform failure falls back to printing the
                // original artifact untouched instead of failing the job.
                let transformedGcode = null;
                let report = null;
                let transformError = null;
                if (transform_mode !== 'skip') {
                    try {
                        ({ output: transformedGcode, report } = automate(gcodeText, automatorConfig));
                    } catch (transformErr) {
                        if (transform_mode !== 'optional' || !rawBuffer3mf) throw transformErr;
                        transformError = transformErr.message;
                        log.warn(`Transform failed for ${job.job_id}, falling back to original artifact: ${transformError}`);
                    }
                }

                if (transformedGcode === null) {
                    // 'skip' mode or optional-transform fallback: keep the original
                    // 3MF artifact as the printable file.
                    if (!rawBuffer3mf) throw new Error('transform_mode skip/fallback requires a .gcode.3mf input');
                    const passthroughName = originalFileName3mf || fileName;
                    fs.writeFileSync(path.join(UPLOADS_DIR, `${job.job_id}_${passthroughName}`), rawBuffer3mf);
                    JobModel.update(job.job_id, {
                        transformed_file_name: passthroughName,
                        transform_report: {
                            skipped: true,
                            mode: transform_mode,
                            transform_error: transformError,
                            gcode_entry_name: gcodeEntryName,
                            file_model: fileModel,
                            allow_model_mismatch: transform_overrides?.allow_model_mismatch,
                        },
                        diff_summary: { raw_mode: true },
                        status: printer_id ? 'assigned' : 'queued',
                    });
                    EventModel.create({
                        entity_type: 'job', entity_id: job.job_id,
                        event_type: 'job.submitted',
                        payload: { raw_mode: true, transform_mode, transform_error: transformError },
                    });
                    log.info(`Job submitted (original artifact, no transform): ${passthroughName}`);
                    this._broadcast('job.created', JobModel.findById(job.job_id));
                    if (printer_id && auto_start) {
                        await this.startJob(job.job_id);
                    }
                    return JobModel.findById(job.job_id);
                }

                if (doubleLoopWarning) report.warnings.push(doubleLoopWarning);

                // Save plain .gcode for debugging
                const debugGcodeFileName = fileName.replace(/\.gcode(\.3mf)?$/i, '.AG.gcode');
                const debugGcodePath = path.join(UPLOADS_DIR, `${job.job_id}_${debugGcodeFileName}`);
                fs.writeFileSync(debugGcodePath, transformedGcode, 'utf-8');
                log.info(`Saved debug .gcode: ${debugGcodeFileName}`);

                const filesWritten = [debugGcodeFileName];
                let primaryFileName = debugGcodeFileName;

                // Repack 3MF if input was 3MF
                if (rawBuffer3mf && originalFileName3mf && gcodeEntryName) {
                    try {
                        const repacked = repack3mf(rawBuffer3mf, gcodeEntryName, transformedGcode);
                        const threemfFileName = originalFileName3mf.replace(/\.gcode\.3mf$/i, '.AG.gcode.3mf');
                        const threemfPath = path.join(UPLOADS_DIR, `${job.job_id}_${threemfFileName}`);
                        fs.writeFileSync(threemfPath, repacked);
                        primaryFileName = threemfFileName;
                        filesWritten.push(threemfFileName);
                        log.info(`Saved repacked .3mf: ${threemfFileName}`);
                    } catch (repackErr) {
                        log.warn(`3MF repack failed (plain .gcode still available): ${repackErr.message}`);
                        report.warnings.push(`3MF repack failed: ${repackErr.message}`);
                    }
                }

                // Update job with transform results
                // Store the gcode entry name so startPrint knows which plate to reference
                JobModel.update(job.job_id, {
                    transformed_file_name: primaryFileName,
                    // flow_cali: explicit override only — startJob defaults the
                    // firmware's flow calibration OFF (see startPrint).
                    transform_report: { ...report, files_written: filesWritten, gcode_entry_name: gcodeEntryName, flow_cali: transform_overrides?.flow_cali, file_model: fileModel, allow_model_mismatch: transform_overrides?.allow_model_mismatch },
                    diff_summary: { automator_v3: true, loops: automatorConfig.loopsN },
                    status: printer_id ? 'assigned' : 'queued',
                });

                EventModel.create({
                    entity_type: 'job', entity_id: job.job_id,
                    event_type: 'job.submitted',
                    payload: {
                        purge_removal: report.purgeRemoval?.method,
                        insertion_point: report.insertionPoint?.method,
                        warnings: report.warnings,
                        overrides_applied: !!transform_overrides,
                        files_written: filesWritten,
                    },
                });

                log.info(`Job transformed: ${primaryFileName} (${report.transformTimeMs}ms)`);
                this._broadcast('job.created', job);
            }

            // Auto-start if printer assigned
            if (printer_id && auto_start) {
                await this.startJob(job.job_id);
            }

            return JobModel.findById(job.job_id);
        } catch (err) {
            // Transform failed — mark job as failed
            JobModel.update(job.job_id, { status: 'failed' });
            EventModel.create({
                entity_type: 'job', entity_id: job.job_id,
                event_type: 'job.transform_failed',
                payload: { error: err.message },
            });
            this._broadcast('job.transform_failed', { job_id: job.job_id, error: err.message });
            throw err;
        }
    }

    /**
     * Start a job: deterministic pipeline — Preflight → Upload → Start → Monitor.
     * Fully instrumented with monotonic ms timing for every stage.
     */
    static async startJob(jobId, _opts = {}) {
        const failoverDepth = _opts.failoverDepth || 0;
        // Errors local to the assigned PRINTER (storage fault, unreachable,
        // refuses to start…) are eligible for automatic failover to another
        // idle printer of the same model — config/file errors are not.
        const printerLocalError = (msg) => { const e = new Error(msg); e.printerLocal = true; return e; };
        const { performance } = await import('node:perf_hooks');
        const t0 = performance.now();
        const debugTrace = [];
        const stage = (name, detail = null) => {
            const elapsed = Math.round(performance.now() - t0);
            const entry = { stage: name, elapsed_ms: elapsed, detail, ts: new Date().toISOString() };
            debugTrace.push(entry);
            log.info(`[SEND:${jobId.slice(0, 8)}] [+${elapsed}ms] ${name}${detail ? ' — ' + (typeof detail === 'object' ? JSON.stringify(detail) : detail) : ''}`);
            // Broadcast each stage for live debug trace UI
            this._broadcast('job.debug_trace', { job_id: jobId, ...entry });
        };

        stage('SEND_CLICK_RECEIVED');

        // ========== PIPELINE LOCK ==========
        const lockKey = `${jobId}`;
        if (this._activePipelines.has(lockKey)) {
            stage('DUPLICATE_PIPELINE_BLOCKED', { lockKey });
            throw new Error('Pipeline already running for this job');
        }
        this._activePipelines.add(lockKey);
        stage('PIPELINE_LOCK_ACQUIRED', { lockKey });

        const releaseLock = () => this._activePipelines.delete(lockKey);

        const job = JobModel.findById(jobId);
        if (!job) { releaseLock(); throw new Error('Job not found'); }
        if (!job.printer_id) { releaseLock(); throw new Error('Job not assigned to a printer'); }
        // 'failed' is allowed so a job stranded by a printer fault can be
        // retried (or failed over) — the pipeline re-runs from preflight.
        if (!['queued', 'assigned', 'failed'].includes(job.status)) {
            releaseLock();
            throw new Error(`Cannot start job: status is ${job.status}`);
        }

        const printer = PrinterModel.findById(job.printer_id);
        if (!printer) throw new Error('Assigned printer not found');

        stage('JOB_LOADED', { name: job.name, printer: printer.name, printer_ip: printer.ip_hostname, transformed_file: job.transformed_file_name });

        const sendTrace = { phases: [], started_at: new Date().toISOString() };
        const broadcastPhase = (phase, status, detail = null) => {
            sendTrace.phases.push({ phase, status, detail, timestamp: new Date().toISOString() });
            this._broadcast('job.send_phase', { job_id: jobId, printer_id: job.printer_id, phase, status, detail });
        };

        try {
            // ========== PHASE 1: PREFLIGHT ==========
            stage('PREFLIGHT_START');
            const { RuntimeSupervisor } = await import('../runtime/RuntimeSupervisor.js');
            const worker = RuntimeSupervisor.getInstance()?.getWorker(job.printer_id);
            if (!worker) {
                stage('PREFLIGHT_FAIL', 'No printer worker');
                broadcastPhase('preflight', 'failed', 'No printer worker found.');
                throw new Error('Preflight failed: No printer worker');
            }

            let preflight = worker.getPreflightStatus();
            if (!preflight.ok) {
                // SELF-HEAL: a canceled/failed print leaves gcode_state=FAILED
                // plus a residual print_error, which reads as 'error' state and
                // would block every start until a human taps OK on the screen.
                // Bambu Studio dismisses it with clean_print_error — do the
                // same when the ONLY blockers are that standing error pair,
                // then re-check. A real fault persists and still blocks below.
                const residueOnly = preflight.errors.length > 0 && preflight.errors.every(e =>
                    e.startsWith('BLOCKED:') || e === 'Printer is in error state');
                if (residueOnly && worker.latestStatus?.print_error && worker.mqttClient?.connected) {
                    const decoded = decodePrintError(worker.latestStatus.print_error);
                    stage('STANDING_PRINT_ERROR_AUTOCLEAR', { error: decoded?.formatted });
                    // Dismiss + re-home for homing failures (a print homes first
                    // anyway; an obstructed bed fails the home and still blocks)
                    const recovery = await worker.recoverFromError();
                    stage(recovery.recovered ? 'STANDING_PRINT_ERROR_RECOVERED' : 'STANDING_PRINT_ERROR_PERSISTS_AFTER_RECOVERY', { steps: recovery.steps });
                    preflight = recovery.preflight;
                }
            }
            if (!preflight.ok) {
                const errMsg = preflight.errors.join('; ');
                stage('PREFLIGHT_FAIL', errMsg);
                broadcastPhase('preflight', 'failed', errMsg);
                throw new Error(`Preflight failed: ${errMsg}`);
            }
            stage('PREFLIGHT_OK', { state: preflight.state, nozzle: preflight.nozzle_temp, bed: preflight.bed_temp, warnings: preflight.warnings });
            broadcastPhase('preflight', 'ok', { state: preflight.state, nozzle_temp: preflight.nozzle_temp, bed_temp: preflight.bed_temp, warnings: preflight.warnings });

            // ========== PHASE 1.5: STANDING PRINTER ERROR ==========
            // A blocking print_error that exists BEFORE we start (e.g. 0500-C010
            // MicroSD fault) means the print can never begin — the old flow
            // uploaded anyway and burned the full 60s ACK timeout. Clear it,
            // give the printer a moment, and fail fast if it comes back.
            if (!worker.mockMode) {
                let standing = worker.latestStatus?.print_error;
                if (standing && standing !== 0) {
                    const decoded = decodePrintError(standing);
                    stage('STANDING_PRINT_ERROR', { error: decoded.formatted, message: decoded.message });
                    if (worker.mqttClient) {
                        worker.mqttClient.cleanPrintError();
                        await new Promise(r => setTimeout(r, 8000));
                        standing = worker.latestStatus?.print_error;
                    }
                    if (standing && standing !== 0) {
                        const still = decodePrintError(standing);
                        stage('STANDING_PRINT_ERROR_PERSISTS', { error: still.formatted });
                        broadcastPhase('preflight', 'failed', `Printer has a standing error: ${still.message} [${still.formatted}]`);
                        throw printerLocalError(`Preflight failed: printer reports ${still.message} [${still.formatted}]. ` +
                            `${(still.remediation || []).slice(0, 2).join('; ')}`);
                    }
                    stage('STANDING_PRINT_ERROR_CLEARED');
                }
            }

            // ========== PHASE 2: FILE READ ==========
            stage('FILE_READ_START');
            const auth = worker.mockMode ? { access_code: 'mock' } : PrinterModel.getAuth(job.printer_id);
            if (!auth?.access_code) { stage('FILE_READ_FAIL', 'No access code'); throw new Error('Upload failed: No access code'); }

            const filePath = path.join(UPLOADS_DIR, `${job.job_id}_${job.transformed_file_name}`);
            if (!fs.existsSync(filePath)) { stage('FILE_READ_FAIL', 'File not found'); throw new Error('Upload failed: File not found'); }

            const fileBuffer = fs.readFileSync(filePath);
            stage('FILE_READ_OK', { bytes: fileBuffer.length, path: filePath });

            // ========== ARTIFACT VALIDATION ==========
            const remoteFileName = job.transformed_file_name;
            const is3mfArtifact = remoteFileName.toLowerCase().endsWith('.3mf');
            const gcodeEntry = job.transform_report?.gcode_entry_name;

            if (!is3mfArtifact) {
                stage('INVALID_PRINT_ARTIFACT_TYPE', { file: remoteFileName, expected: '.gcode.3mf', got: path.extname(remoteFileName) });
                releaseLock();
                broadcastPhase('start', 'failed', `Invalid artifact: Bambu requires .gcode.3mf, got ${remoteFileName}`);
                throw new Error(`Invalid artifact type: Bambu printers require a .gcode.3mf package, not raw ${path.extname(remoteFileName)}. The file "${remoteFileName}" cannot be started via project_file.`);
            }

            if (!gcodeEntry) {
                stage('GCODE_ENTRY_MISSING', { file: remoteFileName });
                releaseLock();
                broadcastPhase('start', 'failed', 'No gcode_entry resolved in transform report');
                throw new Error('Cannot start: gcode_entry is null — transform did not record the plate gcode path. This usually means the input was not a valid .gcode.3mf or 3MF repack failed.');
            }

            let plateNumber = 1;
            const plateMatch = gcodeEntry.match(/plate_(\d+)/i);
            if (plateMatch) plateNumber = parseInt(plateMatch[1], 10);

            stage('ARTIFACT_VALIDATION_OK', { type: '.gcode.3mf', gcode_entry: gcodeEntry, plate: plateNumber, remote_file: remoteFileName });

            // ========== FILE ↔ PRINTER MODEL GUARD ==========
            // A file sliced for one machine printed on another (P1S gcode on
            // an A1, three real incidents) produces garbage lines at best and
            // crashes at worst. Refuse outright — a mismatch is never what a
            // farm wants. Compared at the Automator-geometry level (P1P ≡ P1S);
            // unknown models skip the guard. Override:
            // transform_overrides.allow_model_mismatch.
            {
                const fileModelRec = normalizeModel(job.transform_report?.file_model);
                const printerModelRec = normalizeModel(printer.model);
                if (fileModelRec && printerModelRec
                    && automatorModelKey(fileModelRec.id) !== automatorModelKey(printerModelRec.id)
                    && job.transform_report?.allow_model_mismatch !== true) {
                    stage('FILE_PRINTER_MODEL_MISMATCH', { file_model: fileModelRec.short, printer_model: printerModelRec.short });
                    const msg = `This file is sliced for a ${fileModelRec.short} but "${printer.name}" is a ${printerModelRec.short}. Wrong-machine gcode prints badly or fails. Re-slice the model for ${printerModelRec.short}, or assign a ${fileModelRec.short} printer.`;
                    broadcastPhase('preflight', 'failed', msg);
                    releaseLock();
                    const guardErr = new Error(`Start refused: ${msg}`);
                    guardErr.status = 409; // surfaces the real message to the UI instead of a generic 500
                    throw guardErr;
                }
                if (fileModelRec && printerModelRec) stage('FILE_PRINTER_MODEL_OK', { model: fileModelRec.short });
            }

            // ========== PHASE 3+4+5: FTPS REACHABILITY / UPLOAD / RESOLUTION ==========
            if (worker.mockMode) {
                // MOCK_MODE: no real printer — skip the network phases so the full
                // job pipeline (transform → start → simulated print → completion →
                // ejection → repeat/next) can be exercised end-to-end.
                stage('UPLOAD_SKIPPED_MOCK', { bytes: fileBuffer.length });
                broadcastPhase('upload', 'ok', { mock: true, bytes: fileBuffer.length, filename: remoteFileName });
            } else {
                stage('FTPS_REACHABILITY_START');
                const { BambuFtpsClient } = await import('./BambuFtpsClient.js');
                const ftpsClient = new BambuFtpsClient({ ip: printer.ip_hostname, accessCode: auth.access_code, printerId: job.printer_id });
                const ftpsReachable = await ftpsClient.isReachable();
                stage(ftpsReachable ? 'FTPS_REACHABILITY_OK' : 'FTPS_REACHABILITY_FAIL');
                if (!ftpsReachable) {
                    broadcastPhase('upload', 'failed', 'FTPS port 990 not reachable.');
                    throw printerLocalError('Upload failed: FTPS not reachable');
                }

                // ========== PHASE 4: FTPS UPLOAD (delegated, returns its own trace) ==========
                stage('UPLOAD_DELEGATED_TO_FTPS_CLIENT');
                broadcastPhase('upload', 'running');

                const uploadResult = await ftpsClient.upload(fileBuffer, remoteFileName, (progress) => {
                    this._broadcast('job.upload_progress', {
                        job_id: jobId, printer_id: job.printer_id,
                        bytes: progress.bytes, total: progress.total, percent: progress.percent,
                    });
                });

                // Merge FTPS client's detailed trace into ours
                if (uploadResult.trace) {
                    for (const t of uploadResult.trace) {
                        // FTPS trace timings are relative to the upload's own start; tag the source
                        // so the debug panel can distinguish them from orchestrator-timeline stages.
                        debugTrace.push({ ...t, source: 'ftps_client' });
                        this._broadcast('job.debug_trace', { job_id: jobId, ...t, source: 'ftps_client' });
                    }
                }

                if (!uploadResult.success) {
                    stage('UPLOAD_FAILED', uploadResult.error);
                    broadcastPhase('upload', 'failed', uploadResult.error);

                    // MicroSD error detection
                    const errLower = (uploadResult.error || '').toLowerCase();
                    if (errLower.includes('microsd') || errLower.includes('read/write') || errLower.includes('storage') || errLower.includes('sd card')) {
                        stage('PRINTER_ERROR_DETECTED', { type: 'SD_STORAGE', raw: uploadResult.error });
                    }
                    throw printerLocalError(`Upload failed: ${uploadResult.error}`);
                }

                stage('UPLOAD_COMPLETE', { bytes: uploadResult.bytesUploaded, verified: uploadResult.verified });
                broadcastPhase('upload', 'ok', { bytes: uploadResult.bytesUploaded, verified: uploadResult.verified, filename: remoteFileName });

                // ========== PHASE 5: REMOTE FILE RESOLUTION ==========
                try {
                    const cacheFiles = await ftpsClient.listCacheFiles();
                    const remoteExists = cacheFiles.some(f => f.toLowerCase() === remoteFileName.toLowerCase());
                    if (remoteExists) {
                        stage('REMOTE_FILE_RESOLVED', { remote_path: `/cache/${remoteFileName}`, found_in_listing: true });
                    } else {
                        stage('REMOTE_FILE_RESOLUTION_FAILED', { remote_file: remoteFileName, cache_files: cacheFiles.slice(0, 10) });
                        log.warn(`Remote file not found in /cache/ listing. Expected: ${remoteFileName}. Found: ${cacheFiles.join(', ')}`);
                        // Don't hard-fail — SIZE verification already passed, LIST may not always work
                    }
                } catch (listErr) {
                    stage('REMOTE_FILE_LIST_SKIPPED', { error: listErr.message });
                }
            }

            // ========== PHASE 6: START PRINT ==========
            stage('START_PRINT_REQUESTED');
            broadcastPhase('start', 'running');

            const run = JobRunModel.create({ job_id: jobId, printer_id: job.printer_id });

            if (!worker.mockMode && !worker.mqttClient) {
                stage('START_PRINT_FAIL', 'MQTT not available');
                broadcastPhase('start', 'failed', 'MQTT client not available');
                releaseLock();
                throw new Error('Start failed: MQTT client not available');
            }

            // AMS mapping — two modes (set at submit time by the slicer UI):
            //   auto:   job stores the PRINT COLORS; resolve them against the
            //           printer's CURRENT AMS inventory right now (start time),
            //           so spool swaps between queue and start are respected.
            //   manual: job stores an explicit slot_map (filament -> tray).
            // The gcode is never edited — the printer's firmware applies
            // ams_mapping from the start command to the file's filament indices.
            // Re-read ams_roles from the DB NOW, not from the pipeline's
            // snapshot: the upload takes ~15s and the operator may change the
            // tray pick during it — the fresh value must win.
            const amsRoles = JobModel.findById(jobId)?.ams_roles ?? job.ams_roles;
            let amsMapping = [];
            if (amsRoles?.mode === 'auto' && Array.isArray(amsRoles.colors) && amsRoles.colors.length) {
                const { AmsService } = await import('./AmsService.js');
                const amsStatus = AmsService.getFullStatus(job.printer_id);
                const resolved = AmsService.matchColorsToTrays(amsRoles.colors, amsStatus.slots, 120, amsRoles.material || null);
                if (!resolved.ok) {
                    stage('AMS_AUTO_MAP_FAILED', { reason: resolved.error, colors: amsRoles.colors });
                    broadcastPhase('start', 'failed', resolved.error);
                    releaseLock();
                    // printer-local: another printer may have the right spools loaded
                    throw printerLocalError(`AMS auto-mapping failed: ${resolved.error}`);
                }
                amsMapping = resolved.mapping;
                stage('AMS_AUTO_MAPPED', { mapping: resolved.details });
            } else if (amsRoles?.slot_map) {
                amsMapping = Object.values(amsRoles.slot_map);
                stage('AMS_MANUAL_MAPPING', { slot_map: amsRoles.slot_map, mapping: amsMapping });
            }

            // A job with NO ams config on a printer that HAS an AMS must still
            // use it — use_ams:false makes the printer try the EXTERNAL spool
            // holder and hang at the pre-print stage with an AMS error
            // (07FF-C006, nozzle parked hot, progress 0 — seen on hardware).
            // Default to the first tray and say so loudly.
            const hasAms = !!(worker.latestStatus?.ams?.ams?.length);
            if (!amsMapping.length && hasAms) {
                amsMapping = [0];
                stage('AMS_DEFAULTED_FIRST_TRAY', { reason: 'job has no ams_roles but printer has an AMS — using tray 1. Set the tray mapping on the job to control this.' });
            }

            // Flow (dynamic extrusion) calibration: DEFAULT OFF — Bambu bakes
            // the saved K-factor into sliced gcode, and the firmware's start-of-
            // print recalibration extrudes test filament ("nozzle in the air,
            // filament falling"). Opt in per job via transform_overrides.flow_cali.
            const flowCali = job.transform_report?.flow_cali === true;
            stage('FLOW_CALI_DECISION', { flow_cali: flowCali });

            // Build validated start payload
            const startPayload = {
                filename: remoteFileName,
                plateNumber,
                useAms: amsMapping.length > 0,
                amsMapping,
                flowCali,
            };

            // Final payload validation
            if (!startPayload.filename.endsWith('.3mf')) {
                stage('REMOTE_START_PAYLOAD_INVALID', { reason: 'filename not .3mf', payload: startPayload });
                releaseLock();
                throw new Error('Start payload invalid: filename must be .3mf');
            }

            stage('START_PAYLOAD_VALIDATED', { filename: startPayload.filename, plate: startPayload.plateNumber, ams: startPayload.useAms });

            // Wait for printer state transition (ACK)
            // PRIORITY: state change (idle → printing) = definitive success signal.
            // print_error codes may appear transiently during file loading — don't block on them.
            // Only fail if printer stays idle for the full timeout AND has a new error.
            const ackTimeout = 60000; // large looped files can take longer to load from storage
            const waitForAck = () => new Promise((resolve) => {
                const start = Date.now();
                let lastSeenError = null;
                const check = setInterval(() => {
                    // PRIMARY CHECK: did the printer start? Must be a POSITIVE
                    // printing state — "not idle" would false-ACK when starting
                    // from the dismissed-failed-print state (state 'error').
                    if (worker.state === 'printing' || worker.state === 'paused') {
                        clearInterval(check);
                        resolve({ acked: true, newState: worker.state });
                        return;
                    }

                    // SECONDARY: track any print_error but don't block yet
                    const printError = worker.latestStatus?.print_error;
                    if (printError && printError !== 0) {
                        lastSeenError = decodePrintError(printError);
                    }

                    // TIMEOUT: if we've waited the full timeout and printer is still idle
                    if (Date.now() - start > ackTimeout) {
                        clearInterval(check);
                        if (lastSeenError) {
                            stage('PRINTER_BLOCKED_ERROR', { error: lastSeenError, waited_ms: ackTimeout });
                            resolve({ acked: false, newState: worker.state, blockedError: lastSeenError });
                        } else {
                            resolve({ acked: false, newState: worker.state });
                        }
                    }
                }, 500);
            });

            let ackResult;
            if (worker.mockMode) {
                await worker._startPrint(startPayload); // simulated print
                worker.activeJobId = jobId;
                stage('MOCK_START_COMMAND_SENT');
                stage('WAITING_FOR_PRINTER_ACK', { timeout_ms: ackTimeout });
                ackResult = await waitForAck();
            } else {
                // Up to 2 attempts on THIS printer: transient errors (SD hiccup,
                // missed command) often clear after clean_print_error + resend.
                // The retry also switches to the alternate file-URL form.
                // file:///sdcard/cache is PRIMARY: the ftp:/// form makes the
                // firmware re-fetch the file and throws a bogus 0500-C010 "SD
                // card" error on multi-MB files (3.2MB failed, 117KB was fine —
                // hardware-verified with a byte-identical upload).
                const urlForms = [
                    `file:///sdcard/cache/${remoteFileName}`,
                    `ftp:///cache/${remoteFileName}`,
                ];
                for (let attempt = 1; attempt <= urlForms.length; attempt++) {
                    if (attempt > 1) {
                        stage('START_RETRY_SAME_PRINTER', { attempt });
                        if (worker.latestStatus?.print_error) worker.mqttClient.cleanPrintError();
                        await new Promise(r => setTimeout(r, 5000));
                    }
                    const url = urlForms[attempt - 1];
                    worker.mqttClient.startPrint({ ...startPayload, url });
                    worker.activeJobId = jobId;
                    stage('MQTT_START_COMMAND_SENT', { attempt, url });
                    stage('WAITING_FOR_PRINTER_ACK', { timeout_ms: ackTimeout, attempt });
                    ackResult = await waitForAck();
                    if (ackResult.acked) break;
                }
            }

            if (ackResult.acked) {
                stage('PRINTER_ACK_OK', { new_state: ackResult.newState });
                broadcastPhase('start', 'ok', { printer_state: ackResult.newState });
                // STUCK-START WATCHDOG: "printing" + blocking error + 0 progress
                // minutes after the ACK means the printer hung at the pre-print
                // stage (e.g. filament path) with the nozzle parked hot. Stop
                // the print, fail the job loudly — never leave it silently hung.
                if (!worker.mockMode) this._armStuckStartWatchdog(jobId, job.printer_id, worker);
            } else if (ackResult.blockedError) {
                stage('START_PRINT_BLOCKED');
                broadcastPhase('start', 'failed', `Printer stayed idle with error: ${ackResult.blockedError.message} [${ackResult.blockedError.formatted}]`);
                throw printerLocalError(`Start failed: Printer stayed idle — ${ackResult.blockedError.message} [${ackResult.blockedError.formatted}]`);
            } else {
                // No state transition within the window. A print that actually started
                // would have left IDLE within seconds, so "still idle, no confirmation" is
                // a failed start — NOT a success. Marking it 'printing' here is exactly what
                // masked the real-world failure (project_file ACKed, but nothing prints).
                // Re-check for a standing print_error in case polling missed it.
                const standing = worker.latestStatus?.print_error
                    ? decodePrintError(worker.latestStatus.print_error)
                    : null;
                stage('START_PRINT_NO_ACK', { final_state: ackResult.newState, standing_error: standing?.formatted || null });
                const detail = standing
                    ? `Printer did not start and reports ${standing.message} [${standing.formatted}].`
                    : `Printer accepted the command but did not begin printing within ${ackTimeout / 1000}s (still idle, no error). The file may be unreadable on the printer's storage, or the printer is waiting on an on-screen confirmation.`;
                broadcastPhase('start', 'failed', detail);
                log.warn(`Printer ${job.printer_id} did not ACK start within ${ackTimeout}ms (stayed idle)`);
                throw printerLocalError(`Start failed: ${detail}`);
            }

            stage('FIRST_TELEMETRY_STATE_AFTER_START', {
                state: worker.state,
                nozzle: worker.latestStatus?.nozzle_temp,
                bed: worker.latestStatus?.bed_temp,
                progress: worker.latestStatus?.progress,
            });

            // Update job status
            JobModel.update(jobId, { status: 'printing' });
            JobRunModel.updateStatus(run.run_id, 'printing');

            const totalElapsed = Math.round(performance.now() - t0);
            stage('PIPELINE_COMPLETE', { total_elapsed_ms: totalElapsed });
            releaseLock();

            EventModel.create({
                entity_type: 'job', entity_id: jobId,
                event_type: 'job.started',
                payload: { printer_id: job.printer_id, run_id: run.run_id, send_trace: sendTrace, debug_trace: debugTrace },
            });

            log.info(`Job started: ${job.name} on printer ${job.printer_id} (total: ${totalElapsed}ms)`);
            this._broadcast('job.started', { job_id: jobId, printer_id: job.printer_id, run_id: run.run_id });
            systemEvents.emit('job.started', { job: JobModel.findById(jobId), printer_id: job.printer_id, run_id: run.run_id });
            this._broadcast('job.status_changed', { job_id: jobId, status: 'printing' });
            // Broadcast full trace for debug panel
            this._broadcast('job.debug_trace_complete', { job_id: jobId, trace: debugTrace });
            return { job: JobModel.findById(jobId), run, send_trace: sendTrace, debug_trace: debugTrace };

        } catch (err) {
            const totalElapsed = Math.round(performance.now() - t0);
            stage('PIPELINE_FAILED', { error: err.message, total_elapsed_ms: totalElapsed });
            releaseLock();
            sendTrace.error = err.message;
            JobModel.update(jobId, { status: 'failed' });
            EventModel.create({
                entity_type: 'job', entity_id: jobId,
                event_type: 'job.send_failed',
                payload: { error: err.message, send_trace: sendTrace, debug_trace: debugTrace },
            });
            this._broadcast('job.send_failed', { job_id: jobId, error: err.message, send_trace: sendTrace, debug_trace: debugTrace });
            this._broadcast('job.status_changed', { job_id: jobId, status: 'failed' });

            // ========== AUTO-FAILOVER ==========
            // The assigned printer is the problem (storage fault, unreachable,
            // refuses to start) — hand the job to another idle printer of the
            // same model instead of stranding it. Jobs with an explicit
            // slot_map never fail over (tray indices are printer-specific).
            // Kill switch: JOB_AUTO_FAILOVER=false.
            if (err.printerLocal && failoverDepth < 2
                && process.env.JOB_AUTO_FAILOVER !== 'false'
                && !job.ams_roles?.slot_map) {
                const candidate = await this._pickFailoverPrinter(job, printer);
                if (candidate) {
                    stage('FAILOVER_REASSIGNED', { from: printer.name, to: candidate.name, reason: err.message });
                    log.warn(`Auto-failover: job ${job.name} moves ${printer.name} -> ${candidate.name} (${err.message})`);
                    JobModel.update(jobId, { printer_id: candidate.printer_id, status: 'assigned' });
                    this._broadcast('job.updated', JobModel.findById(jobId));
                    // The job continues on the new printer — this attempt's
                    // failure is not terminal (no retry-requeue, no cloud
                    // job.failed emission).
                    return await this.startJob(jobId, { failoverDepth: failoverDepth + 1 });
                }
                stage('FAILOVER_NO_CANDIDATE', { model: printer.model });
            }

            // Opt-in auto-retry: if the job set max_retries and this is not a
            // known-blocking hardware fault, requeue it and kick the next-job
            // flow (bounded by max_retries; a no-op unless the job opted in).
            let requeue = { requeued: false };
            try {
                requeue = JobRetryService.maybeRequeue(jobId, { error: err.message });
                if (requeue.requeued) {
                    this._broadcast('job.requeued', { job_id: jobId, attempt: requeue.attempt, remaining: requeue.remaining });
                    this._broadcast('job.status_changed', { job_id: jobId, status: 'queued' });
                    if (requeue.printer_id) {
                        // Async so we don't deepen this failure's call stack.
                        Promise.resolve().then(() => this._autoStartNextJob(requeue.printer_id)).catch(() => { /* logged in auto-start */ });
                    }
                }
            } catch (retryErr) {
                log.warn(`Auto-retry evaluation failed: ${retryErr.message}`);
            }

            // Only treat this as a terminal failure (and forward it to the cloud,
            // releasing reservations/firing webhooks) if it is NOT being retried.
            if (!requeue.requeued) {
                systemEvents.emit('job.failed', { job: JobModel.findById(jobId), printer_id: job.printer_id, reason: err.message });
            }
            throw err;
        }
    }

    /**
     * Watch a freshly-ACKed print for a hung start: still 0% with a blocking
     * print_error after several checks → stop the print (heaters off), mark
     * the job failed, broadcast. Transient errors that the printer recovers
     * from (progress moves, error clears) disarm the watchdog.
     */
    static _armStuckStartWatchdog(jobId, printerId, worker, { intervalMs = 60000, strikes = 4 } = {}) {
        let hits = 0, checks = 0;
        const timer = setInterval(() => {
            checks++;
            const job = JobModel.findById(jobId);
            if (!job || job.status !== 'printing') return clearInterval(timer);
            const progress = worker.latestStatus?.progress ?? 0;
            const err = worker.latestStatus?.print_error;
            if (progress > 0 || worker.state !== 'printing') return clearInterval(timer); // healthy or finished
            if (err && err !== 0) {
                hits++;
                if (hits >= strikes) {
                    clearInterval(timer);
                    const decoded = decodePrintError(err);
                    log.error(`Stuck start on ${printerId}: 0% for ${checks} min with ${decoded?.formatted || err} — stopping print, failing job ${job.name}`);
                    try { worker.mqttClient?.stopPrint(); } catch { /* best effort */ }
                    // Dismiss the FAILED-dialog residue our own stop leaves behind
                    for (const delay of [8000, 20000]) {
                        setTimeout(() => { try { if (worker.latestStatus?.print_error) worker.clearPrintError(); } catch { /* best effort */ } }, delay);
                    }
                    JobModel.update(jobId, { status: 'failed' });
                    EventModel.create({
                        entity_type: 'job', entity_id: jobId,
                        event_type: 'job.stuck_start',
                        payload: { error: decoded, waited_min: checks },
                    });
                    this._broadcast('job.send_failed', { job_id: jobId, error: `Print never started: ${decoded?.message || err} [${decoded?.formatted || ''}] — stopped after ${checks} min at 0%` });
                    this._broadcast('job.status_changed', { job_id: jobId, status: 'failed' });
                    systemEvents.emit('job.failed', { job: JobModel.findById(jobId), printer_id: printerId, reason: 'stuck_start' });
                }
            } else {
                hits = 0; // error cleared — give it time
            }
            if (checks >= 15) clearInterval(timer); // hard cap: stop watching after 15 min
        }, intervalMs);
        timer.unref?.(); // never keep the process alive just for a watchdog
    }

    /**
     * Pick an idle, error-free printer with the same Automator geometry to
     * fail a job over to (P1P ≡ P1S). Printers the cloud/queue already gave
     * work to are skipped so failover can't butt into another job's printer.
     * For AMS-auto jobs the candidate must also resolve every print color
     * against its live AMS inventory — otherwise it would just fail again.
     */
    static async _pickFailoverPrinter(job, failedPrinter) {
        const { RuntimeSupervisor } = await import('../runtime/RuntimeSupervisor.js');
        const supervisor = RuntimeSupervisor.getInstance();
        if (!supervisor) return null;
        const amsAuto = job.ams_roles?.mode === 'auto' && Array.isArray(job.ams_roles.colors) && job.ams_roles.colors.length;
        const { AmsService } = amsAuto ? await import('./AmsService.js') : {};
        const wantedKey = automatorModelKey(failedPrinter.model);
        for (const p of PrinterModel.findAll()) {
            if (p.printer_id === failedPrinter.printer_id) continue;
            if (automatorModelKey(p.model) !== wantedKey) continue;
            const worker = supervisor.getWorker(p.printer_id);
            if (!worker) continue;
            if (worker.state !== 'idle') continue;
            if (worker.latestStatus?.print_error) continue;
            if (worker.activeJobId) continue;
            if (amsAuto) {
                try {
                    const status = AmsService.getFullStatus(p.printer_id);
                    if (!AmsService.matchColorsToTrays(job.ams_roles.colors, status.slots, 120, job.ams_roles.material || null).ok) continue;
                } catch { continue; }
            }
            return p;
        }
        return null;
    }

    /**
     * Handle job completion (called when printer reports done).
     * Producer: PrinterWorker completion detection via RuntimeSupervisor.
     * opts.reconcile: the FINISH was detected late (server was offline when
     * the print ended) — do the bookkeeping but take NO physical actions
     * (no ejection sequence, no auto-starts): hours may have passed and the
     * bed state is unknown.
     */
    static async onJobCompleted(jobId, printerId, opts = {}) {
        const job = JobModel.findById(jobId);
        if (!job) return;
        // Idempotency: only a job we believe is printing can complete. A stale or
        // duplicate signal (e.g. re-delivered MQTT report) must not re-run
        // ejection or repeat logic.
        if (job.status !== 'printing') {
            log.warn(`onJobCompleted ignored for ${jobId}: status is ${job.status}`);
            return;
        }

        // Find the current run
        const runs = JobRunModel.findByJobId(jobId);
        const activeRun = runs.find(r => r.status === 'printing');
        if (activeRun) {
            JobRunModel.updateStatus(activeRun.run_id, 'completed');
        }

        const profile = job.profile_id ? GcodeProfileModel.findById(job.profile_id) : null;

        // Trigger the hardware ejection sequence (no-op with a clear event when
        // no ejector accessory is fitted). SKIPPED for jobs whose gcode already
        // contains the transform's cooldown+sweep (transform_report
        // .insertionPoint) — by the time FINISH is reported the part is already
        // ejected, and with an ejector fitted the accessory pass would
        // double-eject (and stall the repeat chain on its cool-wait).
        const ejectionInGcode = !!job.transform_report?.insertionPoint;
        if (profile && !ejectionInGcode && !opts.reconcile) {
            log.info(`Triggering ejection for job ${jobId}`);
            try {
                const ejectResult = await executeEjectionSequence({
                    job_id: jobId,
                    printer_id: printerId,
                    profile,
                });

                EventModel.create({
                    entity_type: 'job', entity_id: jobId,
                    event_type: 'job.eject_result',
                    payload: ejectResult,
                });
            } catch (ejectErr) {
                // Ejection problems must never leave the job stuck "printing".
                log.error(`Ejection failed for job ${jobId}: ${ejectErr.message}`);
                EventModel.create({
                    entity_type: 'job', entity_id: jobId,
                    event_type: 'job.eject_result',
                    payload: { success: false, error: ejectErr.message },
                });
            }
        }

        // Handle repeat
        if (job.repeat_remaining > 1) {
            JobModel.update(jobId, {
                status: 'assigned',
                repeat_remaining: job.repeat_remaining - 1,
            });
            // Auto-start next repeat
            this._broadcast('job.updated', JobModel.findById(jobId)); // Notify repeat count change
            if (opts.reconcile) {
                log.info(`Job ${job.name}: repeat NOT auto-started (late-reconciled completion) — left 'assigned', start it from the Jobs page`);
            } else {
                await this.startJob(jobId);
            }
        } else {
            JobModel.update(jobId, { status: 'completed', repeat_remaining: 0 });
            EventModel.create({
                entity_type: 'job', entity_id: jobId,
                event_type: 'job.completed',
                payload: { total_repeats: job.repeat_total },
            });

            log.info(`Job completed: ${job.name}`);
            this._broadcast('job.completed', { job_id: jobId, total_repeats: job.repeat_total });
            this._broadcast('job.status_changed', { job_id: jobId, status: 'completed' });
            // For integrations (e.g. the cloud node agent forwarding merchant job
            // status): carries metadata so listeners can map back to cloud jobs.
            systemEvents.emit('job.completed', { job: JobModel.findById(jobId), printer_id: printerId });

            // Auto-start next queued job for this printer
            if (!opts.reconcile) await this._autoStartNextJob(printerId);
        }
    }

    /**
     * Handle a print that ended without finishing (stopped on-device or a
     * blocking error). Marks the job failed so it doesn't sit "printing", and
     * does NOT auto-start the next job — the bed state is unknown.
     */
    static async onJobAborted(jobId, printerId, reason = 'aborted') {
        const job = JobModel.findById(jobId);
        if (!job) return;
        if (job.status !== 'printing') {
            log.warn(`onJobAborted ignored for ${jobId}: status is ${job.status}`);
            return;
        }

        const runs = JobRunModel.findByJobId(jobId);
        const activeRun = runs.find(r => r.status === 'printing');
        if (activeRun) {
            JobRunModel.updateStatus(activeRun.run_id, 'failed');
        }

        JobModel.update(jobId, { status: 'failed' });
        EventModel.create({
            entity_type: 'job', entity_id: jobId,
            event_type: 'job.print_aborted',
            payload: { printer_id: printerId, reason },
        });
        log.warn(`Job ${jobId} aborted on printer ${printerId}: ${reason}`);
        this._broadcast('job.status_changed', { job_id: jobId, status: 'failed' });
        systemEvents.emit('job.failed', { job: JobModel.findById(jobId), printer_id: printerId, reason });
    }

    /**
     * Cancel a job.
     */
    static cancelJob(jobId) {
        const job = JobModel.findById(jobId);
        if (!job) throw new Error('Job not found');
        JobModel.update(jobId, { status: 'canceled' });
        EventModel.create({
            entity_type: 'job', entity_id: jobId,
            event_type: 'job.canceled', payload: {},
        });
        this._broadcast('job.canceled', { job_id: jobId });
        this._broadcast('job.status_changed', { job_id: jobId, status: 'canceled' });
        return JobModel.findById(jobId);
    }

    static updateJob(jobId, updates) {
        const job = JobModel.update(jobId, updates);
        this._broadcast('job.updated', job);
        return job;
    }

    static findById(id) { return JobModel.findById(id); }
    static findAll(opts) { return JobModel.findAll(opts); }
    static getQueue(printerId) { return JobModel.getQueue(printerId); }

    static async deleteJob(jobId) {
        const job = JobModel.findById(jobId);
        if (!job) throw new Error('Job not found');
        JobModel.delete(jobId);
        this._broadcast('job.deleted', { job_id: jobId });
        return { success: true };
    }

    static async clearHistory() {
        const count = JobModel.clearHistory();
        this._broadcast('jobs.history_cleared', { count });
        return count;
    }

    static async _autoStartNextJob(printerId) {
        const next = JobModel.getQueue(printerId)[0];
        if (!next) return null;

        try {
            return await this.startJob(next.job_id);
        } catch (error) {
            log.warn(`Auto-start next job failed: ${error.message}`);
            return null;
        }
    }
}

export default JobOrchestrator;
