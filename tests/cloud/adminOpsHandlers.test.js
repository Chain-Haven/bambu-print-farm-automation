import { describe, expect, it, vi } from 'vitest';
import {
    createCloudAuditLogHandler,
    createCloudJobsHandler,
    createCloudStatsHandler,
} from '../../src/cloud/adminOpsHandlers.js';
import { createMemoryCloudStore } from '../../src/cloud/memoryCloudStore.js';

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

const authed = (extra = {}) => ({
    headers: { authorization: 'Bearer admin-secret' },
    ...extra,
});

describe('cloud jobs handler', () => {
    it('rejects requests without an admin token', async () => {
        const store = { listPrintJobsAdmin: vi.fn() };
        const handler = createCloudJobsHandler({ store, adminToken: 'admin-secret' });
        const res = createMockResponse();

        await handler({ method: 'GET', headers: {}, query: {} }, res);

        expect(res.statusCode).toBe(401);
        expect(store.listPrintJobsAdmin).not.toHaveBeenCalled();
    });

    it('lists jobs with status, merchant, search, and pagination filters', async () => {
        const store = {
            listPrintJobsAdmin: vi.fn().mockResolvedValue([{ job_id: 'job-1' }]),
        };
        const handler = createCloudJobsHandler({ store, adminToken: 'admin-secret' });
        const res = createMockResponse();

        await handler(authed({
            method: 'GET',
            query: {
                status: 'printing, queued',
                merchant_id: 'merch-1',
                q: 'bench',
                limit: '25',
                offset: '50',
            },
        }), res);

        expect(store.listPrintJobsAdmin).toHaveBeenCalledWith({
            orgId: null,
            merchantId: 'merch-1',
            statuses: ['printing', 'queued'],
            search: 'bench',
            limit: 25,
            offset: 50,
        });
        expect(res.statusCode).toBe(200);
        expect(res.body.jobs).toEqual([{ job_id: 'job-1' }]);
        expect(res.body.paging).toEqual({ limit: 25, offset: 50, returned: 1 });
    });

    it('cancels a job, queues printer.stop, and records the audit entry', async () => {
        const store = createMemoryCloudStore();
        const org = await store.createOrganization({ name: 'Farm' });
        const node = await store.createFarmNode({ org_id: org.org_id, name: 'NUC', token_hash: 'hash' });
        const job = await store.createPrintJob({
            org_id: org.org_id,
            node_id: node.node_id,
            printer_id: 'printer-uuid',
            name: 'Benchy',
            status: 'printing',
            options: {},
            routing_summary: { selected_local_printer_id: 'printer-1' },
        });

        const handler = createCloudJobsHandler({ store, adminToken: 'admin-secret' });
        const res = createMockResponse();
        await handler(authed({
            method: 'POST',
            body: { action: 'cancel', job_id: job.job_id, reason: 'operator request' },
        }), res);

        expect(res.statusCode).toBe(200);
        expect(res.body.job.status).toBe('canceled');
        expect(res.body.job.options.cancel_reason).toBe('operator request');
        expect(res.body.stop_dispatched).toBe(true);

        const commands = await store.listNodeCommands({ nodeId: node.node_id });
        expect(commands).toHaveLength(1);
        expect(commands[0].command_type).toBe('printer.stop');
        expect(commands[0].payload.local_printer_id).toBe('printer-1');

        const audit = await store.listAuditLogEntries({});
        expect(audit.some((entry) => entry.action === 'job.cancel' && entry.target_id === job.job_id)).toBe(true);
    });

    it('refuses to cancel a job that is already terminal', async () => {
        const store = createMemoryCloudStore();
        const job = await store.createPrintJob({ org_id: 'org-1', name: 'Done', status: 'completed' });

        const handler = createCloudJobsHandler({ store, adminToken: 'admin-secret' });
        const res = createMockResponse();
        await handler(authed({ method: 'POST', body: { action: 'cancel', job_id: job.job_id } }), res);

        expect(res.statusCode).toBe(409);
        expect(res.body.error).toBe('job_not_cancelable');
    });

    it('404s when canceling a job that does not exist', async () => {
        const store = createMemoryCloudStore();
        const handler = createCloudJobsHandler({ store, adminToken: 'admin-secret' });
        const res = createMockResponse();

        await handler(authed({ method: 'POST', body: { action: 'cancel', job_id: 'missing' } }), res);

        expect(res.statusCode).toBe(404);
        expect(res.body.error).toBe('job_not_found');
    });

    it('refuses to redispatch a job that is not waiting for capacity', async () => {
        const store = createMemoryCloudStore();
        const job = await store.createPrintJob({ org_id: 'org-1', name: 'Live', status: 'printing' });

        const handler = createCloudJobsHandler({ store, adminToken: 'admin-secret' });
        const res = createMockResponse();
        await handler(authed({ method: 'POST', body: { action: 'redispatch', job_id: job.job_id } }), res);

        expect(res.statusCode).toBe(409);
        expect(res.body.error).toBe('job_not_waiting');
    });

    it('rejects unknown actions', async () => {
        const store = createMemoryCloudStore();
        const handler = createCloudJobsHandler({ store, adminToken: 'admin-secret' });
        const res = createMockResponse();

        await handler(authed({ method: 'POST', body: { action: 'explode', job_id: 'job-1' } }), res);

        expect(res.statusCode).toBe(400);
        expect(res.body.error).toBe('invalid_job_action');
    });
});

