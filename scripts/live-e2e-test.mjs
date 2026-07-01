#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadCloudSmokeEnv } from '../src/cloud/cloudSmokeEnv.js';

loadCloudSmokeEnv();

const DEFAULT_BASE_URL = 'https://bambu-print-farm-automation.vercel.app';
const OUTPUT_DIR = path.join(process.cwd(), 'output', 'playwright');
const RUN_ID = `e2e-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
const COLOR_HEX = '#00AEEF';
const SECONDARY_COLOR_HEX = '#111111';

function getArgValue(name) {
    const index = process.argv.indexOf(name);
    if (index === -1) return null;
    return process.argv[index + 1] || null;
}

function hasFlag(name) {
    return process.argv.includes(name);
}

function normalizeBaseUrl(value) {
    return String(value || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function requiredEnv(name) {
    const value = process.env[name];
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${name} is required`);
    }
    return value.trim();
}

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function shouldSendBearerAuthorization(key) {
    return !key.startsWith('sb_secret_') && !key.startsWith('sb_publishable_');
}

function encodeStoragePath(storagePath) {
    return storagePath.split('/').map((part) => encodeURIComponent(part)).join('/');
}

function shortId(value) {
    return String(value || '').slice(0, 8);
}

function sanitizeError(error) {
    return String(error?.message || error || 'Unknown error')
        .replace(/pkx_(?:live|setup|node)_[A-Za-z0-9_-]+/g, 'pkx_[redacted]')
        .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [redacted]');
}

function isSecretSummaryKey(key) {
    const normalized = String(key || '').toLowerCase();
    return normalized.includes('token')
        || normalized.includes('secret')
        || normalized === 'apikey'
        || normalized === 'api_key'
        || normalized === 'admintoken';
}

function makeSummaryResult(value = {}) {
    return Object.fromEntries(Object.entries(value).filter(([key, item]) => (
        item !== undefined
        && !isSecretSummaryKey(key)
    )));
}

async function readJsonResponse(response) {
    const text = await response.text();
    try {
        return text ? JSON.parse(text) : {};
    } catch {
        return { raw: text };
    }
}

async function resolvePlaywrightPackageFromPath() {
    const delimiter = path.delimiter;
    const pathEntries = String(process.env.PATH || '').split(delimiter).filter(Boolean);
    const executableNames = process.platform === 'win32'
        ? ['playwright.cmd', 'playwright.ps1', 'playwright']
        : ['playwright'];

    for (const entry of pathEntries) {
        for (const executableName of executableNames) {
            try {
                const realPath = await fs.realpath(path.join(entry, executableName));
                const marker = `${path.sep}node_modules${path.sep}playwright${path.sep}`;
                const markerIndex = realPath.indexOf(marker);
                if (markerIndex === -1) continue;
                return realPath.slice(0, markerIndex + marker.length - 1);
            } catch {
                // Keep walking PATH entries.
            }
        }
    }

    return null;
}

async function loadPlaywright() {
    try {
        return await import('playwright');
    } catch (error) {
        const packageDir = await resolvePlaywrightPackageFromPath();
        if (!packageDir) throw error;
        const requireFromPlaywright = createRequire(path.join(packageDir, 'package.json'));
        return requireFromPlaywright('playwright');
    }
}

