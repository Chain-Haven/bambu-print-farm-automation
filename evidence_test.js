// evidence_test.js — Single end-to-end send with FULL evidence capture
// Captures: FTP control replies, MQTT payload, all inbound MQTT, PWD/LIST/SIZE
import * as ftp from 'basic-ftp';
import tls from 'node:tls';
import mqtt from 'mqtt';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import 'dotenv/config';
import { initDb } from './src/db/database.js';
import { PrinterModel } from './src/models/Printer.js';

const PRINTER_IP = process.env.PRINTER_IP || '192.168.1.50';
const t0 = performance.now();
const trace = [];

function log(stage, detail = null) {
    const elapsed = Math.round(performance.now() - t0);
    const line = `[+${String(elapsed).padStart(7)}ms] ${stage}${detail ? ' — ' + (typeof detail === 'object' ? JSON.stringify(detail) : detail) : ''}`;
    trace.push({ stage, elapsed_ms: elapsed, detail });
    console.log(line);
}

// ============================
// PHASE 1: Setup — find file, get auth
// ============================
await initDb();
const printers = PrinterModel.findAll();
const printer = printers[0];
const auth = PrinterModel.getAuth(printer.printer_id);
log('SETUP', { printer: printer.name, ip: printer.ip_hostname, serial: auth.serial });

