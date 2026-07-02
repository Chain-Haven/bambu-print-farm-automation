#!/usr/bin/env node
// Local end-to-end proof of the whole farm funnel, offline (no Vercel, no
// Supabase, no printer hardware):
//
//   1. Start the cloud control plane locally (real handlers, in-memory store).
//   2. Onboard a merchant (full-auto signup -> setup token -> live API key).
//   3. Provision a farm node and download the Windows package over HTTP.
//   4. Extract the ZIP and BOOT THE ACTUAL SHIPPED BUNDLE (farm-node.cjs) in
//      MOCK_MODE — the same file a Windows user double-clicks.
//   5. Register a printer through the node's local API (what the dashboard does).
//   6. Wait for the heartbeat to mirror the printer into the cloud.
//   7. Verify every readiness gate is ready and no roadmap phase is blocked.
//   8. Submit a merchant print job and watch it route -> node claims
//      cloud.print.ready -> mock pipeline starts the print -> job goes printing.
//
// Usage: npm run e2e:local
import AdmZip from 'adm-zip';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createMemoryCloudStore } from '../src/cloud/memoryCloudStore.js';
import { startLocalCloudServer } from '../src/cloud/localCloudServer.js';

const ADMIN_TOKEN = `e2e-admin-${randomBytes(8).toString('hex')}`;
const PEPPER = `e2e-pepper-${randomBytes(8).toString('hex')}`;
const NODE_BOOT_TIMEOUT_MS = 60000;
const MIRROR_TIMEOUT_MS = 30000;
const PRINT_TIMEOUT_MS = 90000;

const steps = [];
let child = null;
let cloud = null;
let tempRoot = null;

function log(step, detail = '') {
    steps.push(step);
    console.log(`[e2e-local] ${String(steps.length).padStart(2)}. ${step}${detail ? ` — ${detail}` : ''}`);
}

function fail(message) {
    console.error(`\n[e2e-local] FAILED: ${message}`);
    process.exitCode = 1;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
        server.once('error', reject);
    });
}

async function jsonFetch(url, { method = 'GET', headers = {}, body = null } = {}) {
    const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        ...(body !== null ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = { text }; }
    if (!response.ok) {
        throw new Error(`${method} ${url} -> ${response.status}: ${text.slice(0, 300)}`);
    }
    return payload;
}

async function waitFor(label, timeoutMs, probe) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
        try {
            const result = await probe();
            if (result) return result;
        } catch (error) {
            lastError = error;
        }
        await sleep(750);
    }
    throw new Error(`Timed out waiting for ${label}${lastError ? ` (last error: ${lastError.message})` : ''}`);
}

