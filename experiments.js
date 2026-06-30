// experiments.js — 4 controlled experiments to diagnose why A1 stays idle after project_file
// Each experiment: FTP evidence + exact MQTT payload + all inbound for 30s
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
await initDb();
const printers = PrinterModel.findAll();
const auth = PrinterModel.getAuth(printers[0].printer_id);
const SERIAL = auth.serial;

// ── Helpers ──
function ts(t0) { return `[+${String(Math.round(performance.now() - t0)).padStart(7)}ms]`; }

async function ftpConnect() {
    const client = new ftp.Client(300000);
    client.ftp.verbose = false;
    const origTls = tls.connect;
    await client.access({ host: PRINTER_IP, port: 990, user: 'bblp', password: auth.access_code, secure: 'implicit', secureOptions: { rejectUnauthorized: false, minVersion: 'TLSv1.2' } });
    const cs = client.ftp.socket;
    if (cs instanceof tls.TLSSocket) {
        tls.connect = function (opts, ...a) {
            if (opts?.host === PRINTER_IP) { opts.session = cs.getSession(); opts.rejectUnauthorized = false; }
            return origTls.call(tls, opts, ...a);
        };
    }
    return { client, restore: () => { tls.connect = origTls; } };
}

async function mqttRun(payload, durationMs = 30000) {
    return new Promise((resolve) => {
        const t0 = performance.now();
        const messages = [];
        const client = mqtt.connect(`mqtts://${PRINTER_IP}:8883`, {
            clientId: `exp_${Date.now()}`, username: 'bblp', password: auth.access_code, rejectUnauthorized: false,
        });
        const pubTopic = `device/${SERIAL}/request`;
        const subTopic = `device/${SERIAL}/report`;

        client.on('connect', () => {
            client.subscribe(subTopic, () => {
                // Capture all inbound
                client.on('message', (_t, msg) => {
                    const elapsed = Math.round(performance.now() - t0);
                    try {
                        const data = JSON.parse(msg.toString());
                        messages.push({ elapsed_ms: elapsed, data });
                    } catch {
                        messages.push({ elapsed_ms: elapsed, raw: msg.toString().slice(0, 500) });
                    }
                });
                // Publish after a small delay to ensure subscription is active
                setTimeout(() => {
                    client.publish(pubTopic, JSON.stringify(payload));
                    console.log(`  Published to ${pubTopic}`);
                }, 200);
            });
        });

        setTimeout(() => {
            client.end();
            resolve(messages);
        }, durationMs + 500);
    });
}

function printMessages(messages) {
    for (const m of messages) {
        if (m.data?.print) {
            const p = m.data.print;
            // Dump EVERY field (Experiment 4 requirement)
            const dump = {};
            for (const [k, v] of Object.entries(p)) {
                if (typeof v === 'string' && v.length > 300) { dump[k] = `<${v.length} chars>`; continue; }
                dump[k] = v;
            }
            console.log(`  [+${String(m.elapsed_ms).padStart(7)}ms] ${JSON.stringify(dump)}`);
        } else if (m.data) {
            console.log(`  [+${String(m.elapsed_ms).padStart(7)}ms] keys=[${Object.keys(m.data)}] ${JSON.stringify(m.data).slice(0, 300)}`);
        } else {
            console.log(`  [+${String(m.elapsed_ms).padStart(7)}ms] raw: ${m.raw}`);
        }
    }
    // Summary
    const results = messages.filter(m => m.data?.print?.result);
    const states = messages.filter(m => m.data?.print?.gcode_state);
    const errors = messages.filter(m => m.data?.print?.print_error && m.data.print.print_error !== 0);
    console.log(`  --- Summary: ${messages.length} msgs, results=[${results.map(m => m.data.print.result)}], gcode_states=[${states.map(m => m.data.print.gcode_state)}], errors=[${errors.map(m => m.data.print.print_error + ' (0x' + m.data.print.print_error.toString(16) + ')')}]`);
}

