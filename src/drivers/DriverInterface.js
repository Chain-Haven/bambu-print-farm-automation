// src/drivers/DriverInterface.js — Abstract driver interface contract
//
// All accessory drivers MUST implement this interface.
// Core app never talks hardware directly; it uses drivers.

/**
 * @abstract
 * Base class for all accessory drivers (HTTP, MQTT, USB-Serial, Simulators).
 */
export class DriverInterface {
    constructor(accessory) {
        if (new.target === DriverInterface) {
            throw new Error('DriverInterface is abstract and cannot be instantiated directly');
        }
        this.accessoryId = accessory.accessory_id;
        this.type = accessory.type;
        this.endpoint = accessory.endpoint;
        this.calibration = accessory.calibration || {};
        this.lastSeen = null;
        this.health = 'unknown';
        this.lastError = null;
    }

    /**
     * Get driver capabilities for dynamic UI rendering.
     * @returns {object} Capabilities schema { actions: [...], state_fields: [...], controls: [...] }
     */
    getCapabilities() {
        throw new Error('getCapabilities() must be implemented');
    }

    /**
     * Get current state (health + state fields).
     * @returns {object} { state, health, position?, last_error?, last_seen?, ...extra }
     */
    getState() {
        throw new Error('getState() must be implemented');
    }

    /**
     * Execute a command action.
     * @param {string} action - Action name (e.g., 'door.open', 'eject.push')
     * @param {object} params - Action parameters
     * @returns {Promise<object>} Result { success, data?, error? }
     */
    async execute(action, params = {}) {
        throw new Error('execute() must be implemented');
    }

    /**
     * Initialize the driver (connect, probe, etc.).
     * @returns {Promise<void>}
     */
    async initialize() {
        // Default no-op; override if needed
    }

    /**
     * Shutdown the driver (disconnect, cleanup).
     * @returns {Promise<void>}
     */
    async shutdown() {
        // Default no-op; override if needed
    }

    /**
     * Health check / heartbeat.
     * @returns {Promise<{ health: string, lastSeen: string }>}
     */
    async healthCheck() {
        return { health: this.health, lastSeen: this.lastSeen };
    }

    /** Update health tracking. */
    _updateHealth(health, error = null) {
        this.health = health;
        this.lastSeen = new Date().toISOString();
        this.lastError = error;
    }
}

export default DriverInterface;
