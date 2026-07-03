import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';
import { createMemoryCloudStore } from '../../src/cloud/memoryCloudStore.js';
import { createCloudPrintFilesHandler } from '../../src/cloud/adminPrintHandlers.js';
import { classifyPrintFile } from '../../src/cloud/printIntake.js';

const ADMIN_TOKEN = 'print-files-admin';

function createMockResponse() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
        setHeader() {},
    };
}

function slicedThreeMf() {
    const zip = new AdmZip();
    zip.addFile('Metadata/plate_1.gcode', Buffer.from('G28\nG1 X1 Y1\n', 'utf8'));
    zip.addFile('3D/3dmodel.model', Buffer.from('<model/>', 'utf8'));
    return zip.toBuffer();
}

function projectThreeMf() {
    const zip = new AdmZip();
    zip.addFile('3D/3dmodel.model', Buffer.from('<model/>', 'utf8'));
    return zip.toBuffer();
}

async function setupFarm({ nodeCapabilities = {} } = {}) {
    const store = createMemoryCloudStore();
    store.setPublicBaseUrl('http://cloud.test');
    const org = await store.createOrganization({ name: 'Drop Org' });
    const node = await store.createFarmNode({
        org_id: org.org_id,
        name: 'Drop Node',
        token_hash: 'hash',
        capabilities: nodeCapabilities,
    });
    await store.recordNodeHeartbeat(node.node_id, {
        status: 'online',
        last_seen_at: new Date().toISOString(),
        agent_version: 'test',
        host_info: {},
        capabilities: nodeCapabilities,
    });
    await store.upsertCloudPrinters(
        { node_id: node.node_id, org_id: org.org_id },
        [{
            local_printer_id: 'printer-1',
            name: 'A1 Bay 1',
            model: 'Bambu A1',
            status: 'online',
            status_snapshot: { print: { gcode_state: 'IDLE' } },
            capabilities: { materials: ['PLA'], colors: ['#FFFFFF'] },
        }],
    );
    return { store, org, node };
}

async function drop(store, file, extras = {}) {
    const handler = createCloudPrintFilesHandler({ store, adminToken: ADMIN_TOKEN });
    const res = createMockResponse();
    await handler({
        method: 'POST',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        body: {
            name: file.name,
            file: { name: file.name, base64: file.buffer.toString('base64') },
            ...extras,
        },
    }, res);
    return res;
}

describe('classifyPrintFile (buffer-aware .3mf classification)', () => {
    it('keeps a sliced .3mf (embedded plate gcode) ready to print', () => {
        expect(classifyPrintFile('widget.3mf', slicedThreeMf())).toBe('ready_to_print');
    });

    it('reclassifies an unsliced project .3mf as a source model', () => {
        expect(classifyPrintFile('widget.3mf', projectThreeMf())).toBe('source_model');
    });

    it('leaves .gcode.3mf, .gcode, and .stl classification untouched', () => {
        expect(classifyPrintFile('widget.gcode.3mf', projectThreeMf())).toBe('ready_to_print');
        expect(classifyPrintFile('widget.gcode', Buffer.from('G28'))).toBe('ready_to_print');
        expect(classifyPrintFile('widget.stl', Buffer.from('solid x'))).toBe('source_model');
    });
});

describe('operator drop-in print endpoint', () => {
    it('routes a ready gcode file and queues cloud.print.ready', async () => {
        const { store } = await setupFarm();
        const res = await drop(store, { name: 'widget.gcode', buffer: Buffer.from('G28\nG1 X5\n') });

        expect(res.statusCode).toBe(201);
        expect(res.body.routing.status).toBe('routed');
        expect(res.body.job.status).toBe('queued');
        expect(res.body.job.merchant_id).toBeNull();

        const commands = store._db.commands.filter((cmd) => cmd.command_type === 'cloud.print.ready');
        expect(commands).toHaveLength(1);
        expect(commands[0].payload.download_url).toContain('/artifacts/');
    });

    it('routes an STL to a slicer-capable node and queues cloud.print.source with the printer model', async () => {
        const { store } = await setupFarm({ nodeCapabilities: { can_slice: true } });
        const res = await drop(store, { name: 'bracket.stl', buffer: Buffer.from('solid bracket\nendsolid') });

        expect(res.statusCode).toBe(201);
        expect(res.body.routing.status).toBe('routed');
        expect(res.body.will_slice_on_node).toBe(true);

        const commands = store._db.commands.filter((cmd) => cmd.command_type === 'cloud.print.source');
        expect(commands).toHaveLength(1);
        expect(commands[0].payload).toMatchObject({
            file_mode: 'source_model',
            printer_model: 'Bambu A1',
            local_printer_id: 'printer-1',
        });
    });

    it('treats an unsliced project .3mf as a source model needing node-side slicing', async () => {
        const { store } = await setupFarm();
        const res = await drop(store, { name: 'project.3mf', buffer: projectThreeMf() });

        expect(res.statusCode).toBe(201);
        expect(res.body.file.file_mode).toBe('source_model');
        expect(store._db.commands.some((cmd) => cmd.command_type === 'cloud.print.source')).toBe(true);
    });

    it('rejects drops when no farm nodes exist', async () => {
        const store = createMemoryCloudStore();
        const res = await drop(store, { name: 'widget.gcode', buffer: Buffer.from('G28') });
        expect(res.statusCode).toBe(409);
        expect(res.body.error).toBe('no_nodes');
    });

    it('rejects unauthenticated drops', async () => {
        const { store } = await setupFarm();
        const handler = createCloudPrintFilesHandler({ store, adminToken: ADMIN_TOKEN });
        const res = createMockResponse();
        await handler({ method: 'POST', headers: {}, body: {} }, res);
        expect(res.statusCode).toBe(401);
    });
});
