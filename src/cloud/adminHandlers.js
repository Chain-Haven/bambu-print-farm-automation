import { randomBytes } from 'node:crypto';
import { AdminAuthError, authenticateCloudAdmin } from './adminAuth.js';
import { hashNodeToken, parseJsonBody } from './agentProtocol.js';
import {
    buildMerchantApiKeyRecord,
    buildMerchantSetupTokenRecord,
    generateMerchantApiKey,
    generateMerchantSetupToken,
} from './merchantAuth.js';
import { buildWindowsNodePackage, getNodePackageFileName } from './nodePackage.js';
import { buildFarmAutomationPlan, normalizeFarmAutomationSettings } from './farmAutomation.js';

const MERCHANT_SETUP_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const FARM_AUTOMATION_POLICY_KEY = 'farm_automation_policy';
const FARM_FILAMENT_INVENTORY_KEY = 'farm_filament_inventory';
const FARM_INTEGRATIONS_KEY = 'farm_integrations';

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sendJson(res, statusCode, payload) {
    if (typeof res.status === 'function' && typeof res.json === 'function') {
        return res.status(statusCode).json(payload);
    }

    res.statusCode = statusCode;
    if (typeof res.setHeader === 'function') {
        res.setHeader('Content-Type', 'application/json');
    }
    return res.end(JSON.stringify(payload));
}

function methodNotAllowed(res, methods) {
    if (typeof res.setHeader === 'function') {
        res.setHeader('Allow', methods);
    }
    return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
}

function normalizeRequiredString(value, name) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${name} is required`);
    }
    return value.trim();
}

function normalizeOptionalString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseLimit(query = {}) {
    const raw = Number.parseInt(query.limit, 10);
    if (!Number.isFinite(raw)) return 50;
    return Math.max(1, Math.min(raw, 100));
}

function normalizeBoolean(value, name) {
    if (typeof value !== 'boolean') {
        throw new Error(`${name} must be true or false`);
    }
    return value;
}

function normalizeCloudCommand(body) {
    const source = isPlainObject(body) ? body : {};

    return {
        org_id: normalizeRequiredString(source.org_id, 'org_id'),
        node_id: normalizeRequiredString(source.node_id, 'node_id'),
        printer_id: normalizeOptionalString(source.printer_id),
        job_id: normalizeOptionalString(source.job_id),
        command_type: normalizeRequiredString(source.command_type, 'command_type'),
        payload: isPlainObject(source.payload) ? source.payload : {},
    };
}

function normalizeOrganization(body) {
    const source = isPlainObject(body) ? body : {};

    return {
        name: normalizeRequiredString(source.name, 'name'),
    };
}

function normalizeNodeProvision(body) {
    const source = isPlainObject(body) ? body : {};

    return {
        org_id: normalizeRequiredString(source.org_id, 'org_id'),
        name: normalizeRequiredString(source.name, 'name'),
        capabilities: isPlainObject(source.capabilities) ? source.capabilities : {},
        token: normalizeOptionalString(source.local_node_token),
    };
}

function normalizeNodePackageRequest(body, req) {
    const source = isPlainObject(body) ? body : {};
    const host = typeof (req.headers || {}).host === 'string' ? req.headers.host.trim() : '';
    const inferredCloudApiUrl = host ? `https://${host}` : '';

    return {
        cloudApiUrl: normalizeRequiredString(source.cloud_api_url || inferredCloudApiUrl, 'cloud_api_url'),
        localNodeToken: normalizeRequiredString(source.local_node_token, 'local_node_token'),
        nodeName: typeof source.node_name === 'string' && source.node_name.trim() ? source.node_name.trim() : 'Windows NUC',
    };
}

function generateNodeToken() {
    return `pkx_node_${randomBytes(32).toString('base64url')}`;
}

