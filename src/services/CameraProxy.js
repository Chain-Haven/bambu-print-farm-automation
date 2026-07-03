/**
 * CameraProxy — Model-aware camera proxy for Bambu Lab printers.
 *
 * Camera transport is model-specific:
 *   - P1 / P1S / P1P / A1 / A1 Mini:  port 6000, proprietary TLS + JPEG streaming protocol
 *   - X1 / X1C / X1E / H2D:           port 322, RTSPS (RTSP over TLS)
 *
 * For P1-family printers, we connect via Node.js TLS directly to port 6000,
 * send a binary auth packet, and receive framed JPEG images — no ffmpeg needed.
 *
 * For X1-family printers, we connect via TLS to port 322, perform RTSP handshake,
 * and pipe interleaved RTP data to ffmpeg for JPEG extraction.
 */

import { spawn } from 'child_process';
import * as tls from 'tls';
import * as net from 'net';
// ffmpeg is only needed for X1 RTSP interleaved streams (A1/P1 use JPEG framing
// with no ffmpeg). Load it lazily so importing this module — and bundling the
// portable Windows node — never pulls in the platform-specific ffmpeg binary at
// startup. It is resolved on first X1 stream request instead.
let _ffmpegPath = null;
async function resolveFfmpegPath() {
    if (_ffmpegPath) return _ffmpegPath;

    // Prefer the npm-installed binary; the portable farm-node bundle keeps it
    // external, so fall back to a system ffmpeg (PATH / FFMPEG_PATH) before
    // giving up.
    try {
        const mod = await import('@ffmpeg-installer/ffmpeg');
        _ffmpegPath = mod.path || mod.default?.path || mod.default;
    } catch {
        _ffmpegPath = null;
    }

    if (!_ffmpegPath) {
        const envPath = process.env.FFMPEG_PATH;
        if (envPath) {
            _ffmpegPath = envPath;
        } else {
            const { execSync } = await import('node:child_process');
            try {
                const probe = process.platform === 'win32' ? 'where ffmpeg' : 'command -v ffmpeg';
                const found = execSync(probe, { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
                if (found) _ffmpegPath = found;
            } catch {
                /* not on PATH */
            }
        }
    }

    if (!_ffmpegPath) {
        throw new Error('ffmpeg not found — X1/X2/P2S/H2 cameras stream RTSPS and need ffmpeg. Install ffmpeg (or set FFMPEG_PATH) on the farm node.');
    }
    return _ffmpegPath;
}
import { createLogger } from '../utils/logger.js';
import { cameraFamilyFor } from '../models/PrinterModels.js';

const log = createLogger('CameraProxy');

// ─── Model → camera family mapping ──────────────────────────────────
// Resolved through the canonical model registry (src/models/PrinterModels.js)
// so newly-added models automatically pick the right transport.
function getCameraFamily(model) {
    return cameraFamilyFor(model);
}

function getCameraPort(family) {
    return family === 'x1' ? 322 : 6000;
}

// ─── TCP port probe ─────────────────────────────────────────────────
function probePort(ip, port, timeoutMs = 4000) {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        const timer = setTimeout(() => {
            sock.destroy();
            resolve(false);
        }, timeoutMs);

        sock.connect(port, ip, () => {
            clearTimeout(timer);
            sock.destroy();
            resolve(true);
        });
        sock.on('error', () => {
            clearTimeout(timer);
            sock.destroy();
            resolve(false);
        });
    });
}

// ─── Manager ────────────────────────────────────────────────────────
class CameraProxyManager {
    constructor() {
        /** @type {Map<string, Object>} */
        this.streams = new Map();
    }

    /**
     * Start (or reuse) a camera proxy for a given printer.
     * @param {string} printerId
     * @param {string} ip
     * @param {string} accessCode
     * @param {string} model - Printer model string, e.g. "Bambu P1S"
     */
    async start(printerId, ip, accessCode, model) {
        if (this.streams.has(printerId)) {
            const existing = this.streams.get(printerId);
            if (!existing.destroyed) return true;
            this.stop(printerId);
        }

        const family = getCameraFamily(model);
        const port = getCameraPort(family);

        log.info(`Camera for ${printerId}: model="${model}" family=${family} port=${port}`);

        // Probe port first
        const reachable = await probePort(ip, port);
        if (!reachable) {
            const state = this._createState(printerId, ip, accessCode, model, family);
            state.lastError = this._buildUnreachableError(family, port, ip, model);
            log.warn(`Camera port ${port} unreachable on ${ip} for ${printerId}`);

            // Retry up to 3 times with 5s delay
            this.streams.set(printerId, state);
            if (state.retries < 3) {
                state.retries++;
                setTimeout(() => {
                    this.streams.delete(printerId);
                    this.start(printerId, ip, accessCode, model);
                }, 5000);
            }
            return true; // state is set, caller can read lastError
        }

        // Port is open — start the appropriate transport
        if (family === 'p1') {
            return this._startP1Camera(printerId, ip, accessCode, model);
        } else {
            return this._startX1Camera(printerId, ip, accessCode, model);
        }
    }

