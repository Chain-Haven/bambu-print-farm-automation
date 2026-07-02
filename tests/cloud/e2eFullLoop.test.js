import AdmZip from 'adm-zip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryCloudStore } from '../../src/cloud/memoryCloudStore.js';
import { startLocalCloudServer } from '../../src/cloud/localCloudServer.js';
import { createLocalNodeClient } from '../../src/cloud/localNodeClient.js';
import { createLocalNodeAgent } from '../../src/cloud/localNodeAgent.js';
import { executeCloudCommand } from '../../src/cloud/localCommandExecutor.js';

// Full-loop backend e2e over real HTTP with the real handler code, mirroring
// the production flow (scripts/live-e2e-test.mjs) without Vercel/Supabase:
//   merchant onboarding (full-auto signup -> setup token -> live API key) ->
//   provision node in the merchant's org -> download Windows package ->
//   node heartbeat (printers + AMS) -> readiness gates unblock -> cloud
//   command loop -> print job upload -> routing -> node executes
//   cloud.print.ready -> lifecycle events -> merchant job completed.
const ADMIN_TOKEN = 'e2e-admin-secret';
const PEPPER = 'e2e-pepper';

const PRINTER_HEARTBEAT = {
    local_printer_id: 'printer-a1-01',
    name: 'A1 Bay 1',
    model: 'Bambu Lab A1',
    status: 'idle',
    status_snapshot: { print: { gcode_state: 'IDLE' } },
    capabilities: {
        lan_mode: true,
        developer_mode: true,
        auto_eject: true,
        materials: ['PLA'],
        colors: ['#FFFFFF'],
        ams_trays: [
            { material: 'PLA', color_hex: '#FFFFFF', ams_id: 0, tray_id: 0 },
            { material: 'PETG', color_hex: '#111111', ams_id: 0, tray_id: 1 },
        ],
    },
};

let cloud;
let store;

async function adminFetch(path, { method = 'GET', body = null } = {}) {
    return fetch(`${cloud.baseUrl}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${ADMIN_TOKEN}`,
            'Content-Type': 'application/json',
        },
        ...(body !== null ? { body: JSON.stringify(body) } : {}),
    });
}

async function adminJson(path, options) {
    const response = await adminFetch(path, options);
    const payload = await response.json();
    if (!response.ok) {
        throw new Error(`${path} failed (${response.status}): ${JSON.stringify(payload)}`);
    }
    return payload;
}

beforeAll(async () => {
    store = createMemoryCloudStore();
    cloud = await startLocalCloudServer({
        store,
        adminToken: ADMIN_TOKEN,
        pepper: PEPPER,
    });
});

afterAll(async () => {
    await cloud?.close();
});

