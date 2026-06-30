// submit_and_start.js — Submit a job with 20 loops, start it, and monitor
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const BASE_URL = 'http://localhost:3000/api';
const t0 = performance.now();
const log = (s) => console.log(`[+${String(Math.round(performance.now() - t0)).padStart(7)}ms] ${s}`);

// ── Step 1: Login ──
log('Logging in...');
const loginResp = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'antigravity' }),
});
const loginData = await loginResp.json();
const token = loginData.token;
log(`Logged in.`);

// ── Step 2: Get printer and profile ──
const printersResp = await fetch(`${BASE_URL}/printers`, { headers: { Authorization: `Bearer ${token}` } });
const printers = await printersResp.json();
const printerId = printers[0].printer_id;
log(`Printer: ${printers[0].name} (${printerId})`);

const profilesResp = await fetch(`${BASE_URL}/gcode/profiles`, { headers: { Authorization: `Bearer ${token}` } });
const profiles = await profilesResp.json();
const a1Profile = profiles.find(p => p.name === 'A1');
log(`Profile: ${a1Profile?.name} (${a1Profile?.profile_id})`);

// ── Step 3: Submit job ──
const testFile = path.join(process.cwd(), 'Print File Test', 'A1 Large Case white top.gcode.3mf');
log(`File: ${testFile} (${fs.statSync(testFile).size} bytes)`);

const fileBuffer = fs.readFileSync(testFile);
const formData = new FormData();
formData.append('name', 'A1 Large Case - 20 Loops Test');
formData.append('printer_id', printerId);
formData.append('profile_id', a1Profile.profile_id);
formData.append('auto_start', 'true');
formData.append('transform_overrides', JSON.stringify({
    printer_model: 'A1',
    n_loops: 20,
    release_temp_c: 27,
    sweep_z_mm: 4,
}));

// Use Blob (available in Node 24)
const fileBlob = new Blob([fileBuffer], { type: 'application/octet-stream' });
formData.append('file', fileBlob, 'A1 Large Case white top.gcode.3mf');

log('Uploading & submitting...');
const submitResp = await fetch(`${BASE_URL}/jobs/submit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: formData,
});

const submitText = await submitResp.text();
log(`Submit HTTP ${submitResp.status}: ${submitText.slice(0, 800)}`);

let submitData;
try { submitData = JSON.parse(submitText); } catch { console.error('Not JSON response'); process.exit(1); }
if (!submitResp.ok) { console.error('Submit failed:', submitData); process.exit(1); }

const jobId = submitData.job_id;
log(`Job submitted: ${jobId} — status: ${submitData.status}`);

// ── Step 4: Start the job ──
log('Starting job...');
const startResp = await fetch(`${BASE_URL}/jobs/${jobId}/start`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
});
const startText = await startResp.text();
log(`Start HTTP ${startResp.status}: ${startText.slice(0, 500)}`);
if (!startResp.ok) { console.error('Start failed'); process.exit(1); }

// ── Step 5: Monitor for 45s ──
log('Monitoring for 45s...');
for (let i = 0; i < 22; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
        const jobResp = await fetch(`${BASE_URL}/jobs/${jobId}`, { headers: { Authorization: `Bearer ${token}` } });
        const job = await jobResp.json();

        const printerResp = await fetch(`${BASE_URL}/printers/${printerId}`, { headers: { Authorization: `Bearer ${token}` } });
        const printer = await printerResp.json();
        const snap = printer.status_snapshot || {};

        log(`Job: ${job.status} | Printer: state=${snap.state}, gcode=${snap.gcode_state}, err=${snap.print_error || 0}, nozzle=${snap.nozzle_temp}°C`);

        if (job.status === 'printing' && (snap.state === 'printing' || snap.gcode_state === 'RUNNING' || snap.gcode_state === 'PREPARE')) {
            log('✅ PRINT STARTED SUCCESSFULLY!');
            break;
        }
        if (job.status === 'failed') {
            log('❌ JOB FAILED');
            break;
        }
    } catch (e) {
        log(`Monitor error: ${e.message}`);
    }
}

log('Done.');
process.exit(0);
