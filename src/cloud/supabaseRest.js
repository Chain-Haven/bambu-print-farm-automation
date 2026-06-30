function requireValue(value, name) {
    if (!value || typeof value !== 'string') {
        throw new Error(`${name} is required`);
    }
    return value;
}

function normalizeBaseUrl(url) {
    return requireValue(url, 'SUPABASE_URL').replace(/\/+$/, '');
}

function firstRow(rows) {
    return Array.isArray(rows) ? rows[0] || null : null;
}

function shouldSendBearerAuthorization(key) {
    return !key.startsWith('sb_secret_') && !key.startsWith('sb_publishable_');
}

const SETUP_CHECKS = [
    { name: 'organizations_table', path: '/rest/v1/organizations?select=org_id&limit=1' },
    { name: 'farm_nodes_table', path: '/rest/v1/farm_nodes?select=node_id&limit=1' },
    { name: 'cloud_printers_table', path: '/rest/v1/cloud_printers?select=printer_id&limit=1' },
    { name: 'print_jobs_table', path: '/rest/v1/print_jobs?select=job_id&limit=1' },
    { name: 'node_commands_table', path: '/rest/v1/node_commands?select=command_id&limit=1' },
    { name: 'node_events_table', path: '/rest/v1/node_events?select=event_id&limit=1' },
    {
        name: 'claim_node_commands_rpc',
        path: '/rest/v1/rpc/claim_node_commands',
        method: 'POST',
        body: {
            p_node_id: '00000000-0000-0000-0000-000000000000',
            p_limit: 1,
        },
    },
    { name: 'print_artifacts_bucket', path: '/storage/v1/bucket/print-artifacts' },
];

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
        const authHeaders = shouldSendBearerAuthorization(key) ? { Authorization: `Bearer ${key}` } : {};
        const response = await fetchImpl(`${baseUrl}${path}`, {
            method,
            headers: {
                apikey: key,
                ...authHeaders,
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

    function tableListPath(table, { select, orgId = null, order, limit = 50 }) {
        const params = new URLSearchParams();
        params.set('select', select);
        if (orgId) params.set('org_id', `eq.${orgId}`);
        if (order) params.set('order', order);
        params.set('limit', String(limit));
        return `/rest/v1/${table}?${params.toString()}`;
    }

    return {
        async getCloudSetupStatus() {
            const checks = [];

            for (const check of SETUP_CHECKS) {
                try {
                    await request(check.path, {
                        method: check.method || 'GET',
                        body: check.body || null,
                    });
                    checks.push({ name: check.name, ok: true });
                } catch (error) {
                    checks.push({ name: check.name, ok: false, error: error.message });
                    break;
                }
            }

            return {
                checked: true,
                ready: checks.length === SETUP_CHECKS.length && checks.every((check) => check.ok),
                checks,
            };
        },

        async findNodeByTokenHash(tokenHash) {
            const rows = await request(
                `/rest/v1/farm_nodes?token_hash=eq.${encodeURIComponent(tokenHash)}&select=node_id,org_id,name,status&limit=1`,
            );
            const row = firstRow(rows);
            return row ? { ...row, organization_id: row.org_id } : null;
        },

        async createOrganization(organization) {
            const rows = await request(
                '/rest/v1/organizations?select=org_id,name,created_at,updated_at',
                {
                    method: 'POST',
                    headers: { Prefer: 'return=representation' },
                    body: organization,
                },
            );
            return firstRow(rows);
        },

        async getCloudOverview({ orgId = null, limit = 50 } = {}) {
            const boundedLimit = Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 100));
            const [nodes, printers, jobs, commands, events] = await Promise.all([
                request(tableListPath('farm_nodes', {
                    orgId,
                    limit: boundedLimit,
                    order: 'last_seen_at.desc.nullslast',
                    select: 'node_id,org_id,name,status,agent_version,host_info,capabilities,last_seen_at,created_at,updated_at',
                })),
                request(tableListPath('cloud_printers', {
                    orgId,
                    limit: boundedLimit,
                    order: 'last_seen_at.desc.nullslast',
                    select: 'printer_id,org_id,node_id,local_printer_id,name,model,status,status_snapshot,capabilities,last_seen_at,created_at,updated_at',
                })),
                request(tableListPath('print_jobs', {
                    orgId,
                    limit: boundedLimit,
                    order: 'created_at.desc',
                    select: 'job_id,org_id,node_id,printer_id,file_id,name,status,options,created_at,updated_at',
                })),
                request(tableListPath('node_commands', {
                    orgId,
                    limit: boundedLimit,
                    order: 'created_at.desc',
                    select: 'command_id,org_id,node_id,printer_id,job_id,command_type,status,payload,result,error,claimed_at,finished_at,created_at,updated_at',
                })),
                request(tableListPath('node_events', {
                    orgId,
                    limit: boundedLimit,
                    order: 'created_at.desc',
                    select: 'event_id,org_id,node_id,printer_id,command_id,event_type,payload,created_at',
                })),
            ]);

            return {
                nodes: Array.isArray(nodes) ? nodes : [],
                printers: Array.isArray(printers) ? printers : [],
                jobs: Array.isArray(jobs) ? jobs : [],
                commands: Array.isArray(commands) ? commands : [],
                events: Array.isArray(events) ? events : [],
            };
        },

        async createNodeCommand(command) {
            const rows = await request(
                '/rest/v1/node_commands?select=command_id,org_id,node_id,printer_id,job_id,command_type,status,payload,result,error,claimed_at,finished_at,created_at,updated_at',
                {
                    method: 'POST',
                    headers: { Prefer: 'return=representation' },
                    body: command,
                },
            );
            return firstRow(rows);
        },

        async createFarmNode(node) {
            const rows = await request(
                '/rest/v1/farm_nodes?select=node_id,org_id,name,status,agent_version,host_info,capabilities,last_seen_at,created_at,updated_at',
                {
                    method: 'POST',
                    headers: { Prefer: 'return=representation' },
                    body: node,
                },
            );
            return firstRow(rows);
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
