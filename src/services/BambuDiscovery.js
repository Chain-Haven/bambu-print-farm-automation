// src/services/BambuDiscovery.js — SSDP-based Bambu printer network discovery
// Listens for NOTIFY broadcasts on UDP port 2021 from Bambu printers
import dgram from 'node:dgram';
import { createLogger } from '../utils/logger.js';
import { collectNetworkInterfaces, findInterfaceForAddress } from '../cloud/localNetwork.js';

const log = createLogger('BambuDiscovery');

// Bambu model codes → friendly names
const MODEL_MAP = {
    'N2S':              'Bambu A1',
    'N1':               'Bambu A1 Mini',
    'C12':              'Bambu P1S',
    'C11':              'Bambu P1P',
    'C13':              'Bambu X1E',
    'BL-P001':          'Bambu X1C',
    '3DPrinter-X1-Carbon': 'Bambu X1C',
    'C14':              'Bambu P1S 2',
    'N2':               'Bambu A1 (early)',
};

// TTL for discovered printers (60 seconds — they re-broadcast every ~30s)
const DISCOVERY_TTL_MS = 60_000;
const LISTEN_PORT = 2021;

/**
 * Parse a Bambu SSDP NOTIFY packet into structured data.
 * Format is HTTP-like headers, e.g.:
 *   NOTIFY * HTTP/1.1
 *   Host: 239.255.255.250:1990
 *   Location: 192.168.1.50
 *   USN: 00M00A123456789
 *   DevName.bambu.com: My Printer
 *   DevModel.bambu.com: N2S
 *   ...
 */
function parseSsdpPacket(msg) {
    const text = msg.toString('utf-8');
    if (!text.includes('NOTIFY') && !text.includes('bambulab')) return null;

    const headers = {};
    for (const line of text.split('\r\n')) {
        const idx = line.indexOf(':');
        if (idx < 1) continue;
        const key = line.slice(0, idx).trim().toLowerCase();
        const value = line.slice(idx + 1).trim();
        headers[key] = value;
    }

    // Must have Bambu-specific fields
    if (!headers['devmodel.bambu.com'] && !headers['nt']?.includes('bambulab')) return null;

    const modelCode = headers['devmodel.bambu.com'] || 'unknown';
    return {
        serial: headers['usn'] || null,
        name: headers['devname.bambu.com'] || null,
        model_code: modelCode,
        model: MODEL_MAP[modelCode] || modelCode,
        ip: headers['location'] || null,
        connection_mode: headers['devconnect.bambu.com'] || 'unknown',  // "lan" or "cloud"
        signal: parseInt(headers['devsignal.bambu.com'] || '0', 10),
        bind_status: headers['devbind.bambu.com'] || 'unknown',         // "free" or "occupied"
        secure: headers['devseclink.bambu.com'] || null,
        firmware: headers['devversion.bambu.com'] || null,
    };
}

export class BambuDiscovery {
    constructor() {
        this._discovered = new Map();   // serial → { ...printerInfo, last_seen }
        this._socket = null;
        this._running = false;
        this._registeredSerials = new Set();  // serials already added to Antigravity
    }

    /**
     * Start listening for SSDP broadcasts.
     */
    start() {
        if (this._running) return;
        this._running = true;

        try {
            this._socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

            this._socket.on('message', (msg, rinfo) => {
                try {
                    const parsed = parseSsdpPacket(msg);
                    if (!parsed || !parsed.serial) return;

                    // Update/insert into discovered map
                    const existing = this._discovered.get(parsed.serial);
                    const networkInterfaces = collectNetworkInterfaces();
                    const observedAddress = parsed.ip || rinfo.address;
                    const networkInterface = findInterfaceForAddress(observedAddress, networkInterfaces);
                    this._discovered.set(parsed.serial, {
                        ...parsed,
                        last_seen: Date.now(),
                        first_seen: existing?.first_seen || Date.now(),
                        source_ip: rinfo.address,
                        network_interface: networkInterface?.name || null,
                    });

                    // Log new discoveries
                    if (!existing) {
                        log.info(`Discovered: ${parsed.name || 'unnamed'} (${parsed.model}) at ${parsed.ip} [${parsed.serial}] mode=${parsed.connection_mode}`);
                    }
                } catch (e) {
                    // Ignore parse errors from non-Bambu SSDP traffic
                }
            });

            this._socket.on('error', (err) => {
                log.warn(`SSDP socket error: ${err.message}`);
                // Don't crash — discovery is non-critical
            });

            this._socket.bind(LISTEN_PORT, () => {
                log.info(`SSDP discovery listening on UDP port ${LISTEN_PORT}`);
            });

            // Periodically purge stale entries
            this._purgeInterval = setInterval(() => this._purgeStale(), 30_000);
        } catch (e) {
            log.warn(`Failed to start SSDP discovery: ${e.message}`);
            this._running = false;
        }
    }

    /**
     * Stop listening.
     */
    stop() {
        this._running = false;
        if (this._socket) {
            try { this._socket.close(); } catch {}
            this._socket = null;
        }
        if (this._purgeInterval) {
            clearInterval(this._purgeInterval);
            this._purgeInterval = null;
        }
    }

    /**
     * Update the set of already-registered printer serials.
     * Called by RuntimeSupervisor so discover results can flag already_added.
     */
    setRegisteredSerials(serials) {
        this._registeredSerials = new Set(serials);
    }

    /**
     * Get all currently discovered printers.
     * @returns {Array} sorted by signal strength (strongest first)
     */
    getDiscovered() {
        this._purgeStale();
        const results = [];
        for (const [serial, info] of this._discovered) {
            results.push({
                serial: info.serial,
                name: info.name,
                model_code: info.model_code,
                model: info.model,
                ip: info.ip,
                connection_mode: info.connection_mode,
                signal: info.signal,
                signal_bars: this._signalToBars(info.signal),
                bind_status: info.bind_status,
                firmware: info.firmware,
                source_ip: info.source_ip,
                network_interface: info.network_interface,
                already_added: this._registeredSerials.has(serial),
                last_seen_ms: Date.now() - info.last_seen,
            });
        }
        // Sort: not-added first, then by signal strength (less negative = stronger)
        return results.sort((a, b) => {
            if (a.already_added !== b.already_added) return a.already_added ? 1 : -1;
            return b.signal - a.signal;
        });
    }

    /**
     * Convert dBm signal to 0-4 bars.
     */
    _signalToBars(dbm) {
        if (dbm >= -50) return 4;
        if (dbm >= -60) return 3;
        if (dbm >= -70) return 2;
        if (dbm >= -80) return 1;
        return 0;
    }

    /**
     * Remove entries not seen within TTL.
     */
    _purgeStale() {
        const now = Date.now();
        for (const [serial, info] of this._discovered) {
            if (now - info.last_seen > DISCOVERY_TTL_MS) {
                this._discovered.delete(serial);
                log.info(`Pruned stale printer: ${info.name || serial}`);
            }
        }
    }
}

// Singleton
let _instance = null;
export function getDiscoveryInstance() {
    if (!_instance) _instance = new BambuDiscovery();
    return _instance;
}

export default BambuDiscovery;
