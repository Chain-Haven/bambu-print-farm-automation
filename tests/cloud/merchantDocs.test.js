import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('merchant API docs', () => {
    it('publishes public docs and a parseable OpenAPI spec for the merchant API', () => {
        const html = fs.readFileSync('public/merchant-api.html', 'utf8');
        const spec = JSON.parse(fs.readFileSync('public/openapi/merchant-api-v1.json', 'utf8'));

        expect(html).toContain('/api/public/merchants/signup');
        expect(html).toContain('/api/public/farm/filaments');
        expect(html).toContain('/api/cloud/farm-automation');
        expect(html).toContain('approval-required by default');
        expect(html).toContain('pkx_live_');
        expect(spec.openapi).toBe('3.1.0');
        expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining([
            '/api/public/merchants/signup',
            '/api/public/farm/filaments',
            '/api/public/api-keys',
            '/api/public/print-jobs',
            '/api/public/print-jobs/status',
            '/api/cloud/farm-automation',
            '/api/cloud/merchants',
            '/api/cloud/merchant-settings',
            '/api/cloud/merchant-api-keys',
        ]));
        expect(spec.components.securitySchemes.MerchantApiKey.scheme).toBe('bearer');
    });

    it('publishes a functional merchant onboarding page and Windows node setup guide', () => {
        const onboarding = fs.readFileSync('public/merchant-onboarding.html', 'utf8');
        const nodeGuide = fs.readFileSync('public/windows-node-guide.html', 'utf8');
        const nodeGuideMarkdown = fs.readFileSync('docs/windows-local-node.md', 'utf8');

        expect(onboarding).toContain('id="merchant-signup-form"');
        expect(onboarding).toContain('/api/public/merchants/signup');
        expect(onboarding).toContain('/api/public/api-keys');
        expect(onboarding).toContain('pkx_live_');
        expect(onboarding).toContain('approval-required by default');
        expect(nodeGuide).toContain('/api/cloud/nodes');
        expect(nodeGuide).toContain('/api/cloud/node-package');
        expect(nodeGuide).toContain('LOCAL_NODE_TOKEN');
        expect(nodeGuide).toContain('SUPABASE_SERVICE_ROLE_KEY');
        expect(nodeGuideMarkdown).toContain('HTTPS outbound');
        expect(nodeGuideMarkdown).toContain('Start Cloud Node.bat');
        expect(nodeGuideMarkdown).toContain('cloud.print.ready');
    });

    it('keeps the local controller shell bootable with API and app scripts', () => {
        const html = fs.readFileSync('public/index.html', 'utf8');

        expect(html).toContain('<script src="/js/api.js"></script>');
        expect(html).toContain('<script src="/js/ws.js"></script>');
        expect(html).toContain('<script type="module" src="/js/app.js"></script>');
        expect(html.trim()).toMatch(/<\/html>$/);
    });

    it('exposes ready-print cloud commands from the admin console without duplicate payload inputs', () => {
        const html = fs.readFileSync('public/cloud.html', 'utf8');

        expect(html).toContain('value="cloud.print.ready"');
        expect(html.match(/id="command-payload"/g)).toHaveLength(1);
    });

    it('documents the platform roadmap from cloud control plane to Windows edge execution', () => {
        const roadmap = fs.readFileSync('docs/print-farm-platform-roadmap.md', 'utf8');
        const cloudControl = fs.readFileSync('docs/cloud-control-plane.md', 'utf8');

        for (const term of [
            'Fleet Hub',
            'Bambu Connect',
            'LAN Developer Mode',
            'Windows edge agent',
            'durable command intents',
            'model-aware adapter strategy',
        ]) {
            expect(roadmap).toContain(term);
        }
        expect(cloudControl).toContain('docs/print-farm-platform-roadmap.md');
    });
});
