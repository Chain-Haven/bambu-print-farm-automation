#!/usr/bin/env node
// Seeds a realistic in-memory farm and serves the cloud console locally so the
// Print Fleet board can be inspected in a browser without Vercel/Supabase or
// real printers. Usage: node scripts/fleet-demo.mjs [port]
import { createMemoryCloudStore } from '../src/cloud/memoryCloudStore.js';
import { startLocalCloudServer } from '../src/cloud/localCloudServer.js';
import { renderSegmentsToSvg, parseGcodeSegments } from '../src/services/JobPreview.js';

const ADMIN_TOKEN = 'fleet-demo-admin';
const PEPPER = 'fleet-demo-pepper';

function benchyLikeGcode() {
    const lines = ['M83'];
    // A vase-ish spiral so the toolpath preview looks like a real 3D object.
    for (let layer = 0; layer < 60; layer += 1) {
        const z = 0.2 + layer * 0.6;
        const radius = 30 - Math.sin(layer / 9) * 10 - layer * 0.15;
        for (let step = 0; step <= 24; step += 1) {
            const angle = (step / 24) * Math.PI * 2;
            const x = 100 + Math.cos(angle) * radius;
            const y = 100 + Math.sin(angle) * radius * 0.8;
            lines.push(step === 0 ? `G1 X${x.toFixed(2)} Y${y.toFixed(2)} Z${z.toFixed(2)}` : `G1 X${x.toFixed(2)} Y${y.toFixed(2)} E0.4`);
        }
    }
    return lines.join('\n');
}

async function main() {
    const store = createMemoryCloudStore();
    const cloud = await startLocalCloudServer({
        store,
        adminToken: ADMIN_TOKEN,
        pepper: PEPPER,
        port: Number.parseInt(process.argv[2] || '4620', 10),
    });

    const org = await store.createOrganization({ name: 'Demo Farm' });
    const node = await store.createFarmNode({
        org_id: org.org_id,
        name: 'Windows Farm Manager 01',
        token_hash: 'demo-hash',
        capabilities: {},
    });
    await store.recordNodeHeartbeat(node.node_id, {
        status: 'online',
        last_seen_at: new Date().toISOString(),
        agent_version: 'demo',
        host_info: { hostname: 'FARM-NUC' },
        capabilities: { printer_count: 4 },
    });

    const preview = renderSegmentsToSvg(parseGcodeSegments(benchyLikeGcode()));

    const printers = [
        {
            local_printer_id: 'a1-bay-1',
            name: 'A1 Bay 1',
            model: 'Bambu Lab A1',
            status: 'printing',
            status_snapshot: {
                current_job: {
                    job_id: 'job-1',
                    name: 'vase_spiral_x2.gcode.3mf',
                    state: 'printing',
                    progress_percent: 63,
                    remaining_minutes: 84,
                    layer: 120,
                    total_layers: 190,
                    preview,
                },
            },
            capabilities: {
                ip_hostname: '192.168.1.41',
                ams_trays: [
                    { ams_id: 0, tray_id: 0, material: 'PLA', material_base: 'PLA', color_hex: '#146C5A', color_name: 'Green', live_remaining: 72 },
                    { ams_id: 0, tray_id: 1, material: 'PLA Silk', material_base: 'PLA', color_hex: '#FFD700', color_name: 'Gold', live_remaining: 31 },
                    { ams_id: 0, tray_id: 2, material: 'PETG', material_base: 'PETG', color_hex: '#111111', color_name: 'Black', live_remaining: 88 },
                ],
            },
        },
        {
            local_printer_id: 'p1s-bay-2',
            name: 'P1S Bay 2',
            model: 'P1S',
            status: 'printing',
            status_snapshot: {
                current_job: {
                    job_id: 'job-2',
                    name: 'bracket_v4_plate2.gcode.3mf',
                    state: 'paused',
                    progress_percent: 18,
                    remaining_minutes: 213,
                    preview,
                },
            },
            capabilities: {
                ip_hostname: '192.168.1.42',
                ams_trays: [
                    { ams_id: 0, tray_id: 0, material: 'ABS', material_base: 'ABS', color_hex: '#B3261E', color_name: 'Red', live_remaining: 55 },
                    { ams_id: 0, tray_id: 1, material: 'ABS', material_base: 'ABS', color_hex: '#FFFFFF', color_name: 'White', live_remaining: 12 },
                    { ams_id: 0, tray_id: 2, material: 'PLA', material_base: 'PLA', color_hex: '#0000FF', color_name: 'Blue', live_remaining: 97 },
                    { ams_id: 0, tray_id: 3, material: 'TPU', material_base: 'TPU', color_hex: '#FF69B4', color_name: 'Pink', live_remaining: 44 },
                ],
            },
        },
        {
            local_printer_id: 'x1c-bay-3',
            name: 'X1C Bay 3',
            model: 'X1 Carbon',
            status: 'online',
            status_snapshot: {},
            capabilities: {
                ip_hostname: '192.168.1.43',
                ams_trays: [
                    { ams_id: 0, tray_id: 0, material: 'PA-CF', material_base: 'PA-CF', color_hex: '#404040', color_name: 'Dark Gray', live_remaining: 66 },
                ],
            },
        },
        {
            local_printer_id: 'a1-mini-4',
            name: 'A1 Mini Bay 4',
            model: 'A1 Mini',
            status: 'offline',
            status_snapshot: {},
            capabilities: { ip_hostname: '192.168.1.44' },
        },
        {
            local_printer_id: 'h2d-bay-5',
            name: 'H2D Bay 5',
            model: 'H2D',
            status: 'online',
            status_snapshot: {},
            capabilities: {
                ip_hostname: '192.168.1.45',
                ams_trays: [
                    { ams_id: 0, tray_id: 0, material: 'PPS-CF', material_base: 'PPS-CF', color_hex: '#000000', color_name: 'Black', live_remaining: 91 },
                    { ams_id: 0, tray_id: 1, material: 'PC', material_base: 'PC', color_hex: '#C0C0C0', color_name: 'Light Gray', live_remaining: 27 },
                ],
            },
        },
    ];
    await store.upsertCloudPrinters(node, printers);

    // A completed discovery so the "Found on the network" adoption strip shows.
    const discover = await store.createNodeCommand({
        org_id: org.org_id,
        node_id: node.node_id,
        command_type: 'cloud.printers.discover',
        payload: { wait_ms: 1500 },
    });
    await store.claimNodeCommands(node.node_id, 10);
    await store.recordCommandResult(node.node_id, {
        command_id: discover.command_id,
        status: 'succeeded',
        result: {
            discovered: 2,
            printers: [
                { serial: '01P00A394800311', name: 'Bambu-P2S', model: 'P2S', ip: '192.168.1.88', already_added: false },
                { serial: '03919C471102934', name: 'X1C-Workshop', model: 'X1 Carbon', ip: '192.168.1.90', already_added: false },
            ],
        },
        error: null,
        finished_at: new Date().toISOString(),
    });

    console.log(`Fleet demo running:\n  URL:   ${cloud.baseUrl}/cloud\n  Token: ${ADMIN_TOKEN}\n\nIn the browser console run:\n  localStorage.setItem('pkxCloudAdminToken', '${ADMIN_TOKEN}'); location.reload();\n`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
