import { describe, expect, it } from 'vitest';
import { assertSafeWebhookUrl } from '../../src/cloud/urlGuard.js';
import { normalizeWebhookConfig } from '../../src/cloud/webhooks.js';

describe('assertSafeWebhookUrl (SSRF guard)', () => {
    it('accepts public HTTPS URLs and returns a normalized string', () => {
        expect(assertSafeWebhookUrl('https://merchant.example/webhooks/printkinetix'))
            .toBe('https://merchant.example/webhooks/printkinetix');
        expect(assertSafeWebhookUrl('https://api.merchant.example')).toBe('https://api.merchant.example/');
    });

    it('rejects non-HTTPS schemes', () => {
        expect(() => assertSafeWebhookUrl('http://merchant.example/hook')).toThrow(/https/);
        expect(() => assertSafeWebhookUrl('ftp://merchant.example/hook')).toThrow();
        expect(() => assertSafeWebhookUrl('not a url')).toThrow();
    });

    it('rejects loopback, localhost and metadata hosts', () => {
        for (const url of [
            'https://localhost/hook',
            'https://sub.localhost/hook',
            'https://127.0.0.1/hook',
            'https://0.0.0.0/hook',
            'https://169.254.169.254/latest/meta-data',
            'https://[::1]/hook',
        ]) {
            expect(() => assertSafeWebhookUrl(url), url).toThrow(/internal or private/);
        }
    });

    it('rejects RFC-1918 / ULA / link-local private ranges', () => {
        for (const url of [
            'https://10.0.0.5/hook',
            'https://172.16.9.9/hook',
            'https://192.168.1.10/hook',
            'https://100.64.0.1/hook',
            'https://[fd00::1]/hook',
            'https://[fe80::1]/hook',
            'https://printer.local/hook',
            'https://svc.internal/hook',
        ]) {
            expect(() => assertSafeWebhookUrl(url), url).toThrow(/internal or private/);
        }
    });
});

describe('normalizeWebhookConfig SSRF integration', () => {
    it('rejects a webhook config whose new URL targets an internal host', () => {
        expect(() => normalizeWebhookConfig({ endpoint_url: 'http://169.254.169.254/' })).toThrow();
        expect(() => normalizeWebhookConfig({ endpoint_url: 'https://192.168.0.1/hook' })).toThrow();
    });

    it('accepts a public HTTPS webhook URL', () => {
        const config = normalizeWebhookConfig({ endpoint_url: 'https://merchant.example/hook', secret: 'whsec_x' });
        expect(config.endpoint_url).toBe('https://merchant.example/hook');
    });

    it('preserves an unchanged stored URL without re-validating', () => {
        // Legacy stored URLs are not re-validated when the update does not touch them.
        const config = normalizeWebhookConfig({ enabled: false }, { endpoint_url: 'http://legacy-internal/hook', secret: 'whsec_x' });
        expect(config.endpoint_url).toBe('http://legacy-internal/hook');
    });
});
