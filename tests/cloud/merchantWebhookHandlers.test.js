import { describe, expect, it } from 'vitest';
import { createMerchantIntegrationsHandler } from '../../src/cloud/merchantWebhookHandlers.js';

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

describe('merchant integration handlers', () => {
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
