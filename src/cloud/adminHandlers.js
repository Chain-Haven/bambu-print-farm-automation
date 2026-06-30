import { randomBytes, timingSafeEqual } from 'node:crypto';
import { hashNodeToken, parseJsonBody } from './agentProtocol.js';
import { buildWindowsNodePackage, getNodePackageFileName } from './nodePackage.js';

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

function getAdminToken(headers = {}) {
    const direct = headers['x-cloud-admin-token'] || headers['X-Cloud-Admin-Token'];
    if (typeof direct === 'string' && direct.trim()) return direct.trim();

    const authorization = headers.authorization || headers.Authorization;
    if (typeof authorization !== 'string') return null;

    const match = authorization.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : null;
}

function tokensMatch(received, expected) {
    if (!received || !expected) return false;

    const receivedBytes = Buffer.from(received);
    const expectedBytes = Buffer.from(expected);
    if (receivedBytes.length !== expectedBytes.length) return false;

    return timingSafeEqual(receivedBytes, expectedBytes);
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

async function authenticateAdmin(req, res, adminToken) {
    const provided = getAdminToken(req.headers || {});
    if (!provided) {
        sendJson(res, 401, { ok: false, error: 'missing_admin_token' });
        return false;
    }

    if (!adminToken) {
        sendJson(res, 500, { ok: false, error: 'cloud_not_configured' });
        return false;
    }

    if (!tokensMatch(provided, adminToken)) {
        sendJson(res, 403, { ok: false, error: 'invalid_admin_token' });
        return false;
    }

    return true;
}

export function createCloudOverviewHandler({ store, adminToken = process.env.CLOUD_ADMIN_TOKEN }) {
    if (!store) throw new Error('store is required');

    return async function cloudOverviewHandler(req, res) {
        if (req.method && req.method !== 'GET') {
            return methodNotAllowed(res, 'GET');
        }

        try {
            if (!(await authenticateAdmin(req, res, adminToken))) return null;

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
            if (!(await authenticateAdmin(req, res, adminToken))) return null;

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
            if (!(await authenticateAdmin(req, res, adminToken))) return null;

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
            if (!(await authenticateAdmin(req, res, adminToken))) return null;
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
    adminToken = process.env.CLOUD_ADMIN_TOKEN,
    rootDir = process.cwd(),
    packageBuilder = buildWindowsNodePackage,
} = {}) {
    return async function cloudNodePackageHandler(req, res) {
        if (req.method && req.method !== 'POST') {
            return methodNotAllowed(res, 'POST');
        }

        try {
            if (!(await authenticateAdmin(req, res, adminToken))) return null;

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
