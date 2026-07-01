
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger } from '../utils/logger.js';

const log = createLogger('TunnelService');

// Resolve the cloudflared binary across Windows (NUC) and Linux/macOS (Raspberry
// Pi). CLOUDFLARED_PATH wins; otherwise probe the usual locations and finally
// fall back to the bare command so a PATH install works everywhere.
function resolveCloudflaredPath() {
    if (process.env.CLOUDFLARED_PATH) return process.env.CLOUDFLARED_PATH;

    const home = os.homedir() || process.env.USERPROFILE || process.env.HOME || '.';
    const candidates = process.platform === 'win32'
        ? [
            path.join(home, 'cloudflared.exe'),
            'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
        ]
        : [
            '/usr/local/bin/cloudflared',
            '/usr/bin/cloudflared',
            path.join(home, '.cloudflared', 'cloudflared'),
            path.join(home, 'cloudflared'),
        ];

    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) return candidate;
        } catch {
            // ignore and keep probing
        }
    }
    // Rely on PATH resolution (spawn will surface an error if it is missing).
    return 'cloudflared';
}

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
            // Resolve cloudflared across platforms (Windows NUC or Raspberry Pi / Linux).
            const executable = resolveCloudflaredPath();

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
