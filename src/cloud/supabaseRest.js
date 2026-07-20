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
    { name: 'platform_admin_users_table', path: '/rest/v1/platform_admin_users?select=admin_user_id&limit=1' },
    { name: 'platform_admin_sessions_table', path: '/rest/v1/platform_admin_sessions?select=session_id&limit=1' },
    { name: 'platform_admin_password_resets_table', path: '/rest/v1/platform_admin_password_resets?select=reset_token_id&limit=1' },
    { name: 'merchants_table', path: '/rest/v1/merchants?select=merchant_id&limit=1' },
    { name: 'merchant_api_keys_table', path: '/rest/v1/merchant_api_keys?select=key_id&limit=1' },
    { name: 'merchant_setup_tokens_table', path: '/rest/v1/merchant_setup_tokens?select=setup_token_id&limit=1' },
    { name: 'merchant_users_table', path: '/rest/v1/merchant_users?select=merchant_user_id&limit=1' },
    { name: 'merchant_user_sessions_table', path: '/rest/v1/merchant_user_sessions?select=session_id&limit=1' },
    {
        name: 'merchant_user_password_resets_table',
        path: '/rest/v1/merchant_user_password_resets?select=reset_token_id&limit=1',
    },
    { name: 'farm_nodes_table', path: '/rest/v1/farm_nodes?select=node_id&limit=1' },
    { name: 'cloud_printers_table', path: '/rest/v1/cloud_printers?select=printer_id&limit=1' },
    { name: 'print_jobs_table', path: '/rest/v1/print_jobs?select=job_id&limit=1' },
    { name: 'node_commands_table', path: '/rest/v1/node_commands?select=command_id&limit=1' },
    { name: 'node_events_table', path: '/rest/v1/node_events?select=event_id&limit=1' },
    { name: 'routing_decisions_table', path: '/rest/v1/routing_decisions?select=decision_id&limit=1' },
    { name: 'merchant_usage_events_table', path: '/rest/v1/merchant_usage_events?select=usage_event_id&limit=1' },
    { name: 'merchant_files_table', path: '/rest/v1/merchant_files?select=file_id&limit=1' },
    { name: 'merchant_slice_jobs_table', path: '/rest/v1/merchant_slice_jobs?select=slice_job_id&limit=1' },
    { name: 'merchant_orders_table', path: '/rest/v1/merchant_orders?select=order_id&limit=1' },
    { name: 'merchant_order_items_table', path: '/rest/v1/merchant_order_items?select=order_item_id&limit=1' },
    {
        name: 'merchant_material_reservations_table',
        path: '/rest/v1/merchant_material_reservations?select=reservation_id&limit=1',
    },
    { name: 'merchant_batches_table', path: '/rest/v1/merchant_batches?select=batch_id&limit=1' },
    { name: 'merchant_batch_items_table', path: '/rest/v1/merchant_batch_items?select=batch_item_id&limit=1' },
    { name: 'merchant_job_events_table', path: '/rest/v1/merchant_job_events?select=event_id&limit=1' },
    { name: 'merchant_job_artifacts_table', path: '/rest/v1/merchant_job_artifacts?select=artifact_id&limit=1' },
    { name: 'merchant_inspections_table', path: '/rest/v1/merchant_inspections?select=inspection_id&limit=1' },
    {
        name: 'merchant_post_processing_tasks_table',
        path: '/rest/v1/merchant_post_processing_tasks?select=task_id&limit=1',
    },
    { name: 'merchant_shipments_table', path: '/rest/v1/merchant_shipments?select=shipment_id&limit=1' },
    { name: 'merchant_shipping_labels_table', path: '/rest/v1/merchant_shipping_labels?select=label_id&limit=1' },
    { name: 'merchant_rate_cards_table', path: '/rest/v1/merchant_rate_cards?select=rate_card_id&limit=1' },
    { name: 'merchant_invoices_table', path: '/rest/v1/merchant_invoices?select=invoice_id&limit=1' },
    { name: 'merchant_invoice_lines_table', path: '/rest/v1/merchant_invoice_lines?select=invoice_line_id&limit=1' },
    {
        name: 'merchant_webhook_endpoints_table',
        path: '/rest/v1/merchant_webhook_endpoints?select=webhook_id&limit=1',
    },
    {
        name: 'merchant_webhook_deliveries_table',
        path: '/rest/v1/merchant_webhook_deliveries?select=delivery_id&limit=1',
    },
    { name: 'merchant_realtime_tokens_table', path: '/rest/v1/merchant_realtime_tokens?select=token_id&limit=1' },
    {
        name: 'merchant_adapter_events_table',
        path: '/rest/v1/merchant_adapter_events?select=adapter_event_id&limit=1',
    },
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

const PLATFORM_ADMIN_USER_SELECT = [
    'admin_user_id',
    'email',
    'role',
    'status',
    'password_hash',
    'last_login_at',
    'created_at',
    'updated_at',
].join(',');

const PLATFORM_ADMIN_SESSION_SELECT = [
    'session_id',
    'admin_user_id',
    'token_prefix',
    'token_hash',
    'last_used_at',
    'revoked_at',
    'expires_at',
    'created_at',
].join(',');

const PLATFORM_ADMIN_PASSWORD_RESET_SELECT = [
    'reset_token_id',
    'admin_user_id',
    'token_prefix',
    'token_hash',
    'used_at',
    'expires_at',
    'created_at',
].join(',');

const MERCHANT_USER_SELECT = [
    'merchant_user_id',
    'merchant_id',
    'org_id',
    'email',
    'display_name',
    'role',
    'status',
    'password_hash',
    'last_login_at',
    'created_at',
    'updated_at',
].join(',');

const MERCHANT_USER_SESSION_SELECT = [
    'session_id',
    'merchant_user_id',
    'merchant_id',
    'token_prefix',
    'token_hash',
    'last_used_at',
    'revoked_at',
    'expires_at',
    'created_at',
].join(',');

