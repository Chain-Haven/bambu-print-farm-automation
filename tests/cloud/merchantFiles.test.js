import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createFileHandlers } from '../../src/cloud/merchantFiles.js';

const now = () => new Date('2026-07-01T12:00:00.000Z');

function createMockStore(overrides = {}) {
    return {
        uploadPrintArtifact: vi.fn().mockResolvedValue({ Key: 'merchant-files/path' }),
        createMerchantFile: vi.fn().mockImplementation(async (file) => file),
        updateMerchantFile: vi.fn().mockImplementation(async ({ fileId, fields }) => ({
            file_id: fileId,
            storage_path: 'org-1/merchant-1/files/file1/part.stl',
            ...fields,
        })),
        getMerchantFile: vi.fn().mockImplementation(async ({ fileId }) => ({
            file_id: fileId,
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            original_name: 'part.stl',
            status: 'uploaded',
            storage_path: 'org-1/merchant-1/files/file1/part.stl',
        })),
        deleteMerchantFile: vi.fn().mockImplementation(async ({ fileId, deletedAt }) => ({
            file_id: fileId,
            status: 'deleted',
            deleted_at: deletedAt,
            storage_path: 'org-1/merchant-1/files/file1/part.stl',
        })),
        ...overrides,
    };
}

function createHandlers(overrides = {}) {
    const store = createMockStore(overrides.store);
    const authenticateMerchant = vi.fn().mockResolvedValue({
        merchant: {
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            status: 'active',
        },
    });

    return {
        store,
        authenticateMerchant,
        ...createFileHandlers({ store, authenticateMerchant, now }),
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

async function importFilesIndexRoute(store = createMockStore()) {
    vi.resetModules();
    vi.doMock('../../src/cloud/supabaseRest.js', () => ({
        createSupabaseRestClient: vi.fn(() => store),
    }));
    const route = await import('../../api/public/files/index.js');
    vi.doUnmock('../../src/cloud/supabaseRest.js');
    return route.default;
}

describe('merchant files API handlers', () => {
    it('creates source model files from base64 uploads without exposing storage paths', async () => {
        const { createFile, store } = createHandlers();
        const bytes = Buffer.from('solid');
        const checksum = createHash('sha256').update(bytes).digest('hex');

        expect(await createFile({
            file: {
                name: 'part.stl',
                base64: bytes.toString('base64'),
            },
        })).toMatchObject({
            status: 'uploaded',
            file_mode: 'source_model',
            checksum_sha256: checksum,
        });

        const [createdFile] = store.createMerchantFile.mock.calls[0];
        expect(createdFile).toMatchObject({
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            original_name: 'part.stl',
            content_type: 'application/octet-stream',
            byte_size: bytes.length,
            checksum_sha256: checksum,
            file_mode: 'source_model',
            status: 'uploaded',
        });
        expect(createdFile.storage_path).toBe(`org-1/merchant-1/files/${createdFile.file_id}/part.stl`);
        expect(store.uploadPrintArtifact).toHaveBeenCalledWith(
            createdFile.storage_path,
            bytes,
            'application/octet-stream',
        );
        expect(store.uploadPrintArtifact.mock.invocationCallOrder[0]).toBeLessThan(
            store.createMerchantFile.mock.invocationCallOrder[0],
        );
        const secondResult = await createFile({
            file: {
                name: 'part.obj',
                base64: Buffer.from('obj').toString('base64'),
            },
        });
        expect(secondResult).not.toHaveProperty('storage_path');
        expect(JSON.stringify(secondResult)).not.toContain('storage_path');
    });

    it('classifies ready files and preserves content type during upload', async () => {
        const { createFile, store } = createHandlers();
        const bytes = Buffer.from('ready gcode project');

        const result = await createFile({
            file: {
                name: 'plate.gcode.3mf',
                base64: bytes.toString('base64'),
                content_type: 'model/3mf',
            },
        });

        const [createdFile] = store.createMerchantFile.mock.calls[0];
        expect(result).toMatchObject({
            status: 'uploaded',
            file_mode: 'ready_to_print',
        });
        expect(store.uploadPrintArtifact).toHaveBeenCalledWith(
            createdFile.storage_path,
            bytes,
            'model/3mf',
        );
    });

    it('completes, reads, and deletes merchant-scoped files', async () => {
        const {
            completeFile,
            getFile,
            deleteFile,
            store,
        } = createHandlers();

        const completed = await completeFile({ file_id: 'file1' });
        const fetched = await getFile({ file_id: 'file1' });
        const deleted = await deleteFile({ file_id: 'file1' });

        expect(completed).toMatchObject({ status: 'completed' });
        expect(fetched).toMatchObject({ file_id: 'file1' });
        expect(deleted).toMatchObject({ status: 'deleted' });
        expect(completed).not.toHaveProperty('storage_path');
        expect(fetched).not.toHaveProperty('storage_path');
        expect(deleted).not.toHaveProperty('storage_path');

        expect(store.updateMerchantFile).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            fileId: 'file1',
            fields: {
                status: 'completed',
                completed_at: '2026-07-01T12:00:00.000Z',
            },
        });
        expect(store.getMerchantFile).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            fileId: 'file1',
        });
        expect(store.deleteMerchantFile).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            fileId: 'file1',
            deletedAt: '2026-07-01T12:00:00.000Z',
        });
    });

    it('never reads merchant scope from request bodies', async () => {
        const { createFile, store } = createHandlers();
        const body = {
            file: {
                name: 'body-scope.stl',
                base64: Buffer.from('solid').toString('base64'),
            },
        };
        Object.defineProperties(body, {
            org_id: {
                enumerable: true,
                get() {
                    throw new Error('org_id body scope was read');
                },
            },
            merchant_id: {
                enumerable: true,
                get() {
                    throw new Error('merchant_id body scope was read');
                },
            },
        });

        await createFile(body);

        expect(store.createMerchantFile).toHaveBeenCalledWith(expect.objectContaining({
            org_id: 'org-1',
            merchant_id: 'merchant-1',
        }));
        expect(JSON.stringify(store.createMerchantFile.mock.calls[0][0])).not.toContain('body-scope-merchant');
    });

    it('rejects malformed base64 before uploading or creating a file row', async () => {
        const { createFile, store } = createHandlers();

        await expect(createFile({
            file: {
                name: 'part.stl',
                base64: 'not-base64!',
            },
        })).rejects.toMatchObject({
            statusCode: 400,
            code: 'invalid_base64',
        });

        expect(store.uploadPrintArtifact).not.toHaveBeenCalled();
        expect(store.createMerchantFile).not.toHaveBeenCalled();
    });

    it('rejects an oversized base64 payload before allocating or uploading it', async () => {
        const { createFile, store } = createHandlers();
        // ~34MB of base64 chars — well past the 25MB decoded cap.
        const huge = 'A'.repeat(34 * 1024 * 1024);

        await expect(createFile({
            file: {
                name: 'part.stl',
                base64: huge,
            },
        })).rejects.toMatchObject({
            statusCode: 413,
            code: 'file_too_large',
        });

        expect(store.uploadPrintArtifact).not.toHaveBeenCalled();
        expect(store.createMerchantFile).not.toHaveBeenCalled();
    });

    it('does not create a file row when upload persistence fails', async () => {
        const { createFile, store } = createHandlers({
            store: {
                uploadPrintArtifact: vi.fn().mockRejectedValue(new Error('upload failed')),
            },
        });

        await expect(createFile({
            file: {
                name: 'part.stl',
                base64: Buffer.from('solid').toString('base64'),
            },
        })).rejects.toThrow('upload failed');

        expect(store.createMerchantFile).not.toHaveBeenCalled();
    });

    it('fails before creating a file row when upload storage is unavailable', async () => {
        const { createFile, store } = createHandlers({
            store: {
                uploadPrintArtifact: undefined,
            },
        });

        await expect(createFile({
            file: {
                name: 'part.stl',
                base64: Buffer.from('solid').toString('base64'),
            },
        })).rejects.toThrow('store.uploadPrintArtifact is required');

        expect(store.createMerchantFile).not.toHaveBeenCalled();
    });
});

describe('merchant files public routes', () => {
    it('returns v2 public error envelope for unsupported methods', async () => {
        const handler = await importFilesIndexRoute();
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
        const handler = await importFilesIndexRoute();
        const res = createMockResponse();

        try {
            await handler({
                method: 'POST',
                headers: {},
                body: {
                    file: {
                        name: 'part.stl',
                        base64: Buffer.from('solid').toString('base64'),
                    },
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
});