async function issueMerchantSetupToken({
    store,
    merchant,
    merchantPepper,
    now,
    setupTokenFactory,
}) {
    if (!merchantPepper) throw new Error('merchant api key pepper is required');
    if (!merchant || merchant.status !== 'active') {
        throw new Error('merchant must be active before issuing setup token');
    }

    const issuedAt = now();
    const expiresAt = new Date(issuedAt.getTime() + MERCHANT_SETUP_TOKEN_TTL_MS).toISOString();
    const rawToken = setupTokenFactory();
    const setupToken = buildMerchantSetupTokenRecord({
        merchant,
        rawToken,
        pepper: merchantPepper,
        expiresAt,
    });

    await store.createMerchantSetupToken(setupToken.record);
    return {
        secret: setupToken.secret,
        expires_at: expiresAt,
    };
}

async function issueMerchantApiKey({
    store,
    merchant,
    name,
    merchantPepper,
    liveKeyFactory,
}) {
    if (!merchantPepper) throw new Error('merchant api key pepper is required');
    if (!merchant || merchant.status !== 'active') {
        throw new Error('merchant must be active before issuing live API keys');
    }

    const rawKey = liveKeyFactory();
    const apiKey = buildMerchantApiKeyRecord({
        merchant,
        name,
        rawKey,
        pepper: merchantPepper,
    });
    const record = await store.createMerchantApiKey(apiKey.record);

    return {
        secret: apiKey.secret,
        record,
    };
}

function normalizeMerchantAction(body) {
    const source = isPlainObject(body) ? body : {};
    const merchantId = normalizeRequiredString(source.merchant_id, 'merchant_id');
    const action = normalizeRequiredString(source.action, 'action').toLowerCase();
    const issueSetupToken = source.issue_setup_token === true;

    if (!['approve', 'activate', 'reject', 'suspend'].includes(action)) {
        throw new Error('action must be approve, activate, reject, or suspend');
    }

    return {
        merchantId,
        action,
        issueSetupToken,
        metadata: isPlainObject(source.metadata) ? source.metadata : null,
    };
}

function normalizeMerchantKeyRequest(body, query = {}) {
    const source = isPlainObject(body) ? body : {};

    return {
        merchantId: normalizeRequiredString(source.merchant_id || query.merchant_id, 'merchant_id'),
        keyId: normalizeOptionalString(source.key_id || query.key_id),
        name: normalizeOptionalString(source.name) || 'Production',
    };
}

function redactMerchantApiKey(apiKey) {
    if (!apiKey) return null;
    const {
        key_id,
        merchant_id,
        org_id,
        name,
        key_prefix,
        last_used_at,
        revoked_at,
        created_at,
    } = apiKey;

    return Object.fromEntries(Object.entries({
        key_id,
        merchant_id,
        org_id,
        name,
        key_prefix,
        last_used_at,
        revoked_at,
        created_at,
    }).filter(([, value]) => value !== undefined));
}

function hasEnvValue(env, key) {
    return typeof env[key] === 'string' && env[key].trim() !== '';
}

function buildSetupEnvStatus(env, adminToken) {
    return [
        { key: 'SUPABASE_URL', present: hasEnvValue(env, 'SUPABASE_URL'), secret: false },
        {
            key: 'SUPABASE_SERVICE_ROLE_KEY',
            present: hasEnvValue(env, 'SUPABASE_SERVICE_ROLE_KEY') || hasEnvValue(env, 'SUPABASE_SECRET_KEY'),
            secret: true,
        },
        { key: 'NODE_TOKEN_PEPPER', present: hasEnvValue(env, 'NODE_TOKEN_PEPPER'), secret: true },
        { key: 'CLOUD_ADMIN_TOKEN', present: hasEnvValue(env, 'CLOUD_ADMIN_TOKEN') || !!adminToken, secret: true },
    ];
}