describe('full farm loop end to end (local cloud, real handlers over HTTP)', () => {
    let orgId;
    let nodeId;
    let localNodeToken;
    let nodeClient;
    let merchantApiKey;
    let cloudJobId;

    it('onboards a merchant end to end (full-auto signup -> setup token -> live API key)', async () => {
        await adminJson('/api/cloud/merchant-settings', {
            method: 'PATCH',
            body: { full_auto_merchant_mode: true },
        });

        const signupResponse = await fetch(`${cloud.baseUrl}/api/public/merchants/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                company_name: 'E2E Widgets Co',
                contact_email: 'owner@e2e-widgets.example',
            }),
        });
        const signup = await signupResponse.json();
        expect(signupResponse.status).toBe(201);
        expect(signup.approval_required).toBe(false);
        expect(signup.merchant.status).toBe('active');
        expect(signup.merchant_setup_token).toMatch(/^pkx_setup_/);
        orgId = signup.merchant.org_id;

        const keyResponse = await fetch(`${cloud.baseUrl}/api/public/api-keys`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Merchant-Setup-Token': signup.merchant_setup_token,
            },
            body: JSON.stringify({ name: 'Production' }),
        });
        const key = await keyResponse.json();
        expect(keyResponse.status).toBe(201);
        merchantApiKey = key.api_key_secret;
        expect(merchantApiKey).toMatch(/^pkx_live_/);

        const meResponse = await fetch(`${cloud.baseUrl}/api/public/merchant/me`, {
            headers: { Authorization: `Bearer ${merchantApiKey}` },
        });
        expect(meResponse.status).toBe(200);
    });

    it('provisions a farm node in the merchant organization', async () => {
        const node = await adminJson('/api/cloud/nodes', {
            method: 'POST',
            body: { org_id: orgId, name: 'E2E Windows NUC' },
        });
        nodeId = node.node.node_id;
        localNodeToken = node.local_node_token;
        expect(localNodeToken).toMatch(/^pkx_node_/);
    });

    it('downloads the Windows package as the portable no-install bundle', async () => {
        const response = await adminFetch('/api/cloud/node-package', {
            method: 'POST',
            body: {
                cloud_api_url: cloud.baseUrl,
                local_node_token: localNodeToken,
                node_name: 'E2E Windows NUC',
            },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('application/zip');

        const zip = new AdmZip(Buffer.from(await response.arrayBuffer()));
        const entries = zip.getEntries().map((entry) => entry.entryName);

        // Portable bundle: no npm install, no source tree.
        expect(entries).toContain('farm-node.cjs');
        expect(entries).toContain('sql-wasm.wasm');
        expect(entries).toContain('Start Farm Node.bat');
        expect(entries).toContain('get-node.ps1');
        expect(entries).toContain('start-farm-node.sh');
        expect(entries).toContain('.env');
        expect(entries).not.toContain('package.json');
        expect(entries.some((name) => name.startsWith('src/'))).toBe(false);

        const env = zip.readAsText('.env');
        expect(env).toContain(`CLOUD_API_URL=${cloud.baseUrl}`);
        expect(env).toContain(`LOCAL_NODE_TOKEN=${localNodeToken}`);

        const launcher = zip.readAsText('Start Farm Node.bat');
        expect(launcher).toContain('farm-node.cjs');
        expect(launcher).toContain('get-node.ps1'); // auto-fetches portable Node if missing
    });

    it('reports blocked readiness gates before the node comes online', async () => {
        const { automation } = await adminJson('/api/cloud/farm-automation');
        const gates = automation.plan.platform_strategy.readiness;
        const gate = (id) => gates.find((entry) => entry.gate === id);

        expect(gate('edge_agent_online').status).toBe('blocked');
        expect(gate('printer_inventory').status).toBe('blocked');
        expect(gate('inventory_traceability').status).toBe('blocked');
    });

    it('brings the node online with a heartbeat that mirrors printers + AMS filament', async () => {
        nodeClient = createLocalNodeClient({
            cloudApiUrl: cloud.baseUrl,
            token: localNodeToken,
        });

        const heartbeat = await nodeClient.sendHeartbeat({
            status: 'online',
            agent_version: 'e2e-test',
            host_info: { hostname: 'e2e-nuc', platform: 'win32' },
            capabilities: { local_controller: true, printer_lan_control: true },
            printers: [PRINTER_HEARTBEAT],
        });

        expect(heartbeat.ok).toBe(true);
        expect(heartbeat.printers_synced).toBe(1);

        const { overview } = await adminJson('/api/cloud/overview');
        expect(overview.nodes[0].status).toBe('online');
        expect(overview.printers).toHaveLength(1);
        expect(overview.printers[0].local_printer_id).toBe('printer-a1-01');
        expect(overview.printers[0].status).toBe('online'); // idle -> online mapping
    });

    it('unblocks the readiness gates and roadmap phases as real data arrives', async () => {
        // Queue + execute one cloud command (LAN discovery) to satisfy the
        // durable-command-intents gate the same way an operator would.
        const { command } = await adminJson('/api/cloud/commands', {
            method: 'POST',
            body: {
                org_id: orgId,
                node_id: nodeId,
                command_type: 'cloud.printers.discover',
                payload: { wait_ms: 0 },
            },
        });
        expect(command.status).toBe('queued');

        const agent = createLocalNodeAgent({
            client: nodeClient,
            executeCommand: (cmd) => executeCloudCommand(cmd, {
                discoverPrinters: async () => [{ ip: '192.168.1.50', serial: '01P00A000000000', model: 'A1' }],
            }),
        });
        const summary = await agent.runOnce();
        expect(summary).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });

        // Configure operator alerting (Slack webhook) via the same PATCH the UI uses.
        await adminJson('/api/cloud/farm-automation', {
            method: 'PATCH',
            body: {
                integrations: {
                    alerts: [{ type: 'slack', name: 'Ops', url: 'https://hooks.slack.com/services/T000/B000/XXX' }],
                },
            },
        });

        const { automation } = await adminJson('/api/cloud/farm-automation');
        const strategy = automation.plan.platform_strategy;
        const gate = (id) => strategy.readiness.find((entry) => entry.gate === id);

        expect(gate('edge_agent_online').status).toBe('ready');
        expect(gate('printer_inventory').status).toBe('ready');
        expect(gate('command_intents').status).toBe('ready');
        expect(gate('smart_material_queue').status).toBe('ready');
        expect(gate('inventory_traceability').status).toBe('ready'); // AMS filament synced from the printer
        expect(gate('auto_ejection_policy').status).toBe('ready');
        expect(gate('failure_detection').status).toBe('ready');
        expect(gate('operator_alerting').status).toBe('ready');

        // No roadmap phase may remain blocked once the funnel has been walked.
        const blockedPhases = strategy.roadmap_phases.filter((phase) => phase.status === 'blocked');
        expect(blockedPhases).toEqual([]);
        expect(strategy.roadmap_phases.find((phase) => phase.phase === 'foundation').status).toBe('ready');
    });

    it('routes a merchant print job to the online printer and queues cloud.print.ready', async () => {
        const gcode = 'G28\nG1 X10 Y10 F3000\nM104 S0\n';
        const response = await fetch(`${cloud.baseUrl}/api/public/print-jobs`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${merchantApiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                name: 'E2E widget',
                file: {
                    name: 'widget.gcode',
                    base64: Buffer.from(gcode).toString('base64'),
                },
                requirements: { materials: ['PLA'], colors: ['#FFFFFF'] },
            }),
        });
        const payload = await response.json();
        expect(response.status).toBe(201);
        expect(payload.routing.status).toBe('routed');
        expect(payload.routing.selected_local_printer_id).toBe('printer-a1-01');
        expect(payload.job.status).toBe('queued');
        cloudJobId = payload.job.job_id;

        // AMS mapping picked the white PLA tray (global index 0).
        const commands = store._db.commands.filter((cmd) => cmd.command_type === 'cloud.print.ready');
        expect(commands).toHaveLength(1);
        expect(commands[0].payload.ams_mapping).toEqual([0]);
        expect(commands[0].payload.download_url).toContain('/artifacts/');
    });

    it('lets the node execute the print command and drive the job to completed', async () => {
        const submitted = [];
        const fakeWorker = {
            state: 'idle',
            connected: true,
            latestStatus: {},
            getPreflightStatus: () => ({ ok: true, errors: [] }),
        };

        const agent = createLocalNodeAgent({
            client: nodeClient,
            executeCommand: (cmd) => executeCloudCommand(cmd, {
                getWorker: async () => fakeWorker,
                submitJob: async (params) => {
                    submitted.push(params);
                    return {
                        job_id: 'local-job-1',
                        status: 'printing',
                        transformed_file_name: params.fileName,
                        transform_report: { skipped: false },
                        diff_summary: { loops: 1 },
                    };
                },
            }),
        });

        const summary = await agent.runOnce();
        expect(summary).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });

        // The artifact really flowed cloud -> node: the .gcode was wrapped into
        // a printable .gcode.3mf and submitted through the orchestrated pipeline.
        expect(submitted).toHaveLength(1);
        expect(submitted[0].fileName).toBe('widget.gcode.3mf');
        expect(submitted[0].metadata.cloud_job_id).toBe(cloudJobId);
        expect(Buffer.isBuffer(submitted[0].fileContent)).toBe(true);

        // Node reports the lifecycle the way runLocalNode.js forwards it.
        await nodeClient.sendEvents([{
            event_type: 'print_job.started',
            payload: { print_job_id: cloudJobId, local_job_id: 'local-job-1', local_printer_id: 'printer-a1-01' },
        }]);
        await nodeClient.sendEvents([{
            event_type: 'print_job.completed',
            payload: { print_job_id: cloudJobId, local_job_id: 'local-job-1', local_printer_id: 'printer-a1-01' },
        }]);

        const statusResponse = await fetch(
            `${cloud.baseUrl}/api/public/print-jobs/status?job_id=${cloudJobId}`,
            { headers: { Authorization: `Bearer ${merchantApiKey}` } },
        );
        const status = await statusResponse.json();
        expect(statusResponse.status).toBe(200);
        expect(status.job.status).toBe('completed');
    });

    it('mirrors live print telemetry (progress, time remaining, model preview) for the fleet board', async () => {
        const preview = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L5 5"/></svg>').toString('base64')}`;
        await nodeClient.sendHeartbeat({
            status: 'online',
            printers: [{
                ...PRINTER_HEARTBEAT,
                status: 'printing',
                current_job: {
                    job_id: 'local-job-1',
                    name: 'E2E widget',
                    state: 'printing',
                    progress_percent: 37,
                    remaining_minutes: 95,
                    layer: 40,
                    total_layers: 120,
                    preview,
                },
            }],
        });

        const { overview } = await adminJson('/api/cloud/overview');
        const printer = overview.printers.find((row) => row.local_printer_id === 'printer-a1-01');
        expect(printer.status).toBe('printing');
        expect(printer.status_snapshot.current_job).toMatchObject({
            name: 'E2E widget',
            progress_percent: 37,
            remaining_minutes: 95,
            preview,
        });
    });

    it('relays remote camera frames through the command channel', async () => {
        const { command } = await adminJson('/api/cloud/commands', {
            method: 'POST',
            body: {
                org_id: orgId,
                node_id: nodeId,
                command_type: 'printer.camera.snapshot',
                payload: { local_printer_id: 'printer-a1-01' },
            },
        });

        const agent = createLocalNodeAgent({
            client: nodeClient,
            executeCommand: (cmd) => executeCloudCommand(cmd, {
                captureCameraFrame: async (localPrinterId) => ({
                    content_type: 'image/jpeg',
                    image_base64: Buffer.from(`frame-for-${localPrinterId}`).toString('base64'),
                    mock: false,
                }),
            }),
        });
        const summary = await agent.runOnce();
        expect(summary).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });

        const { overview } = await adminJson('/api/cloud/overview');
        const finished = overview.commands.find((row) => row.command_id === command.command_id);
        expect(finished.status).toBe('succeeded');
        expect(finished.result.content_type).toBe('image/jpeg');
        expect(Buffer.from(finished.result.image_base64, 'base64').toString()).toBe('frame-for-printer-a1-01');
    });

    it('adopts a LAN-discovered printer through the cloud (name it, node registers it)', async () => {
        const { command } = await adminJson('/api/cloud/commands', {
            method: 'POST',
            body: {
                org_id: orgId,
                node_id: nodeId,
                command_type: 'cloud.printers.adopt',
                payload: {
                    name: 'P1S Bay 2',
                    model: 'P1S',
                    ip_hostname: '192.168.1.60',
                    access_code: '87654321',
                    serial: '01S00C111111111',
                },
            },
        });

        const registered = [];
        const agent = createLocalNodeAgent({
            client: nodeClient,
            executeCommand: (cmd) => executeCloudCommand(cmd, {
                adoptPrinter: async (details) => {
                    registered.push(details);
                    return { already_added: false, printer: { printer_id: 'printer-p1s-02', ...details } };
                },
                syncPrinters: async () => ({ printers: [PRINTER_HEARTBEAT, { local_printer_id: 'printer-p1s-02' }] }),
            }),
        });
        const summary = await agent.runOnce();
        expect(summary).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
        expect(registered[0]).toMatchObject({
            name: 'P1S Bay 2',
            model: 'P1S',
            ip_hostname: '192.168.1.60',
            access_code: '87654321',
        });

        // The next heartbeat mirrors the adopted printer into the fleet.
        await nodeClient.sendHeartbeat({
            status: 'online',
            printers: [
                PRINTER_HEARTBEAT,
                {
                    local_printer_id: 'printer-p1s-02',
                    name: 'P1S Bay 2',
                    model: 'P1S',
                    status: 'idle',
                    capabilities: { ip_hostname: '192.168.1.60' },
                },
            ],
        });

        const { overview } = await adminJson('/api/cloud/overview');
        expect(overview.printers).toHaveLength(2);
        const adoptedCommand = overview.commands.find((row) => row.command_id === command.command_id);
        expect(adoptedCommand.status).toBe('succeeded');
        expect(adoptedCommand.result.printer.name).toBe('P1S Bay 2');
    });
});
