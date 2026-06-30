// src/api/middleware/errorHandler.js — Global error handler
import { createLogger } from '../../utils/logger.js';

const log = createLogger('API');

export function errorHandler(err, req, res, _next) {
    log.error(`${req.method} ${req.path}`, err.message);

    if (err.status) {
        return res.status(err.status).json({ error: err.message });
    }

    // SQLite constraint violations
    if (err.code === 'SQLITE_CONSTRAINT') {
        return res.status(409).json({ error: 'Conflict: ' + err.message });
    }

    res.status(500).json({ error: 'Internal server error' });
}

/**
 * Wrap an async route handler to catch errors.
 */
export function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}
