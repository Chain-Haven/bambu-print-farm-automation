// quick_status_dump.js — Capture 30s of FULL push_status payloads
import mqtt from 'mqtt';
import 'dotenv/config';
import { initDb } from './src/db/database.js';
import { PrinterModel } from './src/models/Printer.js';
import { performance } from 'node:perf_hooks';

await initDb();
const printers = PrinterModel.findAll();
const auth = PrinterModel.getAuth(printers[0].printer_id);
const t0 = performance.now();

console.log(`Connecting to ${printers[0].ip_hostname}:8883...`);
const client = mqtt.connect(`mqtts://${printers[0].ip_hostname}:8883`, {
    clientId: `antigravity_dump_${Date.now()}`,
    username: 'bblp',
    password: auth.access_code,
    rejectUnauthorized: false,
});

const topic = `device/${auth.serial}/report`;
client.on('connect', () => {
    console.log('Connected. Subscribing to', topic);
    client.subscribe(topic);
});

let msgCount = 0;
client.on('message', (_t, msg) => {
    msgCount++;
    const elapsed = Math.round(performance.now() - t0);
    try {
        const data = JSON.parse(msg.toString());
        // Dump the FULL print object (filter out huge fields like thumbnails)
        if (data.print) {
            const p = data.print;
            // Extract key state fields
            const state = {
                command: p.command,
                gcode_state: p.gcode_state,
                mc_print_stage: p.mc_print_stage,
                mc_percent: p.mc_percent,
                print_error: p.print_error,
                mc_print_error_code: p.mc_print_error_code,
                subtask_name: p.subtask_name,
                gcode_file: p.gcode_file,
                result: p.result,
                reason: p.reason,
                hms: p.hms,
                stg: p.stg,
                stg_cur: p.stg_cur,
                layer_num: p.layer_num,
                total_layer_num: p.total_layer_num,
                nozzle_temper: p.nozzle_temper,
                bed_temper: p.bed_temper,
                wifi_signal: p.wifi_signal,
            };
            // Remove undefined values
            Object.keys(state).forEach(k => state[k] === undefined && delete state[k]);
            console.log(`[+${String(elapsed).padStart(7)}ms] #${msgCount} ${JSON.stringify(state)}`);
        } else {
            console.log(`[+${String(elapsed).padStart(7)}ms] #${msgCount} keys=[${Object.keys(data)}]`);
        }
    } catch (e) {
        console.log(`[+${String(elapsed).padStart(7)}ms] #${msgCount} PARSE_ERROR`);
    }
});

setTimeout(() => {
    console.log(`\nDone. ${msgCount} messages in 20s.`);
    client.end();
    process.exit(0);
}, 20000);