async function main() {
    const { chromium } = await loadPlaywright();

    const baseUrl = normalizeBaseUrl(getArgValue('--cloud-url') || process.env.CLOUD_API_URL || DEFAULT_BASE_URL);
    const adminToken = getArgValue('--admin-token') || requiredEnv('CLOUD_ADMIN_TOKEN');
    const supabaseUrl = normalizeBaseUrl(process.env.SUPABASE_URL);
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
    if (!supabaseServiceKey) {
        throw new Error('SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY is required for live E2E printer seeding and cleanup');
    }

    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    const summary = {
        ok: false,
        run_id: RUN_ID,
        base_url: baseUrl,
        steps: {},
        screenshots: [],
        browser_issues: [],
        cleanup: [],
    };
    const createdOrgIds = new Set();
    const storagePaths = new Set();
    const cleanupErrors = [];
    let originalFarmSettings = null;
    let originalMerchantMode = null;
    let browser = null;
    let context = null;
    let currentStep = 'startup';

    const api = async (requestPath, {
        method = 'GET',
        token = null,
        setupToken = null,
        body = null,
        headers = {},
        expected = [200],
        okField = true,
    } = {}) => {
        const response = await fetch(`${baseUrl}${requestPath}`, {
            method,
            headers: {
                ...(body === null ? {} : { 'Content-Type': 'application/json' }),
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(setupToken ? { 'X-Merchant-Setup-Token': setupToken } : {}),
                ...headers,
            },
            body: body === null ? undefined : JSON.stringify(body),
        });
        const payload = await readJsonResponse(response);
        if (!expected.includes(response.status) || (okField && payload.ok === false)) {
            throw new Error(`${method} ${requestPath} failed (${response.status}): ${payload.message || payload.error || JSON.stringify(payload).slice(0, 180)}`);
        }
        return payload;
    };

    const adminApi = (requestPath, options = {}) => api(requestPath, {
        ...options,
        token: adminToken,
    });

    const merchantApi = (requestPath, apiKey, options = {}) => api(requestPath, {
        ...options,
        token: apiKey,
    });

    const agentApi = (requestPath, nodeToken, options = {}) => api(requestPath, {
        ...options,
        token: nodeToken,
    });

    const supabaseRequest = async (requestPath, { method = 'GET', body = null, headers = {}, allow404 = false } = {}) => {
        const key = supabaseServiceKey.trim();
        const authHeaders = shouldSendBearerAuthorization(key) ? { Authorization: `Bearer ${key}` } : {};
        const response = await fetch(`${supabaseUrl}${requestPath}`, {
            method,
            headers: {
                apikey: key,
                ...authHeaders,
                ...(body === null ? {} : { 'Content-Type': 'application/json' }),
                ...headers,
            },
            body: body === null ? undefined : JSON.stringify(body),
        });
        const text = await response.text();
        if (!response.ok && !(allow404 && response.status === 404)) {
            throw new Error(`Supabase ${method} ${requestPath} failed (${response.status}): ${text.slice(0, 220)}`);
        }
        return text ? JSON.parse(text) : null;
    };

    const supabaseStorageRequest = async (requestPath, { method = 'DELETE', body = null, headers = {}, allow404 = true } = {}) => {
        const key = supabaseServiceKey.trim();
        const authHeaders = shouldSendBearerAuthorization(key) ? { Authorization: `Bearer ${key}` } : {};
        const response = await fetch(`${supabaseUrl}${requestPath}`, {
            method,
            headers: {
                apikey: key,
                ...authHeaders,
                ...headers,
            },
            body,
        });
        if (!response.ok && !(allow404 && response.status === 404)) {
            const text = await response.text();
            throw new Error(`Supabase storage ${method} ${requestPath} failed (${response.status}): ${text.slice(0, 220)}`);
        }
    };

    async function step(name, fn) {
        currentStep = name;
        const startedAt = Date.now();
        try {
            const result = await fn();
            summary.steps[name] = {
                ok: true,
                ms: Date.now() - startedAt,
                ...makeSummaryResult(result),
            };
            return result;
        } catch (error) {
            summary.steps[name] = {
                ok: false,
                ms: Date.now() - startedAt,
                error: sanitizeError(error),
            };
            throw new Error(`${name}: ${sanitizeError(error)}`);
        }
    }

    function attachPageTelemetry(page, label) {
        page.on('console', (message) => {
            if (message.type() !== 'error') return;
            summary.browser_issues.push({
                page: label,
                type: 'console.error',
                text: sanitizeError(message.text()),
            });
        });
        page.on('pageerror', (error) => {
            summary.browser_issues.push({
                page: label,
                type: 'pageerror',
                text: sanitizeError(error),
            });
        });
        page.on('requestfailed', (request) => {
            const failure = request.failure();
            summary.browser_issues.push({
                page: label,
                type: 'requestfailed',
                url: request.url(),
                text: sanitizeError(failure?.errorText || 'request failed'),
            });
        });
    }

    async function screenshot(page, name, maskSelectors = []) {
        const filePath = path.join(OUTPUT_DIR, `${RUN_ID}-${name}.png`);
        const mask = maskSelectors.map((selector) => page.locator(selector));
        await page.screenshot({ path: filePath, fullPage: true, mask });
        summary.screenshots.push(filePath);
        return filePath;
    }

    async function waitForText(page, selector, text, timeout = 30000) {
        await page.waitForFunction(
            ({ selector: query, text: expected }) => document.querySelector(query)?.textContent?.includes(expected),
            { selector, text },
            { timeout },
        );
    }

    async function waitForCountAtLeast(page, selector, count, timeout = 30000) {
        await page.waitForFunction(
            ({ selector: query, count: expected }) => Number(document.querySelector(query)?.textContent || 0) >= expected,
            { selector, count },
            { timeout },
        );
    }

    async function seedPrinter({ orgId, nodeId, localPrinterId }) {
        const rows = await supabaseRequest('/rest/v1/cloud_printers?select=printer_id,org_id,node_id,local_printer_id,name,model,status,capabilities,status_snapshot,last_seen_at', {
            method: 'POST',
            headers: { Prefer: 'return=representation' },
            body: {
                org_id: orgId,
                node_id: nodeId,
                local_printer_id: localPrinterId,
                name: `E2E Bambu X1C ${RUN_ID}`,
                model: 'Bambu X1 Carbon',
                status: 'online',
                capabilities: {
                    printer_lan_control: true,
                    auto_eject: true,
                    failure_detection: true,
                    materials: ['PLA', 'PETG'],
                    colors: [COLOR_HEX, SECONDARY_COLOR_HEX],
                    build_volume_mm: { x: 256, y: 256, z: 256 },
                    ams_trays: [
                        { material: 'PLA', color_hex: COLOR_HEX, ams_id: 1, tray_id: 1 },
                        { material: 'PETG', color_hex: SECONDARY_COLOR_HEX, ams_id: 1, tray_id: 2 },
                    ],
                    ejection: { enabled: true, method: 'auto_eject' },
                    maintenance: { print_hours: 12 },
                },
                status_snapshot: {
                    state: 'idle',
                    gcode_state: 'idle',
                    bed_clear: true,
                    print_hours: 12,
                    ams: {
                        trays: [
                            { tray_type: 'PLA', tray_color: COLOR_HEX, tray_id: 1, ams_id: 1 },
                            { tray_type: 'PETG', tray_color: SECONDARY_COLOR_HEX, tray_id: 2, ams_id: 1 },
                        ],
                    },
                },
                last_seen_at: new Date().toISOString(),
            },
        });
        const printer = rows?.[0];
        assert(printer?.printer_id, 'seeded printer_id was not returned');
        return printer;
    }

    async function cleanup() {
        if (originalFarmSettings) {
            try {
                await adminApi('/api/cloud/farm-automation', {
                    method: 'PATCH',
                    body: originalFarmSettings,
                    expected: [200],
                });
                summary.cleanup.push('restored farm automation settings');
            } catch (error) {
                cleanupErrors.push(`farm automation restore: ${sanitizeError(error)}`);
            }
        }

        if (originalMerchantMode !== null) {
            try {
                await adminApi('/api/cloud/merchant-settings', {
                    method: 'PATCH',
                    body: { full_auto_merchant_mode: originalMerchantMode },
                    expected: [200],
                });
                summary.cleanup.push('restored merchant mode');
            } catch (error) {
                cleanupErrors.push(`merchant mode restore: ${sanitizeError(error)}`);
            }
        }

        for (const storagePath of storagePaths) {
            try {
                await supabaseStorageRequest(`/storage/v1/object/print-artifacts/${encodeStoragePath(storagePath)}`, { method: 'DELETE', allow404: true });
                summary.cleanup.push(`deleted storage artifact ${storagePath}`);
            } catch (error) {
                cleanupErrors.push(`storage cleanup ${storagePath}: ${sanitizeError(error)}`);
            }
        }

        for (const orgId of createdOrgIds) {
            try {
                await supabaseRequest(`/rest/v1/organizations?org_id=eq.${encodeURIComponent(orgId)}`, {
                    method: 'DELETE',
                    headers: { Prefer: 'return=minimal' },
                });
                summary.cleanup.push(`deleted test org ${shortId(orgId)}`);
            } catch (error) {
                cleanupErrors.push(`org cleanup ${shortId(orgId)}: ${sanitizeError(error)}`);
            }
        }
    }

    async function claimAndSucceedCommands({ nodeToken, expectedCommandIds = [] }) {
        const claimed = await agentApi('/api/agent/commands?limit=10', nodeToken, { expected: [200] });
        const commands = Array.isArray(claimed.commands) ? claimed.commands : [];
        if (expectedCommandIds.length > 0) {
            for (const commandId of expectedCommandIds) {
                assert(commands.some((command) => command.command_id === commandId), `expected command ${commandId} was not claimed by the node`);
            }
        }
        for (const command of commands) {
            await agentApi('/api/agent/command-result', nodeToken, {
                method: 'POST',
                body: {
                    command_id: command.command_id,
                    status: 'succeeded',
                    result: {
                        e2e: true,
                        run_id: RUN_ID,
                        command_type: command.command_type,
                    },
                },
                expected: [200],
            });
        }
        return commands;
    }

    try {
        originalMerchantMode = await step('read merchant mode setting', async () => {
            const payload = await adminApi('/api/cloud/merchant-settings', { expected: [200] });
            const enabled = payload.settings?.full_auto_merchant_mode?.enabled === true;
            return { enabled };
        }).then((result) => result.enabled);

        await step('snapshot farm automation settings', async () => {
            const payload = await adminApi('/api/cloud/farm-automation?limit=100', { expected: [200] });
            const settings = payload.automation?.settings;
            assert(settings?.policy && settings?.inventory && settings?.integrations, 'farm automation settings were incomplete');
            originalFarmSettings = {
                policy: settings.policy,
                inventory: settings.inventory,
                integrations: settings.integrations,
            };
            return {
                settings_captured: true,
                existing_spools: Array.isArray(settings.inventory?.spools) ? settings.inventory.spools.length : 0,
                existing_integrations: Object.values(settings.integrations || {}).flat().length,
            };
        });

        await step('force approval-required signup mode', async () => {
            const payload = await adminApi('/api/cloud/merchant-settings', {
                method: 'PATCH',
                body: { full_auto_merchant_mode: false },
                expected: [200],
            });
            assert(payload.settings?.full_auto_merchant_mode?.enabled === false, 'merchant mode did not save as approve-only');
            return { approval_required: true };
        });

        browser = await chromium.launch({ headless: !hasFlag('--headed') });
        context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });

        const onboardingPage = await context.newPage();
        attachPageTelemetry(onboardingPage, 'merchant-onboarding');

        const merchant = await step('browser merchant signup approval-required', async () => {
            await onboardingPage.goto(`${baseUrl}/merchant-onboarding.html`, { waitUntil: 'domcontentloaded' });
            await onboardingPage.locator('#merchant-signup-form').waitFor({ state: 'visible' });
            const email = `printkinetix+${RUN_ID}@example.com`;
            await onboardingPage.fill('input[name="company_name"]', `PrintKinetix E2E Merchant ${RUN_ID}`);
            await onboardingPage.fill('input[name="contact_name"]', 'PrintKinetix E2E');
            await onboardingPage.fill('input[name="contact_email"]', email);
            await onboardingPage.fill('input[name="website"]', `https://${RUN_ID}.example.com`);
            const [response] = await Promise.all([
                onboardingPage.waitForResponse((res) => res.url().endsWith('/api/public/merchants/signup') && res.request().method() === 'POST'),
                onboardingPage.locator('#merchant-signup-form button[type="submit"]').click(),
            ]);
            const payload = await response.json();
            assert(response.status() === 201 && payload.ok === true, `signup failed with ${response.status()}`);
            assert(payload.approval_required === true, 'signup should require admin approval by default');
            assert(payload.merchant?.merchant_id, 'signup response did not include merchant_id');
            assert(payload.merchant?.org_id, 'signup response did not include org_id');
            createdOrgIds.add(payload.merchant.org_id);
            await waitForText(onboardingPage, '#signup-status', 'Pending approval');
            await screenshot(onboardingPage, 'merchant-onboarding-pending', ['#setup-token', '#api-key-secret']);
            return {
                merchant_id: payload.merchant.merchant_id,
                org_id: payload.merchant.org_id,
                status: payload.merchant.status,
                approval_required: payload.approval_required,
                contact_email: email,
            };
        });

        const adminPage = await context.newPage();
        attachPageTelemetry(adminPage, 'cloud-admin');

        await step('browser admin dashboard loads and setup is ready', async () => {
            await adminPage.goto(`${baseUrl}/cloud`, { waitUntil: 'domcontentloaded' });
            await adminPage.locator('h1').filter({ hasText: 'PrintKinetix Admin' }).waitFor({ state: 'visible' });
            await adminPage.fill('#admin-token', adminToken);
            await adminPage.fill('#row-limit', '100');
            await adminPage.locator('#save-token').click();
            await adminPage.locator('#refresh').click();
            await waitForText(adminPage, '#api-state', 'Connected', 45000);
            await waitForText(adminPage, '#setup-status', 'Schema ready', 45000);
            return { connected: true };
        });

        await step('browser admin merchant mode toggle works', async () => {
            await adminPage.locator('#full-auto-mode').setChecked(true);
            await Promise.all([
                adminPage.waitForResponse((res) => res.url().endsWith('/api/cloud/merchant-settings') && res.request().method() === 'PATCH'),
                adminPage.locator('#merchant-settings-form button[type="submit"]').click(),
            ]);
            await waitForText(adminPage, '#merchant-mode-state', 'Full auto on');
            await adminPage.locator('#full-auto-mode').setChecked(false);
            await Promise.all([
                adminPage.waitForResponse((res) => res.url().endsWith('/api/cloud/merchant-settings') && res.request().method() === 'PATCH'),
                adminPage.locator('#merchant-settings-form button[type="submit"]').click(),
            ]);
            await waitForText(adminPage, '#merchant-mode-state', 'Approve only');
            return { toggled_full_auto_on_and_back_to_approval: true };
        });

        const adminOrg = await step('browser admin creates organization', async () => {
            await adminPage.fill('#organization-name', `PrintKinetix E2E Admin Org ${RUN_ID}`);
            const [response] = await Promise.all([
                adminPage.waitForResponse((res) => res.url().endsWith('/api/cloud/organizations') && res.request().method() === 'POST'),
                adminPage.locator('#organization-form button[type="submit"]').click(),
            ]);
            const payload = await response.json();
            assert(response.status() === 201 && payload.organization?.org_id, 'admin organization creation failed');
            createdOrgIds.add(payload.organization.org_id);
            await waitForText(adminPage, '#organization-output', 'ORG_ID=');
            return { org_id: payload.organization.org_id };
        });

        const approval = await step('browser admin approves merchant and issues setup token', async () => {
            await adminPage.fill('#merchant-action-id', merchant.merchant_id);
            await adminPage.selectOption('#merchant-action', 'approve');
            await adminPage.locator('#merchant-issue-setup-token').setChecked(true);
            await adminPage.fill('#merchant-action-metadata', JSON.stringify({ e2e: true, run_id: RUN_ID, admin_org_id: adminOrg.org_id }, null, 2));
            const [response] = await Promise.all([
                adminPage.waitForResponse((res) => res.url().endsWith('/api/cloud/merchants') && res.request().method() === 'POST'),
                adminPage.locator('#merchant-action-form button[type="submit"]').click(),
            ]);
            const payload = await response.json();
            assert(response.status() === 200 && payload.merchant?.status === 'active', 'merchant approval failed');
            assert(typeof payload.merchant_setup_token === 'string' && payload.merchant_setup_token.startsWith('pkx_setup_'), 'setup token was not issued');
            await waitForText(adminPage, '#merchant-action-output', 'MERCHANT_SETUP_TOKEN=');
            return {
                merchant_status: payload.merchant.status,
                setup_token_issued: true,
                setup_token_expires_at: payload.setup_token_expires_at,
                setupToken: payload.merchant_setup_token,
            };
        });

        const node = await step('browser admin provisions Windows node for merchant org', async () => {
            await adminPage.fill('#node-org-id', merchant.org_id);
            await adminPage.fill('#node-name', `E2E Windows Print Manager ${RUN_ID}`);
            await adminPage.fill('#node-capabilities', JSON.stringify({
                e2e: true,
                run_id: RUN_ID,
                max_concurrent_jobs: 4,
                network_interface_count: 2,
                printer_lan_control: true,
                redundant_outbox: true,
            }, null, 2));
            const [response] = await Promise.all([
                adminPage.waitForResponse((res) => res.url().endsWith('/api/cloud/nodes') && res.request().method() === 'POST'),
                adminPage.locator('#node-form button[type="submit"]').click(),
            ]);
            const payload = await response.json();
            assert(response.status() === 201 && payload.node?.node_id, 'node provisioning failed');
            assert(typeof payload.local_node_token === 'string' && payload.local_node_token.startsWith('pkx_node_'), 'local node token was not issued');
            await waitForText(adminPage, '#node-token-output', 'LOCAL_NODE_TOKEN=');
            return {
                node_id: payload.node.node_id,
                node_name: payload.node.name || `E2E Windows Print Manager ${RUN_ID}`,
                local_node_token_issued: true,
                localNodeToken: payload.local_node_token,
            };
        });

        const localPrinterId = `e2e-printer-${RUN_ID}`;
        const printer = await step('agent heartbeat and seeded printer inventory', async () => {
            const heartbeat = await agentApi('/api/agent/heartbeat', node.localNodeToken, {
                method: 'POST',
                body: {
                    status: 'online',
                    agent_version: `e2e-${RUN_ID}`,
                    host_info: {
                        hostname: `windows-e2e-${RUN_ID}`,
                        os: 'Windows 11 Pro',
                        runner: 'live-e2e-test',
                    },
                    capabilities: {
                        e2e: true,
                        run_id: RUN_ID,
                        printer_lan_control: true,
                        network_interface_count: 2,
                        networks: ['192.168.1.0/24', '10.10.0.0/24'],
                        pending_result_count: 0,
                    },
                },
                expected: [200],
            });
            const seeded = await seedPrinter({ orgId: merchant.org_id, nodeId: node.node_id, localPrinterId });
            await agentApi('/api/agent/events', node.localNodeToken, {
                method: 'POST',
                body: {
                    events: [{
                        event_type: 'printer.discovered',
                        printer_id: seeded.printer_id,
                        payload: {
                            local_printer_id: localPrinterId,
                            model: seeded.model,
                            e2e: true,
                            run_id: RUN_ID,
                        },
                    }],
                },
                expected: [200],
            });
            return {
                heartbeat_status: heartbeat.status,
                printer_id: seeded.printer_id,
                local_printer_id: localPrinterId,
            };
        });

        await step('browser admin shows node and printer management tables', async () => {
            await adminPage.fill('#org-id', merchant.org_id);
            await adminPage.locator('#save-token').click();
            await adminPage.locator('#refresh').click();
            await waitForCountAtLeast(adminPage, '#node-count', 1, 45000);
            await waitForCountAtLeast(adminPage, '#printer-count', 1, 45000);
            await waitForText(adminPage, '#nodes-table', node.node_name, 45000);
            await waitForText(adminPage, '#printers-table', localPrinterId, 45000);
            await screenshot(adminPage, 'cloud-admin-printer-management', [
                '#admin-token',
                '#node-token-output',
                '#merchant-action-output',
                '#merchant-key-output',
            ]);
            return { nodes_visible: true, printers_visible: true };
        });

        const farmPolicy = {
            smart_queue_enabled: true,
            auto_eject_enabled: true,
            failure_detection_enabled: true,
            release_temperature_c: 28,
            max_eject_attempts: 4,
            bed_clear_verification: 'camera_or_operator',
        };
        const farmInventory = {
            spools: [
                {
                    spool_id: `${RUN_ID}-pla-cyan`,
                    material: 'PLA',
                    color_hex: COLOR_HEX,
                    color_name: 'Cyan',
                    brand: 'Bambu',
                    lot_code: RUN_ID,
                    grams_remaining: 1000,
                    reorder_threshold_grams: 100,
                    dry_status: 'dry',
                    local_printer_id: localPrinterId,
                    ams_id: 1,
                    tray_id: 1,
                },
                {
                    spool_id: `${RUN_ID}-petg-black`,
                    material: 'PETG',
                    color_hex: SECONDARY_COLOR_HEX,
                    color_name: 'Black',
                    brand: 'Bambu',
                    lot_code: RUN_ID,
                    grams_remaining: 850,
                    reorder_threshold_grams: 120,
                    dry_status: 'dry',
                    local_printer_id: localPrinterId,
                    ams_id: 1,
                    tray_id: 2,
                },
            ],
        };
        const farmIntegrations = {
            alerts: [{ type: 'slack', enabled: true, name: `E2E Slack ${RUN_ID}`, metadata: { run_id: RUN_ID } }],
            ecommerce: [{ type: 'shopify', enabled: true, name: `E2E Shopify ${RUN_ID}`, metadata: { run_id: RUN_ID } }],
            vision: [{ type: 'camera_ai_webhook', enabled: true, name: `E2E Vision ${RUN_ID}`, metadata: { run_id: RUN_ID } }],
            shipping: [{ type: 'shipstation', enabled: true, name: `E2E ShipStation ${RUN_ID}`, metadata: { run_id: RUN_ID } }],
            remote_access: [{ type: 'tailscale', enabled: true, name: `E2E Remote ${RUN_ID}`, metadata: { run_id: RUN_ID } }],
        };

        await step('browser admin saves automation policy inventory and integrations', async () => {
            await adminPage.locator('#smart-queue-enabled').setChecked(true);
            await adminPage.locator('#auto-eject-enabled').setChecked(true);
            await adminPage.locator('#failure-detection-enabled').setChecked(true);
            await adminPage.fill('#release-temperature-c', String(farmPolicy.release_temperature_c));
            await adminPage.fill('#max-eject-attempts', String(farmPolicy.max_eject_attempts));
            await adminPage.selectOption('#bed-clear-verification', farmPolicy.bed_clear_verification);
            await Promise.all([
                adminPage.waitForResponse((res) => res.url().endsWith('/api/cloud/farm-automation') && res.request().method() === 'PATCH'),
                adminPage.locator('#farm-automation-form button[type="submit"]').click(),
            ]);

            await adminPage.fill('#filament-inventory-json', JSON.stringify(farmInventory, null, 2));
            await Promise.all([
                adminPage.waitForResponse((res) => res.url().endsWith('/api/cloud/farm-automation') && res.request().method() === 'PATCH'),
                adminPage.locator('#filament-inventory-form button[type="submit"]').click(),
            ]);

            await adminPage.fill('#integrations-json', JSON.stringify(farmIntegrations, null, 2));
            await Promise.all([
                adminPage.waitForResponse((res) => res.url().endsWith('/api/cloud/farm-automation') && res.request().method() === 'PATCH'),
                adminPage.locator('#integrations-form button[type="submit"]').click(),
            ]);
            await waitForText(adminPage, '#farm-automation-plan', 'auto ejection', 45000);
            return {
                spools_saved: farmInventory.spools.length,
                integrations_saved: Object.values(farmIntegrations).flat().length,
            };
        });

        const adminCommand = await step('browser admin queues printer command and agent completes it', async () => {
            await adminPage.selectOption('#command-node', node.node_id);
            await adminPage.selectOption('#command-type', 'printer.status');
            await adminPage.fill('#command-printer', printer.printer_id);
            await adminPage.fill('#command-payload', JSON.stringify({ local_printer_id: localPrinterId }, null, 2));
            const [response] = await Promise.all([
                adminPage.waitForResponse((res) => res.url().endsWith('/api/cloud/commands') && res.request().method() === 'POST'),
                adminPage.locator('#command-form button[type="submit"]').click(),
            ]);
            const payload = await response.json();
            assert(response.status() === 201 && payload.command?.command_id, 'admin command was not created');
            const commands = await claimAndSucceedCommands({
                nodeToken: node.localNodeToken,
                expectedCommandIds: [payload.command.command_id],
            });
            await adminPage.locator('#refresh').click();
            await waitForText(adminPage, '#commands-table', 'succeeded', 45000);
            return {
                command_id: payload.command.command_id,
                claimed: commands.length,
            };
        });

        const liveKey = await step('browser merchant exchanges setup token for live API key', async () => {
            await onboardingPage.fill('#setup-token', approval.setupToken);
            await onboardingPage.fill('#api-key-name', `E2E Live Key ${RUN_ID}`);
            const [response] = await Promise.all([
                onboardingPage.waitForResponse((res) => res.url().endsWith('/api/public/api-keys') && res.request().method() === 'POST'),
                onboardingPage.locator('#setup-token-form button[type="submit"]').click(),
            ]);
            const payload = await response.json();
            assert(response.status() === 201 && typeof payload.api_key_secret === 'string', 'live API key was not returned');
            assert(payload.api_key_secret.startsWith('pkx_live_'), 'live API key has an unexpected prefix');
            await waitForText(onboardingPage, '#signup-status', 'Live key created');
            await screenshot(onboardingPage, 'merchant-live-key-created', ['#setup-token', '#api-key-secret']);
            return {
                key_id: payload.api_key?.key_id,
                live_key_issued: true,
                apiKey: payload.api_key_secret,
            };
        });

        await step('public docs and openapi are browsable', async () => {
            const docsPage = await context.newPage();
            attachPageTelemetry(docsPage, 'merchant-docs');
            await docsPage.goto(`${baseUrl}/merchant-api.html`, { waitUntil: 'domcontentloaded' });
            await docsPage.locator('body').filter({ hasText: '/api/public/print-jobs' }).waitFor({ state: 'visible' });
            await docsPage.locator('body').filter({ hasText: '/api/public/farm/filaments' }).waitFor({ state: 'visible' });
            await screenshot(docsPage, 'merchant-api-docs');
            await docsPage.goto(`${baseUrl}/windows-node-guide.html`, { waitUntil: 'domcontentloaded' });
            await docsPage.locator('body').filter({ hasText: 'LOCAL_NODE_TOKEN' }).waitFor({ state: 'visible' });
            await screenshot(docsPage, 'windows-node-guide');
            await docsPage.close();

            const openApi = await api('/openapi/merchant-api-v1.json', { expected: [200], okField: false });
            assert(openApi.paths?.['/api/public/print-jobs'], 'OpenAPI is missing /api/public/print-jobs');
            assert(openApi.paths?.['/api/public/farm/filaments'], 'OpenAPI is missing /api/public/farm/filaments');
            return {
                docs_pages: 2,
                openapi_paths: Object.keys(openApi.paths || {}).length,
            };
        });

        await step('public farm capability and filament endpoints publish availability', async () => {
            const filaments = await api('/api/public/farm/filaments', { expected: [200] });
            const capabilities = await api('/api/public/farm/capabilities', { expected: [200] });
            const materials = (filaments.filaments?.materials || []).map((item) => item.material);
            assert(materials.includes('PLA'), 'public filament endpoint did not include PLA');
            assert(materials.includes('PETG'), 'public filament endpoint did not include PETG');
            assert(capabilities.capabilities?.features?.filament_inventory === true, 'public capabilities did not enable filament inventory');
            assert(capabilities.capabilities?.features?.auto_ejection === true, 'public capabilities did not enable auto ejection');
            assert(capabilities.capabilities?.features?.shopify === true, 'public capabilities did not expose Shopify integration');
            assert(capabilities.capabilities?.features?.shipstation === true, 'public capabilities did not expose ShipStation integration');
            assert(capabilities.capabilities?.features?.slack_alerts === true, 'public capabilities did not expose Slack alerts');
            return {
                materials,
                accepting_jobs: capabilities.capabilities?.accepting_jobs,
                online_printers: capabilities.capabilities?.fleet?.online_printer_count,
            };
        });

        const secondaryKey = await step('merchant account key list create and revoke APIs work', async () => {
            const me = await merchantApi('/api/public/merchant/me', liveKey.apiKey, { expected: [200] });
            assert(me.merchant?.merchant_id === merchant.merchant_id, 'merchant/me returned the wrong merchant');
            const created = await merchantApi('/api/public/api-keys', liveKey.apiKey, {
                method: 'POST',
                body: { name: `E2E Secondary ${RUN_ID}` },
                expected: [201],
            });
            assert(created.api_key?.key_id, 'secondary API key id missing');
            const listed = await merchantApi('/api/public/api-keys', liveKey.apiKey, { expected: [200] });
            assert((listed.api_keys || []).some((key) => key.key_id === created.api_key.key_id), 'secondary key was not listed');
            const revoked = await merchantApi('/api/public/api-keys/revoke', liveKey.apiKey, {
                method: 'POST',
                body: { key_id: created.api_key.key_id },
                expected: [200],
            });
            assert(revoked.api_key?.revoked_at, 'secondary key was not revoked');
            return {
                merchant_id: me.merchant.merchant_id,
                secondary_key_created: true,
                secondary_key_revoked: true,
            };
        });

        await step('merchant quote preflight integrations and webhook APIs work', async () => {
            const requirements = {
                material: 'PLA',
                color: COLOR_HEX,
                dimensions_mm: { x: 30, y: 30, z: 12 },
                estimated_grams: 18,
            };
            const quote = await merchantApi('/api/public/quotes', liveKey.apiKey, {
                method: 'POST',
                body: { requirements, options: { routing_strategy: 'fastest_fulfillment' } },
                expected: [200],
            });
            assert(quote.routing?.status === 'routed', `quote routing status was ${quote.routing?.status}`);
            const preflight = await merchantApi('/api/public/print-jobs/preflight', liveKey.apiKey, {
                method: 'POST',
                body: {
                    file: { name: `${RUN_ID}.gcode`, byte_size: 256 },
                    requirements,
                    options: { routing_strategy: 'fastest_fulfillment' },
                },
                expected: [200],
            });
            assert(preflight.routing?.status === 'routed', `preflight routing status was ${preflight.routing?.status}`);
            const integrations = await api('/api/public/integrations', { expected: [200] });
            assert((integrations.integrations || []).some((item) => item.type === 'shopify'), 'integrations endpoint missing Shopify');
            const webhook = await merchantApi('/api/public/webhooks', liveKey.apiKey, {
                method: 'POST',
                body: {
                    enabled: false,
                    endpoint_url: 'https://example.com/printkinetix/e2e',
                    secret: `whsec_${RUN_ID}`,
                    events: ['job.accepted', 'job.canceled', 'job.reprint_requested'],
                },
                expected: [200],
            });
            assert(webhook.webhook?.has_secret === true, 'webhook secret was not accepted');
            const webhookRead = await merchantApi('/api/public/webhooks', liveKey.apiKey, { expected: [200] });
            assert(webhookRead.webhook?.has_secret === true && !('secret' in webhookRead.webhook), 'webhook read did not redact the secret');
            return {
                quote_status: quote.routing.status,
                preflight_status: preflight.routing.status,
                webhook_redacted: true,
            };
        });

        const printJob = await step('merchant print job ingestion routing idempotency and lifecycle work', async () => {
            const requirements = {
                material: 'PLA',
                color: COLOR_HEX,
                dimensions_mm: { x: 30, y: 30, z: 12 },
                estimated_grams: 18,
            };
            const jobBody = {
                name: `E2E Routed Print ${RUN_ID}`,
                file: {
                    name: `${RUN_ID}.gcode`,
                    content_type: 'text/plain',
                    base64: Buffer.from(`; PrintKinetix live E2E ${RUN_ID}\nG28\nM104 S200\nM140 S60\n`).toString('base64'),
                },
                requirements,
                options: {
                    routing_strategy: 'fastest_fulfillment',
                    priority: 'standard',
                    merchant_order_id: `order-${RUN_ID}`,
                    requirements,
                },
            };
            const idempotencyKey = `${RUN_ID}-job`;
            const created = await merchantApi('/api/public/print-jobs', liveKey.apiKey, {
                method: 'POST',
                headers: { 'Idempotency-Key': idempotencyKey },
                body: jobBody,
                expected: [201],
            });
            assert(created.job?.job_id, 'print job id missing');
            assert(created.job.status === 'queued', `expected queued job, got ${created.job.status}`);
            assert(created.routing?.status === 'routed', `expected routed job, got ${created.routing?.status}`);
            if (created.file?.storage_path) storagePaths.add(created.file.storage_path);
            const replay = await merchantApi('/api/public/print-jobs', liveKey.apiKey, {
                method: 'POST',
                headers: { 'Idempotency-Key': idempotencyKey },
                body: jobBody,
                expected: [200],
            });
            assert(replay.idempotent_replay === true, 'idempotency replay did not return the existing job');
            const status = await merchantApi(`/api/public/print-jobs/status?job_id=${encodeURIComponent(created.job.job_id)}`, liveKey.apiKey, { expected: [200] });
            assert(status.job?.job_id === created.job.job_id, 'status endpoint returned the wrong job');
            const listed = await merchantApi('/api/public/print-jobs?limit=20', liveKey.apiKey, { expected: [200] });
            assert((listed.jobs || []).some((job) => job.job_id === created.job.job_id), 'job list did not include the new job');
            const commands = await claimAndSucceedCommands({ nodeToken: node.localNodeToken });
            assert(commands.some((command) => command.command_type === 'cloud.print.ready'), 'agent did not claim the cloud.print.ready command');
            const approved = await merchantApi('/api/public/print-jobs/approve', liveKey.apiKey, {
                method: 'POST',
                body: { job_id: created.job.job_id },
                expected: [200],
            });
            assert(approved.job?.job_id === created.job.job_id, 'approve endpoint returned the wrong job');
            const canceled = await merchantApi('/api/public/print-jobs/cancel', liveKey.apiKey, {
                method: 'POST',
                body: { job_id: created.job.job_id, reason: 'e2e verification complete' },
                expected: [200],
            });
            assert(canceled.job?.status === 'canceled', 'cancel endpoint did not cancel the job');
            const reprint = await merchantApi('/api/public/print-jobs/reprint', liveKey.apiKey, {
                method: 'POST',
                body: { job_id: created.job.job_id, reason: 'e2e reprint route coverage' },
                expected: [201],
            });
            assert(reprint.job?.status === 'reprint_requested', 'reprint endpoint did not create a reprint request');
            return {
                job_id: created.job.job_id,
                routed_printer_id: created.routing.selected_printer_id,
                print_command_claimed: true,
                reprint_job_id: reprint.job.job_id,
            };
        });

        await step('browser admin loads merchant jobs usage keys commands and events', async () => {
            await adminPage.fill('#merchant-lookup-id', merchant.merchant_id);
            await Promise.all([
                adminPage.waitForResponse((res) => res.url().includes('/api/cloud/merchant-jobs') && res.request().method() === 'GET'),
                adminPage.locator('#merchant-lookup-form button[type="submit"]').click(),
            ]);
            await waitForCountAtLeast(adminPage, '#merchant-job-count', 1, 45000);
            await waitForCountAtLeast(adminPage, '#merchant-usage-count', 1, 45000);
            await waitForText(adminPage, '#merchant-jobs-table', printJob.job_id.slice(0, 8), 45000);
            await adminPage.locator('#refresh').click();
            await waitForText(adminPage, '#events-table', 'printer.discovered', 45000);
            await waitForText(adminPage, '#commands-table', adminCommand.command_id.slice(0, 8), 45000);

            const jobs = await adminApi(`/api/cloud/merchant-jobs?merchant_id=${encodeURIComponent(merchant.merchant_id)}&limit=20`, { expected: [200] });
            const usage = await adminApi(`/api/cloud/merchant-usage?merchant_id=${encodeURIComponent(merchant.merchant_id)}&limit=50`, { expected: [200] });
            const keys = await adminApi(`/api/cloud/merchant-api-keys?merchant_id=${encodeURIComponent(merchant.merchant_id)}`, { expected: [200] });
            assert((jobs.jobs || []).length >= 2, 'admin merchant jobs endpoint did not include original and reprint jobs');
            assert((usage.usage || []).length >= 4, 'admin usage endpoint did not include lifecycle usage events');
            assert((keys.api_keys || []).some((key) => key.key_id === liveKey.key_id), 'admin API keys endpoint did not include live key');
            await screenshot(adminPage, 'cloud-admin-merchant-operations', [
                '#admin-token',
                '#node-token-output',
                '#merchant-action-output',
                '#merchant-key-output',
            ]);
            return {
                admin_jobs: jobs.jobs.length,
                admin_usage_events: usage.usage.length,
                admin_api_keys: keys.api_keys.length,
                secondary_key_revoked: secondaryKey.secondary_key_revoked,
            };
        });

        await step('browser telemetry has no errors', async () => {
            assert(summary.browser_issues.length === 0, `browser reported ${summary.browser_issues.length} issue(s): ${JSON.stringify(summary.browser_issues).slice(0, 500)}`);
            return { browser_errors: 0 };
        });

        summary.ok = true;
    } finally {
        await cleanup();
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        if (cleanupErrors.length > 0) {
            summary.cleanup_errors = cleanupErrors;
        }
        await fs.writeFile(path.join(OUTPUT_DIR, `${RUN_ID}-summary.json`), JSON.stringify(summary, null, 2));
    }

    if (cleanupErrors.length > 0) {
        throw new Error(`E2E passed but cleanup had ${cleanupErrors.length} issue(s): ${cleanupErrors.join('; ')}`);
    }

    console.log(JSON.stringify({
        ok: summary.ok,
        run_id: summary.run_id,
        base_url: summary.base_url,
        screenshots: summary.screenshots,
        summary_file: path.join(OUTPUT_DIR, `${RUN_ID}-summary.json`),
        steps: Object.fromEntries(Object.entries(summary.steps).map(([name, value]) => [name, { ok: value.ok, ms: value.ms }])),
        cleanup: summary.cleanup,
    }, null, 2));
}

main().catch(async (error) => {
    console.error(JSON.stringify({
        ok: false,
        run_id: RUN_ID,
        error: sanitizeError(error),
    }, null, 2));
    process.exit(1);
});
