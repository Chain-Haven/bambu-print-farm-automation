import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Vercel cloud node package config', () => {
    it('serves the cloud landing at the root (not the LAN-only printer SPA) and bundles sql.js wasm', () => {
        const config = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));

        // The root must NOT be index.html: that is the local Windows-node printer
        // dashboard, whose /api/auth,/api/printers routes only exist in the Express
        // server (not on Vercel), so it 500s with an HTML-not-JSON parse error.
        expect(config.rewrites).toContainEqual({
            source: '/',
            destination: '/home.html',
        });
        expect(config.rewrites).toContainEqual({
            source: '/cloud',
            destination: '/cloud.html',
        });
        expect(config.rewrites).toContainEqual({
            source: '/merchant-onboarding',
            destination: '/merchant-onboarding.html',
        });
        expect(config.rewrites).toContainEqual({
            source: '/merchant',
            destination: '/merchant.html',
        });
        expect(config.rewrites).toContainEqual({
            source: '/admin-reset',
            destination: '/admin-reset.html',
        });
        expect(config.functions['server.js']).toMatchObject({
            maxDuration: 30,
        });
        expect(config.functions['server.js'].includeFiles).toContain('node_modules/sql.js/dist/sql-wasm.wasm');
    });

    it('includes local runtime files in the node-package function bundle', () => {
        const config = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));

        expect(config.functions['api/cloud/node-package.js']).toMatchObject({
            maxDuration: 30,
        });
        expect(config.functions['api/cloud/node-package.js'].includeFiles).toContain('package.json');
        expect(config.functions['api/cloud/node-package.js'].includeFiles).toContain('package-lock.json');
        expect(config.functions['api/cloud/node-package.js'].includeFiles).toContain('server.js');
        expect(config.functions['api/cloud/node-package.js'].includeFiles).toContain('Start Cloud Node.bat');
        expect(config.functions['api/cloud/node-package.js'].includeFiles).toContain('src/**');
        expect(config.functions['api/cloud/node-package.js'].includeFiles).toContain('public/**');
    });

    it('ships the portable no-install bundle with the node-package function', () => {
        const config = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));

        // Without dist/windows-node/** the deployed download silently falls back
        // to the source ZIP that requires Node 24 + npm install — the portable
        // "works out of the box" package only ships when these files deploy.
        expect(config.functions['api/cloud/node-package.js'].includeFiles).toContain('dist/windows-node/**');
        expect(fs.existsSync('dist/windows-node/farm-node.cjs')).toBe(true);
        expect(fs.existsSync('dist/windows-node/sql-wasm.wasm')).toBe(true);
    });

    it('bundles allowlisted Supabase SQL migrations for the admin migration endpoint', () => {
        const config = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));

        expect(config.functions['api/cloud/admin/migrations.js']).toMatchObject({
            maxDuration: 30,
        });
        expect(config.functions['api/cloud/admin/migrations.js'].includeFiles).toContain(
            'supabase/migrations/20260701050000_merchant_api_v2_adapter_backbone.sql',
        );
        expect(config.functions['api/cloud/admin/migrations.js'].includeFiles).toContain(
            'supabase/migrations/20260701153253_merchant_shipping_claims.sql',
        );
        expect(config.functions['api/cloud/admin/migrations.js'].includeFiles).toContain(
            'supabase/migrations/20260702080000_merchant_user_auth.sql',
        );
    });
});
