// src/runtime/AccessoryWorker.js — Per-accessory worker with driver delegation
import { resolveDriver, shutdownDriver } from '../drivers/DriverManager.js';
import { AccessoryModel } from '../models/Accessory.js';
import { CommandBus } from '../services/CommandBus.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('AccessoryWorker');

export class AccessoryWorker {
    constructor(accessory) {
        this.accessoryId = accessory.accessory_id;
        this.accessory = accessory;
        this.driver = null;
        this.health = 'unknown';
    }

    async start() {
        this.driver = resolveDriver(this.accessory);
        if (this.driver) {
            await this.driver.initialize();
            this.health = this.driver.health;
            AccessoryModel.updateHealth(this.accessoryId, this.health);
            log.info(`Accessory worker started: ${this.accessory.type} [${this.accessoryId}]`);
        }
    }

    async stop() {
        await shutdownDriver(this.accessoryId);
        this.driver = null;
    }

    async executeCommand(cmd) {
        if (!this.driver) {
            CommandBus.markFailed(cmd.command_id, 'No driver available');
            return;
        }

        CommandBus.markSent(cmd.command_id);
        try {
            const result = await this.driver.execute(cmd.action, cmd.params);
            if (result.success) {
                CommandBus.markDone(cmd.command_id, result.data);
            } else {
                CommandBus.markFailed(cmd.command_id, result.error || 'Action failed');
            }
            // Update health
            this.health = this.driver.health;
            AccessoryModel.updateHealth(this.accessoryId, this.health, this.driver.lastError);
            return result;
        } catch (err) {
            CommandBus.markFailed(cmd.command_id, err.message);
            throw err;
        }
    }

    async healthCheck() {
        if (this.driver) {
            const result = await this.driver.healthCheck();
            this.health = result.health;
            AccessoryModel.updateHealth(this.accessoryId, this.health);
        }
    }

    getState() {
        return this.driver ? this.driver.getState() : { health: 'offline' };
    }

    getCapabilities() {
        return this.driver ? this.driver.getCapabilities() : {};
    }
}

export default AccessoryWorker;
