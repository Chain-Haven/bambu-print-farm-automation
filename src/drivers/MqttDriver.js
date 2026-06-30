// src/drivers/MqttDriver.js — MQTT driver for accessories
import { DriverInterface } from './DriverInterface.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('MqttDriver');

export class MqttDriver extends DriverInterface {
    constructor(accessory) {
        super(accessory);
        this.broker = accessory.endpoint?.broker || 'mqtt://localhost';
        this.topicPrefix = accessory.endpoint?.topic_prefix || `accessory/${accessory.accessory_id}`;
        this.client = null;
        this.latestState = {};
    }

    getCapabilities() {
        return { type: this.type, driver: 'mqtt', actions: [], state_fields: [], controls: [] };
    }

    getState() {
        return { ...this.latestState, health: this.health, last_seen: this.lastSeen, last_error: this.lastError };
    }

    async initialize() {
        try {
            const mqtt = await import('mqtt');
            this.client = mqtt.default.connect(this.broker);

            this.client.on('connect', () => {
                this._updateHealth('online');
                this.client.subscribe(`${this.topicPrefix}/state`);
                log.info(`MQTT connected to ${this.broker}`);
            });

            this.client.on('message', (topic, message) => {
                try {
                    this.latestState = JSON.parse(message.toString());
                    this._updateHealth('online');
                } catch (e) {
                    log.warn('Failed to parse MQTT message', e.message);
                }
            });

            this.client.on('error', (err) => {
                this._updateHealth('offline', err.message);
                log.error(`MQTT error: ${err.message}`);
            });

            this.client.on('close', () => {
                this._updateHealth('offline', 'Connection closed');
            });
        } catch (err) {
            this._updateHealth('offline', err.message);
            log.error(`MQTT init failed: ${err.message}`);
        }
    }

    async execute(action, params = {}) {
        if (!this.client || !this.client.connected) {
            return { success: false, error: 'MQTT client not connected' };
        }
        try {
            const topic = `${this.topicPrefix}/command`;
            const payload = JSON.stringify({ action, params });
            this.client.publish(topic, payload);
            this._updateHealth('online');
            return { success: true, data: { published: true } };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    async shutdown() {
        if (this.client) {
            this.client.end();
            this.client = null;
        }
    }
}

export default MqttDriver;
