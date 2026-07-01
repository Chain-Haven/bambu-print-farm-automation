import { createHash } from 'node:crypto';

const VALID_NODE_STATUSES = new Set(['online', 'degraded', 'offline']);
const VALID_COMMAND_RESULT_STATUSES = new Set(['running', 'succeeded', 'failed']);

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function getBearerToken(headers = {}) {
    const value = headers.authorization || headers.Authorization;
    if (typeof value !== 'string') return null;

    const match = value.match(/^Bearer\s+(.+)$/i);
    if (!match) return null;

    const token = match[1].trim();
    return token.length > 0 ? token : null;
}

export function hashNodeToken(token, pepper) {
    if (!token || typeof token !== 'string') {
        throw new Error('node token is required');
    }
    if (!pepper || typeof pepper !== 'string') {
        throw new Error('node token pepper is required');
    }

    return createHash('sha256').update(`${pepper}:${token}`, 'utf8').digest('hex');
}

// cloud_printers.status check constraint values; local worker states are
// mapped onto them (idle → online, error → degraded).
const VALID_PRINTER_STATUSES = new Set(['online', 'offline', 'printing', 'paused', 'degraded', 'unknown']);
const PRINTER_STATUS_MAP = {
    idle: 'online',
    ready: 'online',
    finish: 'online',
    error: 'degraded',
    disconnected: 'offline',
};
const MAX_HEARTBEAT_PRINTERS = 500;

export function normalizePrinterStatus(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (VALID_PRINTER_STATUSES.has(raw)) return raw;
    return PRINTER_STATUS_MAP[raw] || 'unknown';
}

export function normalizeHeartbeatPrinters(source) {
    const rows = Array.isArray(source) ? source : [];
    return rows.slice(0, MAX_HEARTBEAT_PRINTERS).flatMap((row) => {
        if (!isPlainObject(row)) return [];
        const localPrinterId = typeof row.local_printer_id === 'string' && row.local_printer_id.trim()
            ? row.local_printer_id.trim()
            : null;
        if (!localPrinterId) return [];

        return [{
            local_printer_id: localPrinterId,
            name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : localPrinterId,
            model: typeof row.model === 'string' && row.model.trim() ? row.model.trim() : 'unknown',
            status: normalizePrinterStatus(row.status),
            status_snapshot: isPlainObject(row.status_snapshot) ? row.status_snapshot : {},
            capabilities: isPlainObject(row.capabilities) ? row.capabilities : {},
        }];
    });
}

export function normalizeHeartbeat(body = {}, now = () => new Date()) {
    const source = isPlainObject(body) ? body : {};
    const status = VALID_NODE_STATUSES.has(source.status) ? source.status : 'online';

    return {
        status,
        agent_version: typeof source.agent_version === 'string' ? source.agent_version : null,
        host_info: isPlainObject(source.host_info) ? source.host_info : {},
        capabilities: isPlainObject(source.capabilities) ? source.capabilities : {},
        printers: normalizeHeartbeatPrinters(source.printers),
        last_seen_at: now().toISOString(),
    };
}

export function normalizeAgentEvents(body = {}, now = () => new Date()) {
    const source = isPlainObject(body) ? body : {};
    const rows = Array.isArray(source.events) ? source.events : [];
    const createdAt = now().toISOString();

    return rows.slice(0, 100).flatMap((row) => {
        if (!isPlainObject(row)) return [];
        if (typeof row.event_type !== 'string' || row.event_type.trim() === '') return [];

        return [{
            event_type: row.event_type.trim(),
            printer_id: typeof row.printer_id === 'string' && row.printer_id.trim() ? row.printer_id.trim() : null,
            command_id: typeof row.command_id === 'string' && row.command_id.trim() ? row.command_id.trim() : null,
            payload: isPlainObject(row.payload) ? row.payload : {},
            created_at: createdAt,
        }];
    });
}

export function normalizeCommandResult(body = {}, now = () => new Date()) {
    const source = isPlainObject(body) ? body : {};
    const commandId = typeof source.command_id === 'string' ? source.command_id.trim() : '';
    if (!commandId) throw new Error('command_id is required');

    const status = VALID_COMMAND_RESULT_STATUSES.has(source.status) ? source.status : null;
    if (!status) throw new Error('status must be running, succeeded, or failed');

    const failed = status === 'failed';
    const running = status === 'running';

    return {
        command_id: commandId,
        status,
        result: !failed && isPlainObject(source.result) ? source.result : null,
        error: failed ? (typeof source.error === 'string' && source.error.trim() ? source.error.trim() : 'Command failed') : null,
        finished_at: running ? null : now().toISOString(),
    };
}

export function parseJsonBody(body) {
    if (typeof body !== 'string') return isPlainObject(body) ? body : {};
    if (body.trim() === '') return {};

    try {
        const parsed = JSON.parse(body);
        return isPlainObject(parsed) ? parsed : {};
    } catch {
        return {};
    }
}