async function authenticateAdmin(req, res, adminToken, store) {
    if (!adminToken) {
        sendJson(res, 500, { ok: false, error: 'cloud_not_configured' });
        return false;
    }

    try {
        await authenticateCloudAdmin(req, {
            store,
            bootstrapToken: adminToken,
            pepper: process.env.ADMIN_SESSION_PEPPER || process.env.NODE_TOKEN_PEPPER,
        });
        return true;
    } catch (error) {
        if (error instanceof AdminAuthError) {
            sendJson(res, error.statusCode, { ok: false, error: error.code });
            return false;
        }
        throw error;
    }
}

export function createCloudSetupStatusHandler({
    store,
    adminToken = process.env.CLOUD_ADMIN_TOKEN,
    env = process.env,
}) {
    if (!store) throw new Error('store is required');

    return async function cloudSetupStatusHandler(req, res) {
        if (req.method && req.method !== 'GET') {
            return methodNotAllowed(res, 'GET');
        }

        try {
            if (!(await authenticateAdmin(req, res, adminToken, store))) return null;

            const envStatus = buildSetupEnvStatus(env, adminToken);
            const missing = envStatus.filter((item) => !item.present).map((item) => item.key);
            const missingSupabase = missing.includes('SUPABASE_URL') || missing.includes('SUPABASE_SERVICE_ROLE_KEY');
            let backend = {
                checked: false,
                ready: false,
                message: 'Supabase environment is incomplete',
                checks: [],
            };

            if (!missingSupabase) {
                try {
                    backend = await store.getCloudSetupStatus();
                } catch (error) {
                    backend = {
                        checked: true,
                        ready: false,
                        message: error.message,
                        checks: [],
                    };
                }
            }

            return sendJson(res, 200, {
                ok: true,
                setup: {
                    ready: missing.length === 0 && backend.ready === true,
                    env: envStatus,
                    missing,
                    backend,
                },
            });
        } catch (error) {
            return sendJson(res, 500, {
                ok: false,
                error: 'setup_status_failed',
                message: error.message,
            });
        }
    };
}

export function createCloudOverviewHandler({ store, adminToken = process.env.CLOUD_ADMIN_TOKEN }) {
    if (!store) throw new Error('store is required');

    return async function cloudOverviewHandler(req, res) {
        if (req.method && req.method !== 'GET') {
            return methodNotAllowed(res, 'GET');
        }

        try {
            if (!(await authenticateAdmin(req, res, adminToken, store))) return null;

            const overview = await store.getCloudOverview({
                orgId: normalizeOptionalString((req.query || {}).org_id),
                limit: parseLimit(req.query || {}),
            });

            return sendJson(res, 200, { ok: true, overview });
        } catch (error) {
            return sendJson(res, 500, {
                ok: false,
                error: 'overview_failed',
                message: error.message,
            });
        }
    };
}

export function createCloudCommandHandler({ store, adminToken = process.env.CLOUD_ADMIN_TOKEN }) {
    if (!store) throw new Error('store is required');

    return async function cloudCommandHandler(req, res) {
        if (req.method && req.method !== 'POST') {
            return methodNotAllowed(res, 'POST');
        }

        try {
            if (!(await authenticateAdmin(req, res, adminToken, store))) return null;

            const command = await store.createNodeCommand(normalizeCloudCommand(parseJsonBody(req.body)));
            return sendJson(res, 201, { ok: true, command });
        } catch (error) {
            return sendJson(res, 400, {
                ok: false,
                error: 'create_command_failed',
                message: error.message,
            });
        }
    };
}

export function createCloudOrganizationHandler({ store, adminToken = process.env.CLOUD_ADMIN_TOKEN }) {
    if (!store) throw new Error('store is required');

    return async function cloudOrganizationHandler(req, res) {
        if (req.method && req.method !== 'POST') {
            return methodNotAllowed(res, 'POST');
        }

        try {
            if (!(await authenticateAdmin(req, res, adminToken, store))) return null;

            const organization = await store.createOrganization(normalizeOrganization(parseJsonBody(req.body)));
            return sendJson(res, 201, { ok: true, organization });
        } catch (error) {
            return sendJson(res, 400, {
                ok: false,
                error: 'create_organization_failed',
                message: error.message,
            });
        }
    };
}