describe('cloud stats handler', () => {
    it('returns aggregated counts from the store', async () => {
        const store = createMemoryCloudStore();
        const org = await store.createOrganization({ name: 'Farm' });
        await store.createFarmNode({ org_id: org.org_id, name: 'NUC', token_hash: 'hash' });
        await store.createPrintJob({ org_id: org.org_id, name: 'A', status: 'printing' });
        await store.createPrintJob({ org_id: org.org_id, name: 'B', status: 'completed' });
        await store.createMerchant({ org_id: org.org_id, status: 'pending', company_name: 'Shop' });

        const handler = createCloudStatsHandler({ store, adminToken: 'admin-secret' });
        const res = createMockResponse();
        await handler(authed({ method: 'GET', query: {} }), res);

        expect(res.statusCode).toBe(200);
        expect(res.body.stats.jobs.total).toBe(2);
        expect(res.body.stats.jobs.by_status).toEqual({ printing: 1, completed: 1 });
        expect(res.body.stats.jobs.created_last_24h).toBe(2);
        expect(res.body.stats.nodes.total).toBe(1);
        expect(res.body.stats.merchants.by_status).toEqual({ pending: 1 });
        expect(typeof res.body.stats.generated_at).toBe('string');
    });

    it('degrades gracefully when the store has no stats surface', async () => {
        const handler = createCloudStatsHandler({ store: {}, adminToken: 'admin-secret' });
        const res = createMockResponse();
        await handler(authed({ method: 'GET', query: {} }), res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ ok: true, stats: null, supported: false });
    });
});

describe('cloud audit log handler', () => {
    it('lists recorded audit entries newest first with filters', async () => {
        const store = createMemoryCloudStore();
        await store.recordAuditLogEntry({ action: 'merchant.approve', actor_email: 'ops@example.com', target_type: 'merchant', target_id: 'm-1' });
        await store.recordAuditLogEntry({ action: 'node.delete', actor_email: 'ops@example.com', target_type: 'node', target_id: 'n-1' });

        const handler = createCloudAuditLogHandler({ store, adminToken: 'admin-secret' });
        const res = createMockResponse();
        await handler(authed({ method: 'GET', query: {} }), res);

        expect(res.statusCode).toBe(200);
        expect(res.body.entries).toHaveLength(2);
        expect(res.body.entries[0].action).toBe('node.delete');

        const filtered = createMockResponse();
        await handler(authed({ method: 'GET', query: { action: 'merchant.approve' } }), filtered);
        expect(filtered.body.entries).toHaveLength(1);
        expect(filtered.body.entries[0].target_id).toBe('m-1');
    });

    it('reports pending_migration instead of failing when the audit table is missing', async () => {
        const missingTable = Object.assign(new Error('Supabase table is not available: admin_audit_log'), {
            name: 'SupabaseMissingTableError',
        });
        const store = { listAuditLogEntries: vi.fn().mockRejectedValue(missingTable) };
        const handler = createCloudAuditLogHandler({ store, adminToken: 'admin-secret' });
        const res = createMockResponse();

        await handler(authed({ method: 'GET', query: {} }), res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ ok: true, entries: [], pending_migration: true });
    });

    it('degrades gracefully when the store has no audit surface', async () => {
        const handler = createCloudAuditLogHandler({ store: {}, adminToken: 'admin-secret' });
        const res = createMockResponse();
        await handler(authed({ method: 'GET', query: {} }), res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ ok: true, entries: [], supported: false });
    });
});

