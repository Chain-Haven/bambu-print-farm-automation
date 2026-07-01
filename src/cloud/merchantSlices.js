import { createHttpError, merchantScope, publicOk } from './merchantApiV2.js';

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value, name) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw createHttpError(400, 'invalid_payload', `${name} is required`);
    }
    return value.trim();
}

function requiredInternalString(value, name) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${name} is required`);
    }
    return value.trim();
}

function requiredFileId(value) {
    return requiredString(value, 'file_id');
}

function requiredSliceId(value) {
    return requiredString(value, 'slice_id');
}

function safeObject(value) {
    return isPlainObject(value) ? value : {};
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

function publicArtifact(artifact) {
    if (!isPlainObject(artifact)) return undefined;

    const response = {};
    for (const key of ['artifact_id', 'provider', 'original_name', 'content_type', 'created_at']) {
        if (artifact[key] !== undefined && artifact[key] !== null) response[key] = artifact[key];
    }
    return response;
}

function sliceProvider(slice) {
    if (typeof slice?.provider === 'string' && slice.provider) return slice.provider;
    if (typeof slice?.result?.provider === 'string' && slice.result.provider) return slice.result.provider;
    return undefined;
}

function publicSlice(slice, artifact = undefined) {
    const response = {
        slice_id: slice.slice_job_id || slice.slice_id,
        status: slice.status,
    };
    const provider = sliceProvider(slice);
    if (provider) response.provider = provider;

    for (const key of ['file_id', 'created_at', 'updated_at', 'completed_at', 'canceled_at']) {
        if (slice[key] !== undefined && slice[key] !== null) response[key] = slice[key];
    }
    if (isPlainObject(slice.profile)) response.profile = slice.profile;
    if (isPlainObject(slice.requirements)) response.requirements = slice.requirements;

    const safeArtifact = artifact || publicArtifact(slice.result?.artifact);
    if (safeArtifact) response.artifact = safeArtifact;
    return response;
}

function sliceResultPayload(adapterResult, artifact) {
    const result = {
        provider: adapterResult.provider,
    };
    if (artifact?.artifact_id) result.artifact_id = artifact.artifact_id;
    const safeArtifact = publicArtifact(artifact);
    if (safeArtifact) result.artifact = safeArtifact;
    return result;
}

function artifactPayload(artifact) {
    const payload = publicArtifact(artifact) || {};
    if (artifact?.slice_job_id) payload.slice_id = artifact.slice_job_id;
    return payload;
}

function optionalString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function buildArtifactRow({
    scope,
    artifact,
    adapterResult,
    sourceFile,
    sliceJobId,
}) {
    if (!artifact) return null;

    return {
        ...scope,
        artifact_id: requiredInternalString(artifact.artifact_id, 'artifact.artifact_id'),
        job_id: artifact.job_id || null,
        file_id: sourceFile.file_id,
        artifact_type: 'sliced_model',
        storage_path: optionalString(artifact.storage_path),
        provider: artifact.provider || adapterResult.provider || 'mock',
        payload: artifactPayload(artifact),
        metadata: {
            slice_job_id: sliceJobId,
        },
        created_at: artifact.created_at,
    };
}

export function createSliceHandlers({
    store,
    authenticateMerchant,
    adapters,
    now = () => new Date(),
} = {}) {
    if (!store) throw new Error('store is required');
    if (!adapters?.slicer || typeof adapters.slicer.createSliceJob !== 'function') {
        throw new Error('adapters.slicer.createSliceJob is required');
    }

    async function createSlice(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const source = safeObject(body);
        const fileId = requiredFileId(source.file_id);
        const sourceFile = await store.getMerchantFile({
            merchantId: merchant.merchant_id,
            fileId,
        });
        if (!sourceFile) throw createHttpError(404, 'file_not_found', 'File not found');
        if (sourceFile.file_mode !== 'source_model') {
            throw createHttpError(422, 'source_model_required', 'Slicing requires a source model file');
        }

        const profile = safeObject(source.profile);
        const requirements = safeObject(source.requirements);
        const adapterResult = await adapters.slicer.createSliceJob({
            merchant,
            sourceFile,
            profile,
            requirements,
        });
        const sliceJobId = requiredInternalString(adapterResult.slice_job_id, 'adapter slice_job_id');
        const artifact = isPlainObject(adapterResult.artifact) ? adapterResult.artifact : null;
        const scope = merchantScope(merchant);
        const artifactRow = buildArtifactRow({
            scope,
            artifact,
            adapterResult,
            sourceFile,
            sliceJobId,
        });
        const storedArtifact = artifactRow
            ? await store.createMerchantJobArtifact(artifactRow)
            : null;

        const sliceJob = await store.createMerchantSliceJob({
            ...scope,
            slice_job_id: sliceJobId,
            file_id: sourceFile.file_id,
            profile,
            requirements,
            result: sliceResultPayload(adapterResult, artifact),
            status: adapterResult.status || 'queued',
            error: adapterResult.error || null,
            started_at: adapterResult.started_at || null,
            completed_at: adapterResult.completed_at || null,
            created_at: adapterResult.created_at,
            updated_at: adapterResult.updated_at,
        });

        return publicOk(publicSlice(sliceJob, publicArtifact(storedArtifact?.payload || artifact)), requestId);
    }

    async function getSlice(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const sliceJobId = requiredSliceId(safeObject(body).slice_id);
        const sliceJob = await store.getMerchantSliceJob({
            merchantId: merchant.merchant_id,
            sliceJobId,
        });
        if (!sliceJob) throw createHttpError(404, 'slice_not_found', 'Slice not found');
        return publicOk(publicSlice(sliceJob), requestId);
    }

    async function cancelSlice(body = {}, request = null, requestId = undefined) {
        const merchant = await getAuthenticatedMerchant(authenticateMerchant, request);
        const sliceJobId = requiredSliceId(safeObject(body).slice_id);
        const sliceJob = await store.updateMerchantSliceJob({
            merchantId: merchant.merchant_id,
            sliceJobId,
            fields: {
                status: 'canceled',
                canceled_at: now().toISOString(),
            },
        });
        if (!sliceJob) throw createHttpError(404, 'slice_not_found', 'Slice not found');
        return publicOk(publicSlice(sliceJob), requestId);
    }

    return {
        createSlice,
        getSlice,
        cancelSlice,
    };
}
