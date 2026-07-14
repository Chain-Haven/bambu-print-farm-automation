import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AdminAuthError, authenticateCloudAdmin } from './adminAuth.js';
import { hashNodeToken, parseJsonBody } from './agentProtocol.js';
import { createRequestId, getRequestId } from './httpServerUtils.js';
import {
    generateMerchantApiKey,
    generateMerchantSetupToken,
} from './merchantAuth.js';
import {
    createLiveKeyForMerchant,
    createSetupTokenForMerchant,
    redactApiKey as redactMerchantApiKey,
} from './merchantHandlers.js';
import { redactPublicValue } from './merchantPublicProjections.js';
import { redactWebhookConfig } from './webhooks.js';
import { buildWindowsNodePackage, getNodePackageFileName, PORTABLE_BUNDLE_SUBDIR } from './nodePackage.js';
import { buildFarmAutomationPlan, normalizeFarmAutomationSettings } from './farmAutomation.js';

const FARM_AUTOMATION_POLICY_KEY = 'farm_automation_policy';
const FARM_FILAMENT_INVENTORY_KEY = 'farm_filament_inventory';
const FARM_INTEGRATIONS_KEY = 'farm_integrations';

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The V1 webhook signing secret is stored cleartext at metadata.webhook.secret.
// Redact it (to has_secret) before returning merchants to the admin console so
// the plaintext HMAC secret is never shipped to the browser.
function redactMerchant(merchant) {
    if (!isPlainObject(merchant) || !isPlainObject(merchant.metadata) || !isPlainObject(merchant.metadata.webhook)) {
        return merchant;
    }
    return {
        ...merchant,
        metadata: {
            ...merchant.metadata,
            webhook: redactWebhookConfig(merchant.metadata.webhook),
        },
    };
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

function methodNotAllowed(res, methods, requestId = createRequestId()) {
    if (typeof res.setHeader === 'function') {
        res.setHeader('Allow', methods);
    }
    return sendJson(res, 405, {
        ok: false,
        error: 'method_not_allowed',
        message: 'Method not allowed',
        request_id: requestId,
    });
}

// Sanitized 500: never echo error.message back to the client. The fallbackCode
// identifies the failing operation; the request_id lets the operator correlate
// the client report to server logs.
function sendInternalError(res, req, fallbackCode) {
    return sendJson(res, 500, {
        ok: false,
        error: fallbackCode,
        message: 'Unexpected server error',
        request_id: getRequestId(req),
    });
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// org_id is a Postgres uuid column; a free-text value (e.g. a node name typed
// into the Org ID field) otherwise reaches Supabase and comes back as a raw
// 22P02 "invalid input syntax for type uuid" error.
function normalizeUuid(value, name) {
    const normalized = normalizeRequiredString(value, name);
    if (!UUID_PATTERN.test(normalized)) {
        throw new Error(`${name} must be a UUID (got "${normalized}"). Create an organization first — its org_id is returned by POST /api/cloud/orgs, and the Quickstart form fills it in automatically.`);
    }
    return normalized;
}

function normalizeNodeProvision(body) {
    const source = isPlainObject(body) ? body : {};

    return {
        org_id: normalizeUuid(source.org_id, 'org_id'),
        name: normalizeRequiredString(source.name, 'name'),
        capabilities: isPlainObject(source.capabilities) ? source.capabilities : {},
        token: normalizeOptionalString(source.local_node_token),
    };
}

function normalizeNodePackageRequest(body, req) {
    const source = isPlainObject(body) ? body : {};
    const host = typeof (req.headers || {}).host === 'string' ? req.headers.host.trim() : '';
    const inferredCloudApiUrl = host ? `https://${host}` : '';
    const format = String(source.format || 'portable').trim().toLowerCase();
    const localNodeToken = source.local_node_token;
    // The .exe is a generic prebuilt binary hosted externally; it does not carry
    // a per-node token, so a token is only required for the portable/source zip
    // (which bakes .env into the package).
    const tokenRequired = format !== 'exe';

    return {
        cloudApiUrl: normalizeRequiredString(source.cloud_api_url || inferredCloudApiUrl, 'cloud_api_url'),
        localNodeToken: tokenRequired ? normalizeRequiredString(localNodeToken, 'local_node_token') : (typeof localNodeToken === 'string' ? localNodeToken.trim() : ''),
        nodeName: typeof source.node_name === 'string' && source.node_name.trim() ? source.node_name.trim() : 'Windows NUC',
        format: format === 'exe' ? 'exe' : 'portable',
    };
}

function generateNodeToken() {
    return `pkx_node_${randomBytes(32).toString('base64url')}`;
}

// Setup-token / live-key issuance is shared with the public merchant routes
// (merchantHandlers.js) so both surfaces run the exact same implementation.
const issueMerchantSetupToken = ({ store, merchant, merchantPepper, now, setupTokenFactory }) =>
    createSetupTokenForMerchant({ store, merchant, pepper: merchantPepper, now, setupTokenFactory });

const issueMerchantApiKey = ({ store, merchant, name, merchantPepper, liveKeyFactory, scopes }) =>
    createLiveKeyForMerchant({ store, merchant, name, pepper: merchantPepper, liveKeyFactory, scopes });

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
        scopes: source.scopes,
    };
}

