import { randomUUID } from 'node:crypto';

// In-memory implementation of the cloud store contract used by the Vercel
// handlers (see supabaseRest.js for the production implementation). It backs:
//   - the local/self-hosted cloud control plane (localCloudServer.js)
//   - the offline end-to-end tests (tests/cloud/e2eFullLoop.test.js,
//     scripts/local-e2e-test.mjs)
// Only the surface the farm loop needs is implemented: organizations, nodes,
// heartbeats + printer mirroring, command intents, merchants + API keys +
// setup tokens, platform admin users + sessions + password resets, merchant
// users (portal sign-in) + sessions + password resets, print jobs + files +
// routing decisions, platform settings, and print artifacts (stored in
// memory, served via signed-style URLs).

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

export function createMemoryCloudStore({ now = () => new Date() } = {}) {
    const db = {
        platformSettings: new Map(),
        organizations: [],
        nodes: [],
        printers: [],
        commands: [],
        events: [],
        platformAdminUsers: [],
        adminSessions: [],
        adminPasswordResets: [],
        merchants: [],
        merchantApiKeys: [],
        merchantSetupTokens: [],
        merchantUsers: [],
        merchantUserSessions: [],
        merchantUserPasswordResets: [],
        jobFiles: [],
        printJobs: [],
        routingDecisions: [],
        usageEvents: [],
        merchantWebhookEndpoints: [],
        merchantWebhookDeliveries: [],
        artifacts: new Map(),
    };
    let publicBaseUrl = '';

    const ts = () => now().toISOString();
    const byOrg = (rows, orgId) => (orgId ? rows.filter((row) => row.org_id === orgId) : rows);
    const latest = (rows, limit) => [...rows].reverse().slice(0, Math.max(1, Math.min(limit || 50, 100)));

    return {
        // -- test/dev helpers (not part of the production contract) ----------
        setPublicBaseUrl(url) {
            publicBaseUrl = String(url || '').replace(/\/+$/, '');
        },
        getArtifact(storagePath) {
            return db.artifacts.get(storagePath) || null;
        },
        _db: db,

        // -- platform settings ------------------------------------------------
        async getPlatformSetting(key, fallbackValue = null) {
            return db.platformSettings.has(key) ? clone(db.platformSettings.get(key)) : fallbackValue;
        },
        async upsertPlatformSetting(key, value) {
            db.platformSettings.set(key, clone(value));
            return { key, value: clone(value) };
        },

        // -- setup status ------------------------------------------------------
        async getCloudSetupStatus() {
            return { checked: true, ready: true, checks: [{ name: 'memory_store', ok: true }] };
        },

        // -- platform admin users / sessions / password resets ------------------
        async upsertPlatformAdminUser(adminUser) {
            const email = String(adminUser.email || '').toLowerCase();
            let row = db.platformAdminUsers.find((admin) => admin.email === email);
            if (row) {
                Object.assign(row, clone({ ...adminUser, email }), { updated_at: ts() });
            } else {
                row = {
                    admin_user_id: randomUUID(),
                    role: 'admin',
                    status: 'active',
                    password_hash: null,
                    last_login_at: null,
                    created_at: ts(),
                    updated_at: ts(),
                    ...clone(adminUser),
                    email,
                };
                db.platformAdminUsers.push(row);
            }
            return clone(row);
        },
        async findPlatformAdminByEmail(email) {
            const normalized = String(email || '').toLowerCase();
            return clone(db.platformAdminUsers.find((admin) => admin.email === normalized) || null);
        },
        async findPlatformAdminById(adminUserId) {
            return clone(db.platformAdminUsers.find((admin) => admin.admin_user_id === adminUserId) || null);
        },
        async listPlatformAdminUsers() {
            return clone(db.platformAdminUsers);
        },
        async updatePlatformAdminPassword(adminUserId, passwordHash) {
            const row = db.platformAdminUsers.find((admin) => admin.admin_user_id === adminUserId);
            if (!row) return null;
            row.password_hash = passwordHash;
            row.updated_at = ts();
            return clone(row);
        },
        async updatePlatformAdminStatus(adminUserId, status) {
            const row = db.platformAdminUsers.find((admin) => admin.admin_user_id === adminUserId);
            if (!row) return null;
            row.status = status;
            row.updated_at = ts();
            return clone(row);
        },
        async updatePlatformAdminLastLogin(adminUserId, lastLoginAt = ts()) {
            const row = db.platformAdminUsers.find((admin) => admin.admin_user_id === adminUserId);
            if (!row) return null;
            row.last_login_at = lastLoginAt;
            row.updated_at = ts();
            return clone(row);
        },
        async createAdminSession(session) {
            const row = {
                session_id: randomUUID(),
                last_used_at: null,
                revoked_at: null,
                created_at: ts(),
                ...clone(session),
            };
            db.adminSessions.push(row);
            return clone(row);
        },
        async findAdminSessionByHash(tokenHash) {
            return clone(db.adminSessions.find((session) => session.token_hash === tokenHash) || null);
        },
        async touchAdminSession(sessionId, usedAt = ts()) {
            const row = db.adminSessions.find((session) => session.session_id === sessionId);
            if (row) row.last_used_at = usedAt;
        },
        async revokeAdminSession(sessionId, revokedAt = ts()) {
            const row = db.adminSessions.find((session) => session.session_id === sessionId);
            if (!row) return null;
            row.revoked_at = revokedAt;
            return clone(row);
        },
        async revokeAdminSessions(adminUserId, revokedAt = ts()) {
            for (const session of db.adminSessions) {
                if (session.admin_user_id === adminUserId && !session.revoked_at) {
                    session.revoked_at = revokedAt;
                }
            }
        },
        async createAdminPasswordResetToken(resetToken) {
            const row = {
                reset_token_id: randomUUID(),
                used_at: null,
                created_at: ts(),
                ...clone(resetToken),
            };
            db.adminPasswordResets.push(row);
            return clone(row);
        },
        async findAdminPasswordResetTokenByHash(tokenHash) {
            return clone(db.adminPasswordResets.find((reset) => reset.token_hash === tokenHash) || null);
        },
        async markAdminPasswordResetTokenUsed(resetTokenId, usedAt = ts()) {
            const row = db.adminPasswordResets.find((reset) => reset.reset_token_id === resetTokenId);
            if (!row) return null;
            row.used_at = usedAt;
            return clone(row);
        },

        // -- organizations / nodes ---------------------------------------------
        async createOrganization(organization) {
            const row = {
                org_id: randomUUID(),
                name: organization.name,
                created_at: ts(),
                updated_at: ts(),
            };
            db.organizations.push(row);
            return clone(row);
        },
        async createFarmNode(node) {
            const row = {
                node_id: randomUUID(),
                org_id: node.org_id,
                name: node.name,
                status: 'offline',
                agent_version: null,
                host_info: {},
                capabilities: node.capabilities || {},
                token_hash: node.token_hash,
                last_seen_at: null,
                created_at: ts(),
                updated_at: ts(),
            };
            db.nodes.push(row);
            const { token_hash, ...visible } = row;
            return clone(visible);
        },
        async findNodeByTokenHash(tokenHash) {
            const row = db.nodes.find((node) => node.token_hash === tokenHash);
            if (!row) return null;
            return {
                node_id: row.node_id,
                org_id: row.org_id,
                organization_id: row.org_id,
                name: row.name,
                status: row.status,
            };
        },
        async recordNodeHeartbeat(nodeId, heartbeat) {
            const row = db.nodes.find((node) => node.node_id === nodeId);
            if (!row) return;
            row.status = heartbeat.status;
            row.last_seen_at = heartbeat.last_seen_at;
            row.agent_version = heartbeat.agent_version;
            row.host_info = clone(heartbeat.host_info);
            row.capabilities = clone(heartbeat.capabilities);
            row.updated_at = heartbeat.last_seen_at;
        },
        async getNodeWorkSummary(nodeId) {
            const row = db.nodes.find((node) => node.node_id === nodeId);
            if (!row) return null;
            const activeJobStatuses = new Set([
                'queued', 'assigned', 'transforming', 'uploading', 'printing', 'waiting_for_capacity',
            ]);
            const pendingCommandStatuses = new Set(['queued', 'claimed', 'running']);
            return {
                node_id: row.node_id,
                org_id: row.org_id,
                name: row.name,
                status: row.status,
                active_jobs: db.printJobs.filter((job) => (
                    job.node_id === nodeId && activeJobStatuses.has(String(job.status || '').toLowerCase())
                )).length,
                pending_commands: db.commands.filter((command) => (
                    command.node_id === nodeId && pendingCommandStatuses.has(String(command.status || '').toLowerCase())
                )).length,
            };
        },
        async deleteFarmNode(nodeId) {
            const index = db.nodes.findIndex((node) => node.node_id === nodeId);
            if (index === -1) return null;
            const [row] = db.nodes.splice(index, 1);

            // Mirror the production FK behavior (cloud_control_plane migration):
            // printers + commands CASCADE, jobs/events/routing decisions SET NULL.
            db.printers = db.printers.filter((printer) => printer.node_id !== nodeId);
            db.commands = db.commands.filter((command) => command.node_id !== nodeId);
            for (const job of db.printJobs) {
                if (job.node_id === nodeId) job.node_id = null;
            }
            for (const event of db.events) {
                if (event.node_id === nodeId) event.node_id = null;
            }
            for (const decision of db.routingDecisions) {
                if (decision.selected_node_id === nodeId) decision.selected_node_id = null;
            }

            const { token_hash, ...visible } = row;
            return clone(visible);
        },
        async upsertCloudPrinters(node, printers, lastSeenAt = ts()) {
            const orgId = node.organization_id || node.org_id;
            for (const printer of Array.isArray(printers) ? printers : []) {
                const existing = db.printers.find((row) => (
                    row.node_id === node.node_id && row.local_printer_id === printer.local_printer_id
                ));
                const fields = {
                    org_id: orgId,
                    node_id: node.node_id,
                    local_printer_id: printer.local_printer_id,
                    name: printer.name,
                    model: printer.model,
                    status: printer.status,
                    status_snapshot: clone(printer.status_snapshot || {}),
                    capabilities: clone(printer.capabilities || {}),
                    last_seen_at: lastSeenAt,
                    updated_at: lastSeenAt,
                };
                if (existing) {
                    Object.assign(existing, fields);
                } else {
                    db.printers.push({ printer_id: randomUUID(), created_at: lastSeenAt, ...fields });
                }
            }
        },

        // -- overview ------------------------------------------------------------
        async getCloudOverview({ orgId = null, limit = 50 } = {}) {
            return clone({
                nodes: latest(byOrg(db.nodes, orgId), limit).map(({ token_hash, ...node }) => node),
                printers: latest(byOrg(db.printers, orgId), limit),
                jobs: latest(byOrg(db.printJobs, orgId), limit),
                commands: latest(byOrg(db.commands, orgId), limit),
                events: latest(byOrg(db.events, orgId), limit),
            });
        },

        // -- command intents -------------------------------------------------------
        async createNodeCommand(command) {
            const row = {
                command_id: randomUUID(),
                org_id: command.org_id,
                node_id: command.node_id,
                printer_id: command.printer_id || null,
                job_id: command.job_id || null,
                command_type: command.command_type,
                status: 'queued',
                payload: clone(command.payload || {}),
                result: null,
                error: null,
                claimed_at: null,
                finished_at: null,
                created_at: ts(),
                updated_at: ts(),
            };
            db.commands.push(row);
            return clone(row);
        },
        async getNodeCommandById(commandId) {
            return clone(db.commands.find((command) => command.command_id === commandId) || null);
        },
        async listNodeCommands({ nodeId, commandType = null, limit = 50 } = {}) {
            const rows = db.commands.filter((command) => (
                command.node_id === nodeId
                && (!commandType || command.command_type === commandType)
            ));
            return clone(latest(rows, limit));
        },
        async claimNodeCommands(nodeId, limit = 10) {
            const claimed = [];
            for (const command of db.commands) {
                if (claimed.length >= limit) break;
                if (command.node_id !== nodeId || command.status !== 'queued') continue;
                command.status = 'claimed';
                command.claimed_at = ts();
                command.updated_at = command.claimed_at;
                claimed.push(clone(command));
            }
            return claimed;
        },
        async recordCommandResult(nodeId, commandResult) {
            const command = db.commands.find((row) => (
                row.node_id === nodeId
                && row.command_id === commandResult.command_id
                && ['claimed', 'running'].includes(row.status)
            ));
            if (!command) return;
            command.status = commandResult.status;
            command.result = clone(commandResult.result);
            command.error = commandResult.error;
            command.finished_at = commandResult.finished_at;
            command.updated_at = ts();
        },
        async recordNodeEvents(node, events) {
            const orgId = node.organization_id || node.org_id;
            for (const event of events) {
                db.events.push({
                    event_id: randomUUID(),
                    org_id: orgId,
                    node_id: node.node_id,
                    printer_id: event.printer_id,
                    command_id: event.command_id,
                    event_type: event.event_type,
                    payload: clone(event.payload),
                    created_at: event.created_at,
                });
            }
        },

        // -- merchants ---------------------------------------------------------------
        async createMerchant(merchant) {
            const row = {
                merchant_id: randomUUID(),
                approved_at: null,
                rejected_at: null,
                created_at: ts(),
                updated_at: ts(),
                ...clone(merchant),
            };
            db.merchants.push(row);
            return clone(row);
        },
        async findMerchantById(merchantId) {
            return clone(db.merchants.find((row) => row.merchant_id === merchantId) || null);
        },
        async findMerchantByEmail(email) {
            return clone(db.merchants.find((row) => row.contact_email === email) || null);
        },
        async listMerchants({ status = null, limit = 50 } = {}) {
            const rows = status ? db.merchants.filter((row) => row.status === status) : db.merchants;
            return clone(latest(rows, limit));
        },
        async updateMerchantStatus(merchantId, { status, approvedAt = null, rejectedAt = null, metadata = null }) {
            const row = db.merchants.find((merchant) => merchant.merchant_id === merchantId);
            if (!row) return null;
            row.status = status;
            row.approved_at = approvedAt;
            row.rejected_at = rejectedAt;
            if (isPlainObject(metadata)) row.metadata = clone(metadata);
            row.updated_at = ts();
            return clone(row);
        },
        async updateMerchantMetadata(merchantId, metadata) {
            const row = db.merchants.find((merchant) => merchant.merchant_id === merchantId);
            if (!row) return null;
            row.metadata = isPlainObject(metadata) ? clone(metadata) : {};
            row.updated_at = ts();
            return clone(row);
        },

        // -- merchant API keys / setup tokens ---------------------------------------
        async createMerchantApiKey(apiKey) {
            const row = {
                key_id: randomUUID(),
                last_used_at: null,
                revoked_at: null,
                created_at: ts(),
                ...clone(apiKey),
            };
            db.merchantApiKeys.push(row);
            return clone(row);
        },
        async findMerchantApiKeyByHash(keyHash) {
            return clone(db.merchantApiKeys.find((row) => row.key_hash === keyHash && !row.revoked_at) || null);
        },
        async listMerchantApiKeys(merchantId) {
            return clone(db.merchantApiKeys.filter((row) => row.merchant_id === merchantId));
        },
        async touchMerchantApiKey(keyId, usedAt = ts()) {
            const row = db.merchantApiKeys.find((key) => key.key_id === keyId);
            if (row) row.last_used_at = usedAt;
        },
        async revokeMerchantApiKey({ merchantId, keyId, revokedAt = ts() }) {
            const row = db.merchantApiKeys.find((key) => key.merchant_id === merchantId && key.key_id === keyId);
            if (!row) return null;
            row.revoked_at = revokedAt;
            return clone(row);
        },
        async createMerchantSetupToken(setupToken) {
            const row = {
                setup_token_id: randomUUID(),
                used_at: null,
                created_at: ts(),
                ...clone(setupToken),
            };
            db.merchantSetupTokens.push(row);
            return clone(row);
        },
        async findMerchantSetupTokenByHash(tokenHash) {
            return clone(db.merchantSetupTokens.find((row) => row.token_hash === tokenHash) || null);
        },
        async markMerchantSetupTokenUsed(setupTokenId, usedAt = ts()) {
            const row = db.merchantSetupTokens.find((token) => (
                token.setup_token_id === setupTokenId && !token.used_at
            ));
            if (!row) return null;
            row.used_at = usedAt;
            return clone(row);
        },

        // -- merchant users (portal sign-in) -----------------------------------------
        async createMerchantUser(merchantUser) {
            const row = {
                merchant_user_id: randomUUID(),
                display_name: null,
                role: 'owner',
                status: 'active',
                password_hash: null,
                last_login_at: null,
                created_at: ts(),
                updated_at: ts(),
                ...clone(merchantUser),
                email: String(merchantUser.email || '').toLowerCase(),
            };
            db.merchantUsers.push(row);
            return clone(row);
        },
        async findMerchantUserByEmail(email) {
            const normalized = String(email || '').toLowerCase();
            return clone(db.merchantUsers.find((user) => user.email === normalized) || null);
        },
        async findMerchantUserById(merchantUserId) {
            return clone(db.merchantUsers.find((user) => user.merchant_user_id === merchantUserId) || null);
        },
        async listMerchantUsers(merchantId) {
            return clone(db.merchantUsers.filter((user) => user.merchant_id === merchantId));
        },
        async updateMerchantUserPassword(merchantUserId, passwordHash) {
            const row = db.merchantUsers.find((user) => user.merchant_user_id === merchantUserId);
            if (!row) return null;
            row.password_hash = passwordHash;
            row.updated_at = ts();
            return clone(row);
        },
        async updateMerchantUserLastLogin(merchantUserId, lastLoginAt = ts()) {
            const row = db.merchantUsers.find((user) => user.merchant_user_id === merchantUserId);
            if (!row) return null;
            row.last_login_at = lastLoginAt;
            row.updated_at = ts();
            return clone(row);
        },
        async createMerchantUserSession(session) {
            const row = {
                session_id: randomUUID(),
                last_used_at: null,
                revoked_at: null,
                created_at: ts(),
                ...clone(session),
            };
            db.merchantUserSessions.push(row);
            return clone(row);
        },
        async findMerchantUserSessionByHash(tokenHash) {
            return clone(db.merchantUserSessions.find((session) => session.token_hash === tokenHash) || null);
        },
        async touchMerchantUserSession(sessionId, usedAt = ts()) {
            const row = db.merchantUserSessions.find((session) => session.session_id === sessionId);
            if (row) row.last_used_at = usedAt;
        },
        async revokeMerchantUserSession(sessionId, revokedAt = ts()) {
            const row = db.merchantUserSessions.find((session) => session.session_id === sessionId);
            if (!row) return null;
            row.revoked_at = revokedAt;
            return clone(row);
        },
        async revokeMerchantUserSessions(merchantUserId, revokedAt = ts()) {
            for (const session of db.merchantUserSessions) {
                if (session.merchant_user_id === merchantUserId && !session.revoked_at) {
                    session.revoked_at = revokedAt;
                }
            }
        },
        async createMerchantUserPasswordResetToken(resetToken) {
            const row = {
                reset_token_id: randomUUID(),
                used_at: null,
                created_at: ts(),
                ...clone(resetToken),
            };
            db.merchantUserPasswordResets.push(row);
            return clone(row);
        },
        async findMerchantUserPasswordResetTokenByHash(tokenHash) {
            return clone(db.merchantUserPasswordResets.find((reset) => reset.token_hash === tokenHash) || null);
        },
        async markMerchantUserPasswordResetTokenUsed(resetTokenId, usedAt = ts()) {
            const row = db.merchantUserPasswordResets.find((reset) => reset.reset_token_id === resetTokenId);
            if (!row) return null;
            row.used_at = usedAt;
            return clone(row);
        },

        // -- files / jobs / routing -----------------------------------------------
        async uploadPrintArtifact(storagePath, buffer, contentType = 'application/octet-stream') {
            db.artifacts.set(storagePath, {
                buffer: Buffer.isBuffer(buffer) ? Buffer.from(buffer) : Buffer.from(buffer || ''),
                contentType,
            });
        },
        async createSignedPrintArtifactUrl(storagePath, _expiresIn = 3600) {
            const encoded = storagePath.split('/').map((part) => encodeURIComponent(part)).join('/');
            return `${publicBaseUrl}/artifacts/${encoded}`;
        },
        async createJobFile(file) {
            const row = {
                file_id: randomUUID(),
                created_at: ts(),
                ...clone(file),
            };
            db.jobFiles.push(row);
            return clone(row);
        },
        async createPrintJob(job) {
            const row = {
                job_id: randomUUID(),
                created_at: ts(),
                updated_at: ts(),
                ...clone(job),
            };
            db.printJobs.push(row);
            return clone(row);
        },
        async updatePrintJob(jobId, fields) {
            const row = db.printJobs.find((job) => job.job_id === jobId);
            if (!row) return null;
            Object.assign(row, clone(fields), { updated_at: ts() });
            return clone(row);
        },
        async getPrintJobById(jobId) {
            return clone(db.printJobs.find((job) => job.job_id === jobId) || null);
        },
        async getMerchantPrintJob({ merchantId, jobId }) {
            return clone(db.printJobs.find((job) => (
                job.merchant_id === merchantId && job.job_id === jobId
            )) || null);
        },
        async listMerchantPrintJobs({ merchantId, limit = 50 }) {
            return clone(latest(db.printJobs.filter((job) => job.merchant_id === merchantId), limit));
        },
        async findMerchantPrintJobByIdempotencyKey({ merchantId, idempotencyKey }) {
            return clone(db.printJobs.find((job) => (
                job.merchant_id === merchantId && job.options?.idempotency_key === idempotencyKey
            )) || null);
        },

        // -- merchant webhook endpoints + deliveries (v2) -------------------------
        async createMerchantWebhookEndpoint(endpoint) {
            const row = { created_at: ts(), updated_at: ts(), ...clone(endpoint) };
            db.merchantWebhookEndpoints.push(row);
            return clone(row);
        },
        async getMerchantWebhookEndpoint({ merchantId, webhookId }) {
            return clone(db.merchantWebhookEndpoints.find((e) => (
                e.merchant_id === merchantId && e.webhook_id === webhookId
            )) || null);
        },
        async listMerchantWebhookEndpoints({ merchantId, limit = 50 }) {
            return clone(latest(db.merchantWebhookEndpoints.filter((e) => e.merchant_id === merchantId), limit));
        },
        async updateMerchantWebhookEndpoint({ merchantId, webhookId, fields = {} }) {
            const row = db.merchantWebhookEndpoints.find((e) => (
                e.merchant_id === merchantId && e.webhook_id === webhookId
            ));
            if (!row) return null;
            Object.assign(row, clone(fields), { updated_at: ts() });
            return clone(row);
        },
        async deleteMerchantWebhookEndpoint({ merchantId, webhookId }) {
            const row = db.merchantWebhookEndpoints.find((e) => (
                e.merchant_id === merchantId && e.webhook_id === webhookId
            ));
            if (!row) return null;
            Object.assign(row, { status: 'disabled', updated_at: ts() });
            return clone(row);
        },
        async createMerchantWebhookDelivery(delivery) {
            const row = { created_at: ts(), updated_at: ts(), ...clone(delivery) };
            db.merchantWebhookDeliveries.push(row);
            return clone(row);
        },
        async getMerchantWebhookDelivery({ merchantId, deliveryId }) {
            return clone(db.merchantWebhookDeliveries.find((d) => (
                d.merchant_id === merchantId && d.delivery_id === deliveryId
            )) || null);
        },
        async listMerchantWebhookDeliveries({ merchantId, webhookId = null, limit = 50 }) {
            const rows = db.merchantWebhookDeliveries.filter((d) => (
                d.merchant_id === merchantId && (!webhookId || d.webhook_id === webhookId)
            ));
            return clone(latest(rows, limit));
        },
        async updateMerchantWebhookDelivery({ merchantId, deliveryId, fields = {} }) {
            const row = db.merchantWebhookDeliveries.find((d) => (
                d.merchant_id === merchantId && d.delivery_id === deliveryId
            ));
            if (!row) return null;
            Object.assign(row, clone(fields), { updated_at: ts() });
            return clone(row);
        },
        async createRoutingDecision(decision) {
            const row = {
                decision_id: randomUUID(),
                created_at: ts(),
                ...clone(decision),
            };
            db.routingDecisions.push(row);
            return clone(row);
        },
        async createMerchantUsageEvent(event) {
            const row = {
                usage_event_id: randomUUID(),
                created_at: ts(),
                ...clone(event),
            };
            db.usageEvents.push(row);
            return clone(row);
        },
        async listMerchantUsageEvents({ merchantId, limit = 50 } = {}) {
            return clone(latest(db.usageEvents.filter((event) => event.merchant_id === merchantId), limit));
        },
    };
}
