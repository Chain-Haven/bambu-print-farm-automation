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
            'admin-login-form',
            'admin-reset-request-form',
            'farm-automation-form',
            'filament-inventory-form',
            'integrations-form',
            'farm-automation-plan',
            'automation-alerts-table',
            'platform-strategy-table',
            'readiness-gates-table',
            'roadmap-phases-table',
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
            '/api/cloud/admin/login',
            '/api/cloud/admin/me',
            '/api/cloud/admin/password-reset',
            '/api/cloud/farm-automation',
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
            'handleAdminLogin',
            'handleAdminResetRequest',
            'refreshFarmAutomation',
            'handleFarmAutomationSubmit',
            'handleFilamentInventorySubmit',
            'handleIntegrationsSubmit',
            'renderFarmAutomation',
            'renderPlatformStrategy',
            'flattenPlatformStrategyRows',
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
        expect(css).toContain('.automation-grid');
        expect(css).toContain('.alert-list');
        expect(css).toContain('.strategy-grid');
        expect(css).toContain('.detail-drawer');
        expect(css).toContain('.toolbar');
    });

    it('surfaces Merchant API v2 operational resources in the admin dashboard', () => {
        const html = fs.readFileSync('public/cloud.html', 'utf8');
        const js = fs.readFileSync('public/js/cloud-dashboard.js', 'utf8');

        for (const id of [
            'merchant-v2-orders-table',
            'merchant-v2-files-table',
            'merchant-v2-slices-table',
            'merchant-v2-batches-table',
            'merchant-v2-reservations-table',
            'merchant-v2-shipments-table',
            'merchant-v2-invoices-table',
            'merchant-v2-webhooks-table',
            'merchant-v2-adapters-table',
        ]) {
            expect(html).toContain(`id="${id}"`);
        }
        expect(js).toContain('/api/cloud/merchant-v2');
    });

    it('guards farm automation JSON editors from stale refresh responses', () => {
        const js = fs.readFileSync('public/js/cloud-dashboard.js', 'utf8');

        expect(js).toContain('farmAutomationRequestSequence');
        expect(js).toContain('markFarmAutomationMutation');
        expect(js).toContain('bindFarmAutomationEditorGuards');
        expect(js).toContain("elements.filamentInventoryJson.addEventListener('input', markFarmAutomationMutation)");
        expect(js).toContain("elements.integrationsJson.addEventListener('input', markFarmAutomationMutation)");
        expect(js).toContain('if (requestSequence !== farmAutomationRequestSequence)');
        expect(js).toContain('const mutationSequence = markFarmAutomationMutation();');
        expect(js).toContain('if (mutationSequence === farmAutomationRequestSequence)');
    });

    it('makes Windows node onboarding one-click and exposes local printer sync commands', () => {
        const html = fs.readFileSync('public/cloud.html', 'utf8');
        const js = fs.readFileSync('public/js/cloud-dashboard.js', 'utf8');

        for (const id of [
            'node-quickstart-form',
            'quickstart-org-name',
            'quickstart-node-name',
            'quickstart-max-jobs',
            'quickstart-scan-cidrs',
            'quickstart-auto-download',
            'quickstart-output',
            'printer-sync-form',
            'sync-scan-cidrs',
            'sync-include-saved',
            'sync-ams',
            'sync-filament',
            'sync-output',
        ]) {
            expect(html).toContain(`id="${id}"`);
        }

        for (const commandType of [
            'cloud.printers.discover',
            'cloud.printers.sync',
        ]) {
            expect(html).toContain(commandType);
            expect(js).toContain(commandType);
        }

        for (const functionName of [
            'handleNodeQuickstart',
            'handlePrinterSync',
            'queueNodeCommand',
            'buildPrinterSyncPayload',
            'parseCidrs',
        ]) {
            expect(js).toContain(functionName);
        }

        expect(js).toContain('/api/cloud/organizations');
        expect(js).toContain('/api/cloud/nodes');
        expect(js).toContain('/api/cloud/node-package');
        expect(js).toContain('/api/cloud/commands');

        // ONE download button: the portable .zip runs on Windows, macOS, and
        // Linux (per-platform launchers inside), so there is no separate
        // Windows .exe button anymore.
        expect(html).toContain('id="download-node-portable"');
        expect(html).not.toContain('id="download-node-exe"');
        expect(html).toContain('Windows / Mac / Linux');
        expect(js).toContain("format: 'portable'");
        expect(js).not.toContain('handleDownloadExe');
    });

    it('ships the tabbed console: fleet/merchants/nodes/automation with setup at the bottom', () => {
        const html = fs.readFileSync('public/cloud.html', 'utf8');
        const js = fs.readFileSync('public/js/cloud-dashboard.js', 'utf8');
        const css = fs.readFileSync('public/css/cloud.css', 'utf8');

        for (const id of ['console-tabs', 'tab-fleet', 'tab-merchants', 'tab-nodes', 'tab-automation', 'setup-banner']) {
            expect(html).toContain(`id="${id}"`);
        }

        // Backend Setup lives at the BOTTOM of the Nodes & Setup tab — after
        // node provisioning and admin accounts, not at the top of the page.
        const setupIndex = html.indexOf('id="setup-status"');
        expect(setupIndex).toBeGreaterThan(html.indexOf('id="nodes-table"'));
        expect(setupIndex).toBeGreaterThan(html.indexOf('id="admin-users-section"'));
        expect(setupIndex).toBeGreaterThan(html.indexOf('id="node-quickstart-form"'));

        // One visible merchant ID input; the other three are hidden and synced.
        expect(html).toContain('<input id="merchant-action-id" type="hidden">');
        expect(html).toContain('<input id="merchant-key-merchant-id" type="hidden">');
        expect(html).toContain('<input id="merchant-lookup-id" type="hidden">');

        for (const marker of ['showTab', 'bindTabs', 'data-tab-panel', 'setupBanner']) {
            expect(js).toContain(marker);
        }
        expect(css).toContain('.console-tabs');
        expect(css).toContain('.tab-panel');
        expect(css).toContain('.setup-banner');
    });

    it('ships drop-in printing and node deletion on the console', () => {
        const html = fs.readFileSync('public/cloud.html', 'utf8');
        const js = fs.readFileSync('public/js/cloud-dashboard.js', 'utf8');
        const css = fs.readFileSync('public/css/cloud.css', 'utf8');

        for (const id of ['drop-print-section', 'drop-zone', 'drop-file-input', 'drop-status']) {
            expect(html).toContain(`id="${id}"`);
        }
        for (const marker of [
            '/api/cloud/print-files',
            'submitDroppedFile',
            'handleDroppedFiles',
            'bindDropZone',
            'handleDeleteNode',
            'node_has_active_work',
        ]) {
            expect(js).toContain(marker);
        }
        expect(css).toContain('.drop-zone');
        expect(css).toContain('.drop-status-row');
    });

    it('keeps browser controller scripts parseable', () => {
        for (const file of [
            'public/js/api.js',
            'public/js/ws.js',
            'public/js/app.js',
            'public/js/model-viewer.js',
            'public/js/storefront-order.js',
        ]) {
            execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
        }
        // ES modules (they use import syntax): syntax-check via stdin in module mode.
        for (const file of ['public/js/cloud-dashboard.js', 'public/js/fleet-view.js', 'public/js/merchant-portal.js']) {
            execFileSync(process.execPath, ['--check', '--input-type=module'], {
                stdio: 'pipe',
                input: fs.readFileSync(file),
            });
        }
    });

    it('ships the sign-in overhaul: admin account management and the merchant portal', () => {
        const cloudHtml = fs.readFileSync('public/cloud.html', 'utf8');
        const cloudJs = fs.readFileSync('public/js/cloud-dashboard.js', 'utf8');

        // Admin console: self-service reset + super-admin account management.
        for (const id of ['admin-users-section', 'admin-users-table', 'admin-user-create-form', 'admin-user-email', 'admin-user-role']) {
            expect(cloudHtml).toContain(`id="${id}"`);
        }
        for (const marker of [
            '/api/cloud/admin/users',
            '/api/cloud/admin/logout',
            '/api/cloud/admin/bootstrap',
            'refreshAdminUsers',
            'handleAdminUserCreate',
            'handleAdminUserAction',
        ]) {
            expect(cloudJs).toContain(marker);
        }

        // Merchant portal page + controller.
        const portalHtml = fs.readFileSync('public/merchant.html', 'utf8');
        const portalJs = fs.readFileSync('public/js/merchant-portal.js', 'utf8');
        for (const id of ['login-form', 'forgot-form', 'reset-form', 'portal-view', 'api-keys-table', 'create-key-form']) {
            expect(portalHtml).toContain(`id="${id}"`);
        }
        for (const endpoint of [
            '/api/public/merchant/login',
            '/api/public/merchant/logout',
            '/api/public/merchant/session',
            '/api/public/merchant/password',
            '/api/public/merchant/password-reset',
            '/api/public/api-keys',
            '/api/public/api-keys/revoke',
        ]) {
            expect(portalJs).toContain(endpoint);
        }

        // Onboarding collects a password so merchants can sign in at /merchant.
        const onboarding = fs.readFileSync('public/merchant-onboarding.html', 'utf8');
        expect(onboarding).toContain('name="password"');
        expect(onboarding).toContain('href="/merchant"');

        // The standalone /admin-reset page lets a locked-out operator request a
        // reset link by email alone (no CLOUD_ADMIN_TOKEN), then set a password
        // with the emailed token.
        const adminReset = fs.readFileSync('public/admin-reset.html', 'utf8');
        expect(adminReset).toContain('id="request-form"');
        expect(adminReset).toContain('id="request-email"');
        expect(adminReset).toContain('id="reset-form"');
        expect(adminReset).toContain('/api/cloud/admin/password-reset');
        expect(adminReset).toContain('/api/cloud/admin/password');
    });

    it('ships the live Print Fleet board (cards, AMS slots, previews, camera, adoption)', () => {
        const html = fs.readFileSync('public/cloud.html', 'utf8');
        const js = fs.readFileSync('public/js/cloud-dashboard.js', 'utf8');
        const fleet = fs.readFileSync('public/js/fleet-view.js', 'utf8');
        const css = fs.readFileSync('public/css/cloud.css', 'utf8');

        for (const id of [
            'fleet-section',
            'fleet-grid',
            'fleet-discovered',
            'fleet-discovered-list',
            'fleet-live',
            'fleet-scan',
            'camera-modal',
            'camera-image',
            'adopt-modal',
            'adopt-form',
            'adopt-name',
            'adopt-access-code',
        ]) {
            expect(html).toContain(`id="${id}"`);
        }

        expect(js).toContain('createFleetView');
        expect(js).toContain('fleetView.render()');
        expect(js).toContain('fleetView.bind()');

        for (const marker of [
            'detectPrinterFamily',
            'printer.camera.snapshot',
            'cloud.printers.adopt',
            'cloud.printers.discover',
            'current_job',
            'ams_trays',
            'live_remaining',
            'remaining_minutes',
            'job-preview',
            // Discovered printers arrive automatically in node heartbeats —
            // the board must read host_info.discovered_printers, not only
            // manually queued discover-command results.
            'discovered_printers',
        ]) {
            expect(fleet).toContain(marker);
        }

        for (const selector of [
            '.fleet-grid',
            '.printer-card',
            '.ams-rack',
            '.ams-slot',
            '.spool-fill',
            '.printer-visual',
            '.job-preview',
            '.progress-fill',
            '.time-remaining',
            '.printer-actions',
            '.camera-frame',
            '.adopt-modal',
            '.discovered-chip',
        ]) {
            expect(css).toContain(selector);
        }
    });
});