const MERCHANT_USER_PASSWORD_RESET_SELECT = [
    'reset_token_id',
    'merchant_user_id',
    'token_prefix',
    'token_hash',
    'used_at',
    'expires_at',
    'created_at',
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

// API key scopes live in a `scopes` jsonb column added by migration
// 20260702090000. Until that migration is applied on a given environment, the
// column does not exist and PostgREST would 400 on select/insert — so scopes
// are only read/written when MERCHANT_API_KEY_SCOPES_ENABLED=true. When off,
// keys behave as unrestricted (["*"]) for backward compatibility.
function merchantApiKeyScopesEnabled(env = process.env) {
    return env?.MERCHANT_API_KEY_SCOPES_ENABLED === 'true';
}

function merchantApiKeySelect(env = process.env) {
    return merchantApiKeyScopesEnabled(env) ? `${MERCHANT_API_KEY_SELECT},scopes` : MERCHANT_API_KEY_SELECT;
}

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

const MERCHANT_V2_IDS = {
    merchant_files: 'file_id',
    merchant_slice_jobs: 'slice_job_id',
    merchant_orders: 'order_id',
    merchant_order_items: 'order_item_id',
    merchant_material_reservations: 'reservation_id',
    merchant_batches: 'batch_id',
    merchant_inspections: 'inspection_id',
    merchant_post_processing_tasks: 'task_id',
    merchant_shipments: 'shipment_id',
    merchant_invoices: 'invoice_id',
    merchant_webhook_endpoints: 'webhook_id',
    merchant_webhook_deliveries: 'delivery_id',
    merchant_realtime_tokens: 'token_id',
};

function boundedLimit(limit, fallback = 50, max = 100) {
    return Math.max(1, Math.min(Number.parseInt(limit, 10) || fallback, max));
}

function eqFilter(value, name) {
    return `eq.${encodeURIComponent(requireValue(value, name))}`;
}

function statusInFilter(values) {
    const statuses = (Array.isArray(values) ? values : [])
        .map((status) => String(status || '').trim())
        .filter(Boolean)
        .map(encodeURIComponent)
        .join(',');
    if (!statuses) throw new Error('allowed statuses are required');
    return `in.(${statuses})`;
}

function stableCursorFilter({ cursor, timestampColumn, idColumn }) {
    if (!cursor) return null;
    const ts = typeof cursor === 'string' ? cursor : cursor.ts;
    const id = typeof cursor === 'object' && cursor !== null ? cursor.id : null;
    const encodedTs = encodeURIComponent(requireValue(ts, 'cursor'));
    if (!id) return `${timestampColumn}=lt.${encodedTs}`;
    return `or=(${timestampColumn}.lt.${encodedTs},and(${timestampColumn}.eq.${encodedTs},${idColumn}.lt.${encodeURIComponent(requireValue(id, 'cursor id'))}))`;
}

export function isSupabaseMissingTableError(error, tableName = null) {
    const message = String(error?.message || error || '');
    if (!message.includes('PGRST205') && !message.includes('Could not find the table')) {
        return false;
    }
    if (tableName && !message.includes(tableName)) {
        return false;
    }
    return true;
}

export class SupabaseMissingTableError extends Error {
    constructor(tableName, cause = null) {
        super(`Supabase table is not available: ${tableName}`);
        this.name = 'SupabaseMissingTableError';
        this.tableName = tableName;
        this.cause = cause;
    }
}

function rethrowMissingTableError(error, tableName) {
    if (isSupabaseMissingTableError(error, tableName)) {
        throw new SupabaseMissingTableError(tableName, error);
    }
    throw error;
}

export function createSupabaseRestClient({
    url = null,
    supabaseUrl = null,
    serviceKey = null,
    serviceRoleKey = null,
    fetchImpl = globalThis.fetch,
} = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');

    function getConfig() {
        return {
            baseUrl: normalizeBaseUrl(url || supabaseUrl || process.env.SUPABASE_URL),
            key: requireValue(
                serviceKey || serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY,
                'SUPABASE_SERVICE_ROLE_KEY',
            ),
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

    function merchantV2CreatePath(table) {
        return `/rest/v1/${table}?select=*`;
    }

    function merchantV2ResourcePath(table, { merchantId, idColumn, id, select = '*', limit = 1 }) {
        return [
            `/rest/v1/${table}?merchant_id=${eqFilter(merchantId, 'merchant_id')}`,
            `${idColumn}=${eqFilter(id, idColumn)}`,
            `select=${select}`,
            `limit=${boundedLimit(limit, 1, 100)}`,
        ].join('&');
    }

    function merchantV2ConditionalResourcePath(table, {
        merchantId,
        idColumn,
        id,
        filters = [],
        select = '*',
        limit = 1,
    }) {
        return [
            `/rest/v1/${table}?merchant_id=${eqFilter(merchantId, 'merchant_id')}`,
            `${idColumn}=${eqFilter(id, idColumn)}`,
            ...filters,
            `select=${select}`,
            `limit=${boundedLimit(limit, 1, 100)}`,
        ].join('&');
    }

    function merchantV2ListPath(table, {
        merchantId,
        select = '*',
        order = 'created_at.desc',
        limit = 50,
        filters = [],
    }) {
        return [
            `/rest/v1/${table}?merchant_id=${eqFilter(merchantId, 'merchant_id')}`,
            ...filters,
            `select=${select}`,
            `order=${order}`,
            `limit=${boundedLimit(limit)}`,
        ].join('&');
    }

    async function createMerchantV2Row(table, body) {
        const rows = await request(merchantV2CreatePath(table), {
            method: 'POST',
            headers: { Prefer: 'return=representation' },
            body,
        });
        return firstRow(rows);
    }

    async function getMerchantV2Row(table, { merchantId, idColumn, id }) {
        const rows = await request(merchantV2ResourcePath(table, { merchantId, idColumn, id }));
        return firstRow(rows);
    }

    async function updateMerchantV2Row(table, { merchantId, idColumn, id, body }) {
        const rows = await request(merchantV2ResourcePath(table, { merchantId, idColumn, id }), {
            method: 'PATCH',
            headers: { Prefer: 'return=representation' },
            body,
        });
        return firstRow(rows);
    }

    async function listMerchantV2Rows(table, options) {
        const rows = await request(merchantV2ListPath(table, options));
        return Array.isArray(rows) ? rows : [];
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

        async upsertPlatformAdminUser(adminUser) {
            const rows = await request(
                `/rest/v1/platform_admin_users?on_conflict=email&select=${PLATFORM_ADMIN_USER_SELECT}`,
                {
                    method: 'POST',
                    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
                    body: adminUser,
                },
            );
            return firstRow(rows);
        },

        async findPlatformAdminByEmail(email) {
            const rows = await request(
                `/rest/v1/platform_admin_users?email=eq.${encodeURIComponent(requireValue(email, 'admin email'))}&select=${PLATFORM_ADMIN_USER_SELECT}&limit=1`,
            );
            return firstRow(rows);
        },

        async findPlatformAdminById(adminUserId) {
            const rows = await request(
                `/rest/v1/platform_admin_users?admin_user_id=eq.${encodeURIComponent(requireValue(adminUserId, 'admin_user_id'))}&select=${PLATFORM_ADMIN_USER_SELECT}&limit=1`,
            );
            return firstRow(rows);
        },

        async listPlatformAdminUsers() {
            const rows = await request(
                `/rest/v1/platform_admin_users?select=${PLATFORM_ADMIN_USER_SELECT}&order=created_at.asc&limit=100`,
            );
            return Array.isArray(rows) ? rows : [];
        },

        async updatePlatformAdminStatus(adminUserId, status) {
            const rows = await request(
                `/rest/v1/platform_admin_users?admin_user_id=eq.${encodeURIComponent(requireValue(adminUserId, 'admin_user_id'))}&select=${PLATFORM_ADMIN_USER_SELECT}`,
                {
                    method: 'PATCH',
                    headers: { Prefer: 'return=representation' },
                    body: { status: requireValue(status, 'status') },
                },
            );
            return firstRow(rows);
        },

        async updatePlatformAdminPassword(adminUserId, passwordHash) {
            const rows = await request(
                `/rest/v1/platform_admin_users?admin_user_id=eq.${encodeURIComponent(requireValue(adminUserId, 'admin_user_id'))}&select=${PLATFORM_ADMIN_USER_SELECT}`,
                {
                    method: 'PATCH',
                    headers: { Prefer: 'return=representation' },
                    body: { password_hash: requireValue(passwordHash, 'password_hash') },
                },
            );
            return firstRow(rows);
        },

        async updatePlatformAdminLastLogin(adminUserId, lastLoginAt = new Date().toISOString()) {
            const rows = await request(
                `/rest/v1/platform_admin_users?admin_user_id=eq.${encodeURIComponent(requireValue(adminUserId, 'admin_user_id'))}&select=${PLATFORM_ADMIN_USER_SELECT}`,
                {
                    method: 'PATCH',
                    headers: { Prefer: 'return=representation' },
                    body: { last_login_at: lastLoginAt },
                },
            );
            return firstRow(rows);
        },

        async createAdminPasswordResetToken(resetToken) {
            const rows = await request(
                `/rest/v1/platform_admin_password_resets?select=${PLATFORM_ADMIN_PASSWORD_RESET_SELECT}`,
                {
                    method: 'POST',
                    headers: { Prefer: 'return=representation' },
                    body: resetToken,
                },
            );
            return firstRow(rows);
        },

        async findAdminPasswordResetTokenByHash(tokenHash) {
            const rows = await request(
                `/rest/v1/platform_admin_password_resets?token_hash=eq.${encodeURIComponent(requireValue(tokenHash, 'token_hash'))}&select=${PLATFORM_ADMIN_PASSWORD_RESET_SELECT}&limit=1`,
            );
            return firstRow(rows);
        },

        async markAdminPasswordResetTokenUsed(resetTokenId, usedAt = new Date().toISOString()) {
            const rows = await request(
                `/rest/v1/platform_admin_password_resets?reset_token_id=eq.${encodeURIComponent(requireValue(resetTokenId, 'reset_token_id'))}&select=${PLATFORM_ADMIN_PASSWORD_RESET_SELECT}`,
                {
                    method: 'PATCH',
                    headers: { Prefer: 'return=representation' },
                    body: { used_at: usedAt },
                },
            );
            return firstRow(rows);
        },

        async createAdminSession(session) {
            const rows = await request(
                `/rest/v1/platform_admin_sessions?select=${PLATFORM_ADMIN_SESSION_SELECT}`,
                {
                    method: 'POST',
                    headers: { Prefer: 'return=representation' },
                    body: session,
                },
            );
            return firstRow(rows);
        },

        async findAdminSessionByHash(tokenHash) {
            const rows = await request(
                `/rest/v1/platform_admin_sessions?token_hash=eq.${encodeURIComponent(requireValue(tokenHash, 'token_hash'))}&select=${PLATFORM_ADMIN_SESSION_SELECT}&limit=1`,
            );
            return firstRow(rows);
        },

        async touchAdminSession(sessionId, usedAt = new Date().toISOString()) {
            const rows = await request(
                `/rest/v1/platform_admin_sessions?session_id=eq.${encodeURIComponent(requireValue(sessionId, 'session_id'))}&select=${PLATFORM_ADMIN_SESSION_SELECT}`,
                {
                    method: 'PATCH',
                    headers: { Prefer: 'return=representation' },
                    body: { last_used_at: usedAt },
                },
            );
            return firstRow(rows);
        },

        async revokeAdminSession(sessionId, revokedAt = new Date().toISOString()) {
            const rows = await request(
                `/rest/v1/platform_admin_sessions?session_id=eq.${encodeURIComponent(requireValue(sessionId, 'session_id'))}&select=${PLATFORM_ADMIN_SESSION_SELECT}`,
                {
                    method: 'PATCH',
                    headers: { Prefer: 'return=representation' },
                    body: { revoked_at: revokedAt },
                },
            );
            return firstRow(rows);
        },

        async revokeAdminSessions(adminUserId, revokedAt = new Date().toISOString()) {
            await request(
                `/rest/v1/platform_admin_sessions?admin_user_id=eq.${encodeURIComponent(requireValue(adminUserId, 'admin_user_id'))}&revoked_at=is.null`,
                {
                    method: 'PATCH',
                    headers: { Prefer: 'return=minimal' },
                    body: { revoked_at: revokedAt },
                },
            );
        },

        async createMerchantUser(merchantUser) {
            try {
                const rows = await request(
                    `/rest/v1/merchant_users?select=${MERCHANT_USER_SELECT}`,
                    {
                        method: 'POST',
                        headers: { Prefer: 'return=representation' },
                        body: merchantUser,
                    },
                );
                return firstRow(rows);
            } catch (error) {
                rethrowMissingTableError(error, 'merchant_users');
            }
        },

        async findMerchantUserByEmail(email) {
            try {
                const rows = await request(
                    `/rest/v1/merchant_users?email=eq.${encodeURIComponent(requireValue(email, 'merchant user email'))}&select=${MERCHANT_USER_SELECT}&limit=1`,
                );
                return firstRow(rows);
            } catch (error) {
                rethrowMissingTableError(error, 'merchant_users');
            }
        },

        async findMerchantUserById(merchantUserId) {
            const rows = await request(
                `/rest/v1/merchant_users?merchant_user_id=eq.${encodeURIComponent(requireValue(merchantUserId, 'merchant_user_id'))}&select=${MERCHANT_USER_SELECT}&limit=1`,
            );
            return firstRow(rows);
        },

        async listMerchantUsers(merchantId) {
            const rows = await request(
                `/rest/v1/merchant_users?merchant_id=eq.${encodeURIComponent(requireValue(merchantId, 'merchant_id'))}&select=${MERCHANT_USER_SELECT}&order=created_at.asc&limit=100`,
            );
            return Array.isArray(rows) ? rows : [];
        },

        async updateMerchantUserPassword(merchantUserId, passwordHash) {
            const rows = await request(
                `/rest/v1/merchant_users?merchant_user_id=eq.${encodeURIComponent(requireValue(merchantUserId, 'merchant_user_id'))}&select=${MERCHANT_USER_SELECT}`,
                {
                    method: 'PATCH',
                    headers: { Prefer: 'return=representation' },
                    body: { password_hash: requireValue(passwordHash, 'password_hash') },
                },
            );
            return firstRow(rows);
        },

        async updateMerchantUserLastLogin(merchantUserId, lastLoginAt = new Date().toISOString()) {
            const rows = await request(
                `/rest/v1/merchant_users?merchant_user_id=eq.${encodeURIComponent(requireValue(merchantUserId, 'merchant_user_id'))}&select=${MERCHANT_USER_SELECT}`,
                {
                    method: 'PATCH',
                    headers: { Prefer: 'return=representation' },
                    body: { last_login_at: lastLoginAt },
                },
            );
            return firstRow(rows);
        },

        async createMerchantUserSession(session) {
            const rows = await request(
                `/rest/v1/merchant_user_sessions?select=${MERCHANT_USER_SESSION_SELECT}`,
                {
                    method: 'POST',
                    headers: { Prefer: 'return=representation' },
                    body: session,
                },
            );
            return firstRow(rows);
        },

        async findMerchantUserSessionByHash(tokenHash) {
            const rows = await request(
                `/rest/v1/merchant_user_sessions?token_hash=eq.${encodeURIComponent(requireValue(tokenHash, 'token_hash'))}&select=${MERCHANT_USER_SESSION_SELECT}&limit=1`,
            );
            return firstRow(rows);
        },

        async touchMerchantUserSession(sessionId, usedAt = new Date().toISOString()) {
            const rows = await request(
                `/rest/v1/merchant_user_sessions?session_id=eq.${encodeURIComponent(requireValue(sessionId, 'session_id'))}&select=${MERCHANT_USER_SESSION_SELECT}`,
                {
                    method: 'PATCH',
                    headers: { Prefer: 'return=representation' },
                    body: { last_used_at: usedAt },
                },
            );
            return firstRow(rows);
        },

        async revokeMerchantUserSession(sessionId, revokedAt = new Date().toISOString()) {
            const rows = await request(
                `/rest/v1/merchant_user_sessions?session_id=eq.${encodeURIComponent(requireValue(sessionId, 'session_id'))}&select=${MERCHANT_USER_SESSION_SELECT}`,
                {
                    method: 'PATCH',
                    headers: { Prefer: 'return=representation' },
                    body: { revoked_at: revokedAt },
                },
            );
            return firstRow(rows);
        },

        async revokeMerchantUserSessions(merchantUserId, revokedAt = new Date().toISOString()) {
            await request(
                `/rest/v1/merchant_user_sessions?merchant_user_id=eq.${encodeURIComponent(requireValue(merchantUserId, 'merchant_user_id'))}&revoked_at=is.null`,
                {
                    method: 'PATCH',
                    headers: { Prefer: 'return=minimal' },
                    body: { revoked_at: revokedAt },
                },
            );
        },

        async createMerchantUserPasswordResetToken(resetToken) {
            const rows = await request(
                `/rest/v1/merchant_user_password_resets?select=${MERCHANT_USER_PASSWORD_RESET_SELECT}`,
                {
                    method: 'POST',
                    headers: { Prefer: 'return=representation' },
                    body: resetToken,
                },
            );
            return firstRow(rows);
        },

        async findMerchantUserPasswordResetTokenByHash(tokenHash) {
            const rows = await request(
                `/rest/v1/merchant_user_password_resets?token_hash=eq.${encodeURIComponent(requireValue(tokenHash, 'token_hash'))}&select=${MERCHANT_USER_PASSWORD_RESET_SELECT}&limit=1`,
            );
            return firstRow(rows);
        },

        async markMerchantUserPasswordResetTokenUsed(resetTokenId, usedAt = new Date().toISOString()) {
            const rows = await request(
                `/rest/v1/merchant_user_password_resets?reset_token_id=eq.${encodeURIComponent(requireValue(resetTokenId, 'reset_token_id'))}&select=${MERCHANT_USER_PASSWORD_RESET_SELECT}`,
                {
                    method: 'PATCH',
                    headers: { Prefer: 'return=representation' },
                    body: { used_at: usedAt },
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

        async updateMerchantMetadata(merchantId, metadata) {
            const rows = await request(
                `/rest/v1/merchants?merchant_id=eq.${encodeURIComponent(merchantId)}&select=${MERCHANT_SELECT}`,
                {
                    method: 'PATCH',
                    headers: { Prefer: 'return=representation' },
                    body: { metadata: metadata && typeof metadata === 'object' ? metadata : {} },
                },
            );
            return firstRow(rows);
        },

        async createMerchantApiKey(apiKey) {
            const scopesEnabled = merchantApiKeyScopesEnabled();
            const body = scopesEnabled
                ? apiKey
                : (() => { const { scopes: _scopes, ...rest } = apiKey; return rest; })();
            const rows = await request(
                `/rest/v1/merchant_api_keys?select=${merchantApiKeySelect()}`,
                {
                    method: 'POST',
                    headers: { Prefer: 'return=representation' },
                    body,
                },
            );
            return firstRow(rows);
        },

        async findMerchantApiKeyByHash(keyHash) {
            const rows = await request(
                `/rest/v1/merchant_api_keys?key_hash=eq.${encodeURIComponent(keyHash)}&revoked_at=is.null&select=${merchantApiKeySelect()}&limit=1`,
            );
            return firstRow(rows);
        },

        async listMerchantApiKeys(merchantId) {
            const select = merchantApiKeyScopesEnabled()
                ? 'key_id,merchant_id,org_id,name,key_prefix,scopes,last_used_at,revoked_at,created_at'
                : 'key_id,merchant_id,org_id,name,key_prefix,last_used_at,revoked_at,created_at';
            const rows = await request(
                `/rest/v1/merchant_api_keys?merchant_id=eq.${encodeURIComponent(merchantId)}&select=${select}&order=created_at.desc`,
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
            // Conditional consume: the used_at=is.null predicate makes this atomic —
            // only the first concurrent request updates a row (and gets it back);
            // a token already consumed returns no rows (null), so the caller can
            // reject instead of minting a second key from one one-time token.
            const rows = await request(
                `/rest/v1/merchant_setup_tokens?setup_token_id=eq.${encodeURIComponent(setupTokenId)}&used_at=is.null&select=${MERCHANT_SETUP_TOKEN_SELECT}`,
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
                    select: 'job_id,org_id,node_id,printer_id,file_id,name,status,options,routing_summary,created_at,updated_at',
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

        async getJobFileById(fileId) {
            const rows = await request(
                `/rest/v1/job_files?file_id=eq.${encodeURIComponent(fileId)}&select=${JOB_FILE_SELECT}&limit=1`,
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

        async getPrintJobById(jobId) {
            const rows = await request(
                `/rest/v1/print_jobs?job_id=eq.${encodeURIComponent(jobId)}&select=${PRINT_JOB_SELECT}&limit=1`,
            );
            return firstRow(rows);
        },

        async listPrintJobsByStatus({ orgId = null, statuses = [], limit = 50 } = {}) {
            const params = new URLSearchParams();
            if (orgId) params.set('org_id', `eq.${orgId}`);
            params.set('status', `in.(${statuses.join(',')})`);
            params.set('select', PRINT_JOB_SELECT);
            // Oldest first: the job that has waited longest dispatches first.
            params.set('order', 'created_at.asc');
            params.set('limit', String(Math.max(1, Math.min(limit, 100))));
            const rows = await request(`/rest/v1/print_jobs?${params.toString()}`);
            return Array.isArray(rows) ? rows : [];
        },

        // Conditional transition out of waiting_for_capacity: the status filter
        // makes the PATCH a no-op (null) when a concurrent heartbeat already
        // claimed the job, so one waiting job can never dispatch twice.
        async claimWaitingPrintJob(jobId, fields) {
            const rows = await request(
                `/rest/v1/print_jobs?job_id=eq.${encodeURIComponent(jobId)}&status=eq.waiting_for_capacity&select=${PRINT_JOB_SELECT}`,
                {
                    method: 'PATCH',
                    headers: { Prefer: 'return=representation' },
                    body: fields,
                },
            );
            return firstRow(rows);
        },

        async findMerchantPrintJobByIdempotencyKey({ merchantId, idempotencyKey }) {
            const params = new URLSearchParams();
            params.set('merchant_id', `eq.${merchantId}`);
            params.set('options->>idempotency_key', `eq.${idempotencyKey}`);
            params.set('select', PRINT_JOB_SELECT);
            params.set('limit', '1');
            const rows = await request(`/rest/v1/print_jobs?${params.toString()}`);
            return firstRow(rows);
        },

        async createRoutingDecision(decision) {
            const rows = await request(
                `/rest/v1/routing_decisions?select=${ROUTING_DECISION_SELECT}`,
                {
                    method: 'POST',
                    headers: { Prefer: 'return=representation' },
                    body: {
                        ...decision,
                        score: decision.score ?? {},
                        rejected_candidates: decision.rejected_candidates ?? [],
                    },
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

        async listMerchantUsageEvents({
            merchantId,
            jobId = null,
            orderId = null,
            fileId = null,
            createdFrom = null,
            createdTo = null,
            limit = 50,
        }) {
            const filters = [];
            if (jobId) filters.push(`job_id=${eqFilter(jobId, 'job_id')}`);
            if (orderId) filters.push(`metrics->>order_id=${eqFilter(orderId, 'order_id')}`);
            if (fileId) filters.push(`file_id=${eqFilter(fileId, 'file_id')}`);
            if (createdFrom) filters.push(`created_at=gte.${encodeURIComponent(createdFrom)}`);
            if (createdTo) filters.push(`created_at=lt.${encodeURIComponent(createdTo)}`);
            return listMerchantV2Rows('merchant_usage_events', {
                merchantId,
                select: 'usage_event_id,org_id,merchant_id,job_id,file_id,event_type,quantity,metrics,created_at',
                filters,
                order: 'created_at.desc',
                limit,
            });
        },

        async createMerchantFile(file) {
            return createMerchantV2Row('merchant_files', file);
        },

        async getMerchantFile({ merchantId, fileId }) {
            return getMerchantV2Row('merchant_files', {
                merchantId,
                idColumn: MERCHANT_V2_IDS.merchant_files,
                id: fileId,
            });
        },

        async listMerchantFiles({ merchantId, status = null, limit = 50 }) {
            const filters = [];
            if (status) filters.push(`status=${eqFilter(status, 'status')}`);
            return listMerchantV2Rows('merchant_files', { merchantId, filters, limit });
        },

        async updateMerchantFile({ merchantId, fileId, fields = {} }) {
            return updateMerchantV2Row('merchant_files', {
                merchantId,
                idColumn: MERCHANT_V2_IDS.merchant_files,
                id: fileId,
                body: fields,
            });
        },

        async deleteMerchantFile({ merchantId, fileId, deletedAt = new Date().toISOString() }) {
            return updateMerchantV2Row('merchant_files', {
                merchantId,
                idColumn: MERCHANT_V2_IDS.merchant_files,
                id: fileId,
                body: { status: 'deleted', deleted_at: deletedAt },
            });
        },

        async createMerchantSliceJob(sliceJob) {
            return createMerchantV2Row('merchant_slice_jobs', sliceJob);
        },

        async getMerchantSliceJob({ merchantId, sliceJobId }) {
            return getMerchantV2Row('merchant_slice_jobs', {
                merchantId,
                idColumn: MERCHANT_V2_IDS.merchant_slice_jobs,
                id: sliceJobId,
            });
        },

        async listMerchantSliceJobs({ merchantId, status = null, limit = 50 }) {
            const filters = [];
            if (status) filters.push(`status=${eqFilter(status, 'status')}`);
            return listMerchantV2Rows('merchant_slice_jobs', { merchantId, filters, limit });
        },

        async updateMerchantSliceJob({ merchantId, sliceJobId, fields = {} }) {
            return updateMerchantV2Row('merchant_slice_jobs', {
                merchantId,
                idColumn: MERCHANT_V2_IDS.merchant_slice_jobs,
                id: sliceJobId,
                body: fields,
            });
        },

        async createMerchantOrder(order) {
            return createMerchantV2Row('merchant_orders', order);
        },

        async getMerchantOrder({ merchantId, orderId }) {
            return getMerchantV2Row('merchant_orders', {
                merchantId,
                idColumn: MERCHANT_V2_IDS.merchant_orders,
                id: orderId,
            });
        },

        async listMerchantOrders({ merchantId, status = null, limit = 50 }) {
            const filters = [];
            if (status) filters.push(`status=${eqFilter(status, 'status')}`);
            return listMerchantV2Rows('merchant_orders', { merchantId, filters, limit });
        },

        async findMerchantOrderByIdempotencyKey({ merchantId, idempotencyKey }) {
            const rows = await request(merchantV2ListPath('merchant_orders', {
                merchantId,
                filters: [`idempotency_key=${eqFilter(idempotencyKey, 'idempotency_key')}`],
                limit: 1,
            }));
            return firstRow(rows);
        },

        async findMerchantOrderByExternalOrderId({ merchantId, externalOrderId }) {
            const rows = await request(merchantV2ListPath('merchant_orders', {
                merchantId,
                filters: [`external_order_id=${eqFilter(externalOrderId, 'external_order_id')}`],
                limit: 1,
            }));
            return firstRow(rows);
        },

        async updateMerchantOrder({ merchantId, orderId, fields = {} }) {
            return updateMerchantV2Row('merchant_orders', {
                merchantId,
                idColumn: MERCHANT_V2_IDS.merchant_orders,
                id: orderId,
                body: fields,
            });
        },

        async cancelMerchantOrderIfCancelable({
            merchantId,
            orderId,
            canceledAt = new Date().toISOString(),
            cancelableStatuses = ['draft', 'submitted'],
        }) {
            const statuses = (Array.isArray(cancelableStatuses) ? cancelableStatuses : [])
                .map((status) => String(status || '').trim())
                .filter(Boolean)
                .map(encodeURIComponent)
                .join(',');
            const rows = await request(merchantV2ConditionalResourcePath('merchant_orders', {
                merchantId,
                idColumn: MERCHANT_V2_IDS.merchant_orders,
                id: orderId,
                filters: [`status=in.(${statuses})`],
            }), {
                method: 'PATCH',
                headers: { Prefer: 'return=representation' },
                body: {
                    status: 'canceled',
                    canceled_at: canceledAt,
                },
            });
            return firstRow(rows);
        },

        async createMerchantOrderItem(orderItem) {
            return createMerchantV2Row('merchant_order_items', orderItem);
        },

        // Cross-merchant sweep source for the heartbeat order-pickup pass:
        // order items that reference an uploaded file but have no print job.
        async listUnprintedMerchantOrderItems({ limit = 10 } = {}) {
            const rows = await request([
                '/rest/v1/merchant_order_items?job_id=is.null',
                'file_id=not.is.null',
                'select=*',
                'order=created_at.asc',
                `limit=${boundedLimit(limit, 10, 50)}`,
            ].join('&'));
            return Array.isArray(rows) ? rows : [];
        },

        async updateMerchantOrderItem({ merchantId, orderItemId, fields = {} }) {
            return updateMerchantV2Row('merchant_order_items', {
                merchantId,
                idColumn: MERCHANT_V2_IDS.merchant_order_items,
                id: orderItemId,
                body: fields,
            });
        },

        async findMerchantOrderItemByJobAndOrder({ merchantId, jobId, orderId }) {
            const rows = await request(merchantV2ListPath('merchant_order_items', {
                merchantId,
                filters: [
                    `job_id=${eqFilter(jobId, 'job_id')}`,
                    `order_id=${eqFilter(orderId, 'order_id')}`,
                ],
                limit: 1,
            }));
            return firstRow(rows);
        },

        async createMerchantMaterialReservation(reservation) {
            return createMerchantV2Row('merchant_material_reservations', reservation);
        },

        async getMerchantMaterialReservation({ merchantId, reservationId }) {
            return getMerchantV2Row('merchant_material_reservations', {
                merchantId,
                idColumn: MERCHANT_V2_IDS.merchant_material_reservations,
                id: reservationId,
            });
        },

        async listMerchantMaterialReservations({ merchantId, status = null, limit = 50 }) {
            const filters = [];
            if (status) filters.push(`status=${eqFilter(status, 'status')}`);
            return listMerchantV2Rows('merchant_material_reservations', { merchantId, filters, limit });
        },

        async releaseMerchantMaterialReservation({
            merchantId,
            reservationId,
            releasedAt = new Date().toISOString(),
        }) {
            const rows = await request(merchantV2ConditionalResourcePath('merchant_material_reservations', {
                merchantId,
                idColumn: MERCHANT_V2_IDS.merchant_material_reservations,
                id: reservationId,
                filters: ['status=eq.reserved'],
            }), {
                method: 'PATCH',
                headers: { Prefer: 'return=representation' },
                body: { status: 'released', released_at: releasedAt },
            });
            return firstRow(rows);
        },

        async createMerchantBatch(batch) {
            return createMerchantV2Row('merchant_batches', batch);
        },

        async getMerchantBatch({ merchantId, batchId }) {
            return getMerchantV2Row('merchant_batches', {
                merchantId,
                idColumn: MERCHANT_V2_IDS.merchant_batches,
                id: batchId,
            });
        },

        async listMerchantBatches({ merchantId, status = null, limit = 50 }) {
            const filters = [];
            if (status) filters.push(`status=${eqFilter(status, 'status')}`);
            return listMerchantV2Rows('merchant_batches', { merchantId, filters, limit });
        },

        async updateMerchantBatch({ merchantId, batchId, fields = {} }) {
            return updateMerchantV2Row('merchant_batches', {
                merchantId,
                idColumn: MERCHANT_V2_IDS.merchant_batches,
                id: batchId,
                body: fields,
            });
        },

        async updateMerchantBatchIfStatus({
            merchantId,
            batchId,
            allowedStatuses = [],
            fields = {},
        }) {
            const rows = await request(merchantV2ConditionalResourcePath('merchant_batches', {
                merchantId,
                idColumn: MERCHANT_V2_IDS.merchant_batches,
                id: batchId,
                filters: [`status=${statusInFilter(allowedStatuses)}`],
            }), {
                method: 'PATCH',
                headers: { Prefer: 'return=representation' },
                body: fields,
            });
            return firstRow(rows);
        },

        async createMerchantBatchItem(batchItem) {
            return createMerchantV2Row('merchant_batch_items', batchItem);
        },

        async listMerchantBatchItems({ merchantId, batchId, limit = 50 }) {
            const filters = [`batch_id=${eqFilter(batchId, 'batch_id')}`];
            return listMerchantV2Rows('merchant_batch_items', {
                merchantId,
                filters,
                limit,
            });
        },

        async recordMerchantJobEvent(event) {
            return createMerchantV2Row('merchant_job_events', event);
        },

        async listMerchantJobEvents({
            merchantId,
            jobId = null,
            orderId = null,
            batchId = null,
            fileId = null,
            sliceId = null,
            eventType = null,
            cursor = null,
            limit = 50,
        }) {
            const filters = [];
            if (jobId) filters.push(`job_id=${eqFilter(jobId, 'job_id')}`);
            if (orderId) filters.push(`order_id=${eqFilter(orderId, 'order_id')}`);
            if (batchId) filters.push(`batch_id=${eqFilter(batchId, 'batch_id')}`);
            if (fileId) filters.push(`file_id=${eqFilter(fileId, 'file_id')}`);
            if (sliceId) filters.push(`slice_job_id=${eqFilter(sliceId, 'slice_job_id')}`);
            if (eventType) filters.push(`event_type=${eqFilter(eventType, 'event_type')}`);
            const cursorFilter = stableCursorFilter({
                cursor,
                timestampColumn: 'occurred_at',
                idColumn: 'event_id',
            });
            if (cursorFilter) filters.push(cursorFilter);
            return listMerchantV2Rows('merchant_job_events', {
                merchantId,
                filters,
                order: 'occurred_at.desc,event_id.desc',
                limit,
            });
        },

        async createMerchantJobArtifact(artifact) {
            return createMerchantV2Row('merchant_job_artifacts', artifact);
        },

        async listMerchantJobArtifacts({
            merchantId,
            jobId = null,
            fileId = null,
            artifactType = null,
            cursor = null,
            limit = 50,
        }) {
            const filters = [];
            if (jobId) filters.push(`job_id=${eqFilter(jobId, 'job_id')}`);
            if (fileId) filters.push(`file_id=${eqFilter(fileId, 'file_id')}`);
            if (artifactType) filters.push(`artifact_type=${eqFilter(artifactType, 'artifact_type')}`);
            const cursorFilter = stableCursorFilter({
                cursor,
                timestampColumn: 'created_at',
                idColumn: 'artifact_id',
            });
            if (cursorFilter) filters.push(cursorFilter);
            return listMerchantV2Rows('merchant_job_artifacts', {
                merchantId,
                filters,
                order: 'created_at.desc,artifact_id.desc',
                limit,
            });
        },

        async createMerchantInspection(inspection) {
            return createMerchantV2Row('merchant_inspections', inspection);
        },

        async getMerchantInspection({ merchantId, inspectionId }) {
            return getMerchantV2Row('merchant_inspections', {
                merchantId,
                idColumn: MERCHANT_V2_IDS.merchant_inspections,
                id: inspectionId,
            });
        },

        async getMerchantInspectionByJob({ merchantId, jobId }) {
            const rows = await request(merchantV2ResourcePath('merchant_inspections', {
                merchantId,
                idColumn: 'job_id',
                id: jobId,
            }));
            return firstRow(rows);
        },

        async listMerchantInspections({
            merchantId,
            jobId = null,
            orderId = null,
            status = null,
            limit = 50,
        }) {
            const filters = [];
            if (jobId) filters.push(`job_id=${eqFilter(jobId, 'job_id')}`);
            if (orderId) filters.push(`order_id=${eqFilter(orderId, 'order_id')}`);
            if (status) filters.push(`status=${eqFilter(status, 'status')}`);
            return listMerchantV2Rows('merchant_inspections', {
                merchantId,
                filters,
                limit,
            });
        },

        async updateMerchantInspection({ merchantId, inspectionId, fields = {} }) {
            return updateMerchantV2Row('merchant_inspections', {
                merchantId,
                idColumn: MERCHANT_V2_IDS.merchant_inspections,
                id: inspectionId,
                body: fields,
            });
        },

        async updateMerchantInspectionIfDecisionOpen({
            merchantId,
            inspectionId,
            allowedStatuses = [],
            fields = {},
        }) {
            const rows = await request(merchantV2ConditionalResourcePath('merchant_inspections', {
                merchantId,
                idColumn: MERCHANT_V2_IDS.merchant_inspections,
                id: inspectionId,
                filters: [
                    `status=${statusInFilter(allowedStatuses)}`,
                    'decision=is.null',
                ],
            }), {
                method: 'PATCH',
                headers: { Prefer: 'return=representation' },
                body: fields,
            });
            return firstRow(rows);
        },

        async createMerchantPostProcessingTask(task) {
            return createMerchantV2Row('merchant_post_processing_tasks', task);
        },

        async getMerchantPostProcessingTask({ merchantId, taskId }) {
            return getMerchantV2Row('merchant_post_processing_tasks', {
                merchantId,
                idColumn: MERCHANT_V2_IDS.merchant_post_processing_tasks,
                id: taskId,
            });
        },

        async findMerchantPostProcessingTaskByIdempotencyKey({ merchantId, idempotencyKey }) {
            return getMerchantV2Row('merchant_post_processing_tasks', {
                merchantId,
                idColumn: 'idempotency_key',
                id: idempotencyKey,
            });
        },

        async listMerchantPostProcessingTasks({
            merchantId,
            jobId = null,
            orderId = null,
            status = null,
            limit = 50,
        }) {
            const filters = [];
            if (jobId) filters.push(`job_id=${eqFilter(jobId, 'job_id')}`);
            if (orderId) filters.push(`order_id=${eqFilter(orderId, 'order_id')}`);
            if (status) filters.push(`status=${eqFilter(status, 'status')}`);
            return listMerchantV2Rows('merchant_post_processing_tasks', { merchantId, filters, limit });
        },

        async updateMerchantPostProcessingTask({ merchantId, taskId, fields = {} }) {
            return updateMerchantV2Row('merchant_post_processing_tasks', {
                merchantId,
                idColumn: MERCHANT_V2_IDS.merchant_post_processing_tasks,
                id: taskId,
                body: fields,
            });
        },

        async updateMerchantPostProcessingTaskIfStatus({
            merchantId,
            taskId,
            allowedStatuses = [],
            fields = {},
        }) {
            const rows = await request(merchantV2ConditionalResourcePath('merchant_post_processing_tasks', {
                merchantId,
                idColumn: MERCHANT_V2_IDS.merchant_post_processing_tasks,
                id: taskId,
                filters: [`status=${statusInFilter(allowedStatuses)}`],
            }), {
                method: 'PATCH',
                headers: { Prefer: 'return=representation' },
                body: fields,
            });
            return firstRow(rows);
        },

        async createMerchantShipment(shipment) {
            return createMerchantV2Row('merchant_shipments', shipment);
        },

        async findMerchantShipmentByIdempotencyKey({ merchantId, idempotencyKey }) {
            const rows = await request(merchantV2ListPath('merchant_shipments', {
                merchantId,
                filters: [`idempotency_key=${eqFilter(idempotencyKey, 'idempotency_key')}`],
                limit: 1,
            }));
            return firstRow(rows);
        },

        async listMerchantShipments({
            merchantId,
            orderId = null,
            status = null,
            limit = 50,
        }) {
            const filters = [];
            if (orderId) filters.push(`order_id=${eqFilter(orderId, 'order_id')}`);
            if (status) filters.push(`status=${eqFilter(status, 'status')}`);
            return listMerchantV2Rows('merchant_shipments', { merchantId, filters, limit });
        },

        async getMerchantShipment({ merchantId, shipmentId }) {
            return getMerchantV2Row('merchant_shipments', {
                merchantId,
                idColumn: MERCHANT_V2_IDS.merchant_shipments,
                id: shipmentId,
            });
        },

        async updateMerchantShipmentStatus({
            merchantId,
            shipmentId,
            status,
            shippedAt = undefined,
            deliveredAt = undefined,
            fields = {},
        }) {
            const body = { ...fields, status: requireValue(status, 'status') };
            if (shippedAt !== undefined) body.shipped_at = shippedAt;
            if (deliveredAt !== undefined) body.delivered_at = deliveredAt;
            return updateMerchantV2Row('merchant_shipments', {
                merchantId,
                idColumn: MERCHANT_V2_IDS.merchant_shipments,
                id: shipmentId,
                body,
            });
        },

        async updateMerchantShipmentIfClaimStatus({
            merchantId,
            shipmentId,
            allowedStatuses = [],
            fields = {},
        }) {
            const rows = await request(merchantV2ConditionalResourcePath('merchant_shipments', {
                merchantId,
                idColumn: MERCHANT_V2_IDS.merchant_shipments,
                id: shipmentId,
                filters: [`metadata->>shipment_claim_status=${statusInFilter(allowedStatuses)}`],
            }), {
                method: 'PATCH',
                headers: { Prefer: 'return=representation' },
                body: fields,
            });
            return firstRow(rows);
        },

        async createMerchantShippingLabel(label) {
            return createMerchantV2Row('merchant_shipping_labels', label);
        },

        async updateMerchantShippingLabel({ merchantId, labelId, fields = {} }) {
            return updateMerchantV2Row('merchant_shipping_labels', {
                merchantId,
                idColumn: 'label_id',
                id: labelId,
                body: fields,
            });
        },

        async updateMerchantShippingLabelIfClaimStatus({
            merchantId,
            labelId,
            allowedStatuses = [],
            fields = {},
        }) {
            const rows = await request(merchantV2ConditionalResourcePath('merchant_shipping_labels', {
                merchantId,
                idColumn: 'label_id',
                id: labelId,
                filters: [`metadata->>label_claim_status=${statusInFilter(allowedStatuses)}`],
            }), {
                method: 'PATCH',
                headers: { Prefer: 'return=representation' },
                body: fields,
            });
            return firstRow(rows);
        },

        async listMerchantShippingLabels({
            merchantId,
            shipmentId = null,
            limit = 50,
        }) {
            const filters = [];
            if (shipmentId) filters.push(`shipment_id=${eqFilter(shipmentId, 'shipment_id')}`);
            return listMerchantV2Rows('merchant_shipping_labels', {
                merchantId,
                filters,
                limit,
            });
        },

        async getMerchantShippingLabelByShipment({ merchantId, shipmentId }) {
            const rows = await request(merchantV2ListPath('merchant_shipping_labels', {
                merchantId,
                filters: [`shipment_id=${eqFilter(shipmentId, 'shipment_id')}`],
                order: 'created_at.desc',
                limit: 1,
            }));
            return firstRow(rows);
        },

        async getMerchantRateCard({ merchantId, rateCardId = null } = {}) {
            const filters = rateCardId
                ? [`rate_card_id=${eqFilter(rateCardId, 'rate_card_id')}`]
                : ['status=eq.active'];
            const rows = await request(merchantV2ListPath('merchant_rate_cards', {
                merchantId,
                filters,
                order: 'effective_at.desc',
                limit: 1,
            }));
            return firstRow(rows);
        },

        async createMerchantInvoice(invoice) {
            return createMerchantV2Row('merchant_invoices', invoice);
        },

        async listMerchantInvoices({ merchantId, status = null, limit = 50 }) {
            const filters = [];
            if (status) filters.push(`status=${eqFilter(status, 'status')}`);
            return listMerchantV2Rows('merchant_invoices', { merchantId, filters, limit });
        },

        async getMerchantInvoice({ merchantId, invoiceId }) {
            return getMerchantV2Row('merchant_invoices', {
                merchantId,
                idColumn: MERCHANT_V2_IDS.merchant_invoices,
                id: invoiceId,
            });
        },

        async createMerchantInvoiceLine(line) {
            return createMerchantV2Row('merchant_invoice_lines', line);
        },

        async listMerchantInvoiceLines({ merchantId, invoiceId, limit = 100 }) {
            const filters = [`invoice_id=${eqFilter(invoiceId, 'invoice_id')}`];
            return listMerchantV2Rows('merchant_invoice_lines', {
                merchantId,
                filters,
                order: 'created_at.asc',
                limit,
            });
        },

        async createMerchantWebhookEndpoint(endpoint) {
            return createMerchantV2Row('merchant_webhook_endpoints', endpoint);
        },

        async getMerchantWebhookEndpoint({ merchantId, webhookId }) {
            return getMerchantV2Row('merchant_webhook_endpoints', {
                merchantId,
                idColumn: MERCHANT_V2_IDS.merchant_webhook_endpoints,
                id: webhookId,
            });
        },

        async listMerchantWebhookEndpoints({ merchantId, limit = 50 }) {
            return listMerchantV2Rows('merchant_webhook_endpoints', { merchantId, limit });
        },

        async updateMerchantWebhookEndpoint({ merchantId, webhookId, fields = {} }) {
            return updateMerchantV2Row('merchant_webhook_endpoints', {
                merchantId,
                idColumn: MERCHANT_V2_IDS.merchant_webhook_endpoints,
                id: webhookId,
                body: fields,
            });
        },

        async deleteMerchantWebhookEndpoint({ merchantId, webhookId }) {
            // Disable instead of deleting so delivery history remains auditable.
            return updateMerchantV2Row('merchant_webhook_endpoints', {
                merchantId,
                idColumn: MERCHANT_V2_IDS.merchant_webhook_endpoints,
                id: webhookId,
                body: { status: 'disabled' },
            });
        },

        async createMerchantWebhookDelivery(delivery) {
            return createMerchantV2Row('merchant_webhook_deliveries', delivery);
        },

        async listMerchantWebhookDeliveries({ merchantId, webhookId = null, limit = 50 }) {
            const filters = webhookId ? [`webhook_id=${eqFilter(webhookId, 'webhook_id')}`] : [];
            return listMerchantV2Rows('merchant_webhook_deliveries', { merchantId, filters, limit });
        },

        async getMerchantWebhookDelivery({ merchantId, deliveryId }) {
            return getMerchantV2Row('merchant_webhook_deliveries', {
                merchantId,
                idColumn: MERCHANT_V2_IDS.merchant_webhook_deliveries,
                id: deliveryId,
            });
        },

        async updateMerchantWebhookDelivery({ merchantId, deliveryId, fields = {} }) {
            return updateMerchantV2Row('merchant_webhook_deliveries', {
                merchantId,
                idColumn: MERCHANT_V2_IDS.merchant_webhook_deliveries,
                id: deliveryId,
                body: fields,
            });
        },

        async createMerchantRealtimeToken(token) {
            return createMerchantV2Row('merchant_realtime_tokens', token);
        },

        async listMerchantRealtimeTokens({ merchantId, limit = 50, now = new Date().toISOString() }) {
            return listMerchantV2Rows('merchant_realtime_tokens', {
                merchantId,
                select: [
                    'token_id',
                    'org_id',
                    'merchant_id',
                    'token_prefix',
                    'scopes',
                    'channel_names',
                    'expires_at',
                    'revoked_at',
                    'metadata',
                    'created_at',
                    'updated_at',
                ].join(','),
                filters: [
                    'revoked_at=is.null',
                    `expires_at=gt.${encodeURIComponent(now)}`,
                ],
                limit,
            });
        },

        async recordMerchantAdapterEvent(event) {
            return createMerchantV2Row('merchant_adapter_events', event);
        },

        async listMerchantAdapterEvents({ merchantId, adapterName = null, limit = 50 }) {
            const filters = [];
            if (adapterName) filters.push(`adapter_name=${eqFilter(adapterName, 'adapter_name')}`);
            return listMerchantV2Rows('merchant_adapter_events', { merchantId, filters, limit });
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

        async getNodeWorkSummary(nodeId) {
            const encoded = encodeURIComponent(nodeId);
            const nodeRows = await request(
                `/rest/v1/farm_nodes?node_id=eq.${encoded}&select=node_id,org_id,name,status&limit=1`,
            );
            const node = firstRow(nodeRows);
            if (!node) return null;

            const [activeJobs, pendingCommands] = await Promise.all([
                request(`/rest/v1/print_jobs?node_id=eq.${encoded}&status=in.(queued,assigned,transforming,uploading,printing,waiting_for_capacity)&select=job_id&limit=200`),
                request(`/rest/v1/node_commands?node_id=eq.${encoded}&status=in.(queued,claimed,running)&select=command_id&limit=200`),
            ]);

            return {
                ...node,
                active_jobs: Array.isArray(activeJobs) ? activeJobs.length : 0,
                pending_commands: Array.isArray(pendingCommands) ? pendingCommands.length : 0,
            };
        },

        async deleteFarmNode(nodeId) {
            // FKs cascade cloud_printers + node_commands; print_jobs/node_events/
            // routing_decisions keep their rows with node references nulled.
            const rows = await request(
                `/rest/v1/farm_nodes?node_id=eq.${encodeURIComponent(nodeId)}&select=node_id,org_id,name,status,agent_version,last_seen_at,created_at,updated_at`,
                {
                    method: 'DELETE',
                    headers: { Prefer: 'return=representation' },
                },
            );
            return firstRow(rows);
        },

        async upsertCloudPrinters(node, printers, lastSeenAt = new Date().toISOString()) {
            const orgId = node.organization_id || node.org_id;
            const rows = (Array.isArray(printers) ? printers : []).map((printer) => ({
                org_id: orgId,
                node_id: node.node_id,
                local_printer_id: printer.local_printer_id,
                name: printer.name,
                model: printer.model,
                status: printer.status,
                status_snapshot: printer.status_snapshot,
                capabilities: printer.capabilities,
                last_seen_at: lastSeenAt,
                updated_at: lastSeenAt,
            }));
            if (rows.length === 0) return;

            await request(
                '/rest/v1/cloud_printers?on_conflict=node_id,local_printer_id',
                {
                    method: 'POST',
                    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
                    body: rows,
                },
            );
        },

        async getNodeCommandById(commandId) {
            const rows = await request(
                `/rest/v1/node_commands?command_id=eq.${encodeURIComponent(commandId)}&limit=1`,
            );
            return firstRow(rows);
        },

        async listNodeCommands({ nodeId, commandType = null, limit = 50 } = {}) {
            const params = new URLSearchParams();
            params.set('node_id', `eq.${nodeId}`);
            if (commandType) params.set('command_type', `eq.${commandType}`);
            params.set('order', 'created_at.desc');
            params.set('limit', String(Math.max(1, Math.min(limit, 100))));
            const rows = await request(`/rest/v1/node_commands?${params.toString()}`);
            return Array.isArray(rows) ? rows : [];
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
            // Only transition from a non-terminal state. Without this precondition a
            // delayed/duplicate outbox re-delivery could resurrect an already
            // succeeded/failed command (resetting finished_at).
            await request(
                `/rest/v1/node_commands?node_id=eq.${encodeURIComponent(nodeId)}&command_id=eq.${encodeURIComponent(commandResult.command_id)}&status=in.(claimed,running)`,
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