    // ─── P1 / P1S / A1 family — port 6000 TLS + JPEG stream ────────
    async _startP1Camera(printerId, ip, accessCode, model) {
        const state = this._createState(printerId, ip, accessCode, model, 'p1');
        this.streams.set(printerId, state);

        log.info(`P1-family camera: connecting TLS to ${ip}:6000`);

        return new Promise((resolve) => {
            const socket = tls.connect({
                host: ip,
                port: 6000,
                rejectUnauthorized: false,
                timeout: 10000,
            }, () => {
                log.info(`P1 camera TLS connected to ${ip}:6000`);
                state.tlsSocket = socket;

                // Send auth packet
                const authPacket = this._buildP1AuthPacket(accessCode);
                socket.write(authPacket);
                log.info(`P1 camera auth sent (${authPacket.length} bytes)`);

                // Start receiving JPEG frames
                this._handleP1Stream(printerId, state, socket);
                resolve(true);
            });

            socket.on('error', (err) => {
                const msg = err.message || String(err);
                log.error(`P1 camera TLS error for ${printerId}: ${msg}`);
                if (msg.includes('ECONNREFUSED')) {
                    state.lastError = `Port 6000 refused connection on ${ip}. Check: (1) LAN Only Mode enabled, (2) Developer Mode enabled, (3) Printer on same network.`;
                } else if (msg.includes('ECONNRESET')) {
                    state.lastError = `Port 6000 connection reset — access code may be invalid.`;
                } else {
                    state.lastError = `P1 camera connection error: ${msg}`;
                }
                resolve(true);
            });

            socket.on('timeout', () => {
                state.lastError = `P1 camera connection timed out on ${ip}:6000. Check network.`;
                socket.destroy();
                resolve(true);
            });
        });
    }

    /**
     * Build the P1-family camera auth packet.
     *
     * Binary format (80 bytes):
     *   Bytes  0–3:   0x40 0x00 0x00 0x00  — auth command identifier
     *   Bytes  4–7:   0x00 0x30 0x00 0x00  — flags/subcommand
     *   Bytes  8–11:  0x00 0x00 0x00 0x00  — sequence_id
     *   Bytes 12–15:  0x00 0x00 0x00 0x00  — reserved
     *   Bytes 16–47:  username "bblp" + zero-pad to 32 bytes
     *   Bytes 48–79:  access_code + zero-pad to 32 bytes
     */
    _buildP1AuthPacket(accessCode) {
        const buf = Buffer.alloc(80, 0);
        // Auth command
        buf.writeUInt32LE(0x40, 0);
        buf.writeUInt32LE(0x3000, 4);
        // sequence + reserved = 0 (already zeroed)
        // Username: "bblp"
        Buffer.from('bblp', 'ascii').copy(buf, 16);
        // Access code
        Buffer.from(accessCode, 'ascii').copy(buf, 48);
        return buf;
    }

