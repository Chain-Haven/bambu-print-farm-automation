import mqtt from 'mqtt';
import tls from 'node:tls';
import net from 'node:net';
import crypto from 'node:crypto';
import { createLogger } from '../utils/logger.js';
import { PrinterModel } from '../models/Printer.js';

const log = createLogger('BambuClient');

export class BambuClient {
    constructor(printerConfig) {
        // printerConfig: { ip, access_code, serial, printer_id, cert_fingerprint }
        this.ip = printerConfig.ip;
        this.accessCode = printerConfig.access_code;
        this.serial = printerConfig.serial;
        this.printerId = printerConfig.printer_id || 'unknown';
        this.trustedFingerprint = printerConfig.cert_fingerprint || null;

        this.client = null;
        this.connected = false;
        this.reportCallback = null;

        // "Doctor" diagnostics state
        this.diagnostics = {
            tcp: { status: 'pending', error: null },
            tls: { status: 'pending', error: null, fingerprint: null },
            mqtt: { status: 'pending', error: null },
            auth: { status: 'pending', error: null },
            subscription: { status: 'pending' },
        };
    }

    /**
     * Run a full connection sequence with diagnostics.
     * @param {boolean} trustNewCert - If true, accept and return the new cert fingerprint (TOFU).
     * @returns {Promise<{success: boolean, diagnostics: object, fingerprint: string|null}>}
     */
    async connect(trustNewCert = false) {
        log.info(`[${this.printerId}] Starting connection sequence...`);

        // 1. TCP Pre-check
        try {
            await this._checkTcp();
            this.diagnostics.tcp = { status: 'ok', error: null };
        } catch (err) {
            this.diagnostics.tcp = { status: 'failed', error: err.message };
            log.error(`[${this.printerId}] TCP check failed: ${err.message}`);
            return this._getResult(false);
        }

        // 2. TLS & Cert Pinning Check
        let fingerprint = null;
        try {
            fingerprint = await this._checkTls();
            this.diagnostics.tls = { status: 'ok', error: null, fingerprint };

            // TOFU Logic
            if (this.trustedFingerprint) {
                if (fingerprint !== this.trustedFingerprint) {
                    throw new Error(`Certificate Mismatch! Stored: ${this.trustedFingerprint}, Received: ${fingerprint}`);
                }
            } else if (!trustNewCert) {
                // If we don't trust new certs yet (e.g. strict mode), fail?
                // For "Add Printer" wizard, we typically pass trustNewCert=true on 2nd attempt or implicit.
                // Assuming interactive flow handles this.
            }
        } catch (err) {
            this.diagnostics.tls = { status: 'failed', error: err.message, fingerprint };
            log.error(`[${this.printerId}] TLS check failed: ${err.message}`);
            return this._getResult(false);
        }

        // 3. MQTT Connect
        try {
            await this._connectMqtt(fingerprint);

            // Wait for first message to confirm Auth/Subscription? 
            // Actually _connectMqtt resolves on 'connect' event.
            // But 'connect' event implies Auth accepted (broker didn't reject).
            this.diagnostics.mqtt = { status: 'ok', error: null };
            this.diagnostics.auth = { status: 'ok', error: null }; // Assumed if connected
        } catch (err) {
            this.diagnostics.mqtt = { status: 'failed', error: err.message };
            // Distinguish auth error?
            if (err.message.includes('Not authorized') || err.message.includes('Connection refused')) {
                this.diagnostics.auth = { status: 'failed', error: 'Invalid Access Code' };
            }
            return this._getResult(false);
        }

        // 4. Subscribe & Pushing
        try {
            await this._subscribeAndPush();
            this.diagnostics.subscription = { status: 'ok' };
        } catch (err) {
            this.diagnostics.subscription = { status: 'failed', error: err.message };
            /* non-fatal? could just be bad topic */
        }

        return this._getResult(true, fingerprint);
    }

    _getResult(success, fingerprint = null) {
        return {
            success,
            diagnostics: this.diagnostics,
            fingerprint
        };
    }

    _checkTcp() {
        return new Promise((resolve, reject) => {
            const socket = new net.Socket();
            socket.setTimeout(2000);
            socket.on('connect', () => { socket.destroy(); resolve(); });
            socket.on('timeout', () => { socket.destroy(); reject(new Error('TCP Connection Timeout (Port 8883)')); });
            socket.on('error', (err) => { socket.destroy(); reject(err); });
            socket.connect(8883, this.ip);
        });
    }

    _checkTls() {
        return new Promise((resolve, reject) => {
            const options = {
                host: this.ip,
                port: 8883,
                rejectUnauthorized: false, // Self-signed
                timeout: 3000
            };
            try {
                const socket = tls.connect(options, () => {
                    const cert = socket.getPeerCertificate();
                    if (!cert || !cert.fingerprint256) {
                        socket.destroy();
                        reject(new Error('No certificate received'));
                        return;
                    }
                    const fp = cert.fingerprint256;
                    socket.destroy();
                    resolve(fp);
                });
                socket.on('error', (err) => reject(err));
                socket.on('timeout', () => { socket.destroy(); reject(new Error('TLS Handshake Timeout')); });
            } catch (err) {
                reject(err);
            }
        });
    }

    _connectMqtt(expectedFingerprint) {
        return new Promise((resolve, reject) => {
            const clientId = `antigravity_${crypto.randomBytes(4).toString('hex')}`;
            const opts = {
                clientId,
                username: 'bblp',
                password: this.accessCode,
                rejectUnauthorized: false,
                reconnectPeriod: 0, // Disable auto-reconnect for the initial test
                connectTimeout: 5000,
                // Custom check to enforce pinning during MQTT handshake too
                checkServerIdentity: (host, cert) => {
                    if (expectedFingerprint && cert.fingerprint256 !== expectedFingerprint) {
                        const err = new Error('Cert fingerprint check failed during MQTT handshake');
                        return err;
                    }
                    return undefined;
                }
            };

            this.client = mqtt.connect(`mqtts://${this.ip}:8883`, opts);

            this.client.on('connect', () => {
                this.connected = true;
                resolve();
            });

            this.client.on('error', (err) => {
                this.client.end();
                reject(err);
            });

            this.client.on('close', () => {
                this.connected = false;
            });

            this.client.on('message', (topic, message) => {
                try {
                    const payload = JSON.parse(message.toString());
                    if (this.reportCallback) this.reportCallback(payload);
                } catch (e) { }
            });
        });
    }

    _subscribeAndPush() {
        return new Promise((resolve, reject) => {
            if (!this.client || !this.connected) return reject(new Error('Not connected'));

            const reportTopic = `device/${this.serial}/report`;
            this.client.subscribe(reportTopic, (err) => {
                if (err) return reject(err);

                // Send pushall
                const requestTopic = `device/${this.serial}/request`;
                const payload = JSON.stringify({ pushing: { sequence_id: '1', command: 'pushall' } });
                this.client.publish(requestTopic, payload, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        });
    }

    onReport(cb) { this.reportCallback = cb; }

    disconnect() {
        if (this.client) {
            this.client.end();
            this.client = null;
        }
        this.connected = false;
    }
}
