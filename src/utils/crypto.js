// src/utils/crypto.js — AES-256-CBC encryption for sensitive fields (e.g. printer auth)
import crypto from 'node:crypto';

const ALGO = 'aes-256-cbc';
const IV_LEN = 16;

function getKey() {
    const envKey = process.env.ENCRYPTION_KEY;
    if (envKey && envKey.length >= 64) {
        return Buffer.from(envKey.slice(0, 64), 'hex');
    }
    // Derive a 32-byte key from JWT_SECRET or fallback
    const seed = envKey || process.env.JWT_SECRET || 'antigravity-dev-fallback-key';
    return crypto.createHash('sha256').update(seed).digest();
}

/**
 * Encrypt a JSON-serializable value. Returns "iv_hex:ciphertext_hex".
 */
export function encrypt(value) {
    const key = getKey();
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const plaintext = typeof value === 'string' ? value : JSON.stringify(value);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return `${iv.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt a value produced by encrypt(). Returns parsed JSON if possible, else string.
 */
export function decrypt(encoded) {
    const key = getKey();
    const [ivHex, cipherHex] = encoded.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    let decrypted = decipher.update(cipherHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    try { return JSON.parse(decrypted); } catch { return decrypted; }
}
