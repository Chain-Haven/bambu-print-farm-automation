// src/cloud/cloudAgentRuntime.js — the cloud node agent as a restartable,
// in-process runtime. Extracted from runLocalNode.js so BOTH entry points share
// it: `node server.js` auto-starts it when a cloud link is configured (DB
// settings or CLOUD_API_URL/LOCAL_NODE_TOKEN env), and the packaged
// farm-node bundle keeps working unchanged. Exactly one agent runs per process
// — startCloudAgent() stops any previous instance first, so a settings change
// from the UI is a clean restart, and the runLocalNode entry can never race
// the server's auto-start.
import os from 'node:os';
import { createLocalNodeAgent } from './localNodeAgent.js';
import { createLocalNodeClient } from './localNodeClient.js';
import { createLocalResultOutbox } from './localResultOutbox.js';
import { collectNetworkInterfaces } from './localNetwork.js';
import { collectLocalPrinterRecords } from './localPrinterSnapshot.js';
import systemEvents from '../utils/SystemEvents.js';
import { createLogger } from '../utils/logger.js';

export const CLOUD_LINK_SETTING_KEY = 'cloud_link';

const defaultLog = createLogger('CloudNode');

let activeAgent = null;

function parseEnvInt(name, fallback) {
    const value = Number.parseInt(process.env[name] || '', 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getHostInfo() {
    return {
        hostname: os.hostname(),
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        cpus: os.cpus().length,
        total_memory_mb: Math.round(os.totalmem() / 1024 / 1024),
        network_interfaces: collectNetworkInterfaces(),
    };
}

export function maskNodeToken(token) {
    if (typeof token !== 'string' || token.length < 14) return token ? '••••' : null;
    return `${token.slice(0, 9)}…${token.slice(-4)}`;
}

export function getCloudAgentStatus() {
    if (!activeAgent) return { running: false };
    return activeAgent.getStatus();
}

export function isCloudAgentRunning() {
    return Boolean(activeAgent);
}

export async function stopCloudAgent() {
    if (!activeAgent) return;
    const agent = activeAgent;
    activeAgent = null;
    await agent.stop();
}

// Starts (or restarts) the cloud agent loop against the given credentials.
// Assumes server.js's init() has already run — the command executor reaches
// into the live RuntimeSupervisor/JobOrchestrator singletons.
export async function startCloudAgent({
    cloudApiUrl,
    token,
    logger = defaultLog,
} = {}) {
    if (!cloudApiUrl || !token) {
        throw new Error('cloudApiUrl and token are required to start the cloud agent');
    }

    await stopCloudAgent();

    const log = logger;
    const resultOutbox = createLocalResultOutbox();
    const client = createLocalNodeClient({
        cloudApiUrl,
        token,
        requestTimeoutMs: parseEnvInt('CLOUD_REQUEST_TIMEOUT_MS', 15000),
        retry: {
            maxAttempts: parseEnvInt('CLOUD_RETRY_MAX_ATTEMPTS', 4),
            baseDelayMs: parseEnvInt('CLOUD_RETRY_BASE_DELAY_MS', 500),
            maxDelayMs: parseEnvInt('CLOUD_RETRY_MAX_DELAY_MS', 10000),
        },
    });
    const pollIntervalMs = parseEnvInt('CLOUD_COMMAND_POLL_INTERVAL_MS', 2000);
    const heartbeatIntervalMs = parseEnvInt('CLOUD_HEARTBEAT_INTERVAL_MS', 30000);
    const agent = createLocalNodeAgent({
        client,
        pollIntervalMs,
        maxPollIntervalMs: parseEnvInt('CLOUD_COMMAND_MAX_POLL_INTERVAL_MS', 30000),
        resultOutbox,
        outboxFlushLimit: parseEnvInt('CLOUD_RESULT_OUTBOX_FLUSH_LIMIT', 25),
        logger: log,
    });

    const status = {
        running: true,
        cloud_api_url: String(cloudApiUrl).replace(/\/+$/, ''),
        token_hint: maskNodeToken(token),
        started_at: new Date().toISOString(),
        last_heartbeat_at: null,
        last_heartbeat_ok: null,
        last_heartbeat_error: null,
        printer_count: 0,
        mock_mode: process.env.MOCK_MODE === 'true',
    };

    async function sendHeartbeat(state = 'online') {
        const networkInterfaces = collectNetworkInterfaces();

        // Mirror every local printer (state + merged AMS filament view) into the
        // cloud on each heartbeat. This is what populates cloud_printers — the
        // admin console's printer table and the merchant router both read it.
        let printers = [];
        try {
            printers = await collectLocalPrinterRecords({ sync_ams: true, sync_filament: true });
        } catch (error) {
            log.warn(`Printer snapshot for heartbeat failed: ${error.message}`);
        }

        const result = await client.sendHeartbeat({
            status: state,
            agent_version: process.env.npm_package_version || '0.1.0',
            host_info: getHostInfo(),
            capabilities: {
                local_controller: true,
                command_polling: true,
                printer_lan_control: true,
                network_interface_count: networkInterfaces.length,
                pending_result_count: resultOutbox?.size?.() || 0,
                printer_count: printers.length,
            },
            printers,
        });
        status.printer_count = printers.length;
        return result;
    }

    async function heartbeatTick(state = 'online') {
        status.last_heartbeat_at = new Date().toISOString();
        try {
            await sendHeartbeat(state);
            status.last_heartbeat_ok = true;
            status.last_heartbeat_error = null;
        } catch (error) {
            status.last_heartbeat_ok = false;
            status.last_heartbeat_error = error.message;
            throw error;
        }
    }

    // Forward local printer failure alerts (auto-cancel / blocking-error
    // detection) to the cloud so operators and storefronts see them in the
    // control plane. NOTE: node_events.printer_id is a cloud_printers UUID
    // foreign key — the local printer id goes in the payload, not the column.
    const onPrinterAlert = (alert) => {
        client.sendEvents([{
            event_type: alert?.kind === 'auto_canceled' ? 'printer.auto_canceled' : 'printer.alert',
            payload: alert,
        }]).catch((error) => log.warn(`Cloud alert forward failed: ${error.message}`));
    };
    systemEvents.on('printer.alert', onPrinterAlert);

    // Forward job lifecycle for cloud-originated (merchant) jobs so the control
    // plane can move print_jobs to printing/completed/failed, release filament
    // reservations, and fire merchant webhooks. Local-only jobs are skipped.
    const forwardJobLifecycle = (eventType) => ({ job, printer_id, reason } = {}) => {
        const cloudJobId = job?.metadata?.cloud_job_id;
        if (!cloudJobId) return;
        client.sendEvents([{
            event_type: eventType,
            command_id: job?.metadata?.cloud_command_id || null,
            payload: {
                print_job_id: cloudJobId,
                local_job_id: job.job_id,
                local_printer_id: printer_id || job.printer_id || null,
                reason: reason || null,
            },
        }]).catch((error) => log.warn(`Cloud job status forward failed (${eventType}): ${error.message}`));
    };
    const onJobStarted = forwardJobLifecycle('print_job.started');
    const onJobCompleted = forwardJobLifecycle('print_job.completed');
    const onJobFailed = forwardJobLifecycle('print_job.failed');
    systemEvents.on('job.started', onJobStarted);
    systemEvents.on('job.completed', onJobCompleted);
    systemEvents.on('job.failed', onJobFailed);

    // A failed first heartbeat must NOT kill the node: local printer control
    // and the dashboard keep running even when the cloud is briefly
    // unreachable (results spool to the outbox and flush on reconnect).
    try {
        await heartbeatTick('online');
    } catch (error) {
        log.warn(`Initial cloud heartbeat failed (will keep retrying): ${error.message}`);
    }
    const heartbeatTimer = setInterval(() => {
        heartbeatTick('online').catch((error) => {
            log.warn(`Cloud heartbeat failed: ${error.message}`);
        });
    }, heartbeatIntervalMs);

    agent.start();
    log.info(`Cloud link active → ${status.cloud_api_url}; polling every ${pollIntervalMs}ms; result outbox=${resultOutbox.filePath}`);

    const handle = {
        client,
        getStatus() {
            return { ...status, pending_result_count: resultOutbox?.size?.() || 0 };
        },
        async stop() {
            clearInterval(heartbeatTimer);
            agent.stop();
            systemEvents.off('printer.alert', onPrinterAlert);
            systemEvents.off('job.started', onJobStarted);
            systemEvents.off('job.completed', onJobCompleted);
            systemEvents.off('job.failed', onJobFailed);
            status.running = false;
            try {
                await sendHeartbeat('offline');
            } catch (error) {
                log.warn(`Cloud offline heartbeat failed: ${error.message}`);
            }
            if (activeAgent === handle) activeAgent = null;
        },
    };

    activeAgent = handle;
    return handle;
}

// Resolves the cloud-link config: DB settings first (set from the local UI),
// env vars as fallback (the packaged farm-node .env). Returns null when the
// link is unconfigured or explicitly disabled.
export async function resolveCloudLinkConfig() {
    let stored = null;
    try {
        const { SettingsModel } = await import('../models/Settings.js');
        stored = SettingsModel.get(CLOUD_LINK_SETTING_KEY, null);
    } catch {
        /* database not initialized yet — fall through to env */
    }

    if (stored && typeof stored === 'object') {
        if (stored.enabled === false) return null;
        const cloudApiUrl = stored.cloud_api_url || process.env.CLOUD_API_URL || null;
        const token = stored.local_node_token || process.env.LOCAL_NODE_TOKEN || null;
        return cloudApiUrl && token ? { cloudApiUrl, token, source: 'settings' } : null;
    }

    const cloudApiUrl = process.env.CLOUD_API_URL || null;
    const token = process.env.LOCAL_NODE_TOKEN || null;
    return cloudApiUrl && token ? { cloudApiUrl, token, source: 'env' } : null;
}

// Called from server.js init(): starts the agent when configured, never throws
// (a bad cloud config must not take down the local print server).
export async function autoStartCloudAgent({ logger = defaultLog } = {}) {
    try {
        if (isCloudAgentRunning()) return getCloudAgentStatus();
        const config = await resolveCloudLinkConfig();
        if (!config) return null;
        const handle = await startCloudAgent({
            cloudApiUrl: config.cloudApiUrl,
            token: config.token,
            logger,
        });
        return handle.getStatus();
    } catch (error) {
        logger.warn(`Cloud link not started: ${error.message}`);
        return null;
    }
}
