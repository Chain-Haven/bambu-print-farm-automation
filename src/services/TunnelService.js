
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createLogger } from '../utils/logger.js';

const log = createLogger('TunnelService');

class TunnelService {
    constructor() {
        this.process = null;
        this.url = null;
        this.status = 'stopped'; // stopped, starting, running, error
        this.broadcast = null;
    }

    setWsBroadcast(broadcastFn) {
        this.broadcast = broadcastFn;
    }

    _emitStatus() {
        if (this.broadcast) {
            this.broadcast({
                type: 'tunnel.status_changed',
                data: this.getStatus()
            });
        }
    }

    getStatus() {
        return {
            status: this.status,
            url: this.url
        };
    }

    async start() {
        if (this.status === 'running' || this.status === 'starting') {
            return this.getStatus();
        }

        this.status = 'starting';
        this.url = null;
        this._emitStatus();

        try {
            // Path to cloudflared (assuming it's in user profile as per previous steps)
            // Ideally this should be configurable or bundled
            const executable = path.join(process.env.USERPROFILE, 'cloudflared.exe');

            log.info(`Starting tunnel with: ${executable}`);

            this.process = spawn(executable, ['tunnel', '--url', 'http://localhost:3000']);

            this.process.stdout.on('data', (data) => {
                // cloudflared outputs to stderr mostly, but we capture both
                this._parseOutput(data.toString());
            });

            this.process.stderr.on('data', (data) => {
                this._parseOutput(data.toString());
            });

            this.process.on('close', (code) => {
                log.info(`Tunnel process exited with code ${code}`);
                this.status = 'stopped';
                this.url = null;
                this.process = null;
                this._emitStatus();
            });

            this.process.on('error', (err) => {
                log.error('Failed to start tunnel process', err);
                this.status = 'error';
                this._emitStatus();
            });

        } catch (err) {
            log.error('Error starting tunnel', err);
            this.status = 'error';
            this._emitStatus();
        }

        return this.getStatus();
    }

    stop() {
        if (this.process) {
            log.info('Stopping tunnel...');
            this.process.kill(); // SIGTERM
            this.process = null;
        }
        this.status = 'stopped';
        this.url = null;
        this._emitStatus();
        return this.getStatus();
    }

    _parseOutput(output) {
        // Look for the URL in the output
        // Regex to find https://*.trycloudflare.com
        const regex = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;
        const match = output.match(regex);

        if (match && !this.url) {
            this.url = match[0];
            this.status = 'running';
            log.info(`Tunnel URL found: ${this.url}`);
            this._emitStatus();
        }
    }
}

// Singleton
const service = new TunnelService();
export default service;