const MERCHANT_V2_ADMIN_PROJECTIONS = {
    orders: {
        fields: [
            'order_id',
            'org_id',
            'merchant_id',
            'external_order_id',
            'status',
            'totals',
            'due_at',
            'submitted_at',
            'completed_at',
            'canceled_at',
            'metadata',
            'created_at',
            'updated_at',
        ],
        redactNested: new Set(['totals', 'metadata']),
    },
    files: {
        fields: [
            'file_id',
            'org_id',
            'merchant_id',
            'original_name',
            'content_type',
            'byte_size',
            'checksum_sha256',
            'file_mode',
            'status',
            'completed_at',
            'deleted_at',
            'rejected_at',
            'metadata',
            'created_at',
            'updated_at',
        ],
        redactNested: new Set(['metadata']),
    },
    slices: {
        fields: [
            'slice_job_id',
            'org_id',
            'merchant_id',
            'file_id',
            'profile',
            'requirements',
            'result',
            'status',
            'started_at',
            'completed_at',
            'canceled_at',
            'metadata',
            'created_at',
            'updated_at',
        ],
        redactNested: new Set(['profile', 'requirements', 'result', 'metadata']),
    },
    batches: {
        fields: [
            'batch_id',
            'org_id',
            'merchant_id',
            'name',
            'strategy',
            'status',
            'settings',
            'started_at',
            'paused_at',
            'completed_at',
            'canceled_at',
            'metadata',
            'created_at',
            'updated_at',
        ],
        redactNested: new Set(['settings', 'metadata']),
    },
    reservations: {
        fields: [
            'reservation_id',
            'org_id',
            'merchant_id',
            'order_id',
            'batch_id',
            'file_id',
            'job_id',
            'material',
            'color',
            'grams',
            'status',
            'expires_at',
            'released_at',
            'consumed_at',
            'metadata',
            'created_at',
            'updated_at',
        ],
        redactNested: new Set(['metadata']),
    },
    shipments: {
        fields: [
            'shipment_id',
            'org_id',
            'merchant_id',
            'order_id',
            'status',
            'carrier',
            'service_level',
            'tracking_number',
            'shipped_at',
            'delivered_at',
            'metadata',
            'created_at',
            'updated_at',
        ],
        redactNested: new Set(['metadata']),
    },
    invoices: {
        fields: [
            'invoice_id',
            'org_id',
            'merchant_id',
            'status',
            'period_start',
            'period_end',
            'currency',
            'subtotal',
            'total',
            'issued_at',
            'voided_at',
            'metadata',
            'created_at',
            'updated_at',
        ],
        redactNested: new Set(['metadata']),
    },
    webhook_deliveries: {
        fields: [
            'delivery_id',
            'org_id',
            'merchant_id',
            'webhook_id',
            'event_type',
            'status',
            'response_status',
            'attempt_count',
            'next_retry_at',
            'delivered_at',
            'metadata',
            'created_at',
            'updated_at',
        ],
        redactNested: new Set(['metadata']),
    },
    adapter_events: {
        fields: [
            'adapter_event_id',
            'org_id',
            'merchant_id',
            'adapter_name',
            'event_type',
            'resource_type',
            'resource_id',
            'payload',
            'metadata',
            'created_at',
            'updated_at',
        ],
        redactNested: new Set(['payload', 'metadata']),
    },
};

function projectAdminMerchantV2Row(resourceName, row) {
    if (!isPlainObject(row)) return {};
    const projection = MERCHANT_V2_ADMIN_PROJECTIONS[resourceName];
    if (!projection) return {};

    const output = {};
    for (const field of projection.fields) {
        if (row[field] === undefined) continue;
        output[field] = projection.redactNested.has(field)
            ? redactPublicValue(row[field])
            : row[field];
    }
    return output;
}

