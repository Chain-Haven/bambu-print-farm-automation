import 'dotenv/config';
import os from 'node:os';
import { createLocalNodeAgent } from './localNodeAgent.js';
import { createLocalNodeClient } from './localNodeClient.js';
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
    };
}

async function sendHeartbeat(client, status = 'online') {
    return client.sendHeartbeat({
        status,
        agent_version: process.env.npm_package_version || '0.1.0',
        host_info: getHostInfo(),
        capabilities: {
            local_controller: true,
            command_polling: true,
            printer_lan_control: true,
        },
    });
}

async function main() {
    const client = createLocalNodeClient();
    const pollIntervalMs = parseInt(process.env.CLOUD_COMMAND_POLL_INTERVAL_MS || '2000', 10);
    const heartbeatIntervalMs = parseInt(process.env.CLOUD_HEARTBEAT_INTERVAL_MS || '30000', 10);
    const agent = createLocalNodeAgent({ client, pollIntervalMs, logger: log });

    await import('../../server.js');
    await sendHeartbeat(client, 'online');
    const heartbeatTimer = setInterval(() => {
        sendHeartbeat(client, 'online').catch((error) => {
            log.warn(`Cloud heartbeat failed: ${error.message}`);
        });
    }, heartbeatIntervalMs);

    agent.start();
    log.info(`Cloud-connected local node started; polling every ${pollIntervalMs}ms`);

    const shutdown = async () => {
        clearInterval(heartbeatTimer);
        agent.stop();
        try {
            await sendHeartbeat(client, 'offline');
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
