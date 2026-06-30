// final_evidence.js — One more test with calibration disabled + full payload dump
import mqtt from 'mqtt';
import 'dotenv/config';
import { initDb } from './src/db/database.js';
import { PrinterModel } from './src/models/Printer.js';
import { extractGcodeFrom3mf } from './src/gcode/AutomatorZip.js';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

await initDb();
const printers = PrinterModel.findAll();
const auth = PrinterModel.getAuth(printers[0].printer_id);
const t0 = performance.now();
const log = (s, d) => console.log(`[+${String(Math.round(performance.now() - t0)).padStart(7)}ms] ${s}${d ? ' — ' + (typeof d === 'object' ? JSON.stringify(d) : d) : ''}`);

// Find uploaded file
const uploadsDir = path.join(process.cwd(), 'uploads');
const files = fs.readdirSync(uploadsDir).filter(f => f.endsWith('.3mf')).map(f => ({ name: f, stat: fs.statSync(path.join(uploadsDir, f)) })).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
const fileBuffer = fs.readFileSync(path.join(uploadsDir, files[0].name));
const remoteFileName = files[0].name.replace(/^[a-f0-9-]+_/, '');

// Detect plate
const extracted = extractGcodeFrom3mf(fileBuffer);
const plateMatch = extracted.gcodeEntryName.match(/plate_(\d+)/i);
const plateNumber = plateMatch ? parseInt(plateMatch[1], 10) : 1;
log('SETUP', { remote: remoteFileName, plate: plateNumber, entry: extracted.gcodeEntryName, bytes: fileBuffer.length });

// Connect MQTT
const client = mqtt.connect(`mqtts://${printers[0].ip_hostname}:8883`, {
    clientId: `antigravity_final_${Date.now()}`,
    username: 'bblp',
    password: auth.access_code,
    rejectUnauthorized: false,
});

const publishTopic = `device/${auth.serial}/request`;
const subscribeTopic = `device/${auth.serial}/report`;
const allMessages = [];

await new Promise((resolve, reject) => {
    client.on('connect', () => {
        log('MQTT_CONNECTED');
        client.subscribe(subscribeTopic, (err) => {
            if (err) reject(err); else { log('MQTT_SUBSCRIBED'); resolve(); }
        });
    });
    setTimeout(() => reject(new Error('timeout')), 10000);
});

// Capture ALL messages with full print object
client.on('message', (_t, msg) => {
    const elapsed = Math.round(performance.now() - t0);
    try {
        const data = JSON.parse(msg.toString());
        allMessages.push({ elapsed_ms: elapsed, data });
        if (data.print) {
            // Extract ALL print fields that exist (not just known ones)
            const p = data.print;
            const keys = Object.keys(p);
            const important = {};
            for (const k of keys) {
                // Skip huge fields like thumbnails
                if (typeof p[k] === 'string' && p[k].length > 200) continue;
                important[k] = p[k];
            }
            console.log(`[+${String(elapsed).padStart(7)}ms] FULL: ${JSON.stringify(important)}`);
        }
    } catch { }
});

// Build payload — same as before BUT with calibrations DISABLED
const payload = {
    print: {
        sequence_id: String(Date.now()),
        command: 'project_file',
        param: `Metadata/plate_${plateNumber}.gcode`,
        subtask_name: remoteFileName.replace(/\.gcode\.3mf$/i, '').replace(/\.3mf$/i, ''),
        url: `ftp://${remoteFileName}`,
        bed_type: 'auto',
        timelapse: false,
        bed_leveling: true,
        flow_cali: false,        // DISABLED — avoids confirmation dialog
        vibration_cali: false,   // DISABLED — avoids confirmation dialog
        layer_inspect: false,
        use_ams: false,
        ams_mapping: [],
        profile_id: '0',
        project_id: '0',
        subtask_id: '0',
        task_id: '0',
    }
};

console.log('\n=== PUBLISH PAYLOAD ===');
console.log(`Topic: ${publishTopic}`);
console.log(JSON.stringify(payload, null, 2));
console.log('=== END ===\n');

log('PUBLISHING');
client.publish(publishTopic, JSON.stringify(payload));
log('PUBLISHED');

// Wait 30s
log('WAITING_30S');
await new Promise(r => setTimeout(r, 30000));

// Summary
const stateChanges = allMessages.filter(m => m.data?.print?.gcode_state);
const errors = allMessages.filter(m => m.data?.print?.print_error && m.data.print.print_error !== 0);
const results = allMessages.filter(m => m.data?.print?.result);

console.log('\n=== SUMMARY ===');
console.log(`Total messages: ${allMessages.length}`);
console.log(`State changes: ${stateChanges.map(m => `${m.elapsed_ms}ms: ${m.data.print.gcode_state}`).join(', ') || 'NONE'}`);
console.log(`Errors: ${errors.map(m => `${m.elapsed_ms}ms: ${m.data.print.print_error} (0x${m.data.print.print_error.toString(16)})`).join(', ') || 'NONE'}`);
console.log(`Results: ${results.map(m => `${m.elapsed_ms}ms: ${m.data.print.result}/${m.data.print.reason}`).join(', ') || 'NONE'}`);

if (stateChanges.length > 0 && stateChanges.some(m => m.data.print.gcode_state !== 'IDLE')) {
    log('RESULT: PRINT_STARTED ✅');
} else {
    log('RESULT: PRINT_NOT_STARTED ❌');
}

client.end();
process.exit(0);
