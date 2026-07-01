import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { hashMerchantApiKey } from '../../src/cloud/merchantAuth.js';
import {
    createMerchantPrintJobStatusHandler,
    createMerchantPrintJobsHandler,
} from '../../src/cloud/merchantPrintHandlers.js';

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
            company_name: 'Widget Store',
        }),
        touchMerchantApiKey: vi.fn(),
        ...overrides,
    };
}

const now = () => new Date('2026-07-01T12:00:00.000Z');

describe('merchant print jobs handler', () => {
    it('accepts a ready project file, routes it, queues a node command, and tracks usage', async () => {
        const fileBytes = Buffer.from('project bytes');
        const checksum = createHash('sha256').update(fileBytes).digest('hex');
        const store = createAuthStore({
            uploadPrintArtifact: vi.fn().mockResolvedValue({ Key: 'print-artifacts/path' }),
            createJobFile: vi.fn().mockImplementation(async (file) => ({ file_id: 'file-1', ...file })),
            getCloudOverview: vi.fn().mockResolvedValue({
                nodes: [{ node_id: 'node-1', status: 'online' }],
                printers: [{
                    printer_id: 'printer-1',
                    node_id: 'node-1',
                    local_printer_id: 'local-printer-1',
                    status: 'online',
                    status_snapshot: { print: { gcode_state: 'IDLE' } },
                    capabilities: {
                        max_x: 256,
                        max_y: 256,
                        max_z: 256,
                        materials: ['PLA'],
                        colors: ['#FFFFFF'],
                    },
                }],
                jobs: [],
            }),
            createPrintJob: vi.fn().mockImplementation(async (job) => ({ job_id: 'job-1', ...job })),
            createRoutingDecision: vi.fn().mockResolvedValue({ decision_id: 'decision-1' }),
            createSignedPrintArtifactUrl: vi.fn().mockResolvedValue('https://signed.example/file'),
            createNodeCommand: vi.fn().mockResolvedValue({ command_id: 'command-1' }),
            createMerchantUsageEvent: vi.fn().mockResolvedValue({ usage_event_id: 'usage-1' }),
        });
        const handler = createMerchantPrintJobsHandler({ store, pepper: 'pepper', now });
        const res = createMockResponse();

        await handler({
            method: 'POST',
            headers: { authorization: 'Bearer pkx_live_secret' },
            body: {
                name: 'Order 1001',
                file: {
                    name: 'part.gcode.3mf',
                    content_type: 'application/octet-stream',
                    base64: fileBytes.toString('base64'),
                },
                requirements: {
                    dimensions_mm: { x: 100, y: 100, z: 100 },
                    materials: ['PLA'],
                    colors: ['#fff'],
                },
                options: { merchant_order_id: '1001' },
            },
        }, res);

        expect(store.uploadPrintArtifact).toHaveBeenCalledWith(
            expect.stringMatching(/^org-1\/merchant-1\/20260701T120000000Z-[a-f0-9]{12}-part\.gcode\.3mf$/),
            fileBytes,
            'application/octet-stream',
        );
        expect(store.createJobFile).toHaveBeenCalledWith(expect.objectContaining({
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            original_name: 'part.gcode.3mf',
            byte_size: fileBytes.length,
            checksum_sha256: checksum,
            file_mode: 'ready_to_print',
        }));
        expect(store.getCloudOverview).toHaveBeenCalledWith({ orgId: 'org-1', limit: 100 });
        expect(store.createPrintJob).toHaveBeenCalledWith(expect.objectContaining({
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            file_id: 'file-1',
            name: 'Order 1001',
            status: 'queued',
            node_id: 'node-1',
            printer_id: 'printer-1',
        }));
        expect(store.createRoutingDecision).toHaveBeenCalledWith(expect.objectContaining({
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            job_id: 'job-1',
            selected_node_id: 'node-1',
            selected_printer_id: 'printer-1',
            status: 'routed',
            strategy: 'fastest_fulfillment',
        }));
        expect(store.createSignedPrintArtifactUrl).toHaveBeenCalledWith(expect.any(String), 3600);
        expect(store.createNodeCommand).toHaveBeenCalledWith(expect.objectContaining({
            org_id: 'org-1',
            node_id: 'node-1',
            printer_id: 'printer-1',
            job_id: 'job-1',
            command_type: 'cloud.print.ready',
            payload: expect.objectContaining({
                local_printer_id: 'local-printer-1',
                download_url: 'https://signed.example/file',
                storage_path: expect.any(String),
                original_name: 'part.gcode.3mf',
            }),
        }));
        expect(store.createMerchantUsageEvent.mock.calls.map(([event]) => event.event_type)).toEqual([
            'file.uploaded',
            'job.submitted',
        ]);
        expect(res.statusCode).toBe(201);
        expect(res.body).toMatchObject({
            ok: true,
            job: { job_id: 'job-1', status: 'queued' },
            routing: { status: 'routed', selected_printer_id: 'printer-1' },
        });
    });

    it('accepts source models but marks them as needing slicing before routing or commands', async () => {
        const fileBytes = Buffer.from('solid model');
        const store = createAuthStore({
            uploadPrintArtifact: vi.fn().mockResolvedValue({ Key: 'print-artifacts/path' }),
            createJobFile: vi.fn().mockImplementation(async (file) => ({ file_id: 'file-1', ...file })),
            createPrintJob: vi.fn().mockImplementation(async (job) => ({ job_id: 'job-1', ...job })),
            getCloudOverview: vi.fn(),
            createRoutingDecision: vi.fn(),
            createSignedPrintArtifactUrl: vi.fn(),
            createNodeCommand: vi.fn(),
            createMerchantUsageEvent: vi.fn().mockResolvedValue({ usage_event_id: 'usage-1' }),
        });
        const handler = createMerchantPrintJobsHandler({ store, pepper: 'pepper', now });
        const res = createMockResponse();

        await handler({
            method: 'POST',
            headers: { authorization: 'Bearer pkx_live_secret' },
            body: {
                file: {
                    name: 'bracket.stl',
                    content_type: 'model/stl',
                    base64: fileBytes.toString('base64'),
                },
            },
        }, res);

        expect(store.uploadPrintArtifact).toHaveBeenCalledWith(
            expect.stringMatching(/^org-1\/merchant-1\/20260701T120000000Z-[a-f0-9]{12}-bracket\.stl$/),
            fileBytes,
            'application/octet-stream',
        );
        expect(store.createJobFile).toHaveBeenCalledWith(expect.objectContaining({
            original_name: 'bracket.stl',
            content_type: 'application/octet-stream',
            file_mode: 'source_model',
        }));
        expect(store.createPrintJob).toHaveBeenCalledWith(expect.objectContaining({
            name: 'bracket.stl',
            status: 'needs_slicing',
            node_id: null,
            printer_id: null,
        }));
        expect(store.getCloudOverview).not.toHaveBeenCalled();
        expect(store.createNodeCommand).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(201);
        expect(res.body).toMatchObject({
            ok: true,
            job: { status: 'needs_slicing' },
            routing: null,
        });
    });

    it('records waiting-for-capacity jobs when no printer matches', async () => {
        const fileBytes = Buffer.from('project bytes');
        const store = createAuthStore({
            uploadPrintArtifact: vi.fn().mockResolvedValue({ Key: 'print-artifacts/path' }),
            createJobFile: vi.fn().mockImplementation(async (file) => ({ file_id: 'file-1', ...file })),
            getCloudOverview: vi.fn().mockResolvedValue({
                nodes: [{ node_id: 'node-1', status: 'online' }],
                printers: [{
                    printer_id: 'printer-1',
                    node_id: 'node-1',
                    status: 'online',
                    status_snapshot: { print: { gcode_state: 'IDLE' } },
                    capabilities: { max_x: 180, max_y: 180, max_z: 180 },
                }],
                jobs: [],
            }),
            createPrintJob: vi.fn().mockImplementation(async (job) => ({ job_id: 'job-1', ...job })),
            createRoutingDecision: vi.fn().mockResolvedValue({ decision_id: 'decision-1' }),
            createSignedPrintArtifactUrl: vi.fn(),
            createNodeCommand: vi.fn(),
            createMerchantUsageEvent: vi.fn().mockResolvedValue({ usage_event_id: 'usage-1' }),
        });
        const handler = createMerchantPrintJobsHandler({ store, pepper: 'pepper', now });
        const res = createMockResponse();

        await handler({
            method: 'POST',
            headers: { authorization: 'Bearer pkx_live_secret' },
            body: {
                file: {
                    name: 'part.gcode.3mf',
                    base64: fileBytes.toString('base64'),
                },
                requirements: {
                    dimensions_mm: { x: 220, y: 120, z: 120 },
                },
            },
        }, res);

        expect(store.createPrintJob).toHaveBeenCalledWith(expect.objectContaining({
            status: 'waiting_for_capacity',
            node_id: null,
            printer_id: null,
        }));
        expect(store.createRoutingDecision).toHaveBeenCalledWith(expect.objectContaining({
            status: 'no_capacity',
            rejected_candidates: [expect.objectContaining({ reasons: ['build_volume_too_small'] })],
        }));
        expect(store.createNodeCommand).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(201);
        expect(res.body.routing.status).toBe('no_capacity');
    });

    it('lists merchant print jobs with a capped limit', async () => {
        const store = createAuthStore({
            listMerchantPrintJobs: vi.fn().mockResolvedValue([{ job_id: 'job-1', merchant_id: 'merchant-1' }]),
        });
        const handler = createMerchantPrintJobsHandler({ store, pepper: 'pepper', now });
        const res = createMockResponse();

        await handler({
            method: 'GET',
            headers: { authorization: 'Bearer pkx_live_secret' },
            query: { limit: '500' },
        }, res);

        expect(store.listMerchantPrintJobs).toHaveBeenCalledWith({ merchantId: 'merchant-1', limit: 100 });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ ok: true, jobs: [{ job_id: 'job-1', merchant_id: 'merchant-1' }] });
    });
});

describe('merchant print job status handler', () => {
    it('returns one merchant-scoped print job by id', async () => {
        const store = createAuthStore({
            getMerchantPrintJob: vi.fn().mockResolvedValue({
                job_id: 'job-1',
                merchant_id: 'merchant-1',
                status: 'queued',
            }),
        });
        const handler = createMerchantPrintJobStatusHandler({ store, pepper: 'pepper', now });
        const res = createMockResponse();

        await handler({
            method: 'GET',
            headers: { authorization: 'Bearer pkx_live_secret' },
            query: { job_id: ' job-1 ' },
        }, res);

        expect(store.getMerchantPrintJob).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            jobId: 'job-1',
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            ok: true,
            job: {
                job_id: 'job-1',
                merchant_id: 'merchant-1',
                status: 'queued',
            },
        });
    });
});