    /**
     * Handle the P1-family JPEG stream.
     *
     * The P1 camera sends framed JPEG images:
     *   Header (16 bytes):
     *     Bytes 0–3:  magic / frame type
     *     Bytes 4–7:  unknown
     *     Bytes 8–11: JPEG payload size (little-endian uint32)
     *     Bytes 12–15: unknown
     *   Then: raw JPEG data of the indicated size
     *
     * We also handle the case where the stream just sends raw JPEG data
     * (some firmware versions may differ).
     */
    _handleP1Stream(printerId, state, socket) {
        let buf = Buffer.alloc(0);
        let headerParsed = false;
        let expectedSize = 0;
        let frameCount = 0;
        let firstDataReceived = false;

        socket.on('data', (chunk) => {
            if (!firstDataReceived) {
                firstDataReceived = true;
                log.info(`P1 camera: first data received (${chunk.length} bytes), header hex: ${chunk.subarray(0, Math.min(32, chunk.length)).toString('hex')}`);
            }

            buf = Buffer.concat([buf, chunk]);

            // Try to find and extract JPEG frames
            while (buf.length > 0) {
                if (!headerParsed) {
                    // Need at least 16 bytes for the frame header
                    if (buf.length < 16) break;

                    // Check for direct JPEG data (some firmwares may skip headers)
                    if (buf[0] === 0xFF && buf[1] === 0xD8) {
                        // Raw JPEG — scan for end marker
                        const eoi = buf.indexOf(Buffer.from([0xFF, 0xD9]), 2);
                        if (eoi === -1) break; // wait for more data

                        const frame = Buffer.from(buf.subarray(0, eoi + 2));
                        this._deliverFrame(printerId, state, frame, ++frameCount);
                        buf = buf.subarray(eoi + 2);
                        continue;
                    }

                    // Parse frame header
                    expectedSize = buf.readUInt32LE(8);

                    // Sanity check: JPEG frames should be < 2MB
                    if (expectedSize <= 0 || expectedSize > 2 * 1024 * 1024) {
                        // Bad header — try to find next JPEG SOI marker
                        const soi = buf.indexOf(Buffer.from([0xFF, 0xD8]), 1);
                        if (soi > 0) {
                            log.debug(`P1 camera: skipping ${soi} bytes to next JPEG SOI`);
                            buf = buf.subarray(soi);
                        } else {
                            // Discard buffer if too large
                            if (buf.length > 1024 * 1024) {
                                log.warn(`P1 camera: discarding ${buf.length} bytes of unrecognized data`);
                                buf = Buffer.alloc(0);
                            }
                            break;
                        }
                        continue;
                    }

                    headerParsed = true;
                    buf = buf.subarray(16); // consume header
                }

                if (headerParsed) {
                    if (buf.length < expectedSize) break; // wait for full frame

                    const jpegData = buf.subarray(0, expectedSize);

                    // Verify it starts with JPEG SOI
                    if (jpegData[0] === 0xFF && jpegData[1] === 0xD8) {
                        const frame = Buffer.from(jpegData);
                        this._deliverFrame(printerId, state, frame, ++frameCount);
                    } else {
                        log.debug(`P1 camera: frame doesn't start with JPEG SOI, skipping`);
                    }

                    buf = buf.subarray(expectedSize);
                    headerParsed = false;
                    expectedSize = 0;
                }
            }

            // Prevent unbounded buffer growth
            if (buf.length > 5 * 1024 * 1024) {
                log.warn(`P1 camera buffer overflow for ${printerId}, resetting`);
                buf = Buffer.alloc(0);
                headerParsed = false;
            }
        });

        socket.on('close', () => {
            log.info(`P1 camera socket closed for ${printerId} (${frameCount} frames received)`);
            if (frameCount === 0 && !state.lastError) {
                state.lastError = 'P1 camera connection closed without sending frames. Check access code and LAN/Developer mode settings.';
            }
            state.destroyed = true;
            this._cleanupClients(state);
        });

        socket.on('error', (err) => {
            log.error(`P1 camera stream error for ${printerId}: ${err.message}`);
        });
    }

    // ─── X1 / X1C / H2D family — port 322 RTSPS ────────────────────
    async _startX1Camera(printerId, ip, accessCode, model) {
        const state = this._createState(printerId, ip, accessCode, model, 'x1');
        this.streams.set(printerId, state);

        log.info(`X1-family camera: connecting TLS to ${ip}:322`);

        return new Promise((resolve) => {
            const socket = tls.connect({
                host: ip,
                port: 322,
                rejectUnauthorized: false,
                timeout: 10000,
            }, () => {
                log.info(`X1 camera TLS connected to ${ip}:322`);
                state.tlsSocket = socket;

                // Perform RTSP handshake
                this._rtspHandshake(printerId, state, socket, ip, accessCode)
                    .then(() => resolve(true))
                    .catch((err) => {
                        state.lastError = `X1 RTSP handshake failed: ${err.message}`;
                        resolve(true);
                    });
            });

            socket.on('error', (err) => {
                state.lastError = `X1 camera TLS error: ${err.message}`;
                log.error(`X1 camera error for ${printerId}: ${err.message}`);
                resolve(true);
            });

            socket.on('timeout', () => {
                state.lastError = `X1 camera timed out on ${ip}:322.`;
                socket.destroy();
                resolve(true);
            });
        });
    }

