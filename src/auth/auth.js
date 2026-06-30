// src/auth/auth.js — Simple JWT authentication (sql.js API)
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { dbGet, dbRun } from '../db/database.js';
import { generateId } from '../utils/uuid.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Auth');

const JWT_EXPIRES = '24h';

/**
 * Ensure the default admin user exists (from env vars).
 */
export function ensureAdminUser() {
    const username = process.env.ADMIN_USERNAME || process.env.DEFAULT_ADMIN_USER || 'admin';
    const password = process.env.ADMIN_PASSWORD || process.env.DEFAULT_ADMIN_PASS || 'antigravity';

    const existing = dbGet('SELECT user_id FROM users WHERE username = ?', [username]);
    if (existing) return;

    const hash = bcrypt.hashSync(password, 10);
    dbRun('INSERT INTO users (user_id, username, password_hash, role) VALUES (?, ?, ?, ?)',
        [generateId(), username, hash, 'admin']);
    log.info(`Created default admin user: ${username}`);
}

/**
 * Authenticate with username/password, returns JWT token.
 */
export function login(username, password) {
    const user = dbGet('SELECT * FROM users WHERE username = ?', [username]);
    if (!user) return null;

    if (!bcrypt.compareSync(password, user.password_hash)) return null;

    const token = jwt.sign(
        { user_id: user.user_id, username: user.username, role: user.role },
        process.env.JWT_SECRET || 'fallback-secret',
        { expiresIn: JWT_EXPIRES }
    );

    return { token, user: { user_id: user.user_id, username: user.username, role: user.role } };
}

/**
 * Verify a JWT token, returns decoded payload or null.
 */
export function verifyToken(token) {
    try {
        return jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret');
    } catch {
        return null;
    }
}

/**
 * Express middleware: require valid JWT.
 */
export function requireAuth(req, res, next) {
    let token = null;

    // Try Authorization header first
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7);
    }

    // Fallback to query param (for file downloads)
    if (!token && req.query.token) {
        token = req.query.token;
    }

    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    const decoded = verifyToken(token);
    if (!decoded) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
    req.user = decoded;
    next();
}

/**
 * Express middleware: require admin role.
 */
export function requireAdmin(req, res, next) {
    requireAuth(req, res, () => {
        if (req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }
        next();
    });
}