async function main() {
    const adminHeaders = { Authorization: `Bearer ${ADMIN_TOKEN}` };

    // 1. Cloud control plane (real handlers, memory store).
    const store = createMemoryCloudStore();
    cloud = await startLocalCloudServer({ store, adminToken: ADMIN_TOKEN, pepper: PEPPER });
    log('Cloud control plane up', cloud.baseUrl);

    // 2. Merchant onboarding, full-auto.
    await jsonFetch(`${cloud.baseUrl}/api/cloud/merchant-settings`, {
        method: 'PATCH', headers: adminHeaders, body: { full_auto_merchant_mode: true },
    });
    const signup = await jsonFetch(`${cloud.baseUrl}/api/public/merchants/signup`, {
        method: 'POST',
        body: { company_name: 'E2E Local Widgets', contact_email: `owner+${Date.now()}@e2e.example` },
    });
    if (!signup.merchant_setup_token) throw new Error('signup did not return a setup token');
    const orgId = signup.merchant.org_id;
    const apiKeyResponse = await jsonFetch(`${cloud.baseUrl}/api/public/api-keys`, {
        method: 'POST',
        headers: { 'X-Merchant-Setup-Token': signup.merchant_setup_token },
        body: { name: 'Production' },
    });
    const merchantKey = apiKeyResponse.api_key_secret;
    log('Merchant onboarded', `org ${orgId.slice(0, 8)}…, live key issued`);

    // 3. Provision node + download the Windows package.
    const provision = await jsonFetch(`${cloud.baseUrl}/api/cloud/nodes`, {
        method: 'POST', headers: adminHeaders, body: { org_id: orgId, name: 'E2E Local NUC' },
    });
    const packageResponse = await fetch(`${cloud.baseUrl}/api/cloud/node-package`, {
        method: 'POST',
        headers: { ...adminHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            cloud_api_url: cloud.baseUrl,
            local_node_token: provision.local_node_token,
            node_name: 'E2E Local NUC',
        }),
    });
    if (packageResponse.status !== 200) throw new Error(`node-package failed (${packageResponse.status})`);
    const zipBuffer = Buffer.from(await packageResponse.arrayBuffer());
    log('Windows package downloaded', `${Math.round(zipBuffer.length / 1024)} KB`);

    // 4. Extract and boot the shipped bundle.
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pkx-e2e-node-'));
    new AdmZip(zipBuffer).extractAllTo(tempRoot, true);
    if (!fs.existsSync(path.join(tempRoot, 'farm-node.cjs'))) {
        throw new Error('extracted package is not the portable bundle (farm-node.cjs missing) — run `npm run build:node` first');
    }
    const nodePort = await getFreePort();
    child = spawn(process.execPath, ['farm-node.cjs'], {
        cwd: tempRoot,
        env: {
            ...process.env,
            PORT: String(nodePort),
            HOST: '127.0.0.1',
            MOCK_MODE: 'true',
            LOG_LEVEL: 'warn',
            CLOUD_HEARTBEAT_INTERVAL_MS: '1500',
            CLOUD_COMMAND_POLL_INTERVAL_MS: '750',
            CLOUD_API_URL: cloud.baseUrl,
            LOCAL_NODE_TOKEN: provision.local_node_token,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let nodeOutput = '';
    child.stdout.on('data', (chunk) => { nodeOutput += chunk; });
    child.stderr.on('data', (chunk) => { nodeOutput += chunk; });
    child.on('exit', (code) => {
        if (code !== null && code !== 0 && !process.exitCode) {
            fail(`farm-node.cjs exited with code ${code}\n--- node output tail ---\n${nodeOutput.slice(-2000)}`);
        }
    });
    const nodeBaseUrl = `http://127.0.0.1:${nodePort}`;
    await waitFor('node local API', NODE_BOOT_TIMEOUT_MS, async () => {
        const response = await fetch(`${nodeBaseUrl}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'admin', password: 'antigravity' }),
        });
        return response.status === 200;
    });
    log('Shipped bundle booted from the extracted ZIP', `${nodeBaseUrl} (MOCK_MODE)`);

    // 5. Register a printer through the local API (what the dashboard wizard does).
    const login = await jsonFetch(`${nodeBaseUrl}/api/auth/login`, {
        method: 'POST', body: { username: 'admin', password: 'antigravity' },
    });
    const localAuth = { Authorization: `Bearer ${login.token}` };
    const printer = await jsonFetch(`${nodeBaseUrl}/api/printers`, {
        method: 'POST',
        headers: localAuth,
        body: {
            name: 'Mock A1 Bay 1',
            model: 'A1',
            ip_hostname: '192.168.77.10',
            auth: { access_code: '12345678', serial: 'MOCKA1SERIAL0001' },
        },
    });
    log('Printer registered on the node', printer.printer_id);

    // 6. Wait for the heartbeat to mirror node + printer into the cloud.
    const overview = await waitFor('cloud printer mirror', MIRROR_TIMEOUT_MS, async () => {
        const { overview: data } = await jsonFetch(`${cloud.baseUrl}/api/cloud/overview`, { headers: adminHeaders });
        const nodeOnline = data.nodes.some((node) => node.status === 'online');
        return nodeOnline && data.printers.length > 0 ? data : null;
    });
    log('Heartbeat mirrored printer to the cloud', `${overview.printers.length} printer(s), node online`);

    // 7. Readiness gates: queue one command through the node, then verify.
    await jsonFetch(`${cloud.baseUrl}/api/cloud/commands`, {
        method: 'POST',
        headers: adminHeaders,
        body: {
            org_id: orgId,
            node_id: provision.node.node_id,
            command_type: 'cloud.printers.sync',
            payload: {},
        },
    });
    await waitFor('printer sync command completion', MIRROR_TIMEOUT_MS, async () => {
        const { overview: data } = await jsonFetch(`${cloud.baseUrl}/api/cloud/overview`, { headers: adminHeaders });
        return data.commands.some((cmd) => cmd.command_type === 'cloud.printers.sync' && cmd.status === 'succeeded');
    });
    await jsonFetch(`${cloud.baseUrl}/api/cloud/farm-automation`, {
        method: 'PATCH',
        headers: adminHeaders,
        body: {
            integrations: { alerts: [{ type: 'webhook', name: 'Ops', url: 'https://ops.example/hook' }] },
            // The mock printer has no AMS, so record a spool the way an operator
            // does for AMS-less printers (satisfies inventory traceability).
            inventory: {
                spools: [{
                    spool_id: 'e2e-spool-1',
                    material: 'PLA',
                    color_hex: '#FFFFFF',
                    grams_remaining: 800,
                    printer_id: overview.printers[0].printer_id,
                    local_printer_id: printer.printer_id,
                }],
            },
        },
    });
    const { automation } = await jsonFetch(`${cloud.baseUrl}/api/cloud/farm-automation`, { headers: adminHeaders });
    const strategy = automation.plan.platform_strategy;
    const notReadyGates = strategy.readiness.filter((gate) => gate.status !== 'ready');
    const blockedPhases = strategy.roadmap_phases.filter((phase) => phase.status === 'blocked');
    if (notReadyGates.length > 0) {
        throw new Error(`readiness gates not ready: ${notReadyGates.map((gate) => `${gate.gate}=${gate.status}`).join(', ')}`);
    }
    if (blockedPhases.length > 0) {
        throw new Error(`roadmap phases blocked: ${blockedPhases.map((phase) => phase.phase).join(', ')}`);
    }
    log('All readiness gates ready, no roadmap phase blocked');

    // 8. Merchant submits a print job; the node claims and starts it (mock pipeline).
    const gcode = [
        '; e2e-local test print',
        'G28',
        'G1 X10 Y10 Z0.2 F3000',
        'G1 X100 Y100 E5 F1500',
        'M104 S0',
        'M140 S0',
    ].join('\n');
    const jobResponse = await jsonFetch(`${cloud.baseUrl}/api/public/print-jobs`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${merchantKey}` },
        body: {
            name: 'E2E local widget',
            file: { name: 'e2e-widget.gcode', base64: Buffer.from(gcode).toString('base64') },
        },
    });
    if (jobResponse.routing?.status !== 'routed') {
        throw new Error(`merchant job was not routed: ${JSON.stringify(jobResponse.routing)}`);
    }
    const jobId = jobResponse.job.job_id;
    log('Merchant print job routed', `job ${jobId.slice(0, 8)}… -> ${jobResponse.routing.selected_printer_name || jobResponse.routing.selected_local_printer_id}`);

    const finalJob = await waitFor('node to start the print', PRINT_TIMEOUT_MS, async () => {
        const status = await jsonFetch(
            `${cloud.baseUrl}/api/public/print-jobs/status?job_id=${jobId}`,
            { headers: { Authorization: `Bearer ${merchantKey}` } },
        );
        return ['printing', 'completed'].includes(status.job?.status) ? status.job : null;
    });
    log('Auto print loop engaged', `cloud job status: ${finalJob.status}`);

    // 9. Fleet telemetry: the heartbeat must now carry the live job (progress /
    //    remaining time) and a preview of the model rendered from the artifact.
    const printingMirror = await waitFor('current_job in the heartbeat mirror', MIRROR_TIMEOUT_MS, async () => {
        const { overview: data } = await jsonFetch(`${cloud.baseUrl}/api/cloud/overview`, { headers: adminHeaders });
        const mirrored = data.printers.find((row) => row.status_snapshot?.current_job);
        return mirrored || null;
    });
    const currentJob = printingMirror.status_snapshot.current_job;
    const previewKind = typeof currentJob.preview === 'string' && currentJob.preview.startsWith('data:image/')
        ? currentJob.preview.slice(5, currentJob.preview.indexOf(';'))
        : 'none';
    log('Fleet telemetry mirrored', `job "${currentJob.name || '?'}", progress=${currentJob.progress_percent ?? '?'}%, preview=${previewKind}`);
    if (previewKind === 'none') {
        throw new Error('current_job.preview missing — model render did not reach the cloud');
    }

    // 10. Remote camera through the command channel (mock frame in MOCK_MODE).
    const cameraQueued = await jsonFetch(`${cloud.baseUrl}/api/cloud/commands`, {
        method: 'POST',
        headers: adminHeaders,
        body: {
            org_id: orgId,
            node_id: provision.node.node_id,
            command_type: 'printer.camera.snapshot',
            payload: { local_printer_id: printer.printer_id },
        },
    });
    const cameraResult = await waitFor('camera snapshot result', MIRROR_TIMEOUT_MS, async () => {
        const { overview: data } = await jsonFetch(`${cloud.baseUrl}/api/cloud/overview`, { headers: adminHeaders });
        const cmd = data.commands.find((row) => row.command_id === cameraQueued.command.command_id);
        return cmd && ['succeeded', 'failed'].includes(cmd.status) ? cmd : null;
    });
    if (cameraResult.status !== 'succeeded' || !cameraResult.result?.image_base64) {
        throw new Error(`camera snapshot failed: ${cameraResult.error || 'no frame returned'}`);
    }
    log('Remote camera frame relayed', `${cameraResult.result.content_type}, ${Math.round(cameraResult.result.image_base64.length / 1.37 / 1024 * 10) / 10} KB${cameraResult.result.mock ? ' (mock)' : ''}`);

    // 11. Adopt a second printer over the cloud (the discovered-printer flow).
    const adoptQueued = await jsonFetch(`${cloud.baseUrl}/api/cloud/commands`, {
        method: 'POST',
        headers: adminHeaders,
        body: {
            org_id: orgId,
            node_id: provision.node.node_id,
            command_type: 'cloud.printers.adopt',
            payload: {
                name: 'Adopted P1S Bay 2',
                model: 'P1S',
                ip_hostname: '192.168.77.11',
                access_code: '11112222',
                serial: 'MOCKP1SSERIAL002',
            },
        },
    });
    const adoptResult = await waitFor('adopt command result', MIRROR_TIMEOUT_MS, async () => {
        const { overview: data } = await jsonFetch(`${cloud.baseUrl}/api/cloud/overview`, { headers: adminHeaders });
        const cmd = data.commands.find((row) => row.command_id === adoptQueued.command.command_id);
        return cmd && ['succeeded', 'failed'].includes(cmd.status) ? cmd : null;
    });
    if (adoptResult.status !== 'succeeded') {
        throw new Error(`adopt failed: ${adoptResult.error}`);
    }
    await waitFor('adopted printer in the fleet mirror', MIRROR_TIMEOUT_MS, async () => {
        const { overview: data } = await jsonFetch(`${cloud.baseUrl}/api/cloud/overview`, { headers: adminHeaders });
        return data.printers.some((row) => row.name === 'Adopted P1S Bay 2') ? data : null;
    });
    log('Discovered-printer adoption works', 'Adopted P1S Bay 2 joined the fleet');

    console.log('\n[e2e-local] PASS — full funnel verified: download -> boot -> discover/register -> heartbeat -> gates ready -> merchant onboarding -> auto print -> fleet telemetry -> camera -> adoption.');
}

main().catch((error) => {
    fail(error.message);
}).finally(async () => {
    if (child && !child.killed) {
        child.kill('SIGTERM');
        await sleep(500);
        if (!child.killed) child.kill('SIGKILL');
    }
    if (cloud) await cloud.close();
    if (tempRoot) {
        try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    // The spawned node may leave keepalive handles; make sure we exit.
    setTimeout(() => process.exit(process.exitCode || 0), 250).unref();
    process.exit(process.exitCode || 0);
});
