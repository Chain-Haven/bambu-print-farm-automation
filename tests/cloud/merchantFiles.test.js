import { describe, expect, it, vi } from 'vitest';
import { createFileHandlers } from '../../src/cloud/merchantFiles.js';

const now = () => new Date('2026-07-01T12:00:00.000Z');

function createMockStore(overrides = {}) {
    return {
        createMerchantFile: vi.fn().mockImplementation(async (file) => file),
        updateMerchantFile: vi.fn().mockImplementation(async ({ fileId, fields }) => ({
            file_id: fileId,
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

describe('merchant files API handlers', () => {
    it('creates source model files from base64 uploads without exposing storage paths', async () => {
        const { createFile, store } = createHandlers();

        expect(await createFile({
            file: {
                name: 'part.stl',
                base64: Buffer.from('solid').toString('base64'),
            },
        })).toMatchObject({
            status: 'uploaded',
            file_mode: 'source_model',
            checksum_sha256: expect.any(String),
        });

        const [createdFile] = store.createMerchantFile.mock.calls[0];
        expect(createdFile).toMatchObject({
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            original_name: 'part.stl',
            content_type: 'application/octet-stream',
            byte_size: Buffer.byteLength('solid'),
            checksum_sha256: expect.any(String),
            file_mode: 'source_model',
            status: 'uploaded',
        });
        expect(createdFile.storage_path).toBe(`org-1/merchant-1/files/${createdFile.file_id}/part.stl`);
        expect(await createFile({
            file: {
                name: 'part.obj',
                base64: Buffer.from('obj').toString('base64'),
            },
        })).not.toHaveProperty('storage_path');
    });

    it('completes, reads, and deletes merchant-scoped files', async () => {
        const {
            completeFile,
            getFile,
            deleteFile,
            store,
        } = createHandlers();

        expect(await completeFile({ file_id: 'file1' })).toMatchObject({ status: 'completed' });
        expect(await getFile({ file_id: 'file1' })).toMatchObject({ file_id: 'file1' });
        expect(await deleteFile({ file_id: 'file1' })).toMatchObject({ status: 'deleted' });

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
});
