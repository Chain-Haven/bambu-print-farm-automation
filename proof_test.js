#!/usr/bin/env node
// proof_test.js — Known-Good Control Test (standalone, no server needed)
// Uses the app's DB + model layer for decrypted auth, direct FTPS/MQTT

import 'dotenv/config';

// Bootstrap the application database
import { initDb, dbAll } from './src/db/database.js';
import { PrinterModel } from './src/models/Printer.js';
import * as ftp from 'basic-ftp';
import * as tls from 'node:tls';
import mqtt from 'mqtt';

await initDb();

// Find P1S 8
const printers = dbAll('SELECT printer_id, name, ip_hostname FROM printers');
const p1s8 = printers.find(p => p.name === 'P1S 8');
if (!p1s8) { console.error('P1S 8 not found'); process.exit(1); }

const auth = PrinterModel.getAuth(p1s8.printer_id);
if (!auth?.access_code) { console.error('No auth for P1S 8'); process.exit(1); }

const IP = p1s8.ip_hostname;
const SERIAL = auth.serial;
const ACCESS_CODE = auth.access_code;

console.log('='.repeat(70));
console.log('PROOF TEST — Known-Good Control vs Generated Artifact');
console.log('='.repeat(70));
console.log(`Printer: ${p1s8.name} @ ${IP}`);
console.log(`Serial:  ${SERIAL}`);
console.log();

// Step 1: FTPS List /cache/
console.log('--- STEP 1: FTPS list /cache/ ---');
const ftpClient = new ftp.Client(60000);
ftpClient.ftp.verbose = false;
let fileList;
try {
    await ftpClient.access({
        host: IP, port: 990, user: 'bblp',
        password: ACCESS_CODE, secure: 'implicit',
        secureOptions: { rejectUnauthorized: false },
    });
    // TLS session reuse for data channel (required by Bambu FTPS)
    const controlSocket = ftpClient.ftp.socket;
    if (controlSocket instanceof tls.TLSSocket) {
        ftpClient.ftp.tlsOptions = {
            rejectUnauthorized: false,
            session: controlSocket.getSession(),
        };
    }
    try { await ftpClient.cd('/cache'); } catch {}
    fileList = await ftpClient.list();
} finally {
    ftpClient.close();
}

console.log(`Found ${fileList.length} files in /cache/:`);
for (const f of fileList) {
    const isOurs = f.name.includes('.AG.');
    console.log(`  ${isOurs ? '[OURS]' : '[ORIG]'}  ${f.name}  (${f.size} bytes)`);
}

const knownGood = fileList.find(f => f.name.toLowerCase().endsWith('.3mf') && !f.name.includes('.AG.'));
const ourArtifact = fileList.find(f => f.name.toLowerCase().endsWith('.3mf') && f.name.includes('.AG.'));

console.log();
if (knownGood) console.log(`✅ Known-good: ${knownGood.name} (${knownGood.size} bytes)`);
else console.log('⚠  No known-good .gcode.3mf found (all are ours or plain .gcode)');
if (ourArtifact) console.log(`✅ Our artifact: ${ourArtifact.name} (${ourArtifact.size} bytes)`);
else console.log('⚠  No .AG. artifact found');

// Step 2: MQTT connect
console.log();
console.log('--- STEP 2: MQTT connect ---');
const mqttClient = mqtt.connect(`mqtts://${IP}:8883`, {
    clientId: `proof_test_${Date.now()}`,
    username: 'bblp', password: ACCESS_CODE,
    rejectUnauthorized: false, connectTimeout: 10000,
});

let currentState = 'unknown';
let currentPrintError = 0;

await new Promise((resolve, reject) => {
    mqttClient.on('connect', () => {
        console.log('MQTT connected');
        mqttClient.subscribe(`device/${SERIAL}/report`, (err) => {
            if (err) reject(err);
            else {
                mqttClient.publish(`device/${SERIAL}/request`,
                    JSON.stringify({ pushing: { sequence_id: '0', command: 'pushall' } }));
                resolve();
            }
        });
    });
    mqttClient.on('error', reject);
    setTimeout(() => reject(new Error('MQTT connect timeout')), 15000);
});

// Wait for first status
await new Promise((resolve) => {
    const handler = (_topic, msg) => {
        try {
            const d = JSON.parse(msg.toString());
            if (d.print?.gcode_state) {
                currentState = d.print.gcode_state === 'IDLE' ? 'idle' : d.print.gcode_state.toLowerCase();
                currentPrintError = d.print.print_error || 0;
                mqttClient.removeListener('message', handler);
                resolve();
            }
        } catch {}
    };
    mqttClient.on('message', handler);
    setTimeout(resolve, 8000);
});

// Continuous tracking
mqttClient.on('message', (_topic, msg) => {
    try {
        const d = JSON.parse(msg.toString());
        if (d.print) {
            if (d.print.gcode_state) currentState = d.print.gcode_state === 'IDLE' ? 'idle' : d.print.gcode_state.toLowerCase();
            if (d.print.print_error !== undefined) currentPrintError = d.print.print_error;
        }
    } catch {}
});

function fmtErr(pe) {
    if (!pe || pe === 0) return 'none';
    const h = pe.toString(16).toUpperCase().padStart(8, '0');
    return `${h.slice(0,4)}-${h.slice(4)}`;
}

console.log(`State: ${currentState},  print_error: ${fmtErr(currentPrintError)}`);
console.log();

