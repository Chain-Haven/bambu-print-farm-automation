// src/runtime/RuntimeSupervisor.js — Spawns and manages workers for all printers/accessories
import { PrinterModel } from '../models/Printer.js';
import { AccessoryModel } from '../models/Accessory.js';
import { EventModel } from '../models/Event.js';
import { PrinterWorker } from './PrinterWorker.js';
import { AccessoryWorker } from './AccessoryWorker.js';
import { CommandBus } from '../services/CommandBus.js';
import { getDiscoveryInstance } from '../services/BambuDiscovery.js';
import { createLogger } from '../utils/logger.js';

import systemEvents from '../utils/SystemEvents.js';

const log = createLogger('RuntimeSupervisor');

export class RuntimeSupervisor {
    static _instance = null;

    static getInstance() { return this._instance; }

    constructor() {
        this.printerWorkers = new Map();  // printer_id → PrinterWorker
        this.accessoryWorkers = new Map(); // accessory_id → AccessoryWorker
        this.discovery = getDiscoveryInstance();
        this.running = false;
        this.commandPollInterval = null;
        this.healthCheckInterval = null;
        this.wsBroadcast = null; // WebSocket broadcast function (set by server)
        RuntimeSupervisor._instance = this;
    }

    /**
     * Start the runtime: spawn workers for all registered printers/accessories.
     */
    async start() {
        log.info('Starting Runtime Supervisor');
        this.running = true;

        // Listen for dynamic changes
        systemEvents.on('printer.created', (printer) => this.spawnPrinterWorker(printer));
        systemEvents.on('printer.deleted', (id) => this.removePrinterWorker(id));
        systemEvents.on('accessory.created', (acc) => this.spawnAccessoryWorker(acc));
        systemEvents.on('accessory.deleted', (id) => this.removeAccessoryWorker(id));

        // Spawn printer workers
        const printers = PrinterModel.findAll();
        for (const printer of printers) {
            await this.spawnPrinterWorker(printer);
        }

        // Spawn accessory workers
        const accessories = AccessoryModel.findAll();
        for (const acc of accessories) {
            await this.spawnAccessoryWorker(acc);
        }

        // Start command poll loop
        const pollMs = parseInt(process.env.COMMAND_POLL_INTERVAL_MS) || 1000;
        this.commandPollInterval = setInterval(() => this._processCommands(), pollMs);

        // Start health check loop
        const healthMs = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS) || 30000;
        this.healthCheckInterval = setInterval(() => this._healthCheckAll(), healthMs);

        // Process timeouts periodically
        setInterval(() => CommandBus.processTimeouts(), 10000);

        // Bound event-log growth (self-healing storage): prune old events on start
        // and every 6h so a long-running 300-printer node doesn't accumulate rows
        // forever (which also slows the periodic full-DB export).
        const retentionDays = parseInt(process.env.EVENT_RETENTION_DAYS) || 30;
        this._pruneEvents(retentionDays);
        this.eventPruneInterval = setInterval(() => this._pruneEvents(retentionDays), 6 * 60 * 60 * 1000);

        // Start SSDP printer discovery
        this._syncDiscoverySerials();
        this.discovery.start();

