import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Vercel cloud node package config', () => {
    it('serves the root SPA statically and bundles sql.js wasm for legacy server fallback', () => {
        const config = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));

        expect(config.rewrites).toContainEqual({
            source: '/',
            destination: '/index.html',
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
});
