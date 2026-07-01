import { describe, expect, it, vi } from 'vitest';
import { hashMerchantApiKey } from '../../src/cloud/merchantAuth.js';
import {
    createCloudMerchantJobsHandler,
    createCloudMerchantSettingsHandler,
    createCloudMerchantSetupTokenHandler,
    createCloudMerchantUsageHandler,
    createCloudMerchantsHandler,
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

const now = () => new Date('2026-07-01T12:00:00.000Z');

describe('cloud merchant admin handler', () => {
    it('lists merchants by status with an admin token', async () => {
        const merchants = [{ merchant_id: 'merchant-1', status: 'pending' }];
        const store = {
            listMerchants: vi.fn().mockResolvedValue(merchants),
        };
        const handler = createCloudMerchantsHandler({ store, adminToken: 'admin-secret' });
        const res = createMockResponse();

        await handler({
            method: 'GET',
            headers: { authorization: 'Bearer admin-secret' },
            query: { status: 'pending', limit: '500' },
        }, res);

        expect(store.listMerchants).toHaveBeenCalledWith({ status: 'pending', limit: 100 });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ ok: true, merchants });
    });

    it('approves merchants and can issue a one-time setup token in the same action', async () => {
        const merchant = {
            merchant_id: 'merchant-1',
            org_id: 'org-1',
            status: 'active',
        };
        const store = {
            updateMerchantStatus: vi.fn().mockResolvedValue(merchant),
            createMerchantSetupToken: vi.fn().mockResolvedValue({
                setup_token_id: 'setup-1',
                token_prefix: 'pkx_setup_secret',
            }),
        };
        const handler = createCloudMerchantsHandler({
            store,
            adminToken: 'admin-secret',
            merchantPepper: 'pepper',
            now,
            setupTokenFactory: () => 'pkx_setup_secret',
        });
        const res = createMockResponse();

        await handler({
            method: 'POST',
            headers: { authorization: 'Bearer admin-secret' },
            body: {
                merchant_id: 'merchant-1',
                action: 'approve',
                issue_setup_token: true,
            },
        }, res);

        expect(store.updateMerchantStatus).toHaveBeenCalledWith('merchant-1', {
            status: 'active',
            approvedAt: '2026-07-01T12:00:00.000Z',
            rejectedAt: null,
            metadata: null,
        });
        expect(store.createMerchantSetupToken).toHaveBeenCalledWith({
            merchant_id: 'merchant-1',
            org_id: 'org-1',
            token_prefix: 'pkx_setup_secret',
            token_hash: hashMerchantApiKey('pkx_setup_secret', 'pepper'),
            expires_at: '2026-07-08T12:00:00.000Z',
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            ok: true,
            merchant,
            merchant_setup_token: 'pkx_setup_secret',
            setup_token_expires_at: '2026-07-08T12:00:00.000Z',
        });
    });

    it('rejects merchants without issuing credentials', async () => {
        const merchant = { merchant_id: 'merchant-1', status: 'rejected' };
        const store = {
            updateMerchantStatus: vi.fn().mockResolvedValue(merchant),
            createMerchantSetupToken: vi.fn(),
        };
        const handler = createCloudMerchantsHandler({ store, adminToken: 'admin-secret', now });
        const res = createMockResponse();

        await handler({
            method: 'POST',
            headers: { authorization: 'Bearer admin-secret' },
            body: {
                merchant_id: 'merchant-1',
                action: 'reject',
            },
        }, res);

        expect(store.updateMerchantStatus).toHaveBeenCalledWith('merchant-1', {
            status: 'rejected',
            approvedAt: null,
            rejectedAt: '2026-07-01T12:00:00.000Z',
            metadata: null,
        });
        expect(store.createMerchantSetupToken).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ ok: true, merchant });
    });
});

