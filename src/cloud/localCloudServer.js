import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {
    createCloudAdminBootstrapHandler,
    createCloudAdminLoginHandler,
    createCloudAdminLogoutHandler,
    createCloudAdminMeHandler,
    createCloudAdminPasswordResetHandler,
    createCloudAdminSetPasswordHandler,
    createCloudAdminUsersHandler,
} from './adminAuthHandlers.js';
import { createMailer } from './mailer.js';
import {
    createCloudCommandHandler,
    createCloudSetupStatusHandler,
    createCloudFarmAutomationHandler,
    createCloudFilamentOrdersHandler,
    createCloudStorefrontHandler,
    createCloudMerchantSettingsHandler,
    createCloudMerchantSetupTokenHandler,
    createCloudMerchantsHandler,
    createCloudNodePackageHandler,
    createCloudNodeProvisionHandler,
    createCloudOrganizationHandler,
    createCloudOverviewHandler,
} from './adminHandlers.js';
import {
    createClaimCommandsHandler,
    createCommandResultHandler,
    createEventsHandler,
    createHeartbeatHandler,
} from './agentHandlers.js';
import {
    createMerchantApiKeyRevokeHandler,
    createMerchantApiKeysHandler,
    createMerchantMeHandler,
    createMerchantSignupHandler,
} from './merchantHandlers.js';
import {
    createMerchantLoginHandler,
    createMerchantLogoutHandler,
    createMerchantPasswordResetRequestHandler,
    createMerchantPortalMeHandler,
    createMerchantSetPasswordHandler,
} from './merchantUserHandlers.js';
import {
    createMerchantPrintJobStatusHandler,
    createMerchantPrintJobsHandler,
} from './merchantPrintHandlers.js';
import { createCloudPrintFilesHandler } from './adminPrintHandlers.js';
import {
    createStorefrontCancelHandler,
    createStorefrontCheckoutHandler,
    createStorefrontOrderStatusHandler,
    createStorefrontQuoteHandler,
    createStorefrontStripeWebhookHandler,
} from './storefrontHandlers.js';
import { createWooPluginDownloadHandler } from './woocommercePlugin.js';