// ===== TEST RUNNER =====
async function attemptStart(label, filename) {
    console.log('='.repeat(70));
    console.log(`TEST: ${label}`);
    console.log('='.repeat(70));

    let plateNumber = 1;
    const pm = filename.match(/plate_(\d+)/i);
    if (pm) plateNumber = parseInt(pm[1], 10);

    const payload = {
        print: {
            sequence_id: String(Date.now()),
            command: 'project_file',
            param: `Metadata/plate_${plateNumber}.gcode`,
            subtask_name: filename.replace(/\.gcode\.3mf$/i, '').replace(/\.3mf$/i, ''),
            url: `ftp:///sdcard/cache/${filename}`,
            bed_type: 'auto', timelapse: false, bed_leveling: true,
            flow_cali: true, vibration_cali: true, layer_inspect: false,
            use_ams: false, ams_mapping: [],
            profile_id: '0', project_id: '0', subtask_id: '0', task_id: '0',
        }
    };

    console.log(`File:     ${filename}`);
    console.log(`URL:      ${payload.print.url}`);
    console.log(`Param:    ${payload.print.param}`);
    console.log(`Plate:    ${plateNumber}`);
    console.log();

    // Clear errors
    mqttClient.publish(`device/${SERIAL}/request`,
        JSON.stringify({ print: { sequence_id: '0', command: 'clean_print_error' } }));
    await new Promise(r => setTimeout(r, 3000));
    console.log(`Pre-start: state=${currentState}, print_error=${fmtErr(currentPrintError)}`);
    console.log();

    // Start
    console.log('>>> SENDING MQTT project_file COMMAND <<<');
    mqttClient.publish(`device/${SERIAL}/request`, JSON.stringify(payload));
    console.log('Monitoring for 30 seconds...');
    console.log();

    const start = Date.now();
    let transitioned = false;
    let finalState = currentState;
    let finalError = null;

    while (Date.now() - start < 30000) {
        await new Promise(r => setTimeout(r, 1000));
        const elapsed = Math.round((Date.now() - start) / 1000);
        console.log(`  [+${elapsed}s] state=${currentState}, print_error=${fmtErr(currentPrintError)}`);

        if (currentState !== 'idle' && currentState !== 'unknown') {
            transitioned = true;
            finalState = currentState;
            console.log(`  ✅ STATE TRANSITION: ${currentState}`);
            break;
        }
        if (currentPrintError && currentPrintError !== 0) finalError = fmtErr(currentPrintError);
    }

    console.log();
    console.log('--- RESULT ---');
    console.log(`Transitioned: ${transitioned}`);
    console.log(`Final state:  ${finalState}`);
    console.log(`Final error:  ${finalError || 'none'}`);
    if (transitioned) console.log('>>> VERDICT: ✅ PRINT STARTED <<<');
    else if (finalError) console.log(`>>> VERDICT: ❌ BLOCKED — ${finalError} <<<`);
    else console.log('>>> VERDICT: ❌ NO RESPONSE <<<');
    console.log();
    return { transitioned, finalState, finalError };
}

let knownGoodResult = null, ourResult = null;

if (knownGood) {
    knownGoodResult = await attemptStart('KNOWN_GOOD_CONTROL_TEST', knownGood.name);
    if (knownGoodResult.transitioned) {
        console.log('Stopping print for next test...');
        mqttClient.publish(`device/${SERIAL}/request`,
            JSON.stringify({ print: { sequence_id: '0', command: 'stop' } }));
        await new Promise(r => setTimeout(r, 10000));
    }
} else {
    console.log('SKIP: KNOWN_GOOD_CONTROL_TEST — no known-good .3mf on SD card');
}

if (ourArtifact) {
    ourResult = await attemptStart('GENERATED_ARTIFACT_TEST', ourArtifact.name);
    if (ourResult.transitioned) {
        console.log('Stopping print...');
        mqttClient.publish(`device/${SERIAL}/request`,
            JSON.stringify({ print: { sequence_id: '0', command: 'stop' } }));
        await new Promise(r => setTimeout(r, 5000));
    }
} else {
    console.log('SKIP: GENERATED_ARTIFACT_TEST — no .AG. artifact on SD card');
}

// Summary
console.log();
console.log('='.repeat(70));
console.log('FINAL SUMMARY');
console.log('='.repeat(70));
if (knownGoodResult) console.log(`Known-Good:   ${knownGoodResult.transitioned ? '✅ STARTED' : `❌ FAILED (${knownGoodResult.finalError || 'no transition'})`}`);
if (ourResult)       console.log(`Our Artifact: ${ourResult.transitioned ? '✅ STARTED' : `❌ FAILED (${ourResult.finalError || 'no transition'})`}`);
console.log();
if (knownGoodResult && !knownGoodResult.transitioned && ourResult && !ourResult.transitioned)
    console.log('DIAGNOSIS: Both failed → Issue is DEFINITIVELY printer/SD hardware.');
else if (knownGoodResult?.transitioned && ourResult && !ourResult.transitioned)
    console.log('DIAGNOSIS: Known-good works, ours fails → Repacked 3MF has structural issue.');
else if (knownGoodResult?.transitioned && ourResult?.transitioned)
    console.log('DIAGNOSIS: Both work → Pipeline is fully correct.');
else if (!knownGood)
    console.log('DIAGNOSIS: No known-good file for comparison. Upload one from Bambu Studio.');

mqttClient.end();
process.exit(0);
