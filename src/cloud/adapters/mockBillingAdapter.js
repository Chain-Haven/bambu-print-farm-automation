import crypto from 'node:crypto';

export function createMockBillingAdapter({ now = () => new Date() } = {}) {
    return {
        async getRateCard({ merchant = {} } = {}) {
            const timestamp = now().toISOString();

            return {
                provider: 'mock',
                rate_card_id: crypto.randomUUID(),
                merchant_id: merchant.merchant_id,
                org_id: merchant.org_id,
                currency: 'USD',
                created_at: timestamp,
                updated_at: timestamp,
                rates: [
                    {
                        code: 'slice_setup',
                        description: 'Mock slicing setup fee',
                        unit: 'job',
                        amount_cents: 125,
                    },
                    {
                        code: 'machine_time',
                        description: 'Mock machine time',
                        unit: 'minute',
                        amount_cents: 8,
                    },
                    {
                        code: 'material_gram',
                        description: 'Mock material usage',
                        unit: 'gram',
                        amount_cents: 3,
                    },
                ],
            };
        },
    };
}
