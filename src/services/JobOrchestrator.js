// src/services/JobOrchestrator.js — Job lifecycle management
import { JobModel } from '../models/Job.js';
import { JobRunModel } from '../models/JobRun.js';
import { GcodeProfileModel } from '../models/GcodeProfile.js';
import { PrinterModel } from '../models/Printer.js';
import { EventModel } from '../models/Event.js';
import { CommandBus } from './CommandBus.js';
import { automate } from '../gcode/Automator.js';
import { extractGcodeFrom3mf, repack3mf } from '../gcode/AutomatorZip.js';
import { executeEjectionSequence } from './EjectionService.js';
import { createLogger } from '../utils/logger.js';
import { decodePrintError } from '../utils/PrinterErrors.js';
import fs from 'node:fs';
import path from 'node:path';
import { getUploadRoot } from '../utils/uploadPaths.js';

const log = createLogger('JobOrchestrator');
const UPLOADS_DIR = getUploadRoot();

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
     */
    static async submit({ name, printer_id, profile_id, repeat_total, ams_roles, fileContent, fileName, skip_transform = false, transform_overrides = null, rawBuffer3mf = null, originalFileName3mf = null }) {
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
            throw new Error('No G-code transform profile found');
        }

        // Create job record
        const job = JobModel.create({
            name, printer_id, profile_id: profile.profile_id,
            source_file_name: fileName, ams_roles, repeat_total: repeat_total || 1,
        });

        log.info(`Job created: ${job.name} [${job.job_id}]`);

        try {
            // Save original file
            const sourcePath = path.join(UPLOADS_DIR, `${job.job_id}_${fileName}`);
            fs.writeFileSync(sourcePath, fileContent);

            if (skip_transform) {
                // === RAW MODE: Skip transform, use file as-is ===
                const rawFileName = fileName.replace(/\.gcode$/i, '.AG.gcode');
                const rawPath = path.join(UPLOADS_DIR, `${job.job_id}_${rawFileName}`);
                fs.writeFileSync(rawPath, fileContent);

                JobModel.update(job.job_id, {
                    transformed_file_name: rawFileName,
                    transform_report: { skipped: true, reason: 'User requested raw upload' },
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
                const automatorConfig = {
                    printerModel: transform_overrides?.printer_model || profile.printer_model || 'P1S',
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

                // Run the automator
                const { output: transformedGcode, report } = automate(gcodeText, automatorConfig);
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
                    transform_report: { ...report, files_written: filesWritten, gcode_entry_name: gcodeEntryName },
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
            if (printer_id) {
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
    static async startJob(jobId) {
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
        if (!['queued', 'assigned'].includes(job.status)) {
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

            const preflight = worker.getPreflightStatus();
            if (!preflight.ok) {
                const errMsg = preflight.errors.join('; ');
                stage('PREFLIGHT_FAIL', errMsg);
                broadcastPhase('preflight', 'failed', errMsg);
                throw new Error(`Preflight failed: ${errMsg}`);
            }
            stage('PREFLIGHT_OK', { state: preflight.state, nozzle: preflight.nozzle_temp, bed: preflight.bed_temp, warnings: preflight.warnings });
            broadcastPhase('preflight', 'ok', { state: preflight.state, nozzle_temp: preflight.nozzle_temp, bed_temp: preflight.bed_temp, warnings: preflight.warnings });

            // ========== PHASE 2: FILE READ ==========
            stage('FILE_READ_START');
            const auth = PrinterModel.getAuth(job.printer_id);
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

            // ========== PHASE 3: FTPS REACHABILITY ==========
            stage('FTPS_REACHABILITY_START');
            const { BambuFtpsClient } = await import('./BambuFtpsClient.js');
            const ftpsClient = new BambuFtpsClient({ ip: printer.ip_hostname, accessCode: auth.access_code, printerId: job.printer_id });
            const ftpsReachable = await ftpsClient.isReachable();
            stage(ftpsReachable ? 'FTPS_REACHABILITY_OK' : 'FTPS_REACHABILITY_FAIL');
            if (!ftpsReachable) {
                broadcastPhase('upload', 'failed', 'FTPS port 990 not reachable.');
                throw new Error('Upload failed: FTPS not reachable');
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
                throw new Error(`Upload failed: ${uploadResult.error}`);
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

            // ========== PHASE 6: START PRINT ==========
            stage('START_PRINT_REQUESTED');
            broadcastPhase('start', 'running');

            const run = JobRunModel.create({ job_id: jobId, printer_id: job.printer_id });

            if (worker.mqttClient) {
                let amsMapping = [];
                if (job.ams_roles?.slot_map) amsMapping = Object.values(job.ams_roles.slot_map);

                // Build validated start payload
                const startPayload = {
                    filename: remoteFileName,
                    plateNumber,
                    useAms: amsMapping.length > 0,
                    amsMapping,
                };

                // Final payload validation
                if (!startPayload.filename.endsWith('.3mf')) {
                    stage('REMOTE_START_PAYLOAD_INVALID', { reason: 'filename not .3mf', payload: startPayload });
                    releaseLock();
                    throw new Error('Start payload invalid: filename must be .3mf');
                }

                stage('START_PAYLOAD_VALIDATED', { filename: startPayload.filename, plate: startPayload.plateNumber, ams: startPayload.useAms });

                worker.mqttClient.startPrint(startPayload);
                worker.activeJobId = jobId;
                stage('MQTT_START_COMMAND_SENT');
            } else {
                stage('START_PRINT_FAIL', 'MQTT not available');
                broadcastPhase('start', 'failed', 'MQTT client not available');
                releaseLock();
                throw new Error('Start failed: MQTT client not available');
            }

            // Wait for printer state transition (ACK)
            // PRIORITY: state change (idle → printing) = definitive success signal.
            // print_error codes may appear transiently during file loading — don't block on them.
            // Only fail if printer stays idle for the full timeout AND has a new error.
            stage('WAITING_FOR_PRINTER_ACK', { timeout_ms: 60000 });
            const ackTimeout = 60000; // large looped files can take longer to load from storage
            const ackResult = await new Promise((resolve) => {
                const start = Date.now();
                let lastSeenError = null;
                const check = setInterval(() => {
                    // PRIMARY CHECK: did the printer start?
                    if (worker.state !== 'idle') {
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

            if (ackResult.acked) {
                stage('PRINTER_ACK_OK', { new_state: ackResult.newState });
                broadcastPhase('start', 'ok', { printer_state: ackResult.newState });
            } else if (ackResult.blockedError) {
                stage('START_PRINT_BLOCKED');
                broadcastPhase('start', 'failed', `Printer stayed idle with error: ${ackResult.blockedError.message} [${ackResult.blockedError.formatted}]`);
                throw new Error(`Start failed: Printer stayed idle — ${ackResult.blockedError.message} [${ackResult.blockedError.formatted}]`);
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
                throw new Error(`Start failed: ${detail}`);
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
            throw err;
        }
    }

    /**
     * Handle job completion (called when printer reports done).
     */
    static async onJobCompleted(jobId, printerId) {
        const job = JobModel.findById(jobId);
        if (!job) return;

        // Find the current run
        const runs = JobRunModel.findByJobId(jobId);
        const activeRun = runs.find(r => r.status === 'printing');
        if (activeRun) {
            JobRunModel.updateStatus(activeRun.run_id, 'completed');
        }

        const profile = job.profile_id ? GcodeProfileModel.findById(job.profile_id) : null;

        // Trigger ejection sequence
        if (profile) {
            log.info(`Triggering ejection for job ${jobId}`);
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
        }

        // Handle repeat
        if (job.repeat_remaining > 1) {
            JobModel.update(jobId, {
                status: 'assigned',
                repeat_remaining: job.repeat_remaining - 1,
            });
            // Auto-start next repeat
            this._broadcast('job.updated', JobModel.findById(jobId)); // Notify repeat count change
            await this.startJob(jobId);
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

            // Auto-start next queued job for this printer
            await this._autoStartNextJob(printerId);
        }
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