function projectAdminMerchantV2Rows(resourceName, rows) {
    return (Array.isArray(rows) ? rows : []).map((row) => projectAdminMerchantV2Row(resourceName, row));
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
            return sendInternalError(res, req, 'setup_status_failed');
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
            return sendInternalError(res, req, 'overview_failed');
        }
    };
}

export function createCloudCommandHandler({ store, adminToken = process.env.CLOUD_ADMIN_TOKEN }) {
    if (!store) throw new Error('store is required');

    return async function cloudCommandHandler(req, res) {
        // GET ?command_id= — direct command lookup so the console can poll a
        // specific command result (camera frames, adoption, scans) instead of
        // scanning the capped overview list, which loses results on busy farms.
        if (req.method === 'GET') {
            try {
                if (!(await authenticateAdmin(req, res, adminToken, store))) return null;
                const commandId = normalizeRequiredString((req.query || {}).command_id, 'command_id');
                const command = typeof store.getNodeCommandById === 'function'
                    ? await store.getNodeCommandById(commandId)
                    : null;
                if (!command) {
                    return sendJson(res, 404, { ok: false, error: 'command_not_found' });
                }
                return sendJson(res, 200, { ok: true, command });
            } catch (error) {
                return sendJson(res, 400, {
                    ok: false,
                    error: 'get_command_failed',
                    message: error.message,
                });
            }
        }

        if (req.method && req.method !== 'POST') {
            return methodNotAllowed(res, 'GET, POST');
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
        // DELETE decommissions a node: its bearer token stops authenticating
        // immediately and the DB cascades remove its mirrored printers and
        // queued commands (jobs/events keep their rows with node_id nulled).
        if (req.method === 'DELETE') {
            try {
                if (!(await authenticateAdmin(req, res, adminToken, store))) return null;

                const body = parseJsonBody(req.body);
                const query = req.query || {};
                const nodeId = normalizeRequiredString(
                    (isPlainObject(body) ? body.node_id : null) || query.node_id,
                    'node_id',
                );
                const force = (isPlainObject(body) && body.force === true) || query.force === 'true';

                const summary = typeof store.getNodeWorkSummary === 'function'
                    ? await store.getNodeWorkSummary(nodeId)
                    : null;
                if (typeof store.getNodeWorkSummary === 'function' && !summary) {
                    return sendJson(res, 404, { ok: false, error: 'node_not_found' });
                }
                if (!force && summary && (summary.active_jobs > 0 || summary.pending_commands > 0)) {
                    return sendJson(res, 409, {
                        ok: false,
                        error: 'node_has_active_work',
                        message: `Node has ${summary.active_jobs} active job(s) and ${summary.pending_commands} pending command(s). Retry with force=true to delete anyway.`,
                        active_jobs: summary.active_jobs,
                        pending_commands: summary.pending_commands,
                    });
                }

                const deleted = await store.deleteFarmNode(nodeId);
                if (!deleted) {
                    return sendJson(res, 404, { ok: false, error: 'node_not_found' });
                }

                return sendJson(res, 200, { ok: true, node: deleted });
            } catch (error) {
                return sendJson(res, 400, {
                    ok: false,
                    error: 'delete_node_failed',
                    message: error.message,
                });
            }
        }

        if (req.method && req.method !== 'POST') {
            return methodNotAllowed(res, 'POST, DELETE');
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
    exeUrl = process.env.FARM_NODE_EXE_URL,
    fsImpl = fs,
} = {}) {
    return async function cloudNodePackageHandler(req, res) {
        if (req.method && req.method !== 'POST') {
            return methodNotAllowed(res, 'POST');
        }

        try {
            if (!(await authenticateAdmin(req, res, adminToken, store))) return null;

            const request = normalizeNodePackageRequest(parseJsonBody(req.body), req);

            // Windows .exe: a Node SEA binary is too large for a Vercel serverless
            // bundle and must be built on Windows, so it is hosted externally (a
            // GitHub Release asset, Vercel Blob, etc.) and configured via
            // FARM_NODE_EXE_URL. With no URL, a self-hosted server can still serve a
            // locally-built dist/windows-node/farm-node.exe; otherwise we return a
            // clear "not built yet" with build instructions.
            if (request.format === 'exe') {
                if (exeUrl) {
                    return sendJson(res, 200, {
                        ok: true,
                        format: 'exe',
                        download_url: exeUrl,
                        message: 'Opening the hosted Windows .exe download.',
                    });
                }
                const localExe = path.join(rootDir, PORTABLE_BUNDLE_SUBDIR, 'farm-node.exe');
                if (fsImpl.existsSync(localExe)) {
                    const buf = fsImpl.readFileSync(localExe);
                    res.statusCode = 200;
                    if (typeof res.setHeader === 'function') {
                        res.setHeader('Content-Type', 'application/octet-stream');
                        res.setHeader('Content-Disposition', 'attachment; filename="farm-node.exe"');
                        res.setHeader('Cache-Control', 'no-store');
                    }
                    return res.end(buf);
                }
                return sendJson(res, 409, {
                    ok: false,
                    error: 'exe_not_built',
                    message: 'The Windows .exe has not been built yet. Build it on Windows with `npm run build:node:exe` (or via the build-windows-exe GitHub Action), host the resulting farm-node.exe (GitHub Release / Vercel Blob), and set FARM_NODE_EXE_URL to its URL. The Portable .zip works now with no install.',
                    build_command: 'npm run build:node:exe',
                    portable_available: true,
                });
            }

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
                return sendInternalError(res, req, 'farm_automation_failed');
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
                return sendJson(res, 200, { ok: true, merchants: merchants.map(redactMerchant) });
            } catch (error) {
                return sendInternalError(res, req, 'list_merchants_failed');
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
                    merchant: redactMerchant(merchant),
                    merchant_setup_token: setupToken.secret,
                    setup_token_expires_at: setupToken.expires_at,
                });
            }

            return sendJson(res, 200, { ok: true, merchant: redactMerchant(merchant) });
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
                    scopes: request.scopes,
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
                return sendInternalError(res, req, 'merchant_settings_failed');
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

async function listMerchantV2AdminRows(store, methodName, query) {
    if (typeof store[methodName] !== 'function') return [];
    const rows = await store[methodName](query);
    return Array.isArray(rows) ? rows : [];
}

export function createCloudMerchantV2Handler({
    store,
    adminToken = process.env.CLOUD_ADMIN_TOKEN,
}) {
    if (!store) throw new Error('store is required');

    return async function cloudMerchantV2Handler(req, res) {
        if (req.method && req.method !== 'GET') {
            return methodNotAllowed(res, 'GET');
        }

        try {
            if (!(await authenticateAdmin(req, res, adminToken, store))) return null;
            const query = {
                merchantId: normalizeRequiredString((req.query || {}).merchant_id, 'merchant_id'),
                limit: parseLimit(req.query || {}),
            };
            const [
                files,
                orders,
                slices,
                batches,
                reservations,
                shipments,
                invoices,
                webhookDeliveries,
                adapterEvents,
            ] = await Promise.all([
                listMerchantV2AdminRows(store, 'listMerchantFiles', query),
                listMerchantV2AdminRows(store, 'listMerchantOrders', query),
                listMerchantV2AdminRows(store, 'listMerchantSliceJobs', query),
                listMerchantV2AdminRows(store, 'listMerchantBatches', query),
                listMerchantV2AdminRows(store, 'listMerchantMaterialReservations', query),
                listMerchantV2AdminRows(store, 'listMerchantShipments', query),
                listMerchantV2AdminRows(store, 'listMerchantInvoices', query),
                listMerchantV2AdminRows(store, 'listMerchantWebhookDeliveries', query),
                listMerchantV2AdminRows(store, 'listMerchantAdapterEvents', query),
            ]);

            return sendJson(res, 200, {
                ok: true,
                v2: {
                    orders: projectAdminMerchantV2Rows('orders', orders),
                    files: projectAdminMerchantV2Rows('files', files),
                    slices: projectAdminMerchantV2Rows('slices', slices),
                    batches: projectAdminMerchantV2Rows('batches', batches),
                    reservations: projectAdminMerchantV2Rows('reservations', reservations),
                    shipments: projectAdminMerchantV2Rows('shipments', shipments),
                    invoices: projectAdminMerchantV2Rows('invoices', invoices),
                    webhook_deliveries: projectAdminMerchantV2Rows('webhook_deliveries', webhookDeliveries),
                    adapter_events: projectAdminMerchantV2Rows('adapter_events', adapterEvents),
                },
            });
        } catch (error) {
            return sendJson(res, 400, {
                ok: false,
                error: 'list_merchant_v2_failed',
                message: error.message,
            });
        }
    };
}