    async _rtspHandshake(printerId, state, socket, ip, accessCode) {
        const baseUrl = `rtsps://${ip}:322/streaming/live/1`;
        const auth = Buffer.from(`bblp:${accessCode}`).toString('base64');
        let cseq = 1;

        // DESCRIBE
        socket.write([
            `DESCRIBE ${baseUrl} RTSP/1.0`,
            `CSeq: ${cseq++}`,
            `Authorization: Basic ${auth}`,
            `Accept: application/sdp`,
            `User-Agent: Antigravity/1.0`,
            ``, ``
        ].join('\r\n'));

        const descResp = await this._readRtspResponse(socket, 'DESCRIBE');

        // Extract track from SDP
        let trackUrl = `${baseUrl}/trackID=0`;
        const trackMatch = descResp.match(/a=control:(.+)/);
        if (trackMatch) {
            const t = trackMatch[1].trim();
            trackUrl = t.startsWith('rtsp') ? t : `${baseUrl}/${t}`;
        }

        // SETUP
        socket.write([
            `SETUP ${trackUrl} RTSP/1.0`,
            `CSeq: ${cseq++}`,
            `Authorization: Basic ${auth}`,
            `Transport: RTP/AVP/TCP;unicast;interleaved=0-1`,
            `User-Agent: Antigravity/1.0`,
            ``, ``
        ].join('\r\n'));

        const setupResp = await this._readRtspResponse(socket, 'SETUP');
        const sesMatch = setupResp.match(/Session:\s*([^\r\n;]+)/i);
        const sessionId = sesMatch ? sesMatch[1].trim() : '';

        // PLAY
        socket.write([
            `PLAY ${baseUrl} RTSP/1.0`,
            `CSeq: ${cseq++}`,
            `Authorization: Basic ${auth}`,
            `Session: ${sessionId}`,
            `Range: npt=0.000-`,
            `User-Agent: Antigravity/1.0`,
            ``, ``
        ].join('\r\n'));

        await this._readRtspResponse(socket, 'PLAY');
        log.info(`X1 RTSP PLAY started for ${printerId}`);

        // Pipe interleaved RTP to ffmpeg
        await this._startX1FfmpegBridge(printerId, state, socket);
    }

    _readRtspResponse(socket, label) {
        return new Promise((resolve, reject) => {
            let buf = '';
            const timeout = setTimeout(() => reject(new Error(`${label} timeout`)), 10000);
            const onData = (data) => {
                buf += data.toString();
                if (buf.includes('\r\n\r\n') && buf.includes('RTSP/1.0')) {
                    clearTimeout(timeout);
                    socket.removeListener('data', onData);
                    const status = buf.split('\r\n')[0];
                    if (status.includes('200')) resolve(buf);
                    else if (status.includes('401')) reject(new Error('Authentication failed (401)'));
                    else reject(new Error(status));
                }
            };
            socket.on('data', onData);
        });
    }

    async _startX1FfmpegBridge(printerId, state, socket) {
        const ffmpegPath = await resolveFfmpegPath();
        const proc = spawn(ffmpegPath, [
            '-hide_banner', '-loglevel', 'warning',
            '-f', 'h264', '-i', 'pipe:0',
            '-f', 'image2pipe', '-vcodec', 'mjpeg',
            '-q:v', '5', '-r', '2', '-',
        ], { stdio: ['pipe', 'pipe', 'pipe'] });

        state.ffmpegProc = proc;

        // Extract RTP payload from interleaved data
        socket.on('data', (data) => {
            let offset = 0;
            while (offset < data.length) {
                if (data[offset] === 0x24 && offset + 4 <= data.length) {
                    const channel = data[offset + 1];
                    const len = data.readUInt16BE(offset + 2);
                    if (offset + 4 + len <= data.length && channel === 0) {
                        const rtpPacket = data.subarray(offset + 4, offset + 4 + len);
                        if (rtpPacket.length > 12) {
                            try { if (proc.stdin.writable) proc.stdin.write(rtpPacket.subarray(12)); } catch {}
                        }
                    }
                    offset += 4 + len;
                } else {
                    offset++;
                }
            }
        });

        socket.on('close', () => {
            try { proc.stdin.end(); } catch {}
            state.destroyed = true;
        });

        // Parse JPEG from ffmpeg stdout
        proc.stdout.on('data', (chunk) => this._parseJpegFromPipe(printerId, state, chunk));
        proc.stderr.on('data', (d) => {
            const msg = d.toString().trim();
            if (msg) log.warn(`[X1 ffmpeg ${printerId}] ${msg}`);
        });
        proc.on('close', (code) => log.info(`X1 ffmpeg for ${printerId} exited code ${code}`));
    }

