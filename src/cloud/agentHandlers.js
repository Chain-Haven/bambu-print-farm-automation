import {
    getBearerToken,
    hashNodeToken,
    normalizeAgentEvents,
    normalizeHeartbeat,
    parseJsonBody,
} from './agentProtocol.js';

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

function methodNotAllowed(res, methods = 'POST') {
    if (typeof res.setHeader === 'function') {
        res.setHeader('Allow', methods);
    }
    return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
}

async function authenticateNode(req, res, { store, pepper }) {
    const token = getBearerToken(req.headers || {});
    if (!token) {
        sendJson(res, 401, { ok: false, error: 'missing_agent_token' });
        return null;
    }
    if (!pepper) {
        sendJson(res, 500, { ok: false, error: 'cloud_not_configured' });
        return null;
    }

    const tokenHash = hashNodeToken(token, pepper);
    const node = await store.findNodeByTokenHash(tokenHash);
    if (!node) {
        sendJson(res, 403, { ok: false, error: 'unknown_agent_token' });
        return null;
    }

    return node;
}

function parseCommandLimit(query = {}) {
    const raw = Number.parseInt(query.limit, 10);
    if (!Number.isFinite(raw)) return 10;
    return Math.max(1, Math.min(raw, 50));
}

export function createHeartbeatHandler({ store, pepper, now = () => new Date() }) {
    if (!store) throw new Error('store is required');

    return async function heartbeatHandler(req, res) {
        if (req.method && req.method !== 'POST') {
            return methodNotAllowed(res, 'POST');
        }

        try {
            const node = await authenticateNode(req, res, { store, pepper });
            if (!node) return null;

            const heartbeat = normalizeHeartbeat(parseJsonBody(req.body), now);
            await store.recordNodeHeartbeat(node.node_id, heartbeat);

            return sendJson(res, 200, {
                ok: true,
                node_id: node.node_id,
                organization_id: node.organization_id || node.org_id,
                status: heartbeat.status,
            });
        } catch (error) {
            return sendJson(res, 500, {
                ok: false,
                error: 'heartbeat_failed',
                message: error.message,
            });
        }
    };
}

export function createClaimCommandsHandler({ store, pepper }) {
    if (!store) throw new Error('store is required');

    return async function claimCommandsHandler(req, res) {
        if (req.method && req.method !== 'GET') {
            return methodNotAllowed(res, 'GET');
        }

        try {
            const node = await authenticateNode(req, res, { store, pepper });
            if (!node) return null;

            const limit = parseCommandLimit(req.query || {});
            const commands = await store.claimNodeCommands(node.node_id, limit);

            return sendJson(res, 200, {
                ok: true,
                node_id: node.node_id,
                commands,
            });
        } catch (error) {
            return sendJson(res, 500, {
                ok: false,
                error: 'claim_commands_failed',
                message: error.message,
            });
        }
    };
}

export function createEventsHandler({ store, pepper, now = () => new Date() }) {
    if (!store) throw new Error('store is required');

    return async function eventsHandler(req, res) {
        if (req.method && req.method !== 'POST') {
            return methodNotAllowed(res, 'POST');
        }

        try {
            const node = await authenticateNode(req, res, { store, pepper });
            if (!node) return null;

            const events = normalizeAgentEvents(parseJsonBody(req.body), now);
            if (events.length === 0) {
                return sendJson(res, 400, { ok: false, error: 'no_valid_events' });
            }

            await store.recordNodeEvents(node, events);

            return sendJson(res, 200, {
                ok: true,
                accepted: events.length,
            });
        } catch (error) {
            return sendJson(res, 500, {
                ok: false,
                error: 'record_events_failed',
                message: error.message,
            });
        }
    };
}
