import { describe, expect, it, vi } from 'vitest';
import { createSliceHandlers } from '../../src/cloud/merchantSlices.js';

const now = () => new Date('2026-07-01T12:00:00.000Z');

function createMockStore(overrides = {}) {
    return {
        getMerchantFile: vi.fn().mockImplementation(async ({ fileId }) => {
            if (fileId === 'missing-file') return null;
            return {
                file_id: fileId,
                org_id: 'org-1',
                merchant_id: 'merchant-1',
                original_name: 'part.stl',
                file_mode: 'source_model',
                status: 'uploaded',
                storage_path: 'org-1/merchant-1/files/source-file/part.stl',
            };
        }),
        createMerchantSliceJob: vi.fn().mockImplementation(async (sliceJob) => sliceJob),
        getMerchantSliceJob: vi.fn().mockImplementation(async ({ sliceJobId }) => ({
            slice_job_id: sliceJobId,
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            file_id: 'source-file',
            status: 'completed_mock',
            result: { provider: 'mock' },
        })),
        updateMerchantSliceJob: vi.fn().mockImplementation(async ({ sliceJobId, fields }) => ({
            slice_job_id: sliceJobId,
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            file_id: 'source-file',
            result: { provider: 'mock' },
            ...fields,
        })),
        createMerchantJobArtifact: vi.fn().mockImplementation(async (artifact) => artifact),
        ...overrides,
    };
}

function createMockAdapters(overrides = {}) {
    return {
        slicer: {
            createSliceJob: vi.fn().mockImplementation(async ({
                merchant,
                sourceFile,
                profile,
                requirements,
            }) => ({
                provider: 'mock',
                slice_job_id: 'slice1',
                merchant_id: merchant.merchant_id,
                org_id: merchant.org_id,
                file_id: sourceFile.file_id,
                status: 'completed_mock',
                profile,
                requirements,
                created_at: '2026-07-01T12:00:00.000Z',
                updated_at: '2026-07-01T12:00:00.000Z',
                completed_at: '2026-07-01T12:00:00.000Z',
                artifact: {
                    provider: 'mock',
                    artifact_id: 'artifact1',
                    slice_job_id: 'slice1',
                    merchant_id: merchant.merchant_id,
                    org_id: merchant.org_id,
                    file_id: sourceFile.file_id,
                    original_name: 'part.mock-sliced.gcode.3mf',
                    content_type: 'model/3mf',
                    storage_path: 'internal/mock/path/part.gcode.3mf',
                    created_at: '2026-07-01T12:00:00.000Z',
                },
            })),
        },
        ...overrides,
    };
}

function createHandlers(overrides = {}) {
    const store = createMockStore(overrides.store);
    const adapters = createMockAdapters(overrides.adapters);
    const authenticateMerchant = vi.fn().mockResolvedValue({
        merchant: {
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            status: 'active',
        },
    });

    return {
        store,
        adapters,
        authenticateMerchant,
        ...createSliceHandlers({
            store,
            adapters,
            authenticateMerchant,
            now,
        }),
    };
}

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
        end(payload) {
            this.body = payload ? JSON.parse(payload) : null;
            return this;
        },
    };
}

async function importSlicesIndexRoute(store = createMockStore()) {
    vi.resetModules();
    vi.doMock('../../src/cloud/supabaseRest.js', () => ({
        createSupabaseRestClient: vi.fn(() => store),
    }));
    const route = await import('../../api/public/slices/index.js');
    vi.doUnmock('../../src/cloud/supabaseRest.js');
    return route.default;
}

async function importSliceDetailRoute(store = createMockStore()) {
    vi.resetModules();
    vi.doMock('../../src/cloud/supabaseRest.js', () => ({
        createSupabaseRestClient: vi.fn(() => store),
    }));
    const route = await import('../../api/public/slices/[slice_id].js');
    vi.doUnmock('../../src/cloud/supabaseRest.js');
    return route.default;
}

