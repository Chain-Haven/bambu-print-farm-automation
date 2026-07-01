import 'dotenv/config';
import os from 'node:os';
import { createLocalNodeAgent } from './localNodeAgent.js';
import { createLocalNodeClient } from './localNodeClient.js';
import { createLocalResultOutbox } from './localResultOutbox.js';
import { collectNetworkInterfaces } from './localNetwork.js';
import systemEvents from '../utils/SystemEvents.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('CloudNode');

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

async function sendHeartbeat(client, status = 'online', resultOutbox = null) {
    const networkInterfaces = collectNetworkInterfaces();
    return client.sendHeartbeat({
        status,
        agent_version: process.env.npm_package_version || '0.1.0',
        host_info: {
            ...getHostInfo(),
            network_interfaces: networkInterfaces,
        },
        capabilities: {
            local_controller: true,
            command_polling: true,
            printer_lan_control: true,
            network_interface_count: networkInterfaces.length,
            pending_result_count: resultOutbox?.size?.() || 0,
        },
    });
}

function parseEnvInt(name, fallback) {
    const value = Number.parseInt(process.env[name] || '', 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function main() {
    const resultOutbox = createLocalResultOutbox();
    const client = createLocalNodeClient({
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

    await import('../../server.js');

    // Forward local printer failure alerts (auto-cancel / blocking-error detection)
    // to the cloud so operators and storefronts see them in the control plane.
    systemEvents.on('printer.alert', (alert) => {
        client.sendEvents([{
            event_type: alert?.kind === 'auto_canceled' ? 'printer.auto_canceled' : 'printer.alert',
            printer_id: alert?.printer_id,
            payload: alert,
        }]).catch((error) => log.warn(`Cloud alert forward failed: ${error.message}`));
    });

    // A failed first heartbeat must NOT kill the node: local printer control and
    // the dashboard have to keep running even when the cloud is briefly
    // unreachable (results spool to the outbox and flush on reconnect). The
    // interval below and the agent's own retry loop handle recovery.
    try {
        await sendHeartbeat(client, 'online', resultOutbox);
    } catch (error) {
        log.warn(`Initial cloud heartbeat failed (will keep retrying): ${error.message}`);
    }
    const heartbeatTimer = setInterval(() => {
        sendHeartbeat(client, 'online', resultOutbox).catch((error) => {
            log.warn(`Cloud heartbeat failed: ${error.message}`);
        });
    }, heartbeatIntervalMs);

    agent.start();
    log.info(`Cloud-connected local node started; polling every ${pollIntervalMs}ms; result outbox=${resultOutbox.filePath}`);

    const shutdown = async () => {
        clearInterval(heartbeatTimer);
        agent.stop();
        try {
            await sendHeartbeat(client, 'offline', resultOutbox);
        } catch (error) {
            log.warn(`Cloud offline heartbeat failed: ${error.message}`);
        }
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
}

main().catch((error) => {
    log.error(`Cloud node failed to start: ${error.message}`);
    process.exit(1);
});
