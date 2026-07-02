import { randomUUID } from 'node:crypto';

// In-memory implementation of the cloud store contract used by the Vercel
// handlers (see supabaseRest.js for the production implementation). It backs:
//   - the local/self-hosted cloud control plane (localCloudServer.js)
//   - the offline end-to-end tests (tests/cloud/e2eFullLoop.test.js,
//     scripts/local-e2e-test.mjs)
// Only the surface the farm loop needs is implemented: organizations, nodes,
// heartbeats + printer mirroring, command intents, merchants + API keys +
// setup tokens, print jobs + files + routing decisions, platform settings,
// and print artifacts (stored in memory, served via signed-style URLs).

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
        merchants: [],
        merchantApiKeys: [],
        merchantSetupTokens: [],
        jobFiles: [],
        printJobs: [],
        routingDecisions: [],
        usageEvents: [],
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
