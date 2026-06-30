// src/utils/logger.js — Structured logger
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const currentLevel = () => LOG_LEVELS[process.env.LOG_LEVEL || 'info'] ?? 2;

function formatMsg(level, context, msg, data) {
    const ts = new Date().toISOString();
    const ctx = context ? `[${context}]` : '';
    const base = `${ts} ${level.toUpperCase().padEnd(5)} ${ctx} ${msg}`;
    if (data !== undefined) {
        return `${base} ${typeof data === 'string' ? data : JSON.stringify(data)}`;
    }
    return base;
}

export function createLogger(context = '') {
    return {
        error(msg, data) { if (currentLevel() >= 0) console.error(formatMsg('error', context, msg, data)); },
        warn(msg, data) { if (currentLevel() >= 1) console.warn(formatMsg('warn', context, msg, data)); },
        info(msg, data) { if (currentLevel() >= 2) console.log(formatMsg('info', context, msg, data)); },
        debug(msg, data) { if (currentLevel() >= 3) console.log(formatMsg('debug', context, msg, data)); },
    };
}

export default createLogger;