export function createCloudNodeProvisionHandler({
    store,
    adminToken = process.env.CLOUD_ADMIN_TOKEN,
    pepper = process.env.NODE_TOKEN_PEPPER,
    tokenFactory = generateNodeToken,
}) {
    if (!store) throw new Error('store is required');

    return async function cloudNodeProvisionHandler(req, res) {
        if (req.method && req.method !== 'POST') {
            return methodNotAllowed(res, 'POST');
        }

        try {
            if (!(await authenticateAdmin(req, res, adminToken, store))) return null;
            if (!pepper) {
                return sendJson(res, 500, { ok: false, error: 'cloud_not_configured' });
            }

            const provision = normalizeNodeProvision(parseJsonBody(req.body));
            const localNodeToken = provision.token || tokenFactory();
            const node = await store.createFarmNode({
                org_id: provision.org_id,
                name: provision.name,
                token_hash: hashNodeToken(localNodeToken, pepper),
                capabilities: provision.capabilities,
            });

            return sendJson(res, 201, {
                ok: true,
                node,
                local_node_token: localNodeToken,
            });
        } catch (error) {
            return sendJson(res, 400, {
                ok: false,
                error: 'provision_node_failed',
                message: error.message,
            });
        }
    };
}

export function createCloudNodePackageHandler({
    store = null,
    adminToken = process.env.CLOUD_ADMIN_TOKEN,
    rootDir = process.cwd(),
    packageBuilder = buildWindowsNodePackage,
} = {}) {
    return async function cloudNodePackageHandler(req, res) {
        if (req.method && req.method !== 'POST') {
            return methodNotAllowed(res, 'POST');
        }

        try {
            if (!(await authenticateAdmin(req, res, adminToken, store))) return null;

            const request = normalizeNodePackageRequest(parseJsonBody(req.body), req);
            const zipBuffer = packageBuilder({
                rootDir,
                cloudApiUrl: request.cloudApiUrl,
                localNodeToken: request.localNodeToken,
                nodeName: request.nodeName,
            });

            res.statusCode = 200;
            if (typeof res.setHeader === 'function') {
                res.setHeader('Content-Type', 'application/zip');
                res.setHeader('Content-Disposition', `attachment; filename="${getNodePackageFileName(request.nodeName)}"`);
                res.setHeader('Cache-Control', 'no-store');
            }
            return res.end(zipBuffer);
        } catch (error) {
            return sendJson(res, 400, {
                ok: false,
                error: 'node_package_failed',
                message: error.message,
            });
        }
    };
}

