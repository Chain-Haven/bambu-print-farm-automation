import { describe, expect, it, vi } from 'vitest';
import { hashMerchantApiKey } from '../../src/cloud/merchantAuth.js';
import { createMerchantPrintJobLifecycleHandler } from '../../src/cloud/merchantLifecycleHandlers.js';

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

function createAuthStore(overrides = {}) {
    const keyHash = hashMerchantApiKey('pkx_live_secret', 'pepper');
    return {
        findMerchantApiKeyByHash: vi.fn().mockResolvedValue({
            key_id: 'key-1',
            merchant_id: 'merchant-1',
            org_id: 'org-1',
            key_hash: keyHash,
        }),
        findMerchantById: vi.fn().mockResolvedValue({
            merchant_id: 'merchant-1',
            org_id: 'org-1',
            status: 'active',
            metadata: { webhook: { enabled: false } },
        }),
        touchMerchantApiKey: vi.fn(),
        getMerchantPrintJob: vi.fn().mockResolvedValue({
            job_id: 'job-1',
            merchant_id: 'merchant-1',
            org_id: 'org-1',
            file_id: 'file-1',
            name: 'Order 1',
            status: 'needs_approval',
            options: { filament_reservation: { spool_id: 'spool-1' } },
            routing_summary: {},
        }),
        updatePrintJob: vi.fn().mockImplementation(async (jobId, fields) => ({ job_id: jobId, ...fields })),
        createPrintJob: vi.fn().mockImplementation(async (job) => ({ job_id: 'job-reprint', ...job })),
        createMerchantUsageEvent: vi.fn().mockResolvedValue({ usage_event_id: 'usage-1' }),
        getPlatformSetting: vi.fn().mockResolvedValue({
            spools: [{ spool_id: 'spool-1', material: 'PLA', color_hex: '#FFFFFF', reserved_for_job_id: 'job-1' }],
        }),
        upsertPlatformSetting: vi.fn().mockResolvedValue({ key: 'farm_filament_inventory' }),
        ...overrides,
    };
}

const now = () => new Date('2026-07-01T12:00:00.000Z');

describe('merchant print job lifecycle handler', () => {
    it('approves an approval-required print job and records usage', async () => {
        const store = createAuthStore();
        const handler = createMerchantPrintJobLifecycleHandler({ store, pepper: 'pepper', action: 'approve', now });
        const res = createMockResponse();

        await handler({
            method: 'POST',
            headers: { authorization: 'Bearer pkx_live_secret' },
            body: { job_id: 'job-1' },
        }, res);

        expect(store.updatePrintJob).toHaveBeenCalledWith('job-1', expect.objectContaining({
            status: 'queued',
            options: expect.objectContaining({
                approved_at: '2026-07-01T12:00:00.000Z',
            }),
        }));
        expect(store.createMerchantUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
            event_type: 'job.approved',
            quantity: 1,
        }));
        expect(res.statusCode).toBe(200);
        expect(res.body.job.status).toBe('queued');
    });

    it('cancels a job and releases reserved filament', async () => {
        const store = createAuthStore();
        const handler = createMerchantPrintJobLifecycleHandler({ store, pepper: 'pepper', action: 'cancel', now });
        const res = createMockResponse();

        await handler({
            method: 'POST',
            headers: { authorization: 'Bearer pkx_live_secret' },
            body: { job_id: 'job-1', reason: 'Customer changed order' },
        }, res);

        expect(store.updatePrintJob).toHaveBeenCalledWith('job-1', expect.objectContaining({
            status: 'canceled',
            options: expect.objectContaining({
                canceled_at: '2026-07-01T12:00:00.000Z',
                cancel_reason: 'Customer changed order',
            }),
        }));
        expect(store.upsertPlatformSetting).toHaveBeenCalledWith('farm_filament_inventory', {
            spools: [expect.objectContaining({ spool_id: 'spool-1', reserved_for_job_id: null })],
        });
        expect(res.statusCode).toBe(200);
    });

    it('creates a reprint request from an existing merchant job', async () => {
        const store = createAuthStore();
        const handler = createMerchantPrintJobLifecycleHandler({ store, pepper: 'pepper', action: 'reprint', now });
        const res = createMockResponse();

        await handler({
            method: 'POST',
            headers: { authorization: 'Bearer pkx_live_secret' },
            body: { job_id: 'job-1', reason: 'Defect replacement' },
        }, res);

        expect(store.createPrintJob).toHaveBeenCalledWith(expect.objectContaining({
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            file_id: 'file-1',
            name: 'Reprint: Order 1',
            status: 'reprint_requested',
            options: expect.objectContaining({
                source_job_id: 'job-1',
                reprint_reason: 'Defect replacement',
            }),
        }));
        expect(res.statusCode).toBe(201);
        expect(res.body.job.job_id).toBe('job-reprint');
    });
});
