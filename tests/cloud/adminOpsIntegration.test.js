import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMemoryCloudStore } from '../../src/cloud/memoryCloudStore.js';
import { startLocalCloudServer } from '../../src/cloud/localCloudServer.js';

// Full-HTTP proof that the operator console's admin surface works self-hosted:
// the new ops endpoints (jobs / stats / audit) plus the merchant drill-down
// routes that previously existed only as Vercel functions.

const ADMIN_TOKEN = 'test-admin-token';
const PEPPER = 'test-pepper';

let server;
let store;
let baseUrl;

async function api(path, { method = 'GET', body } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${ADMIN_TOKEN}`,
            'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, payload: await response.json() };
}

beforeAll(async () => {
    store = createMemoryCloudStore();
    server = await startLocalCloudServer({ store, adminToken: ADMIN_TOKEN, pepper: PEPPER });
    baseUrl = server.baseUrl;
});

afterAll(async () => {
    await server?.close();
});

describe('self-hosted admin ops endpoints', () => {
    it('serves jobs, stats, and audit over HTTP with filters and actions', async () => {
        const org = await store.createOrganization({ name: 'Farm' });
        const node = await store.createFarmNode({ org_id: org.org_id, name: 'NUC', token_hash: 'hash' });
        const printing = await store.createPrintJob({
            org_id: org.org_id,
            node_id: node.node_id,
            printer_id: 'printer-uuid',
            name: 'Benchy',
            status: 'printing',
            options: {},
            routing_summary: { selected_local_printer_id: 'printer-1' },
        });
        await store.createPrintJob({ org_id: org.org_id, name: 'Waiting Part', status: 'waiting_for_capacity' });

        const list = await api('/api/cloud/jobs?status=printing');
        expect(list.status).toBe(200);
        expect(list.payload.jobs).toHaveLength(1);
        expect(list.payload.jobs[0].name).toBe('Benchy');

        const search = await api('/api/cloud/jobs?q=waiting');
        expect(search.payload.jobs).toHaveLength(1);
        expect(search.payload.jobs[0].status).toBe('waiting_for_capacity');

        const cancel = await api('/api/cloud/jobs', {
            method: 'POST',
            body: { action: 'cancel', job_id: printing.job_id, reason: 'test' },
        });
        expect(cancel.status).toBe(200);
        expect(cancel.payload.job.status).toBe('canceled');
        expect(cancel.payload.stop_dispatched).toBe(true);

        const stats = await api('/api/cloud/stats');
        expect(stats.status).toBe(200);
        expect(stats.payload.stats.jobs.by_status.canceled).toBe(1);
        expect(stats.payload.stats.jobs.by_status.waiting_for_capacity).toBe(1);

        const audit = await api('/api/cloud/audit');
        expect(audit.status).toBe(200);
        expect(audit.payload.entries.some((entry) => entry.action === 'job.cancel')).toBe(true);
    });

    it('serves the merchant drill-down routes that used to be Vercel-only', async () => {
        const org = await store.createOrganization({ name: 'Farm 2' });
        const merchant = await store.createMerchant({
            org_id: org.org_id,
            status: 'active',
            company_name: 'Shop',
            contact_email: 'shop@example.com',
        });

        const keys = await api(`/api/cloud/merchant-api-keys?merchant_id=${merchant.merchant_id}`);
        expect(keys.status).toBe(200);
        expect(keys.payload.api_keys).toEqual([]);

        const created = await api('/api/cloud/merchant-api-keys', {
            method: 'POST',
            body: { merchant_id: merchant.merchant_id, name: 'Production' },
        });
        expect(created.status).toBe(201);
        expect(created.payload.api_key_secret).toMatch(/^pkx_live_/);

        const jobs = await api(`/api/cloud/merchant-jobs?merchant_id=${merchant.merchant_id}`);
        expect(jobs.status).toBe(200);
        expect(jobs.payload.jobs).toEqual([]);

        const usage = await api(`/api/cloud/merchant-usage?merchant_id=${merchant.merchant_id}`);
        expect(usage.status).toBe(200);
        expect(usage.payload.usage).toEqual([]);

        const v2 = await api(`/api/cloud/merchant-v2?merchant_id=${merchant.merchant_id}`);
        expect(v2.status).toBe(200);
        expect(v2.payload.v2.orders).toEqual([]);
    });
});
