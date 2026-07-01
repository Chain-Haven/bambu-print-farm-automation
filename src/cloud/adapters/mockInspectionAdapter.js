import crypto from 'node:crypto';

export function createMockInspectionAdapter({ now = () => new Date() } = {}) {
    return {
        async getInspection({ merchant = {}, job = {} } = {}) {
            const timestamp = now().toISOString();

            return {
                provider: 'mock',
                inspection_id: crypto.randomUUID(),
                merchant_id: merchant.merchant_id || job.merchant_id,
                org_id: merchant.org_id || job.org_id,
                job_id: job.job_id,
                status: 'manual_review',
                summary: 'Mock inspection requires manual review',
                findings: [],
                created_at: timestamp,
                updated_at: timestamp,
            };
        },
    };
}
