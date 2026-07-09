import 'dotenv/config';
import os from 'node:os';
import { createLocalNodeAgent } from './localNodeAgent.js';
import { createLocalNodeClient } from './localNodeClient.js';
import { createLocalResultOutbox } from './localResultOutbox.js';
import { collectNetworkInterfaces } from './localNetwork.js';
import { collectLocalPrinterRecords } from './localPrinterSnapshot.js';
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

// Whether this node can slice source models (STL/OBJ/STEP): true in
// MOCK_MODE (mock slicer) or when a slicer CLI backend is configured. Cached
// after the first check; a config change needs a node restart anyway.
let _slicerAvailable = null;
async function detectSlicerAvailable() {
    if (_slicerAvailable !== null) return _slicerAvailable;
    if (process.env.MOCK_MODE === 'true') {
        _slicerAvailable = true;
        return _slicerAvailable;
    }
    try {
        const { SliceService } = await import('../services/SliceService.js');
        _slicerAvailable = SliceService.getActiveBackend() !== null;
    } catch {
        _slicerAvailable = false;
    }
    return _slicerAvailable;
}

// Whether this node can compile OpenSCAD source to STL (cloud.model.generate,
// used by the agent MCP server's generate_model tool).
let _openscadAvailable = null;
async function detectOpenscadAvailable() {
    if (_openscadAvailable !== null) return _openscadAvailable;
    if (process.env.MOCK_MODE === 'true') {
        _openscadAvailable = true;
        return _openscadAvailable;
    }
    try {
        const { execFile } = await import('node:child_process');
        _openscadAvailable = await new Promise((resolve) => {
            execFile('openscad', ['--version'], { timeout: 5000 }, (error) => resolve(!error));
        });
    } catch {
        _openscadAvailable = false;
    }
    return _openscadAvailable;
}

async function sendHeartbeat(client, status = 'online', resultOutbox = null) {
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
            can_slice: await detectSlicerAvailable(),
            can_generate_models: await detectOpenscadAvailable(),
            network_interface_count: networkInterfaces.length,
            pending_result_count: resultOutbox?.size?.() || 0,
            printer_count: printers.length,
        },
        printers,
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
    // NOTE: node_events.printer_id is a cloud_printers UUID foreign key — the
    // local printer id goes in the payload, not the printer_id column.
    systemEvents.on('printer.alert', (alert) => {
        client.sendEvents([{
            event_type: alert?.kind === 'auto_canceled' ? 'printer.auto_canceled' : 'printer.alert',
            payload: alert,
        }]).catch((error) => log.warn(`Cloud alert forward failed: ${error.message}`));
    });

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
    systemEvents.on('job.started', forwardJobLifecycle('print_job.started'));
    systemEvents.on('job.completed', forwardJobLifecycle('print_job.completed'));
    systemEvents.on('job.failed', forwardJobLifecycle('print_job.failed'));

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

main().catch(async (error) => {
    log.error(`Cloud node failed to start: ${error.message}`);
    // When launched by double-click (farm-node.exe / Start Farm Node.bat), keep
    // the console window open so the error is actually readable.
    if (process.env.PKX_HOLD_CONSOLE === '1' && process.stdin.isTTY) {
        console.error(error.stack || '');
        process.stdout.write('\nPress Enter to close this window...');
        await new Promise((resolve) => {
            process.stdin.resume();
            process.stdin.once('data', resolve);
        });
    }
    process.exit(1);
});
