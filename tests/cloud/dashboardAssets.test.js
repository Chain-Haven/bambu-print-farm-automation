import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('cloud dashboard assets', () => {
    it('surfaces backend setup status before provisioning workflows', () => {
        const html = fs.readFileSync('public/cloud.html', 'utf8');
        const js = fs.readFileSync('public/js/cloud-dashboard.js', 'utf8');
        const css = fs.readFileSync('public/css/cloud.css', 'utf8');

        expect(html).toContain('id="setup-status"');
        expect(html).toContain('Backend Setup');
        expect(js).toContain('/api/cloud/setup');
        expect(js).toContain('renderSetupStatus');
        expect(css).toContain('.setup-status');
    });

    it('exposes a complete Vercel cloud admin suite for merchants, nodes, commands, and usage', () => {
        const html = fs.readFileSync('public/cloud.html', 'utf8');
        const js = fs.readFileSync('public/js/cloud-dashboard.js', 'utf8');
        const css = fs.readFileSync('public/css/cloud.css', 'utf8');

        for (const id of [
            'merchant-settings-form',
            'merchant-list-form',
            'merchant-action-form',
            'merchant-key-form',
            'merchant-lookup-form',
            'merchant-api-keys-table',
            'merchant-jobs-table',
            'merchant-usage-table',
            'selected-detail',
        ]) {
            expect(html).toContain(`id="${id}"`);
        }

        for (const endpoint of [
            '/api/cloud/merchant-settings',
            '/api/cloud/merchants',
            '/api/cloud/merchant-setup-token',
            '/api/cloud/merchant-api-keys',
            '/api/cloud/merchant-jobs',
            '/api/cloud/merchant-usage',
            '/api/cloud/node-package',
            '/api/cloud/commands',
        ]) {
            expect(js).toContain(endpoint);
        }

        for (const functionName of [
            'refreshMerchantSettings',
            'refreshMerchants',
            'handleMerchantAction',
            'handleMerchantKeySubmit',
            'refreshMerchantOperationalData',
            'showDetail',
            'applyCommandTemplate',
        ]) {
            expect(js).toContain(functionName);
        }

        expect(css).toContain('.admin-layout');
        expect(css).toContain('.detail-drawer');
        expect(css).toContain('.toolbar');
    });

    it('keeps browser controller scripts parseable', () => {
        for (const file of ['public/js/api.js', 'public/js/ws.js', 'public/js/app.js', 'public/js/cloud-dashboard.js']) {
            execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
        }
    });
});
