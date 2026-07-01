import { describe, expect, it, vi } from 'vitest';
import { hashMerchantApiKey } from '../../src/cloud/merchantAuth.js';
import {
    createMerchantIntegrationsHandler,
    createMerchantWebhooksHandler,
} from '../../src/cloud/merchantWebhookHandlers.js';

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
            metadata: { existing: true },
        }),
        touchMerchantApiKey: vi.fn(),
        updateMerchantMetadata: vi.fn().mockImplementation(async (merchantId, metadata) => ({
            merchant_id: merchantId,
            metadata,
        })),
        ...overrides,
    };
}

describe('merchant webhook and integration handlers', () => {
    it('saves webhook settings in merchant metadata and redacts the secret in responses', async () => {
        const store = createAuthStore();
        const handler = createMerchantWebhooksHandler({ store, pepper: 'pepper' });
        const res = createMockResponse();

        await handler({
            method: 'POST',
            headers: { authorization: 'Bearer pkx_live_secret' },
            body: {
                endpoint_url: 'https://merchant.example/webhook',
                enabled: true,
                secret: 'whsec_test',
                events: ['job.accepted', 'job.completed'],
            },
        }, res);

        expect(store.updateMerchantMetadata).toHaveBeenCalledWith('merchant-1', {
            existing: true,
            webhook: expect.objectContaining({
                endpoint_url: 'https://merchant.example/webhook',
                secret: 'whsec_test',
                events: ['job.accepted', 'job.completed'],
            }),
        });
        expect(res.statusCode).toBe(200);
        expect(res.body.webhook).toMatchObject({
            endpoint_url: 'https://merchant.example/webhook',
            enabled: true,
            has_secret: true,
        });
        expect(JSON.stringify(res.body)).not.toContain('whsec_test');
    });

    it('lists supported ecommerce, shipping, alerting, automation, and no-code integrations', async () => {
        const handler = createMerchantIntegrationsHandler();
        const res = createMockResponse();

        await handler({ method: 'GET', headers: {}, query: {} }, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.integrations.map((integration) => integration.type)).toEqual(expect.arrayContaining([
            'shopify',
            'woocommerce',
            'etsy',
            'shipstation',
            'slack',
            'zapier',
            'make',
            'webhooks',
        ]));
    });
});