export function createCloudFarmAutomationHandler({
    store,
    adminToken = process.env.CLOUD_ADMIN_TOKEN,
}) {
    if (!store) throw new Error('store is required');

    async function loadAutomation({ orgId = null, limit = 50 } = {}) {
        const [policy, inventory, integrations, overview] = await Promise.all([
            store.getPlatformSetting(FARM_AUTOMATION_POLICY_KEY, {}),
            store.getPlatformSetting(FARM_FILAMENT_INVENTORY_KEY, { spools: [] }),
            store.getPlatformSetting(FARM_INTEGRATIONS_KEY, {}),
            store.getCloudOverview({ orgId, limit }),
        ]);
        const settings = normalizeFarmAutomationSettings({ policy, inventory, integrations });
        const plan = buildFarmAutomationPlan({ overview, settings });

        return { settings, plan, overview };
    }

    return async function cloudFarmAutomationHandler(req, res) {
        if (req.method === 'GET') {
            try {
                if (!(await authenticateAdmin(req, res, adminToken, store))) return null;
                const automation = await loadAutomation({
                    orgId: normalizeOptionalString((req.query || {}).org_id),
                    limit: parseLimit(req.query || {}),
                });
                return sendJson(res, 200, { ok: true, automation });
            } catch (error) {
                return sendJson(res, 500, {
                    ok: false,
                    error: 'farm_automation_failed',
                    message: error.message,
                });
            }
        }

        if (req.method && req.method !== 'PATCH') {
            return methodNotAllowed(res, 'GET, PATCH');
        }

        try {
            if (!(await authenticateAdmin(req, res, adminToken, store))) return null;
            const body = parseJsonBody(req.body);
            const current = await loadAutomation({
                orgId: normalizeOptionalString((req.query || {}).org_id),
                limit: parseLimit(req.query || {}),
            });
            const nextSettings = normalizeFarmAutomationSettings({
                policy: isPlainObject(body.policy) ? { ...current.settings.policy, ...body.policy } : current.settings.policy,
                inventory: isPlainObject(body.inventory) ? body.inventory : current.settings.inventory,
                integrations: isPlainObject(body.integrations) ? body.integrations : current.settings.integrations,
            });

            if (isPlainObject(body.policy)) {
                await store.upsertPlatformSetting(FARM_AUTOMATION_POLICY_KEY, nextSettings.policy);
            }
            if (isPlainObject(body.inventory)) {
                await store.upsertPlatformSetting(FARM_FILAMENT_INVENTORY_KEY, nextSettings.inventory);
            }
            if (isPlainObject(body.integrations)) {
                await store.upsertPlatformSetting(FARM_INTEGRATIONS_KEY, nextSettings.integrations);
            }

            const automation = await loadAutomation({
                orgId: normalizeOptionalString((req.query || {}).org_id),
                limit: parseLimit(req.query || {}),
            });
            return sendJson(res, 200, { ok: true, automation });
        } catch (error) {
            return sendJson(res, 400, {
                ok: false,
                error: 'update_farm_automation_failed',
                message: error.message,
            });
        }
    };
}

export function createCloudMerchantsHandler({
    store,
    adminToken = process.env.CLOUD_ADMIN_TOKEN,
    merchantPepper = process.env.MERCHANT_API_KEY_PEPPER || process.env.NODE_TOKEN_PEPPER,
    setupTokenFactory = generateMerchantSetupToken,
    now = () => new Date(),
}) {
    if (!store) throw new Error('store is required');

    return async function cloudMerchantsHandler(req, res) {
        if (req.method === 'GET') {
            try {
                if (!(await authenticateAdmin(req, res, adminToken, store))) return null;
                const merchants = await store.listMerchants({
                    status: normalizeOptionalString((req.query || {}).status),
                    limit: parseLimit(req.query || {}),
                });
                return sendJson(res, 200, { ok: true, merchants });
            } catch (error) {
                return sendJson(res, 500, {
                    ok: false,
                    error: 'list_merchants_failed',
                    message: error.message,
                });
            }
        }

        if (req.method && req.method !== 'POST') {
            return methodNotAllowed(res, 'GET, POST');
        }

        try {
            if (!(await authenticateAdmin(req, res, adminToken, store))) return null;

            const action = normalizeMerchantAction(parseJsonBody(req.body));
            const timestamp = now().toISOString();
            let status;
            let approvedAt = null;
            let rejectedAt = null;

            if (action.action === 'approve' || action.action === 'activate') {
                status = 'active';
                approvedAt = timestamp;
            } else if (action.action === 'reject') {
                status = 'rejected';
                rejectedAt = timestamp;
            } else {
                status = 'suspended';
            }

            const merchant = await store.updateMerchantStatus(action.merchantId, {
                status,
                approvedAt,
                rejectedAt,
                metadata: action.metadata,
            });

            if (action.issueSetupToken) {
                const setupToken = await issueMerchantSetupToken({
                    store,
                    merchant,
                    merchantPepper,
                    setupTokenFactory,
                    now,
                });
                return sendJson(res, 200, {
                    ok: true,
                    merchant,
                    merchant_setup_token: setupToken.secret,
                    setup_token_expires_at: setupToken.expires_at,
                });
            }

            return sendJson(res, 200, { ok: true, merchant });
        } catch (error) {
            return sendJson(res, 400, {
                ok: false,
                error: 'merchant_admin_action_failed',
                message: error.message,
            });
        }
    };
}

