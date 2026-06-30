// src/services/AccessoryRegistry.js — Accessory Registry + Driver Manager Service
import { AccessoryModel } from '../models/Accessory.js';
import { EventModel } from '../models/Event.js';
import { PrinterRegistry } from './PrinterRegistry.js';
import { resolveDriver, shutdownDriver } from '../drivers/DriverManager.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('AccessoryRegistry');

export class AccessoryRegistry {
    static create(data) {
        const accessory = AccessoryModel.create(data);
        // Refresh printer capabilities if linked
        if (accessory.printer_id) {
            PrinterRegistry.refreshCapabilities(accessory.printer_id);
        }
        EventModel.create({
            entity_type: 'accessory', entity_id: accessory.accessory_id,
            event_type: 'accessory.registered', payload: { type: data.type, printer_id: data.printer_id }
        });
        log.info(`Accessory registered: ${accessory.type} [${accessory.accessory_id}]`);
        return accessory;
    }

    static findAll() { return AccessoryModel.findAll(); }
    static findById(id) { return AccessoryModel.findById(id); }
    static findByPrinterId(printerId) { return AccessoryModel.findByPrinterId(printerId); }

    static update(id, fields) {
        const prev = AccessoryModel.findById(id);
        const accessory = AccessoryModel.update(id, fields);
        // If printer assignment changed, refresh both old and new printer capabilities
        if (prev && fields.printer_id !== undefined && prev.printer_id !== fields.printer_id) {
            if (prev.printer_id) PrinterRegistry.refreshCapabilities(prev.printer_id);
            if (fields.printer_id) PrinterRegistry.refreshCapabilities(fields.printer_id);
        }
        return accessory;
    }

    static async delete(id) {
        const accessory = AccessoryModel.findById(id);
        if (accessory) {
            await shutdownDriver(id);
            AccessoryModel.delete(id);
            if (accessory.printer_id) {
                PrinterRegistry.refreshCapabilities(accessory.printer_id);
            }
            log.info(`Accessory removed: ${accessory.type} [${id}]`);
        }
        return accessory;
    }

    /**
     * Get a live driver instance for the accessory.
     */
    static getDriver(accessoryId) {
        const accessory = AccessoryModel.findById(accessoryId);
        if (!accessory) return null;
        return resolveDriver(accessory);
    }

    /**
     * Test connection to an accessory via its driver.
     */
    static async testConnection(accessoryId) {
        const driver = this.getDriver(accessoryId);
        if (!driver) return { success: false, error: 'No driver available' };
        try {
            await driver.initialize();
            const health = await driver.healthCheck();
            AccessoryModel.updateHealth(accessoryId, health.health);
            return { success: true, data: health };
        } catch (err) {
            AccessoryModel.updateHealth(accessoryId, 'offline', err.message);
            return { success: false, error: err.message };
        }
    }

    /**
     * Execute a command on an accessory via its driver.
     */
    static async executeAction(accessoryId, action, params = {}) {
        const driver = this.getDriver(accessoryId);
        if (!driver) return { success: false, error: 'No driver available' };
        return driver.execute(action, params);
    }

    /**
     * Run health checks on all accessories.
     */
    static async healthCheckAll() {
        const accessories = AccessoryModel.findAll();
        const results = [];
        for (const acc of accessories) {
            const driver = resolveDriver(acc);
            if (driver) {
                const health = await driver.healthCheck();
                AccessoryModel.updateHealth(acc.accessory_id, health.health);
                results.push({ accessory_id: acc.accessory_id, ...health });
            }
        }
        return results;
    }
}

export default AccessoryRegistry;