// ════════════════════════════════════════════════════════════
// EXPERIMENT 1: Start a KNOWN Bambu Studio file already on printer
// ════════════════════════════════════════════════════════════
console.log('\n' + '='.repeat(80));
console.log('EXPERIMENT 1: Start known Bambu Studio file (no upload)');
console.log('='.repeat(80));
{
    // FTP: confirm file exists
    const { client, restore } = await ftpConnect();
    try { await client.cd('/cache'); } catch { }
    let pwdResp; try { pwdResp = await client.send('PWD'); } catch { }
    console.log(`  PWD: ${pwdResp?.message}`);

    // Find the Studio file + .bbl
    const list = await client.list();
    const studioFile = list.find(f => f.name === 'Large Case White Print_Regular Tops.3mf');
    const bblFile = list.find(f => f.name === 'Large Case White Print_Regular Tops.bbl');
    const gcodeFile = list.find(f => f.name.includes('Large Case White Print_Regular Tops') && f.name.endsWith('.gcode'));
    console.log(`  Studio .3mf: ${studioFile ? studioFile.name + ' (' + studioFile.size + ' bytes)' : 'NOT FOUND'}`);
    console.log(`  Studio .bbl: ${bblFile ? bblFile.name + ' (' + bblFile.size + ' bytes)' : 'NOT FOUND'}`);
    console.log(`  Studio .gcode: ${gcodeFile ? gcodeFile.name + ' (' + gcodeFile.size + ' bytes)' : 'NOT FOUND'}`);

    // The companion gcode is "Large Case White Print_Regular Tops_plate_4.gcode" → plate 4
    const plateMatch = gcodeFile?.name.match(/plate_(\d+)/i);
    const plateNumber = plateMatch ? parseInt(plateMatch[1], 10) : 1;
    console.log(`  Detected plate: ${plateNumber}`);

    // SIZE check
    if (studioFile) {
        try {
            const sz = await client.size(studioFile.name);
            console.log(`  SIZE: ${sz} bytes`);
        } catch (e) { console.log(`  SIZE error: ${e.message}`); }
    }

    restore(); client.close();

    if (!studioFile) { console.log('  SKIP: Studio file not found'); }
    else {
        // MQTT: project_file referencing the existing Studio file
        const payload = {
            print: {
                sequence_id: String(Date.now()),
                command: 'project_file',
                param: `Metadata/plate_${plateNumber}.gcode`,
                subtask_name: studioFile.name.replace(/\.3mf$/i, ''),
                url: `ftp://${studioFile.name}`,
                bed_type: 'auto',
                timelapse: false,
                bed_leveling: true,
                flow_cali: false,
                vibration_cali: false,
                layer_inspect: false,
                use_ams: false,
                ams_mapping: [],
                profile_id: '0', project_id: '0', subtask_id: '0', task_id: '0',
            }
        };
        console.log(`\n  MQTT Payload:`);
        console.log(`  ${JSON.stringify(payload, null, 2).split('\n').join('\n  ')}`);
        console.log(`\n  Inbound messages (30s):`);
        const msgs = await mqttRun(payload);
        printMessages(msgs);
    }
}

// ════════════════════════════════════════════════════════════
// EXPERIMENT 2: Upload our file renamed to plain .3mf (no .gcode segment)
// ════════════════════════════════════════════════════════════
console.log('\n' + '='.repeat(80));
console.log('EXPERIMENT 2: Upload with plain .3mf filename (no .gcode segment)');
console.log('='.repeat(80));
{
    // Read our transformed file
    const uploadsDir = path.join(process.cwd(), 'uploads');
    const files = fs.readdirSync(uploadsDir).filter(f => f.endsWith('.3mf')).map(f => ({ name: f, stat: fs.statSync(path.join(uploadsDir, f)) })).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    const fileBuffer = fs.readFileSync(path.join(uploadsDir, files[0].name));
    // Rename: remove .gcode from filename
    const newName = 'A1 Large Case white top.AG.3mf'; // plain .3mf, no .gcode segment
    console.log(`  Original: ${files[0].name.replace(/^[a-f0-9-]+_/, '')}`);
    console.log(`  Renamed:  ${newName}`);
    console.log(`  Bytes:    ${fileBuffer.length}`);

    // Upload with new name
    const { client, restore } = await ftpConnect();
    try { await client.cd('/cache'); } catch { }
    const stream = Readable.from(fileBuffer);
    await client.uploadFrom(stream, newName);
    let pwdResp; try { pwdResp = await client.send('PWD'); } catch { }
    console.log(`  PWD: ${pwdResp?.message}`);

    // LIST + SIZE
    const list = await client.list();
    const uploaded = list.find(f => f.name === newName);
    console.log(`  LIST confirms: ${uploaded ? uploaded.name + ' (' + uploaded.size + ' bytes)' : 'NOT FOUND'}`);
    try {
        const sz = await client.size(newName);
        console.log(`  SIZE: ${sz} (match: ${sz === fileBuffer.length})`);
    } catch (e) { console.log(`  SIZE error: ${e.message}`); }

    restore(); client.close();

    // MQTT: project_file with plain .3mf name, plate_8
    const payload = {
        print: {
            sequence_id: String(Date.now()),
            command: 'project_file',
            param: 'Metadata/plate_8.gcode',
            subtask_name: 'A1 Large Case white top.AG',
            url: `ftp://${newName}`,
            bed_type: 'auto',
            timelapse: false,
            bed_leveling: true,
            flow_cali: false,
            vibration_cali: false,
            layer_inspect: false,
            use_ams: false,
            ams_mapping: [],
            profile_id: '0', project_id: '0', subtask_id: '0', task_id: '0',
        }
    };
    console.log(`\n  MQTT Payload:`);
    console.log(`  ${JSON.stringify(payload, null, 2).split('\n').join('\n  ')}`);
    console.log(`\n  Inbound messages (30s):`);
    const msgs = await mqttRun(payload);
    printMessages(msgs);
}

