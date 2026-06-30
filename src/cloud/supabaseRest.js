function requireValue(value, name) {
    if (!value || typeof value !== 'string') {
        throw new Error(`${name} is required`);
    }
    return value;
}

function normalizeBaseUrl(url) {
    return requireValue(url, 'SUPABASE_URL').replace(/\/+$/, '');
}

export function createSupabaseRestClient({
    url = process.env.SUPABASE_URL,
    serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY,
    fetchImpl = globalThis.fetch,
} = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');

    function getConfig() {
        return {
            baseUrl: normalizeBaseUrl(url),
            key: requireValue(serviceKey, 'SUPABASE_SERVICE_ROLE_KEY'),
        };
    }

    async function request(path, { method = 'GET', body = null, headers = {} } = {}) {
        const { baseUrl, key } = getConfig();
        const response = await fetchImpl(`${baseUrl}${path}`, {
            method,
            headers: {
                apikey: key,
                Authorization: `Bearer ${key}`,
                'Content-Type': 'application/json',
                ...headers,
            },
            body: body === null ? undefined : JSON.stringify(body),
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Supabase ${method} ${path} failed (${response.status}): ${text}`);
        }

        if (response.status === 204) return null;
        const text = await response.text();
        return text ? JSON.parse(text) : null;
    }

    return {
        async findNodeByTokenHash(tokenHash) {
            const rows = await request(
                `/rest/v1/farm_nodes?token_hash=eq.${encodeURIComponent(tokenHash)}&select=node_id,org_id,name,status&limit=1`,
            );
            const row = Array.isArray(rows) ? rows[0] : null;
            return row ? { ...row, organization_id: row.org_id } : null;
        },

        async recordNodeHeartbeat(nodeId, heartbeat) {
            await request(`/rest/v1/farm_nodes?node_id=eq.${encodeURIComponent(nodeId)}`, {
                method: 'PATCH',
                headers: { Prefer: 'return=minimal' },
                body: {
                    status: heartbeat.status,
                    last_seen_at: heartbeat.last_seen_at,
                    agent_version: heartbeat.agent_version,
                    host_info: heartbeat.host_info,
                    capabilities: heartbeat.capabilities,
                    updated_at: heartbeat.last_seen_at,
                },
            });
        },

        async claimNodeCommands(nodeId, limit = 10) {
            return request('/rest/v1/rpc/claim_node_commands', {
                method: 'POST',
                body: {
                    p_node_id: nodeId,
                    p_limit: limit,
                },
            });
        },

        async recordNodeEvents(node, events) {
            const organizationId = node.organization_id || node.org_id;
            const rows = events.map((event) => ({
                org_id: organizationId,
                node_id: node.node_id,
                printer_id: event.printer_id,
                command_id: event.command_id,
                event_type: event.event_type,
                payload: event.payload,
                created_at: event.created_at,
            }));

            await request('/rest/v1/node_events', {
                method: 'POST',
                headers: { Prefer: 'return=minimal' },
                body: rows,
            });
        },

        async recordCommandResult(nodeId, commandResult) {
            await request(
                `/rest/v1/node_commands?node_id=eq.${encodeURIComponent(nodeId)}&command_id=eq.${encodeURIComponent(commandResult.command_id)}`,
                {
                    method: 'PATCH',
                    headers: { Prefer: 'return=minimal' },
                    body: {
                        status: commandResult.status,
                        result: commandResult.result,
                        error: commandResult.error,
                        finished_at: commandResult.finished_at,
                        updated_at: new Date().toISOString(),
                    },
                },
            );
        },
    };
}
