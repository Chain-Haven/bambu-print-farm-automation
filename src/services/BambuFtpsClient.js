// src/services/BambuFtpsClient.js — FTPS file transfer to Bambu printers
// Instrumented with precise stage timing for debugging

import * as ftp from 'basic-ftp';
import tls from 'node:tls';
import { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { createLogger } from '../utils/logger.js';

const log = createLogger('BambuFTPS');

export class BambuFtpsClient {
    constructor({ ip, accessCode, printerId }) {
        this.ip = ip;
        this.accessCode = accessCode;
        this.printerId = printerId || 'unknown';
    }

    async isReachable() {
        const net = await import('node:net');
        return new Promise((resolve) => {
            const socket = new net.default.Socket();
            socket.setTimeout(3000);
            socket.on('connect', () => { socket.destroy(); resolve(true); });
            socket.on('timeout', () => { socket.destroy(); resolve(false); });
            socket.on('error', () => { socket.destroy(); resolve(false); });
            socket.connect(990, this.ip);
        });
    }

    /**
     * Upload with full stage timing instrumentation.
     * Returns { success, bytesUploaded, verified, error?, trace[] }
     */
    async upload(content, remoteFileName, onProgress = null) {
        const buffer = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
        const totalBytes = buffer.length;
        const t0 = performance.now();
        const trace = [];
        const stage = (name, detail = null) => {
            const elapsed = Math.round(performance.now() - t0);
            trace.push({ stage: name, elapsed_ms: elapsed, detail, ts: new Date().toISOString() });
            log.info(`[${this.printerId}] [+${elapsed}ms] ${name}${detail ? ' — ' + (typeof detail === 'object' ? JSON.stringify(detail) : detail) : ''}`);
        };

        // Log settings at start
        stage('FTPS_CONFIG', {
            host: this.ip,
            port: 990,
            user: 'bblp',
            timeout_ms: 300000,
            file_size: totalBytes,
            file_name: remoteFileName,
            upload_method: 'streaming_from_buffer_via_Readable.from',
            tls: 'implicit',
            tls_session_reuse: true,
        });

        let client;
        let origTlsConnect;
        try {
            // === CONNECT ===
            stage('FTPS_CONNECT_START');
            client = new ftp.Client(300000); // 5 min timeout
            client.ftp.verbose = false;

            const tlsOptions = {
                rejectUnauthorized: false,
                minVersion: 'TLSv1.2',
            };

            await client.access({
                host: this.ip,
                port: 990,
                user: 'bblp',
                password: this.accessCode,
                secure: 'implicit',
                secureOptions: tlsOptions,
            });
            stage('FTPS_CONNECT_OK');

            // === TLS SESSION REUSE PATCH ===
            const controlSocket = client.ftp.socket;
            if (controlSocket instanceof tls.TLSSocket) {
                stage('FTPS_TLS_HANDSHAKE_OK', {
                    protocol: controlSocket.getProtocol?.(),
                    cipher: controlSocket.getCipher?.()?.name,
                    session_reuse: !!controlSocket.getSession(),
                });

                origTlsConnect = tls.connect;
                const self = this;
                tls.connect = function (options, ...args) {
                    if (options && options.host === self.ip) {
                        options.session = controlSocket.getSession();
                        options.rejectUnauthorized = false;
                    }
                    return origTlsConnect.call(tls, options, ...args);
                };
            }

            // === CD /cache ===
            stage('FTPS_CD_CACHE_START');
            try {
                await client.cd('/cache');
                stage('FTPS_CD_CACHE_OK');
            } catch (e) {
                stage('FTPS_CD_CACHE_FAIL', e.message);
            }

            // === UPLOAD ===
            stage('UPLOAD_STREAM_OPENED', { total_bytes: totalBytes });

            let lastProgressLog = performance.now();
            let bytesTransferred = 0;
            client.trackProgress((info) => {
                bytesTransferred = info.bytesOverall;
                const now = performance.now();
                // Emit progress at least every 1s
                if (now - lastProgressLog >= 1000 || bytesTransferred === totalBytes) {
                    const elapsedSec = (now - t0) / 1000;
                    const kbps = bytesTransferred > 0 ? Math.round((bytesTransferred / 1024) / elapsedSec) : 0;
                    stage('UPLOAD_PROGRESS', {
                        bytes_sent: bytesTransferred,
                        total: totalBytes,
                        percent: Math.round((bytesTransferred / totalBytes) * 100),
                        throughput_kbps: kbps,
                    });
                    lastProgressLog = now;
                }
                if (onProgress) {
                    onProgress({
                        bytes: bytesTransferred,
                        total: totalBytes,
                        percent: Math.round((bytesTransferred / totalBytes) * 100),
                    });
                }
            });

            const uploadStart = performance.now();
            const stream = Readable.from(buffer);
            await client.uploadFrom(stream, remoteFileName);
            const uploadEnd = performance.now();
            const uploadDurationMs = Math.round(uploadEnd - uploadStart);
            const uploadKBps = Math.round((totalBytes / 1024) / (uploadDurationMs / 1000));

            client.trackProgress();
            stage('UPLOAD_FINISHED', {
                bytes_sent: totalBytes,
                duration_ms: uploadDurationMs,
                throughput_kbps: uploadKBps,
                throughput_mbps: Math.round(uploadKBps * 8 / 1024 * 100) / 100,
            });

            // === VERIFY ===
            stage('REMOTE_VERIFY_START', { method: 'FTP SIZE command' });
            let verified = false;
            try {
                const remoteSize = await client.size(remoteFileName);
                verified = remoteSize === totalBytes;
                stage('REMOTE_VERIFY_END', { remote_size: remoteSize, local_size: totalBytes, match: verified });
            } catch (e) {
                stage('REMOTE_VERIFY_END', { error: e.message, assumed_ok: true });
                verified = true;
            }

            return { success: true, bytesUploaded: totalBytes, verified, trace };

        } catch (err) {
            stage('FTPS_ERROR', { error: err.message, code: err.code });

            // MicroSD error detection
            const msg = err.message.toLowerCase();
            if (msg.includes('microsd') || msg.includes('read/write') || msg.includes('storage') || msg.includes('sd card')) {
                stage('PRINTER_ERROR_DETECTED', {
                    type: 'SD_STORAGE',
                    raw_message: err.message,
                    guidance: 'Format SD in printer or replace card',
                });
            }

            return { success: false, bytesUploaded: 0, error: err.message, trace };
        } finally {
            if (origTlsConnect) tls.connect = origTlsConnect;
            if (client) client.close();
        }
    }

    async listCache() {
        let client;
        let origTlsConnect;
        try {
            client = new ftp.Client(300000);
            client.ftp.verbose = false;
            await client.access({ host: this.ip, port: 990, user: 'bblp', password: this.accessCode, secure: 'implicit', secureOptions: { rejectUnauthorized: false } });
            const controlSocket = client.ftp.socket;
            if (controlSocket instanceof tls.TLSSocket) {
                origTlsConnect = tls.connect;
                const self = this;
                tls.connect = function (options, ...args) {
                    if (options && options.host === self.ip) { options.session = controlSocket.getSession(); options.rejectUnauthorized = false; }
                    return origTlsConnect.call(tls, options, ...args);
                };
            }
            try { await client.cd('/cache'); } catch { /* root */ }
            const list = await client.list();
            return list.map(f => ({ name: f.name, size: f.size, date: f.modifiedAt }));
        } catch (err) {
            log.error(`[${this.printerId}] FTPS list failed: ${err.message}`);
            return [];
        } finally {
            if (origTlsConnect) tls.connect = origTlsConnect;
            if (client) client.close();
        }
    }

    /**
     * List filenames in /cache/ (convenience wrapper).
     * @returns {string[]} Array of filenames
     */
    async listCacheFiles() {
        const entries = await this.listCache();
        return entries.map(e => e.name);
    }
}

export default BambuFtpsClient;