export function createCloudMerchantSetupTokenHandler({
    store,
    adminToken = process.env.CLOUD_ADMIN_TOKEN,
    merchantPepper = process.env.MERCHANT_API_KEY_PEPPER || process.env.NODE_TOKEN_PEPPER,
    setupTokenFactory = generateMerchantSetupToken,
    now = () => new Date(),
}) {
    if (!store) throw new Error('store is required');

    return async function cloudMerchantSetupTokenHandler(req, res) {
        if (req.method && req.method !== 'POST') {
            return methodNotAllowed(res, 'POST');
        }

        try {
            if (!(await authenticateAdmin(req, res, adminToken, store))) return null;
            const body = parseJsonBody(req.body);
            const merchantId = normalizeRequiredString(body.merchant_id, 'merchant_id');
            const merchant = await store.findMerchantById(merchantId);
            const setupToken = await issueMerchantSetupToken({
                store,
                merchant,
                merchantPepper,
                setupTokenFactory,
                now,
            });

            return sendJson(res, 201, {
                ok: true,
                merchant_id: merchant.merchant_id,
                merchant_setup_token: setupToken.secret,
                setup_token_expires_at: setupToken.expires_at,
            });
        } catch (error) {
            return sendJson(res, 400, {
                ok: false,
                error: 'issue_merchant_setup_token_failed',
                message: error.message,
            });
        }
    };
}

export function createCloudMerchantApiKeysHandler({
    store,
    adminToken = process.env.CLOUD_ADMIN_TOKEN,
    merchantPepper = process.env.MERCHANT_API_KEY_PEPPER || process.env.NODE_TOKEN_PEPPER,
    liveKeyFactory = generateMerchantApiKey,
    now = () => new Date(),
}) {
    if (!store) throw new Error('store is required');

    return async function cloudMerchantApiKeysHandler(req, res) {
        if (req.method === 'GET') {
            try {
                if (!(await authenticateAdmin(req, res, adminToken, store))) return null;
                const merchantId = normalizeRequiredString((req.query || {}).merchant_id, 'merchant_id');
                const apiKeys = await store.listMerchantApiKeys(merchantId);
                return sendJson(res, 200, {
                    ok: true,
                    api_keys: apiKeys.map(redactMerchantApiKey),
                });
            } catch (error) {
                return sendJson(res, 400, {
                    ok: false,
                    error: 'list_merchant_api_keys_failed',
                    message: error.message,
                });
            }
        }

        if (req.method === 'POST') {
            try {
                if (!(await authenticateAdmin(req, res, adminToken, store))) return null;
                const request = normalizeMerchantKeyRequest(parseJsonBody(req.body), req.query || {});
                const merchant = await store.findMerchantById(request.merchantId);
                const apiKey = await issueMerchantApiKey({
                    store,
                    merchant,
                    name: request.name,
                    merchantPepper,
                    liveKeyFactory,
                });

                return sendJson(res, 201, {
                    ok: true,
                    api_key: redactMerchantApiKey(apiKey.record),
                    api_key_secret: apiKey.secret,
                });
            } catch (error) {
                return sendJson(res, 400, {
                    ok: false,
                    error: 'create_merchant_api_key_failed',
                    message: error.message,
                });
            }
        }

        if (req.method === 'DELETE') {
            try {
                if (!(await authenticateAdmin(req, res, adminToken, store))) return null;
                const request = normalizeMerchantKeyRequest(parseJsonBody(req.body), req.query || {});
                if (!request.keyId) throw new Error('key_id is required');
                const revoked = await store.revokeMerchantApiKey({
                    merchantId: request.merchantId,
                    keyId: request.keyId,
                    revokedAt: now().toISOString(),
                });

                if (!revoked) {
                    return sendJson(res, 404, { ok: false, error: 'api_key_not_found' });
                }

                return sendJson(res, 200, {
                    ok: true,
                    api_key: redactMerchantApiKey(revoked),
                });
            } catch (error) {
                return sendJson(res, 400, {
                    ok: false,
                    error: 'revoke_merchant_api_key_failed',
                    message: error.message,
                });
            }
        }

        return methodNotAllowed(res, 'GET, POST, DELETE');
    };
}

