import crypto from 'node:crypto';
import { createHttpError, merchantScope, publicOk } from './merchantApiV2.js';

const readyExtensions = new Set(['.gcode', '.3mf', '.gcode.3mf']);
const sourceExtensions = new Set(['.stl', '.obj', '.step', '.stp']);

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value, name) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw createHttpError(400, 'invalid_payload', `${name} is required`);
    }
    return value.trim();
}

function safeFileName(name) {
    const rawName = requiredString(name, 'file.name');
    const baseName = rawName.split(/[\\/]/).filter(Boolean).pop() || '';
    const safeName = baseName.replace(/[^A-Za-z0-9._-]/g, '_');
    if (!safeName || safeName === '.' || safeName === '..') {
        throw createHttpError(400, 'invalid_payload', 'file.name is required');
    }
    return safeName;
}

function classifyFileName(name) {
    const lowerName = name.toLowerCase();
    for (const extension of readyExtensions) {
        if (lowerName.endsWith(extension)) return 'ready_to_print';
    }
    for (const extension of sourceExtensions) {
        if (lowerName.endsWith(extension)) return 'source_model';
    }
    throw createHttpError(
        400,
        'invalid_file_extension',
        'file.name must end in .gcode, .3mf, .gcode.3mf, .stl, .obj, .step, or .stp',
    );
}

function decodeBase64(value) {
    const source = requiredString(value, 'file.base64');
    const compact = source.replace(/\s+/g, '');
    const paddingIndex = compact.indexOf('=');
    const hasInvalidPadding = paddingIndex !== -1 && !/^=+$/.test(compact.slice(paddingIndex));
    if (
        compact.length === 0
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)
        || hasInvalidPadding
        || compact.length % 4 === 1
    ) {
        throw createHttpError(400, 'invalid_base64', 'file.base64 must be valid base64');
    }

    const padded = compact.padEnd(Math.ceil(compact.length / 4) * 4, '=');
    const buffer = Buffer.from(padded, 'base64');
    if (buffer.length === 0) {
        throw createHttpError(400, 'invalid_payload', 'file.base64 decoded to an empty file');
    }
    if (buffer.toString('base64') !== padded) {
        throw createHttpError(400, 'invalid_base64', 'file.base64 must be valid base64');
    }
    return buffer;
}

function normalizeContentType(file = {}) {
    const value = typeof file.content_type === 'string' && file.content_type.trim()
        ? file.content_type
        : file.contentType;
    return typeof value === 'string' && value.trim() ? value.trim() : 'application/octet-stream';
}

function redactFile(file) {
    if (!isPlainObject(file)) return file;
    const { storage_path: _storagePath, ...publicFile } = file;
    return publicFile;
}

async function getAuthenticatedMerchant(authenticateMerchant, request) {
    if (typeof authenticateMerchant !== 'function') {
        throw new Error('authenticateMerchant is required');
    }
    const context = await authenticateMerchant(request);
    const merchant = context?.merchant || context;
    if (!merchant?.org_id || !merchant?.merchant_id) {
        throw createHttpError(403, 'merchant_scope_missing', 'Merchant scope is unavailable');
    }
    return merchant;
}

function requiredFileId(value) {
    return requiredString(value, 'file_id');
}

export function createFileHandlers({
    store,
    authenticateMerchant,
    now = () => new Date(),
} = {}) {
    if (!store) throw new Error('store is required');

    async function createFile(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const scope = merchantScope(merchant);
        const source = isPlainObject(body) ? body : {};
        const file = isPlainObject(source.file) ? source.file : {};
        const safeName = safeFileName(file.name || file.filename);
        const buffer = decodeBase64(file.base64);
        const fileMode = classifyFileName(safeName);
        const fileId = crypto.randomUUID();
        const contentType = normalizeContentType(file);
        const storagePath = `${scope.org_id}/${scope.merchant_id}/files/${fileId}/${safeName}`;
        if (typeof store.uploadPrintArtifact !== 'function') {
            throw new Error('store.uploadPrintArtifact is required');
        }
        await store.uploadPrintArtifact(storagePath, buffer, contentType);

        const record = await store.createMerchantFile({
            ...scope,
            file_id: fileId,
            original_name: safeName,
            content_type: contentType,
            byte_size: buffer.length,
            checksum_sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
            file_mode: fileMode,
            storage_path: storagePath,
            status: 'uploaded',
        });

        return publicOk(redactFile(record), requestId);
    }

    async function completeFile(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const fileId = requiredFileId(isPlainObject(body) ? body.file_id : null);
        const file = await store.updateMerchantFile({
            merchantId: merchant.merchant_id,
            fileId,
            fields: {
                status: 'completed',
                completed_at: now().toISOString(),
            },
        });
        if (!file) throw createHttpError(404, 'file_not_found', 'File not found');
        return publicOk(redactFile(file), requestId);
    }

    async function getFile(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const fileId = requiredFileId(isPlainObject(body) ? body.file_id : null);
        const file = await store.getMerchantFile({
            merchantId: merchant.merchant_id,
            fileId,
        });
        if (!file) throw createHttpError(404, 'file_not_found', 'File not found');
        return publicOk(redactFile(file), requestId);
    }

    async function deleteFile(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const fileId = requiredFileId(isPlainObject(body) ? body.file_id : null);
        const file = await store.deleteMerchantFile({
            merchantId: merchant.merchant_id,
            fileId,
            deletedAt: now().toISOString(),
        });
        if (!file) throw createHttpError(404, 'file_not_found', 'File not found');
        return publicOk(redactFile(file), requestId);
    }

    return {
        createFile,
        completeFile,
        getFile,
        deleteFile,
    };
}
