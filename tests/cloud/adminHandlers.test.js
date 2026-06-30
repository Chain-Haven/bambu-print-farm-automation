import { describe, expect, it, vi } from 'vitest';
import { hashNodeToken } from '../../src/cloud/agentProtocol.js';
import {
    createCloudCommandHandler,
    createCloudNodeProvisionHandler,
    createCloudOverviewHandler,
} from '../../src/cloud/adminHandlers.js';

function createMockResponse() {
    return {
        statusCode: 200,
        body: null,
        headers: {},
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        },
        setHeader(name, value) {
            this.headers[name] = value;
        },
    };
}

describe('cloud admin auth', () => {
    it('rejects overview requests without the bootstrap admin token', async () => {
        const store = {
            getCloudOverview: vi.fn(),
        };
        const handler = createCloudOverviewHandler({ store, adminToken: 'admin-secret' });
        const res = createMockResponse();

        await handler({ method: 'GET', headers: {}, query: {} }, res);

        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ ok: false, error: 'missing_admin_token' });
        expect(store.getCloudOverview).not.toHaveBeenCalled();
    });
});

describe('cloud overview handler', () => {
    it('returns farm overview data filtered by organization with a capped limit', async () => {
        const overview = {
            nodes: [{ node_id: 'node-1', name: 'NUC 1', status: 'online' }],
            printers: [],
            jobs: [],
            commands: [],
            events: [],
        };
        const store = {
            getCloudOverview: vi.fn().mockResolvedValue(overview),
        };
        const handler = createCloudOverviewHandler({ store, adminToken: 'admin-secret' });
        const res = createMockResponse();

        await handler(
            {
                method: 'GET',
                headers: { authorization: 'Bearer admin-secret' },
                query: { org_id: 'org-1', limit: '500' },
            },
            res,
        );

        expect(store.getCloudOverview).toHaveBeenCalledWith({ orgId: 'org-1', limit: 100 });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ ok: true, overview });
    });
});

describe('cloud command handler', () => {
    it('queues sanitized commands for a local node', async () => {
        const command = {
            command_id: 'command-1',
            org_id: 'org-1',
            node_id: 'node-1',
            command_type: 'printer.gcode',
            status: 'queued',
            payload: { local_printer_id: 'printer-1', gcode: 'M400' },
        };
        const store = {
            createNodeCommand: vi.fn().mockResolvedValue(command),
        };
        const handler = createCloudCommandHandler({ store, adminToken: 'admin-secret' });
        const res = createMockResponse();

        await handler(
            {
                method: 'POST',
                headers: { 'x-cloud-admin-token': 'admin-secret' },
                body: {
                    org_id: 'org-1',
                    node_id: 'node-1',
                    command_type: 'printer.gcode',
                    printer_id: 'cloud-printer-1',
                    payload: { local_printer_id: 'printer-1', gcode: 'M400' },
                    status: 'succeeded',
                    claimed_at: 'client-spoof',
                },
            },
            res,
        );

        expect(store.createNodeCommand).toHaveBeenCalledWith({
            org_id: 'org-1',
            node_id: 'node-1',
            printer_id: 'cloud-printer-1',
            job_id: null,
            command_type: 'printer.gcode',
            payload: { local_printer_id: 'printer-1', gcode: 'M400' },
        });
        expect(res.statusCode).toBe(201);
        expect(res.body).toEqual({ ok: true, command });
    });

    it('rejects commands without a command type', async () => {
        const store = {
            createNodeCommand: vi.fn(),
        };
        const handler = createCloudCommandHandler({ store, adminToken: 'admin-secret' });
        const res = createMockResponse();

        await handler(
            {
                method: 'POST',
                headers: { authorization: 'Bearer admin-secret' },
                body: { org_id: 'org-1', node_id: 'node-1', payload: {} },
            },
            res,
        );

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            ok: false,
            error: 'create_command_failed',
            message: 'command_type is required',
        });
        expect(store.createNodeCommand).not.toHaveBeenCalled();
    });
});

describe('cloud node provisioning handler', () => {
    it('provisions a node with a hashed token and returns the raw token once', async () => {
        const node = {
            node_id: 'node-1',
            org_id: 'org-1',
            name: 'Windows NUC',
            status: 'offline',
        };
        const store = {
            createFarmNode: vi.fn().mockResolvedValue(node),
        };
        const handler = createCloudNodeProvisionHandler({
            store,
            adminToken: 'admin-secret',
            pepper: 'pepper',
            tokenFactory: () => 'pkx_node_generated_secret',
        });
        const res = createMockResponse();

        await handler(
            {
                method: 'POST',
                headers: { authorization: 'Bearer admin-secret' },
                body: {
                    org_id: 'org-1',
                    name: 'Windows NUC',
                    capabilities: { max_concurrent_jobs: 4 },
                    token_hash: 'client-spoof',
                },
            },
            res,
        );

        expect(store.createFarmNode).toHaveBeenCalledWith({
            org_id: 'org-1',
            name: 'Windows NUC',
            token_hash: hashNodeToken('pkx_node_generated_secret', 'pepper'),
            capabilities: { max_concurrent_jobs: 4 },
        });
        expect(res.statusCode).toBe(201);
        expect(res.body).toEqual({
            ok: true,
            node,
            local_node_token: 'pkx_node_generated_secret',
        });
    });
});