    // ─── Shared helpers ─────────────────────────────────────────────

    _createState(printerId, ip, accessCode, model, family) {
        return {
            printerId,
            ip,
            accessCode,
            model,
            family,
            tlsSocket: null,
            ffmpegProc: null,
            frame: null,
            clients: new Set(),
            lastError: null,
            retries: 0,
            destroyed: false,
        };
    }

    _deliverFrame(printerId, state, frame, count) {
        state.frame = frame;
        state.lastError = null;
        state.retries = 0;

        if (count <= 3 || count % 100 === 0) {
            log.info(`P1 camera frame #${count} for ${printerId}: ${frame.length} bytes`);
        }

        // Push to MJPEG streaming clients
        for (const res of state.clients) {
            try {
                res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
                res.write(frame);
                res.write('\r\n');
            } catch { /* client disconnected */ }
        }
    }

    _parseJpegFromPipe(printerId, state, chunk) {
        if (!state._jpegBuf) state._jpegBuf = Buffer.alloc(0);
        state._jpegBuf = Buffer.concat([state._jpegBuf, chunk]);

        let startIdx = 0;
        let count = 0;
        while (true) {
            const soi = state._jpegBuf.indexOf(Buffer.from([0xFF, 0xD8]), startIdx);
            if (soi === -1) break;
            const eoi = state._jpegBuf.indexOf(Buffer.from([0xFF, 0xD9]), soi + 2);
            if (eoi === -1) break;
            this._deliverFrame(printerId, state, Buffer.from(state._jpegBuf.subarray(soi, eoi + 2)), ++count);
            startIdx = eoi + 2;
        }
        if (startIdx > 0) state._jpegBuf = state._jpegBuf.subarray(startIdx);
        if (state._jpegBuf.length > 5 * 1024 * 1024) state._jpegBuf = Buffer.alloc(0);
    }

    _cleanupClients(state) {
        for (const res of state.clients) {
            try { res.end(); } catch {}
        }
        state.clients.clear();
    }

    _buildUnreachableError(family, port, ip, model) {
        if (family === 'p1') {
            return [
                `Camera port ${port} is unreachable on ${ip} (model: ${model}).`,
                `Diagnostic checklist:`,
                `1. Ensure the printer is in LAN Only Mode (Settings → Network)`,
                `2. Enable Developer Mode on the printer if available`,
                `3. Verify the access code is correct`,
                `4. Confirm the printer is on the same network as this server`,
                `5. Check firmware is up to date (01.06.00.00+)`,
            ].join('\n');
        }
        return [
            `Camera port ${port} is unreachable on ${ip} (model: ${model}).`,
            `For X1/H2D printers, ensure LAN Mode Liveview is enabled in printer settings.`,
        ].join('\n');
    }

    // ─── Public API (unchanged contract) ────────────────────────────

    getFrame(printerId)  { return this.streams.get(printerId)?.frame || null; }
    getError(printerId)  { return this.streams.get(printerId)?.lastError || null; }

    isRunning(printerId) {
        const s = this.streams.get(printerId);
        return s && !s.destroyed;
    }

    addStreamClient(printerId, res) {
        const state = this.streams.get(printerId);
        if (!state) return false;
        state.clients.add(res);
        res.on('close', () => state.clients.delete(res));
        // If we already have a frame, send it immediately
        if (state.frame) {
            try {
                res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${state.frame.length}\r\n\r\n`);
                res.write(state.frame);
                res.write('\r\n');
            } catch {}
        }
        return true;
    }

    stop(printerId) {
        const state = this.streams.get(printerId);
        if (state) {
            state.destroyed = true;
            try { state.tlsSocket?.destroy(); } catch {}
            try { state.ffmpegProc?.kill('SIGTERM'); } catch {}
            this._cleanupClients(state);
            this.streams.delete(printerId);
            log.info(`Camera proxy stopped for ${printerId}`);
        }
    }

    stopAll() {
        for (const [id] of this.streams) this.stop(id);
    }
}

const cameraProxy = new CameraProxyManager();
export default cameraProxy;
