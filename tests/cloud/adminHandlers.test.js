import { describe, expect, it, vi } from 'vitest';
import { hashNodeToken } from '../../src/cloud/agentProtocol.js';
import {
    createCloudCommandHandler,
    createCloudNodePackageHandler,
    createCloudNodeProvisionHandler,
    createCloudOrganizationHandler,
    createCloudOverviewHandler,
    createCloudSetupStatusHandler,
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

function createMockDownloadResponse() {
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
        end(payload) {
            this.body = payload;
            return this;
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

describe('cloud setup status handler', () => {
    it('reports missing Supabase environment without touching the backend', async () => {
        const store = {
            getCloudSetupStatus: vi.fn(),
        };
        const handler = createCloudSetupStatusHandler({
            store,
            adminToken: 'admin-secret',
            env: {
                CLOUD_ADMIN_TOKEN: 'admin-secret',
                NODE_TOKEN_PEPPER: 'pepper',
            },
        });
        const res = createMockResponse();

        await handler(
            {
                method: 'GET',
                headers: { authorization: 'Bearer admin-secret' },
            },
            res,
        );

        expect(store.getCloudSetupStatus).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            ok: true,
            setup: {
                ready: false,
                env: [
                    { key: 'SUPABASE_URL', present: false, secret: false },
                    { key: 'SUPABASE_SERVICE_ROLE_KEY', present: false, secret: true },
                    { key: 'NODE_TOKEN_PEPPER', present: true, secret: true },
                    { key: 'CLOUD_ADMIN_TOKEN', present: true, secret: true },
                ],
                missing: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
                backend: {
                    checked: false,
                    ready: false,
                    message: 'Supabase environment is incomplete',
                    checks: [],
                },
            },
        });
    });

    it('checks backend schema readiness after required environment is present', async () => {
        const backend = {
            checked: true,
            ready: true,
            checks: [{ name: 'organizations_table', ok: true }],
        };
        const store = {
            getCloudSetupStatus: vi.fn().mockResolvedValue(backend),
        };
        const handler = createCloudSetupStatusHandler({
            store,
            adminToken: 'admin-secret',
            env: {
                SUPABASE_URL: 'https://example.supabase.co',
                SUPABASE_SERVICE_ROLE_KEY: 'service-key',
                NODE_TOKEN_PEPPER: 'pepper',
                CLOUD_ADMIN_TOKEN: 'admin-secret',
            },
        });
        const res = createMockResponse();

        await handler(
            {
                method: 'GET',
                headers: { authorization: 'Bearer admin-secret' },
            },
            res,
        );

        expect(store.getCloudSetupStatus).toHaveBeenCalledOnce();
        expect(res.statusCode).toBe(200);
        expect(res.body.setup.ready).toBe(true);
        expect(res.body.setup.backend).toEqual(backend);
        expect(res.body.setup.missing).toEqual([]);
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

describe('cloud organization handler', () => {
    it('creates a bootstrap organization without trusting client IDs', async () => {
        const organization = {
            org_id: 'org-1',
            name: 'Bambu Lab',
        };
        const store = {
            createOrganization: vi.fn().mockResolvedValue(organization),
        };
        const handler = createCloudOrganizationHandler({ store, adminToken: 'admin-secret' });
        const res = createMockResponse();

        await handler(
            {
                method: 'POST',
                headers: { authorization: 'Bearer admin-secret' },
                body: {
                    org_id: 'client-spoof',
                    name: ' Bambu Lab ',
                    created_at: 'client-spoof',
                },
            },
            res,
        );

        expect(store.createOrganization).toHaveBeenCalledWith({ name: 'Bambu Lab' });
        expect(res.statusCode).toBe(201);
        expect(res.body).toEqual({ ok: true, organization });
    });

    it('rejects organization creation without a name', async () => {
        const store = {
            createOrganization: vi.fn(),
        };
        const handler = createCloudOrganizationHandler({ store, adminToken: 'admin-secret' });
        const res = createMockResponse();

        await handler(
            {
                method: 'POST',
                headers: { authorization: 'Bearer admin-secret' },
                body: {},
            },
            res,
        );

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            ok: false,
            error: 'create_organization_failed',
            message: 'name is required',
        });
        expect(store.createOrganization).not.toHaveBeenCalled();
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

describe('cloud node package handler', () => {
    it('returns a zip download for an authenticated admin', async () => {
        const packageBuffer = Buffer.from('zip-data');
        const packageBuilder = vi.fn().mockReturnValue(packageBuffer);
        const handler = createCloudNodePackageHandler({
            adminToken: 'admin-secret',
            rootDir: '/repo',
            packageBuilder,
        });
        const res = createMockDownloadResponse();

        await handler(
            {
                method: 'POST',
                headers: { authorization: 'Bearer admin-secret', host: 'farm.example.com' },
                body: {
                    local_node_token: 'pkx_node_secret',
                    cloud_api_url: 'https://farm.example.com',
                    node_name: 'Print NUC 01',
                },
            },
            res,
        );

        expect(packageBuilder).toHaveBeenCalledWith({
            rootDir: '/repo',
            cloudApiUrl: 'https://farm.example.com',
            localNodeToken: 'pkx_node_secret',
            nodeName: 'Print NUC 01',
        });
        expect(res.statusCode).toBe(200);
        expect(res.headers['Content-Type']).toBe('application/zip');
        expect(res.headers['Content-Disposition']).toBe('attachment; filename="print-nuc-01-cloud-node.zip"');
        expect(res.body).toBe(packageBuffer);
    });

    it('rejects package downloads without a local node token', async () => {
        const packageBuilder = vi.fn();
        const handler = createCloudNodePackageHandler({
            adminToken: 'admin-secret',
            rootDir: '/repo',
            packageBuilder,
        });
        const res = createMockDownloadResponse();

        await handler(
            {
                method: 'POST',
                headers: { authorization: 'Bearer admin-secret', host: 'farm.example.com' },
                body: { cloud_api_url: 'https://farm.example.com' },
            },
            res,
        );

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({
            ok: false,
            error: 'node_package_failed',
            message: 'local_node_token is required',
        });
        expect(packageBuilder).not.toHaveBeenCalled();
    });

    it('format=exe returns a redirect URL when FARM_NODE_EXE_URL is configured', async () => {
        const packageBuilder = vi.fn();
        const handler = createCloudNodePackageHandler({
            adminToken: 'admin-secret',
            rootDir: '/repo',
            packageBuilder,
            exeUrl: 'https://example.com/releases/farm-node.exe',
        });
        const res = createMockDownloadResponse();

        await handler(
            {
                method: 'POST',
                headers: { authorization: 'Bearer admin-secret', host: 'farm.example.com' },
                body: { format: 'exe', cloud_api_url: 'https://farm.example.com' },
            },
            res,
        );

        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({
            ok: true,
            format: 'exe',
            download_url: 'https://example.com/releases/farm-node.exe',
        });
        expect(packageBuilder).not.toHaveBeenCalled();
    });

    it('format=exe without a hosted URL or local exe returns 409 exe_not_built', async () => {
        const packageBuilder = vi.fn();
        const fsImpl = { existsSync: vi.fn().mockReturnValue(false) };
        const handler = createCloudNodePackageHandler({
            adminToken: 'admin-secret',
            rootDir: '/repo',
            packageBuilder,
            exeUrl: null,
            fsImpl,
        });
        const res = createMockDownloadResponse();

        await handler(
            {
                method: 'POST',
                headers: { authorization: 'Bearer admin-secret', host: 'farm.example.com' },
                body: { format: 'exe', cloud_api_url: 'https://farm.example.com' },
            },
            res,
        );

        expect(res.statusCode).toBe(409);
        expect(res.body).toMatchObject({ ok: false, error: 'exe_not_built', portable_available: true });
        expect(res.body.build_command).toBe('npm run build:node:exe');
        expect(packageBuilder).not.toHaveBeenCalled();
    });
});