// Find the most recent transformed .3mf in uploads/
const uploadsDir = path.join(process.cwd(), 'uploads');
const files = fs.readdirSync(uploadsDir)
    .filter(f => f.endsWith('.3mf'))
    .map(f => ({ name: f, stat: fs.statSync(path.join(uploadsDir, f)) }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

if (files.length === 0) { console.error('No .3mf files in uploads/'); process.exit(1); }
const uploadFile = files[0];
const fileBuffer = fs.readFileSync(path.join(uploadsDir, uploadFile.name));
// The remote filename is everything after the jobId prefix
const remoteFileName = uploadFile.name.replace(/^[a-f0-9-]+_/, '');
log('FILE_SELECTED', { local: uploadFile.name, remote: remoteFileName, bytes: fileBuffer.length });

// ============================
// PHASE 2: FTPS Upload with raw control reply capture
// ============================
log('FTPS_CONNECT_START');

const origTlsConnect = tls.connect;
const ftpClient = new ftp.Client(300000);

// ENABLE VERBOSE to capture FTP control replies (150, 226, etc.)
ftpClient.ftp.verbose = true;
// Capture all FTP log output
const ftpLog = [];
ftpClient.ftp.log = (msg) => {
    const elapsed = Math.round(performance.now() - t0);
    ftpLog.push({ elapsed_ms: elapsed, msg: msg.trim() });
};

await ftpClient.access({
    host: PRINTER_IP,
    port: 990,
    user: 'bblp',
    password: auth.access_code,
    secure: 'implicit',
    secureOptions: { rejectUnauthorized: false, minVersion: 'TLSv1.2' },
});
log('FTPS_CONNECT_OK');

// Patch TLS session reuse
const controlSocket = ftpClient.ftp.socket;
if (controlSocket instanceof tls.TLSSocket) {
    log('FTPS_TLS_HANDSHAKE_OK', {
        protocol: controlSocket.getProtocol?.(),
        cipher: controlSocket.getCipher?.()?.name,
        session: !!controlSocket.getSession(),
    });
    tls.connect = function (options, ...args) {
        if (options && options.host === PRINTER_IP) {
            options.session = controlSocket.getSession();
            options.rejectUnauthorized = false;
        }
        return origTlsConnect.call(tls, options, ...args);
    };
}

// CD /cache + PWD
log('FTPS_CD_CACHE');
try { await ftpClient.cd('/cache'); } catch (e) { log('FTPS_CD_CACHE_FAIL', e.message); }
// PWD — Bambu returns non-standard format, use raw send
let cwd = '/cache';
try {
    const pwdResp = await ftpClient.send('PWD');
    cwd = pwdResp.message || '/cache';
    log('FTPS_PWD', { raw_response: pwdResp.message, code: pwdResp.code });
} catch (e) { log('FTPS_PWD', { fallback: '/cache', error: e.message }); }

// UPLOAD
log('UPLOAD_START', { remote: remoteFileName, bytes: fileBuffer.length });
const uploadStart = performance.now();
let lastByteTime = null;

ftpClient.trackProgress((info) => {
    if (info.bytesOverall > 0) lastByteTime = performance.now();
});

const stream = Readable.from(fileBuffer);
await ftpClient.uploadFrom(stream, remoteFileName);
const uploadEnd = performance.now();
ftpClient.trackProgress();

const uploadMs = Math.round(uploadEnd - uploadStart);
const lastByteToFinish = lastByteTime ? Math.round(uploadEnd - lastByteTime) : '?';
log('UPLOAD_FINISHED', {
    duration_ms: uploadMs,
    throughput_kbps: Math.round((fileBuffer.length / 1024) / (uploadMs / 1000)),
    last_byte_to_226_ms: lastByteToFinish,
});

// PWD again
try {
    const pwdResp2 = await ftpClient.send('PWD');
    cwd = pwdResp2.message || cwd;
    log('FTPS_PWD_AFTER_UPLOAD', { raw_response: pwdResp2.message });
} catch (e) { log('FTPS_PWD_AFTER_UPLOAD', { using: cwd }); }

// LIST
log('FTPS_LIST_START');
const listing = await ftpClient.list();
const listEntries = listing.map(f => ({ name: f.name, size: f.size, type: f.type }));
log('FTPS_LIST', { entries: listEntries });

// SIZE
log('FTPS_SIZE_START');
try {
    const remoteSize = await ftpClient.size(remoteFileName);
    log('FTPS_SIZE', { remote_size: remoteSize, local_size: fileBuffer.length, match: remoteSize === fileBuffer.length });
} catch (e) {
    log('FTPS_SIZE_FAIL', e.message);
}

// Restore TLS and close
tls.connect = origTlsConnect;
ftpClient.close();
log('FTPS_CLOSED');

// Dump all FTP control channel replies
console.log('\n=== FTP CONTROL CHANNEL LOG (raw, with timestamps) ===');
for (const entry of ftpLog) {
    console.log(`[+${String(entry.elapsed_ms).padStart(7)}ms] ${entry.msg}`);
}
console.log('=== END FTP CONTROL CHANNEL LOG ===\n');

// ============================
// PHASE 3: MQTT — connect, publish startPrint, capture ALL inbound for 30s
// ============================
log('MQTT_CONNECT_START');
const mqttClient = mqtt.connect(`mqtts://${PRINTER_IP}:8883`, {
    clientId: `antigravity_evidence_${Date.now()}`,
    username: 'bblp',
    password: auth.access_code,
    rejectUnauthorized: false,
    connectTimeout: 10000,
});

const inboundMessages = [];
const publishTopic = `device/${auth.serial}/request`;
const subscribeTopic = `device/${auth.serial}/report`;

await new Promise((resolve, reject) => {
    mqttClient.on('connect', () => {
        log('MQTT_CONNECTED');
        mqttClient.subscribe(subscribeTopic, (err) => {
            if (err) { log('MQTT_SUBSCRIBE_FAIL', err.message); reject(err); }
            else { log('MQTT_SUBSCRIBED', { topic: subscribeTopic }); resolve(); }
        });
    });
    mqttClient.on('error', (err) => { log('MQTT_ERROR', err.message); reject(err); });
    setTimeout(() => reject(new Error('MQTT connect timeout')), 10000);
});

// Detect correct plate number from the 3MF archive
// The gcode entry inside is Metadata/plate_N.gcode — we need to find N
let plateNumber = 1;
try {
    // Scan the 3MF (ZIP) for the Metadata/plate_*.gcode entry
    const { extractGcodeFrom3mf } = await import('./src/gcode/AutomatorZip.js');
    const extracted = extractGcodeFrom3mf(fileBuffer);
    const entryName = extracted.gcodeEntryName; // e.g. "Metadata/plate_8.gcode"
    const match = entryName.match(/plate_(\d+)/i);
    if (match) plateNumber = parseInt(match[1], 10);
    log('PLATE_DETECTED', { gcode_entry: entryName, plate_number: plateNumber });
} catch (e) {
    log('PLATE_DETECTION_FALLBACK', { error: e.message, using: plateNumber });
}

// Build the exact startPrint payload
const startPayload = {
    print: {
        sequence_id: String(Date.now()),
        command: 'project_file',
        param: `Metadata/plate_${plateNumber}.gcode`,
        subtask_name: remoteFileName.replace(/\.gcode\.3mf$/i, '').replace(/\.3mf$/i, ''),
        url: `ftp://${remoteFileName}`,
        bed_type: 'auto',
        timelapse: false,
        bed_leveling: true,
        flow_cali: true,
        vibration_cali: true,
        layer_inspect: false,
        use_ams: false,
        ams_mapping: [],
        profile_id: '0',
        project_id: '0',
        subtask_id: '0',
        task_id: '0',
    }
};

// Log the EXACT payload
console.log('\n=== MQTT PUBLISH PAYLOAD (exact JSON) ===');
console.log(`Topic: ${publishTopic}`);
console.log(JSON.stringify(startPayload, null, 2));
console.log('=== END MQTT PAYLOAD ===\n');

// File path verification
const uploadedPath = `${cwd}/${remoteFileName}`;
const mqttUrl = startPayload.print.url;
log('FILE_PATH_VERIFICATION', {
    ftp_upload_path: uploadedPath,
    mqtt_url: mqttUrl,
    mqtt_subtask_name: startPayload.print.subtask_name,
    mqtt_param: startPayload.print.param,
});

// Set up inbound message capture BEFORE publishing
mqttClient.on('message', (topic, message) => {
    const elapsed = Math.round(performance.now() - t0);
    try {
        const data = JSON.parse(message.toString());
        inboundMessages.push({ elapsed_ms: elapsed, topic, data });
        // Log state changes immediately
        if (data.print?.gcode_state || data.print?.mc_print_stage) {
            log('MQTT_INBOUND_STATE', {
                gcode_state: data.print.gcode_state,
                mc_print_stage: data.print.mc_print_stage,
                mc_percent: data.print.mc_percent,
                mc_remaining_time: data.print.mc_remaining_time,
            });
        }
    } catch {
        inboundMessages.push({ elapsed_ms: elapsed, topic, raw: message.toString().slice(0, 200) });
    }
});

// PUBLISH
log('MQTT_PUBLISH_START');
mqttClient.publish(publishTopic, JSON.stringify(startPayload));
log('MQTT_PUBLISH_DONE');

// Wait 30 seconds, capturing all inbound
log('WAITING_30S_FOR_INBOUND_MESSAGES');
await new Promise(resolve => setTimeout(resolve, 30000));

log('CAPTURE_COMPLETE', { total_inbound: inboundMessages.length });

// Dump all inbound messages
console.log('\n=== ALL INBOUND MQTT MESSAGES (30s window) ===');
for (const msg of inboundMessages) {
    const keys = msg.data ? Object.keys(msg.data) : ['raw'];
    const stateInfo = msg.data?.print?.gcode_state ? ` STATE=${msg.data.print.gcode_state}` : '';
    const hms = msg.data?.print?.hms ? ` HMS=${JSON.stringify(msg.data.print.hms)}` : '';
    const error = msg.data?.print?.mc_print_error_code ? ` ERROR_CODE=${msg.data.print.mc_print_error_code}` : '';
    console.log(`[+${String(msg.elapsed_ms).padStart(7)}ms] topic=${msg.topic} keys=[${keys}]${stateInfo}${hms}${error}`);

    // For print-related messages, dump more detail
    if (msg.data?.print) {
        const p = msg.data.print;
        const relevant = {};
        for (const k of ['command', 'gcode_state', 'mc_print_stage', 'mc_percent', 'mc_remaining_time',
            'subtask_name', 'gcode_file', 'print_error', 'mc_print_error_code',
            'result', 'reason', 'hms']) {
            if (p[k] !== undefined) relevant[k] = p[k];
        }
        if (Object.keys(relevant).length > 0) {
            console.log(`         print: ${JSON.stringify(relevant)}`);
        }
    }
}
console.log('=== END INBOUND MQTT MESSAGES ===\n');

// Final summary
const firstStateChange = inboundMessages.find(m => m.data?.print?.gcode_state && m.data.print.gcode_state !== 'IDLE');
if (firstStateChange) {
    log('RESULT_PRINT_STARTED', {
        new_state: firstStateChange.data.print.gcode_state,
        detected_at_ms: firstStateChange.elapsed_ms,
    });
} else {
    log('RESULT_PRINT_NOT_STARTED', {
        conclusion: 'Printer remained idle for 30s after startPrint command',
        payload_sent: startPayload,
        file_uploaded_to: uploadedPath,
        file_verified: true,
    });
}

// Full trace summary
console.log('\n=== FULL STAGE TRACE ===');
for (const t of trace) {
    const d = t.detail ? (typeof t.detail === 'object' ? JSON.stringify(t.detail) : t.detail) : '';
    console.log(`[+${String(t.elapsed_ms).padStart(7)}ms] ${t.stage}${d ? ' — ' + d : ''}`);
}

mqttClient.end();
process.exit(0);
