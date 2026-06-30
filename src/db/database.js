// src/db/database.js — SQLite connection via sql.js (pure JS/WASM, no native bindings)
// Provides a synchronous-like API wrapper around sql.js
import initSqlJs from 'sql.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../utils/logger.js';

const log = createLogger('DB');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _db = null;
let _dbPath = null;
let _saveTimer = null;

/**
 * Initialize the database (async — must be called once at startup).
 */
export async function initDb() {
    if (_db) return _db;

    _dbPath = process.env.DB_PATH || './data/antigravity.db';
    const dir = path.dirname(_dbPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        log.info(`Created data directory: ${dir}`);
    }

    const SQL = await initSqlJs();

    // Load existing database file if present
    if (fs.existsSync(_dbPath)) {
        const buffer = fs.readFileSync(_dbPath);
        _db = new SQL.Database(buffer);
        log.info(`Database loaded from ${_dbPath}`);
    } else {
        _db = new SQL.Database();
        log.info(`New database created at ${_dbPath}`);
    }

    // Enable WAL mode and foreign keys
    _db.run('PRAGMA journal_mode = WAL');
    _db.run('PRAGMA foreign_keys = ON');

    // Auto-save periodically
    _saveTimer = setInterval(() => saveDb(), 10000);

    return _db;
}

/**
 * Get the database instance (must call initDb first).
 */
export function getDb() {
    if (!_db) throw new Error('Database not initialized. Call initDb() first.');
    return _db;
}

/**
 * Save database to disk.
 */
export function saveDb() {
    if (!_db || !_dbPath) return;
    try {
        const data = _db.export();
        fs.writeFileSync(_dbPath, Buffer.from(data));
    } catch (err) {
        log.error(`Failed to save database: ${err.message}`);
    }
}

/**
 * Helper: Execute a SQL statement that returns no results.
 */
export function dbExec(sql) {
    getDb().run(sql);
}

/**
 * Helper: Prepare and run a statement, returns { changes, lastInsertRowid }.
 */
export function dbRun(sql, params = []) {
    const db = getDb();
    const stmt = db.prepare(sql);
    if (params.length > 0) stmt.bind(params);
    stmt.step();
    stmt.free();
    // sql.js doesn't provide changes/lastInsertRowid via statement, use db method
    const changesResult = db.exec('SELECT changes() as c, last_insert_rowid() as r');
    const row = changesResult.length > 0 ? changesResult[0].values[0] : [0, 0];
    return { changes: row[0], lastInsertRowid: row[1] };
}

/**
 * Helper: Query all matching rows as an array of objects.
 */
export function dbAll(sql, params = []) {
    const db = getDb();
    const stmt = db.prepare(sql);
    if (params.length > 0) stmt.bind(params);
    const results = [];
    while (stmt.step()) {
        const row = stmt.getAsObject();
        results.push(row);
    }
    stmt.free();
    return results;
}

/**
 * Helper: Query a single row (first result) as an object, or null.
 */
export function dbGet(sql, params = []) {
    const db = getDb();
    const stmt = db.prepare(sql);
    if (params.length > 0) stmt.bind(params);
    let result = null;
    if (stmt.step()) {
        result = stmt.getAsObject();
    }
    stmt.free();
    return result;
}

/**
 * Run all pending migrations in order.
 */
export function runMigrations() {
    const db = getDb();

    // Create migrations tracking table
    db.run(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      filename  TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

    const migrationsDir = path.join(__dirname, 'migrations');
    if (!fs.existsSync(migrationsDir)) {
        log.warn('No migrations directory found');
        return;
    }

    const appliedRows = dbAll('SELECT filename FROM _migrations');
    const applied = new Set(appliedRows.map(r => r.filename));

    const files = fs.readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort();

    for (const file of files) {
        if (applied.has(file)) continue;
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
        log.info(`Running migration: ${file}`);
        db.run(sql);
        dbRun('INSERT INTO _migrations (filename) VALUES (?)', [file]);
        log.info(`Migration applied: ${file}`);
    }

    saveDb();
}

/**
 * Close the database connection.
 */
export function closeDb() {
    if (_saveTimer) {
        clearInterval(_saveTimer);
        _saveTimer = null;
    }
    if (_db) {
        saveDb();
        _db.close();
        _db = null;
        log.info('Database closed');
    }
}

export default { initDb, getDb, runMigrations, closeDb, dbExec, dbRun, dbAll, dbGet, saveDb };
