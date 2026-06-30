// src/drivers/DriverManager.js — Resolve accessory → driver instance
//
// Factory that creates the correct driver based on accessory type + connection_type.
// In MOCK_MODE, always returns simulator drivers.

import { HttpDriver } from './HttpDriver.js';
import { MqttDriver } from './MqttDriver.js';
import { UsbSerialDriver } from './UsbSerialDriver.js';
import { DoorServoSimulator } from './simulators/DoorServoSimulator.js';
import { EjectPusherSimulator } from './simulators/EjectPusherSimulator.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('DriverManager');

// Registry of active driver instances
const activeDrivers = new Map();

/**
 * Create or retrieve a driver instance for an accessory.
 * @param {object} accessory - Accessory record from DB
 * @returns {import('./DriverInterface.js').DriverInterface}
 */
export function resolveDriver(accessory) {
    const key = accessory.accessory_id;

    // Return cached driver if exists
    if (activeDrivers.has(key)) {
        return activeDrivers.get(key);
    }

    const mockMode = process.env.MOCK_MODE === 'true';
    let driver;

    if (mockMode) {
        driver = createSimulatorDriver(accessory);
    } else {
        driver = createRealDriver(accessory);
    }

    if (driver) {
        activeDrivers.set(key, driver);
        log.info(`Driver created for ${accessory.type} [${key}] (${mockMode ? 'simulator' : accessory.connection_type})`);
    }

    return driver;
}

/**
 * Create a simulator driver based on accessory type.
 */
function createSimulatorDriver(accessory) {
    switch (accessory.type) {
        case 'door_servo':
            return new DoorServoSimulator(accessory);
        case 'eject_printhead':
            return new EjectPusherSimulator(accessory);
        default:
            log.warn(`No simulator for accessory type: ${accessory.type}`);
            return createRealDriver(accessory); // fallback to real driver
    }
}

/**
 * Create a real hardware driver based on connection_type.
 */
function createRealDriver(accessory) {
    switch (accessory.connection_type) {
        case 'http':
            return new HttpDriver(accessory);
        case 'mqtt':
            return new MqttDriver(accessory);
        case 'usb_serial':
            return new UsbSerialDriver(accessory);
        default:
            log.error(`Unknown connection type: ${accessory.connection_type}`);
            return null;
    }
}

/**
 * Shutdown and remove a specific driver.
 */
export async function shutdownDriver(accessoryId) {
    const driver = activeDrivers.get(accessoryId);
    if (driver) {
        await driver.shutdown();
        activeDrivers.delete(accessoryId);
        log.info(`Driver shutdown: ${accessoryId}`);
    }
}

/**
 * Shutdown all active drivers.
 */
export async function shutdownAllDrivers() {
    for (const [id, driver] of activeDrivers) {
        await driver.shutdown();
        log.info(`Driver shutdown: ${id}`);
    }
    activeDrivers.clear();
}

/**
 * Get all active drivers.
 */
export function getActiveDrivers() {
    return new Map(activeDrivers);
}

export default { resolveDriver, shutdownDriver, shutdownAllDrivers, getActiveDrivers };
