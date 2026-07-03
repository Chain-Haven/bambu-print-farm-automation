import { describe, expect, it } from 'vitest';
import { createMemoryCloudStore } from '../../src/cloud/memoryCloudStore.js';
import { createHeartbeatHandler } from '../../src/cloud/agentHandlers.js';
import { hashNodeToken } from '../../src/cloud/agentProtocol.js';
import { redispatchWaitingJobs, preferSlicerNodes } from '../../src/cloud/printDispatch.js';

const PEPPER = 'dispatch-pepper';
const TOKEN = 'pkx_node_dispatch_test';

function createMockResponse() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
        setHeader() {},
    };
}

function printerRecord({ state = 'IDLE', canDo = {} } = {}) {
    return {
        local_printer_id: 'printer-1',
        name: 'A1 Bay 1',
        model: 'Bambu A1',
        status: state === 'RUNNING' ? 'printing' : 'online',
        status_snapshot: { print: { gcode_state: state } },
        capabilities: { max_x: 256, max_y: 256, max_z: 256, materials: ['PLA'], colors: ['#FFFFFF'], ...canDo },
    };
}

async function setupFarm({ printerState = 'RUNNING' } = {}) {
    const store = createMemoryCloudStore();
    store.setPublicBaseUrl('http://cloud.test');
    const org = await store.createOrganization({ name: 'Dispatch Org' });
    const node = await store.createFarmNode({
        org_id: org.org_id,
        name: 'Dispatch Node',
        token_hash: hashNodeToken(TOKEN, PEPPER),
        capabilities: { can_slice: true },
    });
    await store.recordNodeHeartbeat(node.node_id, {
        status: 'online',
        last_seen_at: new Date().toISOString(),
        agent_version: 'test',
        host_info: {},
        capabilities: { can_slice: true },
    });
    await store.upsertCloudPrinters(
        { node_id: node.node_id, org_id: org.org_id },
        [printerRecord({ state: printerState })],
    );
    return { store, org, node };
}

async function createWaitingJob(store, org, { fileMode = 'ready_to_print', name = 'waiting.gcode' } = {}) {
    await store.uploadPrintArtifact(`${org.org_id}/test/${name}`, Buffer.from('G28\n'), 'application/octet-stream');
    const file = await store.createJobFile({
        org_id: org.org_id,
        merchant_id: 'merchant-1',
        storage_path: `${org.org_id}/test/${name}`,
        original_name: name,
        content_type: 'application/octet-stream',
        byte_size: 4,
        file_mode: fileMode,
        requirements: { materials: ['PLA'] },
    });
    const job = await store.createPrintJob({
        org_id: org.org_id,
        merchant_id: 'merchant-1',
        node_id: null,
        printer_id: null,
        file_id: file.file_id,
        name,
        status: 'waiting_for_capacity',
        options: {},
        routing_summary: { status: 'no_capacity' },
    });
    return { file, job };
}

describe('preferSlicerNodes', () => {
    it('restricts routing to slicer-capable nodes when any advertise one', () => {
        const overview = {
            nodes: [
                { node_id: 'n1', capabilities: {} },
                { node_id: 'n2', capabilities: { can_slice: true } },
            ],
            printers: [
                { printer_id: 'p1', node_id: 'n1' },
                { printer_id: 'p2', node_id: 'n2' },
            ],
        };
        expect(preferSlicerNodes(overview).printers.map((p) => p.printer_id)).toEqual(['p2']);

        // No slicer anywhere: keep everything (the node reports a clear error).
        const none = { ...overview, nodes: overview.nodes.map((n) => ({ ...n, capabilities: {} })) };
        expect(preferSlicerNodes(none).printers).toHaveLength(2);
    });
});

describe('redispatchWaitingJobs', () => {
    it('dispatches a waiting job once a printer frees up', async () => {
        const { store, org } = await setupFarm({ printerState: 'RUNNING' });
        const { job } = await createWaitingJob(store, org);

        // Printer busy: nothing to dispatch.
        let result = await redispatchWaitingJobs({ store, orgId: org.org_id });
        expect(result.dispatched).toBe(0);

        // Printer frees up (mirrored by the next heartbeat).
        await store.upsertCloudPrinters(
            { node_id: store._db.nodes[0].node_id, org_id: org.org_id },
            [printerRecord({ state: 'IDLE' })],
        );

        result = await redispatchWaitingJobs({ store, orgId: org.org_id });
        expect(result.dispatched).toBe(1);

        const updated = await store.getPrintJobById(job.job_id);
        expect(updated.status).toBe('queued');
        expect(updated.printer_id).toBeTruthy();

        const commands = store._db.commands.filter((cmd) => cmd.command_type === 'cloud.print.ready');
        expect(commands).toHaveLength(1);
        expect(commands[0].job_id).toBe(job.job_id);
        expect(commands[0].payload.download_url).toContain('/artifacts/');

        // Second pass: job already claimed, nothing dispatches twice.
        result = await redispatchWaitingJobs({ store, orgId: org.org_id });
        expect(result.dispatched).toBe(0);
        expect(store._db.commands.filter((cmd) => cmd.command_type === 'cloud.print.ready')).toHaveLength(1);
    });

    it('dispatches waiting source models as cloud.print.source', async () => {
        const { store, org } = await setupFarm({ printerState: 'IDLE' });
        const { job } = await createWaitingJob(store, org, { fileMode: 'source_model', name: 'bracket.stl' });

        const result = await redispatchWaitingJobs({ store, orgId: org.org_id });
        expect(result.dispatched).toBe(1);

        const commands = store._db.commands.filter((cmd) => cmd.command_type === 'cloud.print.source');
        expect(commands).toHaveLength(1);
        expect(commands[0].payload).toMatchObject({
            print_job_id: job.job_id,
            file_mode: 'source_model',
            printer_model: 'Bambu A1',
        });
    });

    it('does not place two waiting jobs on the same freed printer in one pass', async () => {
        const { store, org } = await setupFarm({ printerState: 'IDLE' });
        await createWaitingJob(store, org, { name: 'first.gcode' });
        await createWaitingJob(store, org, { name: 'second.gcode' });

        const result = await redispatchWaitingJobs({ store, orgId: org.org_id });
        expect(result.dispatched).toBe(1);
        expect(store._db.printJobs.filter((job) => job.status === 'waiting_for_capacity')).toHaveLength(1);
    });

    it('runs from the heartbeat path automatically', async () => {
        const { store, org } = await setupFarm({ printerState: 'IDLE' });
        const { job } = await createWaitingJob(store, org);

        const handler = createHeartbeatHandler({ store, pepper: PEPPER });
        const res = createMockResponse();
        await handler({
            method: 'POST',
            headers: { authorization: `Bearer ${TOKEN}` },
            body: { status: 'online', printers: [printerRecord({ state: 'IDLE' })] },
        }, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.waiting_jobs_dispatched).toBe(1);
        const updated = await store.getPrintJobById(job.job_id);
        expect(updated.status).toBe('queued');
    });
});
