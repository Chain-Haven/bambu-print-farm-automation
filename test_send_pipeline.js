// test_send_pipeline.js — End-to-end instrumented send test
import 'dotenv/config';
import { initDb } from './src/db/database.js';
import { JobOrchestrator } from './src/services/JobOrchestrator.js';
import { RuntimeSupervisor } from './src/runtime/RuntimeSupervisor.js';
import { PrinterModel } from './src/models/Printer.js';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

await initDb();

// Get the printer
const printers = PrinterModel.findAll();
const printer = printers[0];
if (!printer) { console.error('No printer found'); process.exit(1); }
console.log(`Printer: ${printer.name} (${printer.printer_id})`);

// Read test file
const testFile = path.join(process.cwd(), 'Print File Test', 'A1 Large Case white top.gcode.3mf');
if (!fs.existsSync(testFile)) { console.error('Test file not found:', testFile); process.exit(1); }
const fileContent = fs.readFileSync(testFile);
console.log(`Test file: ${fileContent.length} bytes`);

// Find A1 profile
import { GcodeProfileModel } from './src/models/GcodeProfile.js';
const profiles = GcodeProfileModel.findAll();
const a1Profile = profiles.find(p => p.printer_model === 'Bambu A1');
console.log(`Profile: ${a1Profile?.name} (${a1Profile?.profile_id})`);

// Set up broadcast sink (no WS in standalone test)
JobOrchestrator._broadcast = (type, data) => { };

// Submit the job
console.log('\n=== SUBMITTING JOB ===');
const submitStart = performance.now();
const job = await JobOrchestrator.submit({
    name: 'Pipeline Trace Test',
    printer_id: printer.printer_id,
    profile_id: a1Profile?.profile_id,
    repeat_total: 1,
    ams_roles: null,
    fileContent,
    fileName: 'A1 Large Case white top.gcode.3mf',
});
const submitEnd = performance.now();
console.log(`Job submitted: ${job.job_id} in ${Math.round(submitEnd - submitStart)}ms`);
console.log(`Transformed file: ${job.transformed_file_name}`);

// Start the job — this triggers the full instrumented pipeline
console.log('\n=== STARTING JOB (full instrumented trace) ===\n');
try {
    const result = await JobOrchestrator.startJob(job.job_id);

    console.log('\n=== FULL DEBUG TRACE ===');
    if (result.debug_trace) {
        for (const t of result.debug_trace) {
            const detail = t.detail ? (typeof t.detail === 'object' ? JSON.stringify(t.detail) : t.detail) : '';
            const pad = String(t.elapsed_ms).padStart(7);
            console.log(`[+${pad}ms] ${t.stage}${detail ? ' — ' + detail : ''}`);
        }
    }

    // Summary
    const trace = result.debug_trace || [];
    const clickToUploadOpen = trace.find(t => t.stage === 'UPLOAD_STREAM_OPENED')?.elapsed_ms;
    const uploadFinished = trace.find(t => t.stage === 'UPLOAD_FINISHED');
    const verifyEnd = trace.find(t => t.stage === 'REMOTE_VERIFY_END');
    const acked = trace.find(t => t.stage === 'START_PRINT_ACKED' || t.stage === 'START_PRINT_NO_ACK');
    const firstTelem = trace.find(t => t.stage === 'FIRST_TELEMETRY_STATE_AFTER_START');
    const total = trace.find(t => t.stage === 'PIPELINE_COMPLETE');

    console.log('\n=== TIMING SUMMARY ===');
    console.log(`Click → UPLOAD_STREAM_OPENED:  ${clickToUploadOpen ?? '?'}ms`);
    if (uploadFinished?.detail) {
        console.log(`Upload throughput:             ${uploadFinished.detail.throughput_kbps} KB/s (${uploadFinished.detail.throughput_mbps} Mbps)`);
        console.log(`Upload duration:               ${uploadFinished.detail.duration_ms}ms`);
    }
    if (verifyEnd) {
        const verifyStart = trace.find(t => t.stage === 'REMOTE_VERIFY_START');
        const verifyDuration = verifyStart ? (verifyEnd.elapsed_ms - verifyStart.elapsed_ms) : '?';
        console.log(`Remote verify duration:        ${verifyDuration}ms`);
    }
    if (acked) console.log(`Upload finish → ACK:           ${acked.elapsed_ms - (uploadFinished?.elapsed_ms || 0)}ms`);
    if (firstTelem) console.log(`First telemetry after start:   state=${firstTelem.detail?.state}`);
    if (total) console.log(`Total pipeline:                ${total.detail?.total_elapsed_ms}ms`);

} catch (err) {
    console.error('\nPIPELINE FAILED:', err.message);
}

process.exit(0);
