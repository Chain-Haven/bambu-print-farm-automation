import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function ensureDirectory(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readEntries(filePath) {
    if (!fs.existsSync(filePath)) return [];
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writeEntries(filePath, entries) {
    ensureDirectory(filePath);
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(entries, null, 2)}\n`);
    fs.renameSync(tempPath, filePath);
}

function requireString(value, name) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${name} is required`);
    }
    return value.trim();
}

export function createLocalResultOutbox({
    filePath = process.env.CLOUD_RESULT_OUTBOX_PATH || './data/cloud-result-outbox.json',
    maxEntries = Number.parseInt(process.env.CLOUD_RESULT_OUTBOX_MAX_ENTRIES || '1000', 10),
    now = () => new Date(),
    idFactory = randomUUID,
} = {}) {
    const normalizedPath = requireString(filePath, 'filePath');
    const entryLimit = Math.max(1, Number.isFinite(maxEntries) ? maxEntries : 1000);

    function load() {
        return readEntries(normalizedPath);
    }

    function save(entries) {
        writeEntries(normalizedPath, entries.slice(-entryLimit));
    }

    return {
        enqueueCommandResult(commandId, payload) {
            const entries = load();
            const entry = {
                id: idFactory(),
                type: 'command_result',
                command_id: requireString(commandId, 'commandId'),
                payload: payload && typeof payload === 'object' ? payload : {},
                attempts: 0,
                created_at: now().toISOString(),
                last_attempt_at: null,
                last_error: null,
            };
            entries.push(entry);
            save(entries);
            return entry;
        },

        list(limit = entryLimit) {
            const capped = Math.max(1, Math.min(Number.parseInt(limit, 10) || entryLimit, entryLimit));
            return load().slice(0, capped);
        },

        remove(id) {
            const target = requireString(id, 'id');
            save(load().filter((entry) => entry.id !== target));
        },

        markAttempt(id, error, attemptTime = now()) {
            const target = requireString(id, 'id');
            const entries = load().map((entry) => {
                if (entry.id !== target) return entry;
                return {
                    ...entry,
                    attempts: (Number.parseInt(entry.attempts, 10) || 0) + 1,
                    last_attempt_at: attemptTime.toISOString(),
                    last_error: error?.message || String(error || 'unknown error'),
                };
            });
            save(entries);
        },

        size() {
            return load().length;
        },

        filePath: normalizedPath,
    };
}