async function importSliceCancelRoute(store = createMockStore()) {
    vi.resetModules();
    vi.doMock('../../src/cloud/supabaseRest.js', () => ({
        createSupabaseRestClient: vi.fn(() => store),
    }));
    const route = await import('../../api/public/slices/[slice_id]/cancel.js');
    vi.doUnmock('../../src/cloud/supabaseRest.js');
    return route.default;
}

describe('merchant slicing API handlers', () => {
    it('creates, reads, and cancels merchant-scoped slice jobs', async () => {
        const {
            createSlice,
            getSlice,
            cancelSlice,
            store,
            adapters,
        } = createHandlers();

        expect(await createSlice({
            file_id: 'source-file',
            profile: { quality: 'standard' },
        })).toMatchObject({ status: 'completed_mock', provider: 'mock' });
        expect(await getSlice({ slice_id: 'slice1' })).toMatchObject({ slice_id: 'slice1' });
        expect(await cancelSlice({ slice_id: 'slice1' })).toMatchObject({ status: 'canceled' });

        expect(store.getMerchantFile).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            fileId: 'source-file',
        });
        expect(adapters.slicer.createSliceJob).toHaveBeenCalledWith({
            merchant: {
                org_id: 'org-1',
                merchant_id: 'merchant-1',
                status: 'active',
            },
            sourceFile: expect.objectContaining({
                file_id: 'source-file',
                file_mode: 'source_model',
            }),
            profile: { quality: 'standard' },
            requirements: {},
        });
        expect(store.createMerchantSliceJob).toHaveBeenCalledWith(expect.objectContaining({
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            slice_job_id: 'slice1',
            file_id: 'source-file',
            profile: { quality: 'standard' },
            requirements: {},
            status: 'running',
            result: { provider: 'mock' },
        }));
        expect(store.createMerchantJobArtifact).toHaveBeenCalledWith(expect.objectContaining({
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            artifact_id: 'artifact1',
            file_id: 'source-file',
            artifact_type: 'sliced_model',
            storage_path: 'internal/mock/path/part.gcode.3mf',
            provider: 'mock',
            payload: expect.objectContaining({
                original_name: 'part.mock-sliced.gcode.3mf',
                content_type: 'model/3mf',
            }),
        }));
        expect(store.updateMerchantSliceJob.mock.calls[0][0]).toMatchObject({
            merchantId: 'merchant-1',
            sliceJobId: 'slice1',
            fields: {
                status: 'completed_mock',
                result: expect.objectContaining({
                    provider: 'mock',
                    artifact_id: 'artifact1',
                    artifact: expect.objectContaining({
                        artifact_id: 'artifact1',
                        original_name: 'part.mock-sliced.gcode.3mf',
                    }),
                }),
                completed_at: '2026-07-01T12:00:00.000Z',
            },
        });
        expect(store.updateMerchantSliceJob).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            sliceJobId: 'slice1',
            fields: {
                status: 'canceled',
                canceled_at: '2026-07-01T12:00:00.000Z',
            },
        });
        expect(store.createMerchantSliceJob.mock.invocationCallOrder[0]).toBeLessThan(
            store.createMerchantJobArtifact.mock.invocationCallOrder[0],
        );
        expect(store.createMerchantJobArtifact.mock.invocationCallOrder[0]).toBeLessThan(
            store.updateMerchantSliceJob.mock.invocationCallOrder[0],
        );
    });

    it('returns safe artifact metadata without storage paths or invented file ids', async () => {
        const { createSlice } = createHandlers();

        const result = await createSlice({
            file_id: 'source-file',
            profile: { quality: 'standard' },
        });

        expect(result).toMatchObject({
            slice_id: 'slice1',
            status: 'completed_mock',
            provider: 'mock',
            artifact: {
                artifact_id: 'artifact1',
                provider: 'mock',
                original_name: 'part.mock-sliced.gcode.3mf',
                content_type: 'model/3mf',
            },
        });
        expect(result.artifact).not.toHaveProperty('file_id');
        expect(JSON.stringify(result)).not.toContain('storage_path');
    });

    it('does not expose raw adapter or stored slice errors in public responses', async () => {
        const rawError = 'internal://path node_id=printer-1 stack at secret.js:12';
        const { createSlice } = createHandlers({
            adapters: {
                slicer: {
                    createSliceJob: vi.fn().mockResolvedValue({
                        provider: 'mock',
                        slice_job_id: 'slice-failed',
                        file_id: 'source-file',
                        status: 'failed',
                        error: rawError,
                    }),
                },
            },
        });
        const getHandlers = createHandlers({
            store: {
                getMerchantSliceJob: vi.fn().mockResolvedValue({
                    slice_job_id: 'slice-failed',
                    org_id: 'org-1',
                    merchant_id: 'merchant-1',
                    file_id: 'source-file',
                    status: 'failed',
                    result: { provider: 'mock' },
                    error: rawError,
                }),
            },
        });

        const createResult = await createSlice({
            file_id: 'source-file',
            profile: { quality: 'standard' },
        });
        const getResult = await getHandlers.getSlice({ slice_id: 'slice-failed' });

        expect(JSON.stringify(createResult)).not.toContain('internal://path');
        expect(JSON.stringify(createResult)).not.toContain('node_id=');
        expect(JSON.stringify(createResult)).not.toContain('stack');
        expect(JSON.stringify(getResult)).not.toContain('internal://path');
        expect(JSON.stringify(getResult)).not.toContain('node_id=');
        expect(JSON.stringify(getResult)).not.toContain('stack');
        expect(createResult).not.toHaveProperty('error');
        expect(getResult).not.toHaveProperty('error');
    });

    it('marks slice jobs failed with safe details when artifact persistence fails', async () => {
        const rawError = 'internal://artifact-bucket node_id=printer-7 stack at storage.js:42';
        const { createSlice, store } = createHandlers({
            store: {
                createMerchantJobArtifact: vi.fn().mockRejectedValue(new Error(rawError)),
            },
        });

        let caughtError;
        try {
            await createSlice({
                file_id: 'source-file',
                profile: { quality: 'standard' },
            });
        } catch (error) {
            caughtError = error;
        }

        expect(caughtError).toMatchObject({
            statusCode: 500,
            code: 'slice_artifact_failed',
            message: 'Slice artifact could not be stored',
        });
        expect(JSON.stringify(caughtError)).not.toContain('internal://artifact-bucket');
        expect(JSON.stringify(caughtError)).not.toContain('node_id=');
        expect(store.createMerchantJobArtifact).toHaveBeenCalled();
        expect(store.createMerchantSliceJob).toHaveBeenCalledWith(expect.objectContaining({
            slice_job_id: 'slice1',
            status: 'running',
            result: { provider: 'mock' },
        }));
        expect(store.updateMerchantSliceJob).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            sliceJobId: 'slice1',
            fields: {
                status: 'failed',
                result: {
                    provider: 'mock',
                    error_code: 'artifact_persistence_failed',
                    message: 'Slice artifact could not be stored',
                },
                metadata: {
                    error_code: 'artifact_persistence_failed',
                },
            },
        });
        expect(JSON.stringify(store.updateMerchantSliceJob.mock.calls)).not.toContain('internal://artifact-bucket');
        expect(JSON.stringify(store.updateMerchantSliceJob.mock.calls)).not.toContain('node_id=');
    });

    it('rejects ready-to-print files because slicing requires a source model', async () => {
        const { createSlice, store, adapters } = createHandlers({
            store: {
                getMerchantFile: vi.fn().mockResolvedValue({
                    file_id: 'ready-file',
                    org_id: 'org-1',
                    merchant_id: 'merchant-1',
                    original_name: 'plate.gcode.3mf',
                    file_mode: 'ready_to_print',
                    status: 'uploaded',
                }),
            },
        });

        await expect(createSlice({
            file_id: 'ready-file',
            profile: { quality: 'standard' },
        })).rejects.toMatchObject({
            statusCode: 422,
            code: 'source_model_required',
        });

        expect(adapters.slicer.createSliceJob).not.toHaveBeenCalled();
        expect(store.createMerchantSliceJob).not.toHaveBeenCalled();
        expect(store.createMerchantJobArtifact).not.toHaveBeenCalled();
    });

    it('returns not found when the source file is missing', async () => {
        const { createSlice } = createHandlers();

        await expect(createSlice({
            file_id: 'missing-file',
            profile: { quality: 'standard' },
        })).rejects.toMatchObject({
            statusCode: 404,
            code: 'file_not_found',
        });
    });
});

