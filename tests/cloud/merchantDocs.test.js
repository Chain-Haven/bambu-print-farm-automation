import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function collectPublicRoutePaths(dir = 'api/public') {
    const routePaths = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            routePaths.push(...collectPublicRoutePaths(entryPath));
            continue;
        }
        if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
        const routePath = `/${entryPath
            .replace(/^api\/public\//, 'api/public/')
            .replace(/\/index\.js$/, '')
            .replace(/\.js$/, '')
            .replace(/\[([^\]]+)\]/g, '{$1}')}`;
        routePaths.push(routePath);
    }
    return routePaths;
}

describe('merchant API docs', () => {
    it('publishes public v2 merchant docs and OpenAPI coverage for the adapter backbone', async () => {
        const html = fs.readFileSync('public/merchant-api.html', 'utf8');
        const spec = JSON.parse(fs.readFileSync('public/openapi/merchant-api-v2.json', 'utf8'));
        const planDiscoveryLabels = [
            '/api/public/files',
            '/api/public/slices',
            '/api/public/orders',
            '/api/public/routing/estimate',
            '/api/public/material-reservations',
            '/api/public/batches',
            '/api/public/shipments',
            '/api/public/rate-card',
            '/api/public/invoices',
            '/api/public/realtime/tokens',
        ];

        for (const path of [
            ...planDiscoveryLabels,
            '/api/public/billing/rate-card',
            '/api/public/billing/usage',
            '/api/public/billing/invoices',
            '/api/public/billing/invoices/preview',
        ]) {
            expect(html).toContain(path);
        }
        for (const path of [
            '/api/public/files',
            '/api/public/slices',
            '/api/public/orders',
            '/api/public/routing/estimate',
            '/api/public/material-reservations',
            '/api/public/batches',
            '/api/public/shipments',
            '/api/public/realtime/tokens',
            '/api/public/billing/rate-card',
            '/api/public/billing/usage',
            '/api/public/billing/invoices',
            '/api/public/billing/invoices/preview',
            '/api/public/shipments/{shipment_id}/labels',
            '/api/public/webhooks/{webhook_id}/test',
            '/api/public/post-processing/tasks/{task_id}/complete',
            '/api/public/inspections/{inspection_id}/manual-review',
        ]) {
            expect(spec.paths[path]).toBeTruthy();
        }
        expect(spec.paths['/api/public/rate-card']).toBeUndefined();
        expect(spec.paths['/api/public/invoices']).toBeUndefined();
        expect(html).toContain('mock adapter');
        expect(html).toContain('merchant-api-v2.json');
        expect(html).toContain('MERCHANT_WEBHOOK_SIGNING_SECRET_KEY');
        expect(spec.openapi).toBe('3.1.0');
        expect(spec.components.securitySchemes.MerchantApiKey.scheme).toBe('bearer');
        expect(Object.keys(spec.components.schemas)).toEqual(expect.arrayContaining([
            'File',
            'Slice',
            'Order',
            'RoutingEstimate',
            'MaterialReservation',
            'Batch',
            'Shipment',
            'RateCard',
            'Invoice',
            'RealtimeToken',
            'WebhookEndpoint',
        ]));
    });

    it('only advertises implemented public API routes in the v2 OpenAPI path table', () => {
        const spec = JSON.parse(fs.readFileSync('public/openapi/merchant-api-v2.json', 'utf8'));
        const implementedPublicRoutes = new Set(collectPublicRoutePaths());

        for (const specPath of Object.keys(spec.paths).filter((route) => route.startsWith('/api/public/'))) {
            expect(implementedPublicRoutes.has(specPath), specPath).toBe(true);
        }
    });

    it('serves the v2 OpenAPI document as static JSON from the public API route', async () => {
        const { default: handler } = await import('../../api/public/openapi-v2.js');
        const headers = {};
        const res = {
            statusCode: 200,
            setHeader: (key, value) => {
                headers[key.toLowerCase()] = value;
            },
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(payload) {
                this.body = payload;
                return this;
            },
        };

        await handler({ method: 'GET' }, res);

        expect(res.statusCode).toBe(200);
        expect(headers['content-type']).toBe('application/json');
        expect(res.body.openapi).toBe('3.1.0');
    });

    it('publishes public docs and a parseable OpenAPI spec for the merchant API', () => {
        const html = fs.readFileSync('public/merchant-api.html', 'utf8');
        const spec = JSON.parse(fs.readFileSync('public/openapi/merchant-api-v1.json', 'utf8'));

        expect(html).toContain('/api/public/merchants/signup');
        expect(html).toContain('/api/public/farm/capabilities');
        expect(html).toContain('/api/public/farm/filaments');
        expect(html).toContain('/api/public/quotes');
        expect(html).toContain('/api/public/print-jobs/preflight');
        expect(html).toContain('/api/public/print-jobs/cancel');
        expect(html).toContain('/api/public/webhooks');
        expect(html).toContain('Idempotency-Key');
        expect(html).toContain('/api/cloud/farm-automation');
        expect(html).toContain('approval-required by default');
        expect(html).toContain('pkx_live_');
        expect(spec.openapi).toBe('3.1.0');
        expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining([
            '/api/public/merchants/signup',
            '/api/public/farm/capabilities',
            '/api/public/farm/filaments',
            '/api/public/api-keys',
            '/api/public/quotes',
            '/api/public/print-jobs',
            '/api/public/print-jobs/preflight',
            '/api/public/print-jobs/status',
            '/api/public/print-jobs/cancel',
            '/api/public/print-jobs/approve',
            '/api/public/print-jobs/reprint',
            '/api/public/webhooks',
            '/api/public/integrations',
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
        expect(onboarding).toContain('rel="icon"');
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

    it('declares inline favicons on public merchant pages so browser smoke tests do not hit favicon fallback errors', () => {
        for (const file of ['public/merchant-onboarding.html', 'public/merchant-api.html', 'public/windows-node-guide.html']) {
            const html = fs.readFileSync(file, 'utf8');
            expect(html).toContain('rel="icon"');
            expect(html).toContain('data:image/svg+xml');
        }
    });

    it('ships static root favicon fallbacks so missing icon requests never invoke the Express serverless function', () => {
        for (const file of ['public/favicon.ico', 'public/favicon.png']) {
            expect(fs.existsSync(file)).toBe(true);
            expect(fs.readFileSync(file, 'utf8')).toContain('<svg');
        }
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
