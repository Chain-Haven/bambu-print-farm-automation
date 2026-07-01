import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('merchant API docs', () => {
    it('publishes public docs and a parseable OpenAPI spec for the merchant API', () => {
        const html = fs.readFileSync('public/merchant-api.html', 'utf8');
        const spec = JSON.parse(fs.readFileSync('public/openapi/merchant-api-v1.json', 'utf8'));

        expect(html).toContain('/api/public/merchants/signup');
        expect(html).toContain('approval-required by default');
        expect(html).toContain('pkx_live_');
        expect(spec.openapi).toBe('3.1.0');
        expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining([
            '/api/public/merchants/signup',
            '/api/public/api-keys',
            '/api/public/print-jobs',
            '/api/public/print-jobs/status',
            '/api/cloud/merchants',
            '/api/cloud/merchant-settings',
        ]));
        expect(spec.components.securitySchemes.MerchantApiKey.scheme).toBe('bearer');
    });
});
