import crypto from 'node:crypto';

function mockSlicedName(originalName = 'model.stl') {
    const normalized = String(originalName || 'model.stl').trim() || 'model.stl';
    const baseName = normalized.replace(/\.[^/.]+$/, '');
    return `${baseName}.mock-sliced.gcode.3mf`;
}

export function createMockSlicerAdapter({ now = () => new Date() } = {}) {
    return {
        async createSliceJob({
            merchant = {},
            sourceFile = {},
            profile = {},
            requirements = {},
        } = {}) {
            const sliceJobId = crypto.randomUUID();
            const artifactId = crypto.randomUUID();
            const timestamp = now().toISOString();

            return {
                provider: 'mock',
                slice_job_id: sliceJobId,
                merchant_id: merchant.merchant_id,
                org_id: merchant.org_id,
                file_id: sourceFile.file_id,
                status: 'completed_mock',
                profile,
                requirements,
                created_at: timestamp,
                updated_at: timestamp,
                completed_at: timestamp,
                artifact: {
                    provider: 'mock',
                    artifact_id: artifactId,
                    slice_job_id: sliceJobId,
                    merchant_id: merchant.merchant_id,
                    org_id: merchant.org_id,
                    file_id: sourceFile.file_id,
                    original_name: mockSlicedName(sourceFile.original_name),
                    content_type: 'model/3mf',
                    created_at: timestamp,
                },
            };
        },
    };
}