describe('cloud merchant setup token handler', () => {
    it('issues one-time setup tokens for already-active merchants', async () => {
        const merchant = {
            merchant_id: 'merchant-1',
            org_id: 'org-1',
            status: 'active',
        };
        const store = {
            findMerchantById: vi.fn().mockResolvedValue(merchant),
            createMerchantSetupToken: vi.fn().mockResolvedValue({ setup_token_id: 'setup-1' }),
        };
        const handler = createCloudMerchantSetupTokenHandler({
            store,
            adminToken: 'admin-secret',
            merchantPepper: 'pepper',
            now,
            setupTokenFactory: () => 'pkx_setup_secret',
        });
        const res = createMockResponse();

        await handler({
            method: 'POST',
            headers: { authorization: 'Bearer admin-secret' },
            body: { merchant_id: 'merchant-1' },
        }, res);

        expect(store.findMerchantById).toHaveBeenCalledWith('merchant-1');
        expect(store.createMerchantSetupToken).toHaveBeenCalledWith(expect.objectContaining({
            merchant_id: 'merchant-1',
            token_hash: hashMerchantApiKey('pkx_setup_secret', 'pepper'),
        }));
        expect(res.statusCode).toBe(201);
        expect(res.body).toEqual({
            ok: true,
            merchant_id: 'merchant-1',
            merchant_setup_token: 'pkx_setup_secret',
            setup_token_expires_at: '2026-07-08T12:00:00.000Z',
        });
    });
});

describe('cloud merchant settings handler', () => {
    it('reads and updates full-auto merchant mode', async () => {
        const store = {
            getPlatformSetting: vi.fn().mockResolvedValueOnce({ enabled: false }),
            upsertPlatformSetting: vi.fn().mockResolvedValueOnce({
                key: 'full_auto_merchant_mode',
                value: { enabled: true },
            }),
        };
        const handler = createCloudMerchantSettingsHandler({ store, adminToken: 'admin-secret' });
        const getRes = createMockResponse();
        const patchRes = createMockResponse();

        await handler({
            method: 'GET',
            headers: { authorization: 'Bearer admin-secret' },
        }, getRes);
        await handler({
            method: 'PATCH',
            headers: { authorization: 'Bearer admin-secret' },
            body: { full_auto_merchant_mode: true },
        }, patchRes);

        expect(getRes.body).toEqual({
            ok: true,
            settings: { full_auto_merchant_mode: { enabled: false } },
        });
        expect(store.upsertPlatformSetting).toHaveBeenCalledWith('full_auto_merchant_mode', { enabled: true });
        expect(patchRes.body).toEqual({
            ok: true,
            settings: { full_auto_merchant_mode: { enabled: true } },
        });
    });
});

describe('cloud merchant jobs and usage handlers', () => {
    it('lists merchant jobs and usage by merchant id', async () => {
        const store = {
            listMerchantPrintJobs: vi.fn().mockResolvedValue([{ job_id: 'job-1' }]),
            listMerchantUsageEvents: vi.fn().mockResolvedValue([{ usage_event_id: 'usage-1' }]),
        };
        const jobsHandler = createCloudMerchantJobsHandler({ store, adminToken: 'admin-secret' });
        const usageHandler = createCloudMerchantUsageHandler({ store, adminToken: 'admin-secret' });
        const jobsRes = createMockResponse();
        const usageRes = createMockResponse();

        await jobsHandler({
            method: 'GET',
            headers: { authorization: 'Bearer admin-secret' },
            query: { merchant_id: 'merchant-1', limit: '500' },
        }, jobsRes);
        await usageHandler({
            method: 'GET',
            headers: { authorization: 'Bearer admin-secret' },
            query: { merchant_id: 'merchant-1', limit: '500' },
        }, usageRes);

        expect(store.listMerchantPrintJobs).toHaveBeenCalledWith({ merchantId: 'merchant-1', limit: 100 });
        expect(store.listMerchantUsageEvents).toHaveBeenCalledWith({ merchantId: 'merchant-1', limit: 100 });
        expect(jobsRes.body).toEqual({ ok: true, jobs: [{ job_id: 'job-1' }] });
        expect(usageRes.body).toEqual({ ok: true, usage: [{ usage_event_id: 'usage-1' }] });
    });
});
