// src/drivers/HttpDriver.js — HTTP REST driver for accessories
import { DriverInterface } from './DriverInterface.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('HttpDriver');

export class HttpDriver extends DriverInterface {
    constructor(accessory) {
        super(accessory);
        this.baseUrl = typeof accessory.endpoint === 'object' ? accessory.endpoint.url : accessory.endpoint;
        this.timeout = accessory.endpoint?.timeout_ms || 5000;
    }

    getCapabilities() {
        return { type: this.type, driver: 'http', actions: [], state_fields: [], controls: [] };
    }

    getState() {
        return { health: this.health, last_seen: this.lastSeen, last_error: this.lastError };
    }

    async execute(action, params = {}) {
        try {
            const url = `${this.baseUrl}/execute`;
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), this.timeout);

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action, params }),
                signal: controller.signal,
            });
            clearTimeout(timer);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            this._updateHealth('online');
            return { success: true, data };
        } catch (err) {
            this._updateHealth('offline', err.message);
            log.error(`HTTP execute failed: ${err.message}`);
            return { success: false, error: err.message };
        }
    }

    async healthCheck() {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 3000);
            const response = await fetch(`${this.baseUrl}/health`, { signal: controller.signal });
            clearTimeout(timer);
            this._updateHealth(response.ok ? 'online' : 'degraded');
        } catch {
            this._updateHealth('offline', 'Health check failed');
        }
        return { health: this.health, lastSeen: this.lastSeen };
    }
}

export default HttpDriver;
