// src/drivers/UsbSerialDriver.js — USB Serial driver for accessories
import { DriverInterface } from './DriverInterface.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('UsbSerialDriver');

export class UsbSerialDriver extends DriverInterface {
    constructor(accessory) {
        super(accessory);
        this.tty = accessory.endpoint?.tty || accessory.endpoint;
        this.baudRate = accessory.endpoint?.baud_rate || 115200;
        this.deviceSerial = accessory.endpoint?.device_serial || null;
        this.port = null;
        this.parser = null;
        this.responseBuffer = '';
        this.responseResolve = null;
    }

    getCapabilities() {
        return { type: this.type, driver: 'usb_serial', actions: [], state_fields: [], controls: [] };
    }

    getState() {
        return {
            connected: this.port?.isOpen || false,
            health: this.health,
            last_seen: this.lastSeen,
            last_error: this.lastError,
        };
    }

    async initialize() {
        try {
            const { SerialPort } = await import('serialport');
            const { ReadlineParser } = await import('@serialport/parser-readline');

            this.port = new SerialPort({ path: this.tty, baudRate: this.baudRate, autoOpen: false });

            this.parser = this.port.pipe(new ReadlineParser({ delimiter: '\n' }));
            this.parser.on('data', (line) => {
                this._updateHealth('online');
                if (this.responseResolve) {
                    this.responseResolve(line.trim());
                    this.responseResolve = null;
                }
            });

            this.port.on('error', (err) => {
                this._updateHealth('offline', err.message);
                log.error(`Serial error: ${err.message}`);
            });

            await new Promise((resolve, reject) => {
                this.port.open((err) => err ? reject(err) : resolve());
            });

            this._updateHealth('online');
            log.info(`Serial connected: ${this.tty} @ ${this.baudRate}`);
        } catch (err) {
            this._updateHealth('offline', err.message);
            log.error(`Serial init failed: ${err.message}`);
        }
    }

    async execute(action, params = {}) {
        if (!this.port || !this.port.isOpen) {
            return { success: false, error: 'Serial port not connected' };
        }

        try {
            const command = JSON.stringify({ action, params }) + '\n';

            const responsePromise = new Promise((resolve, reject) => {
                this.responseResolve = resolve;
                setTimeout(() => {
                    this.responseResolve = null;
                    reject(new Error('Serial command timeout'));
                }, 5000);
            });

            this.port.write(command);
            const response = await responsePromise;
            this._updateHealth('online');

            try {
                return { success: true, data: JSON.parse(response) };
            } catch {
                return { success: true, data: { raw: response } };
            }
        } catch (err) {
            this._updateHealth('degraded', err.message);
            return { success: false, error: err.message };
        }
    }

    async shutdown() {
        if (this.port && this.port.isOpen) {
            await new Promise(resolve => this.port.close(resolve));
        }
    }

    /** List available serial ports (static utility). */
    static async listPorts() {
        try {
            const { SerialPort } = await import('serialport');
            return await SerialPort.list();
        } catch {
            return [];
        }
    }
}

export default UsbSerialDriver;
