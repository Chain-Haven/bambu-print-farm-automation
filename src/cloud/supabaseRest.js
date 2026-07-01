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

function encodeStoragePath(path) {
    return requireValue(path, 'storage path')
        .split('/')
        .map((part) => encodeURIComponent(part))
        .join('/');
}

const SETUP_CHECKS = [
    { name: 'organizations_table', path: '/rest/v1/organizations?select=org_id&limit=1' },
    { name: 'platform_settings_table', path: '/rest/v1/platform_settings?select=key&limit=1' },
    { name: 'merchants_table', path: '/rest/v1/merchants?select=merchant_id&limit=1' },
    { name: 'merchant_api_keys_table', path: '/rest/v1/merchant_api_keys?select=key_id&limit=1' },
    { name: 'merchant_setup_tokens_table', path: '/rest/v1/merchant_setup_tokens?select=setup_token_id&limit=1' },
    { name: 'farm_nodes_table', path: '/rest/v1/farm_nodes?select=node_id&limit=1' },
    { name: 'cloud_printers_table', path: '/rest/v1/cloud_printers?select=printer_id&limit=1' },
    { name: 'print_jobs_table', path: '/rest/v1/print_jobs?select=job_id&limit=1' },
    { name: 'node_commands_table', path: '/rest/v1/node_commands?select=command_id&limit=1' },
    { name: 'node_events_table', path: '/rest/v1/node_events?select=event_id&limit=1' },
    { name: 'routing_decisions_table', path: '/rest/v1/routing_decisions?select=decision_id&limit=1' },
    { name: 'merchant_usage_events_table', path: '/rest/v1/merchant_usage_events?select=usage_event_id&limit=1' },
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

const MERCHANT_SELECT = [
    'merchant_id',
    'org_id',
    'company_name',
    'contact_email',
    'contact_name',
    'website',
    'status',
    'approval_mode',
    'metadata',
    'approved_at',
    'rejected_at',
    'created_at',
    'updated_at',
].join(',');

const MERCHANT_API_KEY_SELECT = [
    'key_id',
    'merchant_id',
    'org_id',
    'name',
    'key_prefix',
    'key_hash',
    'last_used_at',
    'revoked_at',
    'created_at',
].join(',');

const MERCHANT_SETUP_TOKEN_SELECT = [
    'setup_token_id',
    'merchant_id',
    'org_id',
    'token_prefix',
    'token_hash',
    'used_at',
    'expires_at',
    'created_at',
].join(',');

const JOB_FILE_SELECT = [
    'file_id',
    'org_id',
    'merchant_id',
    'storage_path',
    'original_name',
    'content_type',
    'byte_size',
    'checksum_sha256',
    'file_mode',
    'requirements',
    'created_at',
].join(',');

const PRINT_JOB_SELECT = [
    'job_id',
    'org_id',
    'merchant_id',
    'node_id',
    'printer_id',
    'file_id',
    'name',
    'status',
    'options',
    'routing_summary',
    'created_at',
    'updated_at',
].join(',');

const ROUTING_DECISION_SELECT = [
    'decision_id',
    'org_id',
    'merchant_id',
    'job_id',
    'selected_node_id',
    'selected_printer_id',
    'status',
    'strategy',
    'score',
    'rejected_candidates',
    'created_at',
].join(',');

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

    async function storageRequest(path, { method = 'POST', body = null, headers = {} } = {}) {
        const { baseUrl, key } = getConfig();
        const authHeaders = shouldSendBearerAuthorization(key) ? { Authorization: `Bearer ${key}` } : {};
        const response = await fetchImpl(`${baseUrl}${path}`, {
            method,
            headers: {
                apikey: key,
                ...authHeaders,
                ...headers,
            },
            body,
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
        async getPlatformSetting(key, fallbackValue = null) {
            const rows = await request(
                `/rest/v1/platform_settings?key=eq.${encodeURIComponent(requireValue(key, 'setting key'))}&select=key,value&limit=1`,
            );
            const row = firstRow(rows);
            return row ? row.value : fallbackValue;
        },

        async upsertPlatformSetting(key, value) {
            const rows = await request(
                '/rest/v1/platform_settings?on_conflict=key&select=key,value,updated_at',
                {
                    method: 'POST',
                    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
                    body: {
                        key: requireValue(key, 'setting key'),
                        value: value && typeof value === 'object' ? value : {},
                    },
                },
            );
            return firstRow(rows);
        },

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

        async createMerchant(merchant) {
            const rows = await request(
                `/rest/v1/merchants?select=${MERCHANT_SELECT}`,
                {
                    method: 'POST',
                    headers: { Prefer: 'return=representation' },
                    body: merchant,
                },
            );
            return firstRow(rows);
        },

        async findMerchantById(merchantId) {
            const rows = await request(
                `/rest/v1/merchants?merchant_id=eq.${encodeURIComponent(merchantId)}&select=${MERCHANT_SELECT}&limit=1`,
            );
            return firstRow(rows);
        },

        async findMerchantByEmail(email) {
            const rows = await request(
                `/rest/v1/merchants?contact_email=eq.${encodeURIComponent(email)}&select=${MERCHANT_SELECT}&limit=1`,
            );
            return firstRow(rows);
        },

        async listMerchants({ status = null, limit = 50 } = {}) {
            const params = new URLSearchParams();
            params.set('select', MERCHANT_SELECT);
            params.set('order', 'created_at.desc');
            params.set('limit', String(Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 100))));
            if (status) params.set('status', `eq.${status}`);
            const rows = await request(`/rest/v1/merchants?${params.toString()}`);
            return Array.isArray(rows) ? rows : [];
        },

        async updateMerchantStatus(merchantId, { status, approvedAt = null, rejectedAt = null, metadata = null }) {
            const body = {
                status,
                approved_at: approvedAt,
                rejected_at: rejectedAt,
            };
            if (metadata && typeof metadata === 'object') body.metadata = metadata;
            const rows = await request(
                `/rest/v1/merchants?merchant_id=eq.${encodeURIComponent(merchantId)}&select=${MERCHANT_SELECT}`,
                {
                    method: 'PATCH',
                    headers: { Prefer: 'return=representation' },
                    body,
                },
            );
            return firstRow(rows);
        },

        async createMerchantApiKey(apiKey) {
            const rows = await request(
                `/rest/v1/merchant_api_keys?select=${MERCHANT_API_KEY_SELECT}`,
                {
                    method: 'POST',
                    headers: { Prefer: 'return=representation' },
                    body: apiKey,
                },
            );
            return firstRow(rows);
        },

        async findMerchantApiKeyByHash(keyHash) {
            const rows = await request(
                `/rest/v1/merchant_api_keys?key_hash=eq.${encodeURIComponent(keyHash)}&revoked_at=is.null&select=${MERCHANT_API_KEY_SELECT}&limit=1`,
            );
            return firstRow(rows);
        },

        async listMerchantApiKeys(merchantId) {
            const rows = await request(
                `/rest/v1/merchant_api_keys?merchant_id=eq.${encodeURIComponent(merchantId)}&select=key_id,merchant_id,org_id,name,key_prefix,last_used_at,revoked_at,created_at&order=created_at.desc`,
            );
            return Array.isArray(rows) ? rows : [];
        },

        async touchMerchantApiKey(keyId, usedAt = new Date().toISOString()) {
            await request(`/rest/v1/merchant_api_keys?key_id=eq.${encodeURIComponent(keyId)}`, {
                method: 'PATCH',
                headers: { Prefer: 'return=minimal' },
                body: { last_used_at: usedAt },
            });
        },

        async revokeMerchantApiKey({ merchantId, keyId, revokedAt = new Date().toISOString() }) {
            const rows = await request(
                `/rest/v1/merchant_api_keys?merchant_id=eq.${encodeURIComponent(merchantId)}&key_id=eq.${encodeURIComponent(keyId)}&select=key_id,merchant_id,org_id,name,key_prefix,last_used_at,revoked_at,created_at`,
                {
                    method: 'PATCH',
                    headers: { Prefer: 'return=representation' },
                    body: { revoked_at: revokedAt },
                },
            );
            return firstRow(rows);
        },

        async createMerchantSetupToken(setupToken) {
            const rows = await request(
                `/rest/v1/merchant_setup_tokens?select=${MERCHANT_SETUP_TOKEN_SELECT}`,
                {
                    method: 'POST',
                    headers: { Prefer: 'return=representation' },
                    body: setupToken,
                },
            );
            return firstRow(rows);
        },

        async findMerchantSetupTokenByHash(tokenHash) {
            const rows = await request(
                `/rest/v1/merchant_setup_tokens?token_hash=eq.${encodeURIComponent(tokenHash)}&select=${MERCHANT_SETUP_TOKEN_SELECT}&limit=1`,
            );
            return firstRow(rows);
        },

        async markMerchantSetupTokenUsed(setupTokenId, usedAt = new Date().toISOString()) {
            const rows = await request(
                `/rest/v1/merchant_setup_tokens?setup_token_id=eq.${encodeURIComponent(setupTokenId)}&select=${MERCHANT_SETUP_TOKEN_SELECT}`,
                {
                    method: 'PATCH',
                    headers: { Prefer: 'return=representation' },
                    body: { used_at: usedAt },
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

        async createJobFile(file) {
            const rows = await request(
                `/rest/v1/job_files?select=${JOB_FILE_SELECT}`,
                {
                    method: 'POST',
                    headers: { Prefer: 'return=representation' },
                    body: file,
                },
            );
            return firstRow(rows);
        },

        async createPrintJob(job) {
            const rows = await request(
                `/rest/v1/print_jobs?select=${PRINT_JOB_SELECT}`,
                {
                    method: 'POST',
                    headers: { Prefer: 'return=representation' },
                    body: job,
                },
            );
            return firstRow(rows);
        },

        async updatePrintJob(jobId, fields) {
            const rows = await request(
                `/rest/v1/print_jobs?job_id=eq.${encodeURIComponent(jobId)}&select=${PRINT_JOB_SELECT}`,
                {
                    method: 'PATCH',
                    headers: { Prefer: 'return=representation' },
                    body: fields,
                },
            );
            return firstRow(rows);
        },

        async listMerchantPrintJobs({ merchantId, limit = 50 }) {
            const rows = await request(
                `/rest/v1/print_jobs?merchant_id=eq.${encodeURIComponent(merchantId)}&select=${PRINT_JOB_SELECT}&order=created_at.desc&limit=${Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 100))}`,
            );
            return Array.isArray(rows) ? rows : [];
        },

        async getMerchantPrintJob({ merchantId, jobId }) {
            const rows = await request(
                `/rest/v1/print_jobs?merchant_id=eq.${encodeURIComponent(merchantId)}&job_id=eq.${encodeURIComponent(jobId)}&select=${PRINT_JOB_SELECT}&limit=1`,
            );
            return firstRow(rows);
        },

        async createRoutingDecision(decision) {
            const rows = await request(
                `/rest/v1/routing_decisions?select=${ROUTING_DECISION_SELECT}`,
                {
                    method: 'POST',
                    headers: { Prefer: 'return=representation' },
                    body: decision,
                },
            );
            return firstRow(rows);
        },

        async createMerchantUsageEvent(event) {
            const rows = await request(
                '/rest/v1/merchant_usage_events?select=usage_event_id,org_id,merchant_id,job_id,file_id,event_type,quantity,metrics,created_at',
                {
                    method: 'POST',
                    headers: { Prefer: 'return=representation' },
                    body: event,
                },
            );
            return firstRow(rows);
        },

        async listMerchantUsageEvents({ merchantId, limit = 50 }) {
            const rows = await request(
                `/rest/v1/merchant_usage_events?merchant_id=eq.${encodeURIComponent(merchantId)}&select=usage_event_id,org_id,merchant_id,job_id,file_id,event_type,quantity,metrics,created_at&order=created_at.desc&limit=${Math.max(1, Math.min(Number.parseInt(limit, 10) || 50, 100))}`,
            );
            return Array.isArray(rows) ? rows : [];
        },

        async uploadPrintArtifact(storagePath, buffer, contentType = 'application/octet-stream') {
            return storageRequest(`/storage/v1/object/print-artifacts/${encodeStoragePath(storagePath)}`, {
                method: 'POST',
                headers: {
                    'Content-Type': contentType || 'application/octet-stream',
                    'x-upsert': 'false',
                },
                body: buffer,
            });
        },

        async createSignedPrintArtifactUrl(storagePath, expiresIn = 3600) {
            const { baseUrl } = getConfig();
            const payload = await request(`/storage/v1/object/sign/print-artifacts/${encodeStoragePath(storagePath)}`, {
                method: 'POST',
                body: { expiresIn },
            });
            const signedUrl = payload?.signedURL || payload?.signedUrl || payload?.url;
            if (!signedUrl) return null;
            return signedUrl.startsWith('http') ? signedUrl : `${baseUrl}${signedUrl}`;
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