describe('merchant slicing public routes', () => {
    it('returns v2 public error envelope for unsupported methods', async () => {
        const handler = await importSlicesIndexRoute();
        const res = createMockResponse();

        await handler({ method: 'GET', headers: {} }, res);

        expect(res.statusCode).toBe(405);
        expect(res.headers.Allow).toBe('POST');
        expect(res.body).toMatchObject({
            ok: false,
            error: 'method_not_allowed',
            message: 'Method not allowed',
            request_id: expect.stringMatching(/^req_/),
        });
    });

    it('returns v2 public error envelope for missing merchant auth', async () => {
        const originalPepper = process.env.NODE_TOKEN_PEPPER;
        process.env.NODE_TOKEN_PEPPER = 'pepper';
        const handler = await importSlicesIndexRoute();
        const res = createMockResponse();

        try {
            await handler({
                method: 'POST',
                headers: {},
                body: {
                    file_id: 'source-file',
                    profile: { quality: 'standard' },
                },
            }, res);
        } finally {
            if (originalPepper === undefined) delete process.env.NODE_TOKEN_PEPPER;
            else process.env.NODE_TOKEN_PEPPER = originalPepper;
        }

        expect(res.statusCode).toBe(401);
        expect(res.body).toMatchObject({
            ok: false,
            error: 'missing_api_key',
            message: 'Merchant authentication failed',
            request_id: expect.stringMatching(/^req_/),
        });
    });

    it('returns v2 public error envelopes for detail and cancel route methods', async () => {
        const detailHandler = await importSliceDetailRoute();
        const cancelHandler = await importSliceCancelRoute();
        const detailRes = createMockResponse();
        const cancelRes = createMockResponse();

        await detailHandler({ method: 'POST', headers: {}, query: { slice_id: 'slice1' } }, detailRes);
        await cancelHandler({ method: 'GET', headers: {}, query: { slice_id: 'slice1' } }, cancelRes);

        expect(detailRes.statusCode).toBe(405);
        expect(detailRes.headers.Allow).toBe('GET');
        expect(detailRes.body).toMatchObject({
            ok: false,
            error: 'method_not_allowed',
            request_id: expect.stringMatching(/^req_/),
        });
        expect(cancelRes.statusCode).toBe(405);
        expect(cancelRes.headers.Allow).toBe('POST');
        expect(cancelRes.body).toMatchObject({
            ok: false,
            error: 'method_not_allowed',
            request_id: expect.stringMatching(/^req_/),
        });
    });

    it('returns v2 public auth envelopes for detail and cancel routes', async () => {
        const originalPepper = process.env.NODE_TOKEN_PEPPER;
        process.env.NODE_TOKEN_PEPPER = 'pepper';
        const detailHandler = await importSliceDetailRoute();
        const cancelHandler = await importSliceCancelRoute();
        const detailRes = createMockResponse();
        const cancelRes = createMockResponse();

        try {
            await detailHandler({ method: 'GET', headers: {}, query: { slice_id: 'slice1' } }, detailRes);
            await cancelHandler({ method: 'POST', headers: {}, query: { slice_id: 'slice1' } }, cancelRes);
        } finally {
            if (originalPepper === undefined) delete process.env.NODE_TOKEN_PEPPER;
            else process.env.NODE_TOKEN_PEPPER = originalPepper;
        }

        expect(detailRes.statusCode).toBe(401);
        expect(detailRes.body).toMatchObject({
            ok: false,
            error: 'missing_api_key',
            message: 'Merchant authentication failed',
            request_id: expect.stringMatching(/^req_/),
        });
        expect(cancelRes.statusCode).toBe(401);
        expect(cancelRes.body).toMatchObject({
            ok: false,
            error: 'missing_api_key',
            message: 'Merchant authentication failed',
            request_id: expect.stringMatching(/^req_/),
        });
    });
});