describe('admin mutations record audit entries', () => {
    it('audits merchant status changes made through the admin merchants handler', async () => {
        const { createCloudMerchantsHandler } = await import('../../src/cloud/adminHandlers.js');
        const store = createMemoryCloudStore();
        const merchant = await store.createMerchant({ org_id: 'org-1', status: 'pending', company_name: 'Shop' });

        const handler = createCloudMerchantsHandler({
            store,
            adminToken: 'admin-secret',
            merchantPepper: 'pepper',
        });
        const res = createMockResponse();
        await handler(authed({
            method: 'POST',
            body: { merchant_id: merchant.merchant_id, action: 'approve' },
        }), res);

        expect(res.statusCode).toBe(200);
        const audit = await store.listAuditLogEntries({ action: 'merchant.approve' });
        expect(audit).toHaveLength(1);
        expect(audit[0].target_id).toBe(merchant.merchant_id);
        expect(audit[0].actor_email).toBe('bootstrap');
        expect(audit[0].detail.status).toBe('active');
    });

    it('audits node deletion', async () => {
        const { createCloudNodeProvisionHandler } = await import('../../src/cloud/adminHandlers.js');
        const store = createMemoryCloudStore();
        const org = await store.createOrganization({ name: 'Farm' });
        const node = await store.createFarmNode({ org_id: org.org_id, name: 'NUC', token_hash: 'hash' });

        const handler = createCloudNodeProvisionHandler({
            store,
            adminToken: 'admin-secret',
            pepper: 'pepper',
        });
        const res = createMockResponse();
        await handler(authed({ method: 'DELETE', query: { node_id: node.node_id }, body: {} }), res);

        expect(res.statusCode).toBe(200);
        const audit = await store.listAuditLogEntries({ action: 'node.delete' });
        expect(audit).toHaveLength(1);
        expect(audit[0].target_id).toBe(node.node_id);
    });

    it('never lets a failing audit store break the underlying action', async () => {
        const { createCloudMerchantsHandler } = await import('../../src/cloud/adminHandlers.js');
        const store = createMemoryCloudStore();
        const merchant = await store.createMerchant({ org_id: 'org-1', status: 'pending', company_name: 'Shop' });
        store.recordAuditLogEntry = vi.fn().mockRejectedValue(new Error('audit table down'));

        const handler = createCloudMerchantsHandler({
            store,
            adminToken: 'admin-secret',
            merchantPepper: 'pepper',
        });
        const res = createMockResponse();
        await handler(authed({
            method: 'POST',
            body: { merchant_id: merchant.merchant_id, action: 'suspend' },
        }), res);

        expect(res.statusCode).toBe(200);
        expect(res.body.merchant.status).toBe('suspended');
    });
});

describe('node command history listing', () => {
    it('lists a node command history through GET /api/cloud/commands?node_id=', async () => {
        const { createCloudCommandHandler } = await import('../../src/cloud/adminHandlers.js');
        const store = createMemoryCloudStore();
        const org = await store.createOrganization({ name: 'Farm' });
        const node = await store.createFarmNode({ org_id: org.org_id, name: 'NUC', token_hash: 'hash' });
        await store.createNodeCommand({ org_id: org.org_id, node_id: node.node_id, command_type: 'printer.status', payload: {} });
        await store.createNodeCommand({ org_id: org.org_id, node_id: node.node_id, command_type: 'printer.stop', payload: {} });

        const handler = createCloudCommandHandler({ store, adminToken: 'admin-secret' });
        const res = createMockResponse();
        await handler(authed({ method: 'GET', query: { node_id: node.node_id } }), res);

        expect(res.statusCode).toBe(200);
        expect(res.body.commands).toHaveLength(2);

        const filtered = createMockResponse();
        await handler(authed({ method: 'GET', query: { node_id: node.node_id, command_type: 'printer.stop' } }), filtered);
        expect(filtered.body.commands).toHaveLength(1);
        expect(filtered.body.commands[0].command_type).toBe('printer.stop');
    });
});