// ════════════════════════════════════════════════════════════
// EXPERIMENT 3: Path mapping — try different url path formats
// ════════════════════════════════════════════════════════════
console.log('\n' + '='.repeat(80));
console.log('EXPERIMENT 3: Path mapping tests');
console.log('='.repeat(80));
{
    const testName = 'A1 Large Case white top.AG.3mf'; // use the file from exp 2

    // 3A: Try CWD /sdcard/cache
    console.log('\n  --- 3A: Try CWD /sdcard/cache ---');
    {
        const { client, restore } = await ftpConnect();
        try {
            await client.cd('/sdcard/cache');
            let pwdResp; try { pwdResp = await client.send('PWD'); } catch { }
            console.log(`  PWD after cd /sdcard/cache: ${pwdResp?.message}`);
            const list = await client.list();
            const found = list.find(f => f.name === testName);
            console.log(`  File visible: ${found ? 'YES (' + found.size + ' bytes)' : 'NO'}`);
        } catch (e) {
            console.log(`  CWD /sdcard/cache FAILED: ${e.message}`);
        }
        restore(); client.close();
    }

    // 3B: url = ftp:///cache/<file> (no sdcard)
    console.log('\n  --- 3B: url = ftp:///cache/<file> ---');
    {
        const payload = {
            print: {
                sequence_id: String(Date.now()),
                command: 'project_file',
                param: 'Metadata/plate_8.gcode',
                subtask_name: 'A1 Large Case white top.AG',
                url: `ftp:///cache/${testName}`,
                bed_type: 'auto', timelapse: false, bed_leveling: true,
                flow_cali: false, vibration_cali: false, layer_inspect: false,
                use_ams: false, ams_mapping: [],
                profile_id: '0', project_id: '0', subtask_id: '0', task_id: '0',
            }
        };
        console.log(`  url: ${payload.print.url}`);
        const msgs = await mqttRun(payload);
        printMessages(msgs);
    }

    // 3C: url = ftp://<file> (bare filename, no path — what studio might use)
    console.log('\n  --- 3C: url = ftp://<file> (bare) ---');
    {
        const payload = {
            print: {
                sequence_id: String(Date.now()),
                command: 'project_file',
                param: 'Metadata/plate_8.gcode',
                subtask_name: 'A1 Large Case white top.AG',
                url: `ftp://${testName}`,
                bed_type: 'auto', timelapse: false, bed_leveling: true,
                flow_cali: false, vibration_cali: false, layer_inspect: false,
                use_ams: false, ams_mapping: [],
                profile_id: '0', project_id: '0', subtask_id: '0', task_id: '0',
            }
        };
        console.log(`  url: ${payload.print.url}`);
        const msgs = await mqttRun(payload);
        printMessages(msgs);
    }
}

// ════════════════════════════════════════════════════════════
// EXPERIMENT 4: Full JSON dump of every inbound message
// ════════════════════════════════════════════════════════════
console.log('\n' + '='.repeat(80));
console.log('EXPERIMENT 4: Full JSON dump — requestStatus then observe all fields');
console.log('='.repeat(80));
{
    // First request a full status push, then observe FULL payloads
    const statusPayload = { pushing: { sequence_id: '0', command: 'pushall' } };
    console.log(`  Requesting pushall first, then waiting 15s for full status dump...\n`);

    const msgs = await mqttRun(statusPayload, 15000);
    // Print FULL json for each (truncating huge fields)
    for (const m of msgs) {
        if (m.data) {
            const fullDump = JSON.stringify(m.data, (key, value) => {
                if (typeof value === 'string' && value.length > 200) return `<${value.length} chars>`;
                return value;
            });
            // Split at 300 chars per line for readability
            console.log(`  [+${String(m.elapsed_ms).padStart(7)}ms] ${fullDump.slice(0, 2000)}`);
            if (fullDump.length > 2000) console.log(`    ...truncated (${fullDump.length} total chars)`);
        }
    }
}

console.log('\n' + '='.repeat(80));
console.log('ALL EXPERIMENTS COMPLETE');
console.log('='.repeat(80));
process.exit(0);
