// run_trace_test.js — submit + start a job via HTTP and capture the full trace
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const filePath = path.join(process.cwd(), 'Print File Test', 'A1 Large Case white top.gcode.3mf');
const fileData = fs.readFileSync(filePath);
const fileName = 'A1 Large Case white top.gcode.3mf';

function req(method, urlPath, body, headers = {}) {
    return new Promise((ok, no) => {
        const opts = { hostname: 'localhost', port: 3000, path: '/api' + urlPath, method, headers: { ...headers } };
        const r = http.request(opts, s => {
            let d = ''; s.on('data', c => d += c);
            s.on('end', () => { try { ok({ status: s.statusCode, body: JSON.parse(d) }); } catch { ok({ status: s.statusCode, body: d }); } });
        });
        r.on('error', no);
        if (body) { if (typeof body === 'string' || Buffer.isBuffer(body)) r.write(body); else r.write(JSON.stringify(body)); }
        r.end();
    });
}

function multipart(urlPath, fields, file, token) {
    return new Promise((ok, no) => {
        const boundary = '----AntigravityBoundary' + Date.now();
        let body = '';
        for (const [k, v] of Object.entries(fields)) {
            body += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
        }
        const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
        const fileFooter = `\r\n--${boundary}--\r\n`;
        const headerBuf = Buffer.from(fileHeader, 'utf-8');
        const footerBuf = Buffer.from(fileFooter, 'utf-8');
        const bodyBuf = Buffer.from(body, 'utf-8');
        const totalLength = bodyBuf.length + headerBuf.length + file.data.length + footerBuf.length;

        const opts = {
            hostname: 'localhost', port: 3000, path: '/api' + urlPath, method: 'POST',
            headers: {
                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                'Content-Length': totalLength,
                'Authorization': `Bearer ${token}`,
            },
        };
        const r = http.request(opts, s => {
            let d = ''; s.on('data', c => d += c);
            s.on('end', () => { try { ok({ status: s.statusCode, body: JSON.parse(d) }); } catch { ok({ status: s.statusCode, body: d }); } });
        });
        r.on('error', no);
        r.write(bodyBuf);
        r.write(headerBuf);
        r.write(file.data);
        r.write(footerBuf);
        r.end();
    });
}

async function main() {
    // Login
    const login = await req('POST', '/auth/login', JSON.stringify({ username: 'admin', password: 'antigravity' }), { 'Content-Type': 'application/json' });
    const token = login.body.token;
    console.log('Logged in');

    // Get printer + profile
    const printers = await req('GET', '/printers', null, { Authorization: `Bearer ${token}` });
    const pid = printers.body[0].printer_id;
    console.log('Printer:', printers.body[0].name, pid);

    const profiles = await req('GET', '/gcode/profiles', null, { Authorization: `Bearer ${token}` });
    const a1Profile = profiles.body.find(p => p.printer_model === 'Bambu A1');
    console.log('Profile:', a1Profile?.name, a1Profile?.profile_id);

    // Submit job via multipart
    console.log('\n=== SUBMITTING JOB ===');
    const submitResult = await multipart('/jobs/submit', {
        name: 'TRACE_TEST',
        printer_id: pid,
        profile_id: a1Profile?.profile_id || '',
        repeat_total: '1',
    }, { name: fileName, data: fileData }, token);

    if (submitResult.status !== 201) {
        console.error('Submit failed:', submitResult.status, JSON.stringify(submitResult.body));
        process.exit(1);
    }
    const jobId = submitResult.body.job_id;
    console.log('Job submitted:', jobId);

    // Start the job — full trace
    console.log('\n=== STARTING JOB ===');
    const t0 = Date.now();
    const startResult = await req('POST', `/jobs/${jobId}/start`, null, { Authorization: `Bearer ${token}` });
    const elapsed = Date.now() - t0;
    console.log(`HTTP round-trip: ${elapsed}ms, status: ${startResult.status}`);

    if (startResult.body.debug_trace) {
        console.log('\n=== FULL DEBUG TRACE ===');
        for (const t of startResult.body.debug_trace) {
            const d = t.detail ? (typeof t.detail === 'object' ? JSON.stringify(t.detail) : t.detail) : '';
            console.log(`[+${String(t.elapsed_ms).padStart(7)}ms] ${t.stage}${d ? ' — ' + d : ''}`);
        }

        const trace = startResult.body.debug_trace;
        const clickToUpload = trace.find(t => t.stage === 'UPLOAD_STREAM_OPENED');
        const uploadDone = trace.find(t => t.stage === 'UPLOAD_FINISHED');
        const verifyStart = trace.find(t => t.stage === 'REMOTE_VERIFY_START');
        const verifyEnd = trace.find(t => t.stage === 'REMOTE_VERIFY_END');
        const acked = trace.find(t => t.stage.includes('ACKED') || t.stage.includes('NO_ACK'));
        const firstTelem = trace.find(t => t.stage === 'FIRST_TELEMETRY_STATE_AFTER_START');
        const total = trace.find(t => t.stage === 'PIPELINE_COMPLETE');

        console.log('\n=== TIMING SUMMARY ===');
        console.log(`Click → UPLOAD_STREAM_OPENED: ${clickToUpload?.elapsed_ms ?? '?'}ms`);
        if (uploadDone?.detail) {
            console.log(`Upload duration:              ${uploadDone.detail.duration_ms}ms`);
            console.log(`Upload throughput:            ${uploadDone.detail.throughput_kbps} KB/s (${uploadDone.detail.throughput_mbps} Mbps)`);
        }
        if (verifyStart && verifyEnd) {
            console.log(`Remote verify:                ${verifyEnd.elapsed_ms - verifyStart.elapsed_ms}ms`);
        }
        if (acked && uploadDone) {
            console.log(`Upload→ACK:                   ${acked.elapsed_ms - uploadDone.elapsed_ms}ms`);
        }
        if (firstTelem) console.log(`First telemetry:              state=${firstTelem.detail?.state}`);
        if (total) console.log(`Total pipeline:               ${total.detail?.total_elapsed_ms}ms`);
    }

    if (startResult.body.error) console.log('\nERROR:', startResult.body.error);
}

main().catch(e => console.error('FATAL:', e.message));