        log.info(`Runtime started: ${printers.length} printers, ${accessories.length} accessories`);
    }

    /**
     * Stop all workers.
     */
    async stop() {
        this.running = false;
        if (this.commandPollInterval) clearInterval(this.commandPollInterval);
        if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
        if (this.eventPruneInterval) clearInterval(this.eventPruneInterval);
        this.discovery.stop();

        for (const [id, worker] of this.printerWorkers) {
            await worker.stop();
        }
        for (const [id, worker] of this.accessoryWorkers) {
            await worker.stop();
        }
        this.printerWorkers.clear();
        this.accessoryWorkers.clear();
        log.info('Runtime stopped');
    }

    async spawnPrinterWorker(printer) {
        if (this.printerWorkers.has(printer.printer_id)) return;
        const worker = new PrinterWorker(printer);
        worker.onStatusUpdate = (status) => this._broadcastStatus('printer', printer.printer_id, status);
        worker.onAlert = (alert) => {
            if (this.wsBroadcast) this.wsBroadcast({ type: 'printer.alert', id: printer.printer_id, data: alert });
            systemEvents.emit('printer.alert', alert); // for alerting integrations (email/webhook/etc.)
        };
        worker.onJobFinished = (finish) => this._handleJobFinished(finish);
        this.printerWorkers.set(printer.printer_id, worker);
        try {
            await worker.start();
            log.info(`Printer worker spawned: ${printer.name} [${printer.printer_id}]`);
        } catch (err) {
            // One printer failing to start must never abort the whole fleet's boot
            // (critical at 300 printers). The worker stays registered and the health
            // loop self-heals it via _attemptReconnect().
            log.warn(`Printer worker ${printer.name} failed initial start (${err.message}); will self-heal`);
        }
    }

    async spawnAccessoryWorker(accessory) {
        if (this.accessoryWorkers.has(accessory.accessory_id)) return;
        const worker = new AccessoryWorker(accessory);
        this.accessoryWorkers.set(accessory.accessory_id, worker);
        await worker.start();
        log.info(`Accessory worker spawned: ${accessory.type} [${accessory.accessory_id}]`);
    }

    async removePrinterWorker(printerId) {
        const worker = this.printerWorkers.get(printerId);
        if (worker) {
            await worker.stop();
            this.printerWorkers.delete(printerId);
        }
    }

    async removeAccessoryWorker(accessoryId) {
        const worker = this.accessoryWorkers.get(accessoryId);
        if (worker) {
            await worker.stop();
            this.accessoryWorkers.delete(accessoryId);
        }
    }

    /**
     * Process queued commands for all workers.
     */
    _processCommands() {
        // Printer commands
        for (const [printerId, worker] of this.printerWorkers) {
            const cmds = CommandBus.pullQueued('printer', printerId, 5);
            for (const cmd of cmds) {
                worker.executeCommand(cmd).catch(err => {
                    CommandBus.markFailed(cmd.command_id, err.message);
                });
            }
        }

        // Accessory commands
        for (const [accId, worker] of this.accessoryWorkers) {
            const cmds = CommandBus.pullQueued('accessory', accId, 5);
            for (const cmd of cmds) {
                worker.executeCommand(cmd).catch(err => {
                    CommandBus.markFailed(cmd.command_id, err.message);
                });
            }
        }
    }

    _pruneEvents(retentionDays) {
        try {
            const removed = EventModel.pruneOlderThan(retentionDays);
            if (removed > 0) log.info(`Pruned ${removed} events older than ${retentionDays}d`);
        } catch (err) {
            log.warn(`Event prune failed: ${err.message}`);
        }
    }

    /**
     * A worker resolved its active job (print ended). Hand the outcome to the
     * orchestrator: completed → ejection + repeat + auto-start-next; anything
     * else → mark the job failed so it doesn't sit "printing" forever.
     * Dynamic import avoids a static require cycle (JobOrchestrator imports
     * this module dynamically too).
     */
    async _handleJobFinished({ job_id, printer_id, outcome }) {
        try {
            const { JobOrchestrator } = await import('../services/JobOrchestrator.js');
            if (outcome === 'completed') {
                await JobOrchestrator.onJobCompleted(job_id, printer_id);
            } else {
                await JobOrchestrator.onJobAborted(job_id, printer_id, outcome);
            }
        } catch (err) {
            log.error(`Job finish handling failed for ${job_id} (${outcome}): ${err.message}`);
        }
    }

    _healthCheckAll() {
        for (const [, worker] of this.printerWorkers) {
            worker.healthCheck().catch(() => { });
        }
        for (const [, worker] of this.accessoryWorkers) {
            worker.healthCheck().catch(() => { });
        }
    }

    _broadcastStatus(type, id, status) {
        if (this.wsBroadcast) {
            this.wsBroadcast({ type: `${type}.status`, id, data: status });
        }
    }

    /** Set WebSocket broadcast function. */
    setWsBroadcast(fn) { this.wsBroadcast = fn; }

    /** Get a printer worker by ID. */
    getWorker(printerId) {
        return this.printerWorkers.get(printerId) || null;
    }

    /** Sync registered printer serials to discovery service. */
    _syncDiscoverySerials() {
        const printers = PrinterModel.findAll();
        const serials = printers.map(p => p.serial_number).filter(Boolean);
        this.discovery.setRegisteredSerials(serials);
    }

    /** Get running status for all workers. */
    getStatus() {
        return {
            running: this.running,
            printers: Array.from(this.printerWorkers.entries()).map(([id, w]) => ({
                printer_id: id, state: w.state, connected: w.connected,
            })),
            accessories: Array.from(this.accessoryWorkers.entries()).map(([id, w]) => ({
                accessory_id: id, health: w.health,
            })),
        };
    }
}

// Singleton
let _supervisor = null;
export function getSupervisor() {
    if (!_supervisor) _supervisor = new RuntimeSupervisor();
    return _supervisor;
}

export default { RuntimeSupervisor, getSupervisor };
