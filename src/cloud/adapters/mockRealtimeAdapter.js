import crypto from 'node:crypto';

export function createMockRealtimeAdapter({ now = () => new Date() } = {}) {
    return {
        async createMerchantToken({
            merchant = {},
            scopes = [],
            expiresInSeconds = 900,
        } = {}) {
            const tokenId = crypto.randomUUID();
            const issuedAt = now();

            return {
                provider: 'mock',
                token_id: tokenId,
                merchant_id: merchant.merchant_id,
                org_id: merchant.org_id,
                token: `pkx_mock_rt_${tokenId.replaceAll('-', '')}`,
                scopes,
                issued_at: issuedAt.toISOString(),
                expires_at: new Date(issuedAt.getTime() + expiresInSeconds * 1000).toISOString(),
            };
        },
    };
}