// A self-contained cloud control plane: the SAME handler code the Vercel
// functions run, wired to an Express app against any store implementation
// (Supabase in production, the in-memory store for local/self-hosted use and
// end-to-end tests). This lets the full farm loop — provision node, download
// the Windows package, heartbeat, printer mirror, merchant signup, print job
// routing, command claim/result — run without Vercel or Supabase.
export function createLocalCloudApp({
    store,
    adminToken,
    pepper,
    fetchImpl = globalThis.fetch,
    rootDir = process.cwd(),
    now = () => new Date(),
    mailer = null,
}) {
    if (!store) throw new Error('store is required');
    if (!adminToken) throw new Error('adminToken is required');
    if (!pepper) throw new Error('pepper is required');

    // Default mailer runs disabled and logs messages (incl. reset links) to the
    // console, so self-hosted operators can complete password resets offline.
    const authMailer = mailer || createMailer();

    const app = express();
    app.use(express.json({ limit: '40mb' }));

    const wire = (handler) => (req, res) => Promise.resolve(handler(req, res)).catch((error) => {
        if (!res.headersSent) {
            res.status(500).json({ ok: false, error: 'internal_error', message: error.message });
        }
    });

    // Admin (cloud console) endpoints.
    // Setup status: this server has no Supabase dependency, so present the
    // local store as a fully-configured backend to the console.
    app.all('/api/cloud/setup', wire(createCloudSetupStatusHandler({
        store,
        adminToken,
        env: {
            SUPABASE_URL: 'local-store',
            SUPABASE_SERVICE_ROLE_KEY: 'local-store',
            NODE_TOKEN_PEPPER: pepper,
            CLOUD_ADMIN_TOKEN: adminToken,
        },
    })));
    app.all('/api/cloud/organizations', wire(createCloudOrganizationHandler({ store, adminToken })));
    app.all('/api/cloud/nodes', wire(createCloudNodeProvisionHandler({ store, adminToken, pepper })));
    app.all('/api/cloud/node-package', wire(createCloudNodePackageHandler({ store, adminToken, rootDir })));
    app.all('/api/cloud/commands', wire(createCloudCommandHandler({ store, adminToken })));
    app.all('/api/cloud/print-files', wire(createCloudPrintFilesHandler({ store, adminToken, now })));
    app.all('/api/cloud/overview', wire(createCloudOverviewHandler({ store, adminToken })));
    app.all('/api/cloud/farm-automation', wire(createCloudFarmAutomationHandler({ store, adminToken })));
    app.all('/api/cloud/filament-orders', wire(createCloudFilamentOrdersHandler({ store, adminToken, fetchImpl, now })));
    app.all('/api/cloud/storefront', wire(createCloudStorefrontHandler({ store, adminToken, now })));
    app.all('/api/cloud/merchants', wire(createCloudMerchantsHandler({ store, adminToken, merchantPepper: pepper })));
    app.all('/api/cloud/merchant-settings', wire(createCloudMerchantSettingsHandler({ store, adminToken })));
    app.all('/api/cloud/merchant-setup-token', wire(createCloudMerchantSetupTokenHandler({ store, adminToken, merchantPepper: pepper })));

    // Agent (edge node) endpoints.
    app.all('/api/agent/heartbeat', wire(createHeartbeatHandler({ store, pepper, now, fetchImpl, mailer: authMailer })));
    app.all('/api/agent/commands', wire(createClaimCommandsHandler({ store, pepper })));
    app.all('/api/agent/events', wire(createEventsHandler({ store, pepper, now, fetchImpl, mailer: authMailer })));
    app.all('/api/agent/command-result', wire(createCommandResultHandler({ store, pepper, now })));

    // Public merchant endpoints.
    app.all('/api/public/merchants/signup', wire(createMerchantSignupHandler({ store, pepper, now })));
    app.all('/api/public/api-keys/revoke', wire(createMerchantApiKeyRevokeHandler({ store, pepper, now })));
    app.all('/api/public/api-keys', wire(createMerchantApiKeysHandler({ store, pepper, now })));
    app.all('/api/public/merchant/me', wire(createMerchantMeHandler({ store, pepper, now })));
    app.all('/api/public/print-jobs', wire(createMerchantPrintJobsHandler({ store, pepper, now, fetchImpl })));
    app.all('/api/public/print-jobs/status', wire(createMerchantPrintJobStatusHandler({ store, pepper, now })));

    // Public storefront (no auth): instant quote -> checkout -> status -> cancel.
    app.all('/api/public/storefront/quote', wire(createStorefrontQuoteHandler({ store, now })));
    app.all('/api/public/storefront/checkout', wire(createStorefrontCheckoutHandler({ store, now, fetchImpl, mailer: authMailer })));
    app.all('/api/public/storefront/orders', wire(createStorefrontOrderStatusHandler({ store })));
    app.all('/api/public/storefront/cancel', wire(createStorefrontCancelHandler({ store, now, fetchImpl, mailer: authMailer })));
    app.all('/api/public/storefront/stripe-webhook', wire(createStorefrontStripeWebhookHandler({ store, now, fetchImpl, mailer: authMailer })));

    // Merchant integrations: WooCommerce plugin download.
    app.all('/api/public/integrations/woocommerce-plugin', wire(createWooPluginDownloadHandler({ rootDir })));

    // Public liveness (parity with the Vercel /api/health function) + OpenAPI
    // index, so the landing page status badge and spec links work self-hosted.
    app.get('/api/health', (_req, res) => res.json({
        ok: true,
        status: 'operational',
        service: 'printkinetix-cloud',
        time: now().toISOString(),
        env: 'local',
    }));
    app.get('/api/public/openapi.json', (_req, res) => res.json({
        ok: true,
        service: 'printkinetix-merchant-api',
        specs: {
            v1: { url: '/openapi/merchant-api-v1.json' },
            v2: { url: '/openapi/merchant-api-v2.json', live_route: '/api/public/openapi-v2' },
        },
        docs_url: '/merchant-api.html',
    }));

    // Merchant portal sign-in (email/password sessions + password resets).
    app.all('/api/public/merchant/login', wire(createMerchantLoginHandler({ store, pepper, now })));
    app.all('/api/public/merchant/logout', wire(createMerchantLogoutHandler({ store, pepper, now })));
    app.all('/api/public/merchant/session', wire(createMerchantPortalMeHandler({ store, pepper, now })));
    app.all('/api/public/merchant/password', wire(createMerchantSetPasswordHandler({ store, pepper, now })));
    app.all('/api/public/merchant/password-reset', wire(createMerchantPasswordResetRequestHandler({
        store,
        pepper,
        now,
        mailer: authMailer,
    })));

    // Admin sign-in: the full email/password + reset suite the Vercel functions
    // expose, backed by the same store. The CLOUD_ADMIN_TOKEN (bootstrap) path
    // keeps working for provisioning scripts and first-time setup.
    app.all('/api/cloud/admin/me', wire(createCloudAdminMeHandler({
        store,
        bootstrapToken: adminToken,
        pepper,
        now,
    })));
    app.all('/api/cloud/admin/bootstrap', wire(createCloudAdminBootstrapHandler({
        store,
        bootstrapToken: adminToken,
        pepper,
        now,
    })));
    app.all('/api/cloud/admin/login', wire(createCloudAdminLoginHandler({ store, pepper, now })));
    app.all('/api/cloud/admin/logout', wire(createCloudAdminLogoutHandler({
        store,
        bootstrapToken: adminToken,
        pepper,
        now,
    })));
    app.all('/api/cloud/admin/password', wire(createCloudAdminSetPasswordHandler({ store, pepper, now })));
    app.all('/api/cloud/admin/password-reset', wire(createCloudAdminPasswordResetHandler({
        store,
        bootstrapToken: adminToken,
        pepper,
        now,
        mailer: authMailer,
    })));
    app.all('/api/cloud/admin/users', wire(createCloudAdminUsersHandler({
        store,
        bootstrapToken: adminToken,
        pepper,
        now,
        mailer: authMailer,
    })));

    // Serve the operator console statically (same files Vercel serves) so the
    // whole cloud UI works self-hosted / in tests.
    const publicDir = path.join(rootDir, 'public');
    if (fs.existsSync(path.join(publicDir, 'cloud.html'))) {
        app.get('/cloud', (_req, res) => res.sendFile(path.join(publicDir, 'cloud.html')));
        for (const page of ['merchant', 'merchant-onboarding', 'admin-reset', 'order']) {
            const file = path.join(publicDir, `${page}.html`);
            if (fs.existsSync(file)) {
                app.get(`/${page}`, (_req, res) => res.sendFile(file));
            }
        }
        app.use(express.static(publicDir));
    }

    // Print artifact downloads (the memory store's "signed URL" target).
    if (typeof store.getArtifact === 'function') {
        app.get(/^\/artifacts\/(.+)$/, (req, res) => {
            const storagePath = decodeURIComponent(req.params[0]);
            const artifact = store.getArtifact(storagePath);
            if (!artifact) return res.status(404).json({ ok: false, error: 'artifact_not_found' });
            res.setHeader('Content-Type', artifact.contentType || 'application/octet-stream');
            return res.end(artifact.buffer);
        });
    }

    return app;
}

export function startLocalCloudServer({ port = 0, host = '127.0.0.1', ...options } = {}) {
    const app = createLocalCloudApp(options);

    return new Promise((resolve, reject) => {
        const server = app.listen(port, host, () => {
            const address = server.address();
            const baseUrl = `http://${host}:${address.port}`;
            if (typeof options.store?.setPublicBaseUrl === 'function') {
                options.store.setPublicBaseUrl(baseUrl);
            }
            resolve({
                server,
                baseUrl,
                close: () => new Promise((done) => server.close(done)),
            });
        });
        server.once('error', reject);
    });
}