export function createCloudMerchantSettingsHandler({
    store,
    adminToken = process.env.CLOUD_ADMIN_TOKEN,
}) {
    if (!store) throw new Error('store is required');

    return async function cloudMerchantSettingsHandler(req, res) {
        if (req.method === 'GET') {
            try {
                if (!(await authenticateAdmin(req, res, adminToken, store))) return null;
                const fullAuto = await store.getPlatformSetting('full_auto_merchant_mode', { enabled: false });
                return sendJson(res, 200, {
                    ok: true,
                    settings: { full_auto_merchant_mode: fullAuto },
                });
            } catch (error) {
                return sendJson(res, 500, {
                    ok: false,
                    error: 'merchant_settings_failed',
                    message: error.message,
                });
            }
        }

        if (req.method && req.method !== 'PATCH') {
            return methodNotAllowed(res, 'GET, PATCH');
        }

        try {
            if (!(await authenticateAdmin(req, res, adminToken, store))) return null;
            const body = parseJsonBody(req.body);
            const enabled = normalizeBoolean(
                body.full_auto_merchant_mode ?? body.enabled,
                'full_auto_merchant_mode',
            );
            const row = await store.upsertPlatformSetting('full_auto_merchant_mode', { enabled });

            return sendJson(res, 200, {
                ok: true,
                settings: { full_auto_merchant_mode: row?.value || { enabled } },
            });
        } catch (error) {
            return sendJson(res, 400, {
                ok: false,
                error: 'update_merchant_settings_failed',
                message: error.message,
            });
        }
    };
}

export function createCloudMerchantJobsHandler({
    store,
    adminToken = process.env.CLOUD_ADMIN_TOKEN,
}) {
    if (!store) throw new Error('store is required');

    return async function cloudMerchantJobsHandler(req, res) {
        if (req.method && req.method !== 'GET') {
            return methodNotAllowed(res, 'GET');
        }

        try {
            if (!(await authenticateAdmin(req, res, adminToken, store))) return null;
            const jobs = await store.listMerchantPrintJobs({
                merchantId: normalizeRequiredString((req.query || {}).merchant_id, 'merchant_id'),
                limit: parseLimit(req.query || {}),
            });
            return sendJson(res, 200, { ok: true, jobs });
        } catch (error) {
            return sendJson(res, 400, {
                ok: false,
                error: 'list_merchant_jobs_failed',
                message: error.message,
            });
        }
    };
}

export function createCloudMerchantUsageHandler({
    store,
    adminToken = process.env.CLOUD_ADMIN_TOKEN,
}) {
    if (!store) throw new Error('store is required');

    return async function cloudMerchantUsageHandler(req, res) {
        if (req.method && req.method !== 'GET') {
            return methodNotAllowed(res, 'GET');
        }

        try {
            if (!(await authenticateAdmin(req, res, adminToken, store))) return null;
            const usage = await store.listMerchantUsageEvents({
                merchantId: normalizeRequiredString((req.query || {}).merchant_id, 'merchant_id'),
                limit: parseLimit(req.query || {}),
            });
            return sendJson(res, 200, { ok: true, usage });
        } catch (error) {
            return sendJson(res, 400, {
                ok: false,
                error: 'list_merchant_usage_failed',
                message: error.message,
            });
        }
    };
}
