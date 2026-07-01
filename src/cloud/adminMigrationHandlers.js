import fs from 'node:fs';
import path from 'node:path';
import { AdminAuthError, authenticateCloudAdmin } from './adminAuth.js';
import { parseJsonBody } from './agentProtocol.js';

export const ALLOWED_SUPABASE_MIGRATION_FILES = Object.freeze([
    '20260701050000_merchant_api_v2_adapter_backbone.sql',
    '20260701153253_merchant_shipping_claims.sql',
]);

const DISALLOWED_SQL_BODY_KEYS = ['sql', 'query', 'statement', 'statements'];

class PublicMigrationError extends Error {
    constructor(statusCode, code, payload = {}) {
        super(code);
        this.name = 'PublicMigrationError';
        this.statusCode = statusCode;
        this.code = code;
        this.payload = payload;
    }
}

function sendJson(res, statusCode, payload) {
    if (typeof res.status === 'function' && typeof res.json === 'function') {
        return res.status(statusCode).json(payload);
    }

    res.statusCode = statusCode;
    if (typeof res.setHeader === 'function') {
        res.setHeader('Content-Type', 'application/json');
    }
    return res.end(JSON.stringify(payload));
}

function methodNotAllowed(res, methods) {
    if (typeof res.setHeader === 'function') {
        res.setHeader('Allow', methods);
    }
    return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasStringValue(env, key) {
    return typeof env[key] === 'string' && env[key].trim() !== '';
}

function migrationMeta(filename) {
    const match = filename.match(/^(\d{14})_(.+)\.sql$/);
    if (!match) throw new Error(`invalid migration filename: ${filename}`);
    return {
        filename,
        version: match[1],
        name: match[2],
    };
}

function loadAllowlistedMigrations({ rootDir = process.cwd(), files = ALLOWED_SUPABASE_MIGRATION_FILES } = {}) {
    return files.map((filename) => {
        const meta = migrationMeta(filename);
        const absolutePath = path.join(rootDir, 'supabase', 'migrations', filename);
        return {
            ...meta,
            sql: fs.readFileSync(absolutePath, 'utf8'),
        };
    });
}

function normalizeRequestedMigrations(body, allowlistedMigrations) {
    const source = isPlainObject(body) ? body : {};
    if (DISALLOWED_SQL_BODY_KEYS.some((key) => Object.prototype.hasOwnProperty.call(source, key))) {
        throw new PublicMigrationError(400, 'sql_not_allowed');
    }

    if (source.migrations === undefined) return allowlistedMigrations;
    if (!Array.isArray(source.migrations)) {
        throw new PublicMigrationError(400, 'invalid_migration_request');
    }

    const selected = new Set();
    for (const raw of source.migrations) {
        if (typeof raw !== 'string' || raw.trim() === '') {
            throw new PublicMigrationError(400, 'invalid_migration_request');
        }
        const requested = raw.trim();
        const migration = allowlistedMigrations.find(
            (candidate) => candidate.filename === requested || candidate.version === requested,
        );
        if (!migration) {
            throw new PublicMigrationError(400, 'migration_not_allowed', {
                allowed_migrations: ALLOWED_SUPABASE_MIGRATION_FILES,
            });
        }
        selected.add(migration.filename);
    }

    return allowlistedMigrations.filter((migration) => selected.has(migration.filename));
}

function publicMigrationResult(migration, status) {
    return {
        filename: migration.filename,
        version: migration.version,
        name: migration.name,
        status,
    };
}

export function resolvePostgresConnectionString(env = process.env) {
    for (const key of ['POSTGRES_URL_NON_POOLING', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL']) {
        if (hasStringValue(env, key)) return env[key].trim();
    }

    if (
        hasStringValue(env, 'POSTGRES_HOST')
        && hasStringValue(env, 'POSTGRES_USER')
        && hasStringValue(env, 'POSTGRES_PASSWORD')
        && hasStringValue(env, 'POSTGRES_DATABASE')
    ) {
        const user = encodeURIComponent(env.POSTGRES_USER.trim());
        const password = encodeURIComponent(env.POSTGRES_PASSWORD.trim());
        const host = env.POSTGRES_HOST.trim();
        const port = hasStringValue(env, 'POSTGRES_PORT') ? env.POSTGRES_PORT.trim() : '5432';
        const database = encodeURIComponent(env.POSTGRES_DATABASE.trim());
        return `postgres://${user}:${password}@${host}:${port}/${database}?sslmode=require`;
    }

    throw new PublicMigrationError(500, 'postgres_not_configured');
}

export function createDefaultPgClientFactory({ env = process.env } = {}) {
    return async function defaultPgClientFactory() {
        const connectionString = resolvePostgresConnectionString(env);
        const pg = await import('pg');
        return new pg.default.Client({ connectionString });
    };
}

async function ensureSchemaMigrationsTable(client) {
    await client.query('create schema if not exists supabase_migrations');
    await client.query(`
create table if not exists supabase_migrations.schema_migrations (
    version text primary key
)`);
    await client.query('alter table supabase_migrations.schema_migrations add column if not exists name text');
    await client.query('alter table supabase_migrations.schema_migrations add column if not exists statements text[]');
}

async function listAppliedMigrationVersions(client) {
    const result = await client.query('select version from supabase_migrations.schema_migrations');
    return new Set((result.rows || []).map((row) => row.version));
}

async function recordMigrationApplied(client, migration) {
    await client.query(
        `insert into supabase_migrations.schema_migrations (version, name, statements)
values ($1, $2, $3)
on conflict (version) do nothing`,
        [migration.version, migration.name, [migration.sql]],
    );
}

async function applyMigration(client, migration) {
    await client.query('BEGIN');
    try {
        await client.query(migration.sql);
        await recordMigrationApplied(client, migration);
        await client.query('COMMIT');
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch {
            // Keep the browser response safe and focused on the original failure.
        }
        throw new PublicMigrationError(500, 'migration_apply_failed', {
            migration: migration.filename,
            message: 'A bundled migration failed while applying.',
        });
    }
}

async function runMigrations({ client, migrations, dryRun = false }) {
    await client.connect();
    try {
        await ensureSchemaMigrationsTable(client);
        const appliedVersions = await listAppliedMigrationVersions(client);
        const results = [];

        for (const migration of migrations) {
            if (appliedVersions.has(migration.version)) {
                results.push(publicMigrationResult(migration, 'skipped'));
                continue;
            }
            if (dryRun) {
                results.push(publicMigrationResult(migration, 'pending'));
                continue;
            }

            await applyMigration(client, migration);
            appliedVersions.add(migration.version);
            results.push(publicMigrationResult(migration, 'applied'));
        }

        return results;
    } finally {
        await client.end();
    }
}

function handleAuthError(res, error) {
    if (error instanceof AdminAuthError) {
        sendJson(res, error.statusCode, { ok: false, error: error.code });
        return true;
    }
    return false;
}

function handlePublicMigrationError(res, error) {
    if (error instanceof PublicMigrationError) {
        sendJson(res, error.statusCode, {
            ok: false,
            error: error.code,
            ...error.payload,
        });
        return true;
    }
    return false;
}

export function createCloudAdminMigrationHandler({
    store,
    adminToken = process.env.CLOUD_ADMIN_TOKEN,
    pepper = process.env.ADMIN_SESSION_PEPPER || process.env.NODE_TOKEN_PEPPER,
    env = process.env,
    rootDir = process.cwd(),
    clientFactory = createDefaultPgClientFactory({ env }),
} = {}) {
    return async function cloudAdminMigrationHandler(req, res) {
        if (req.method && !['GET', 'POST'].includes(req.method)) {
            return methodNotAllowed(res, 'GET, POST');
        }

        try {
            await authenticateCloudAdmin(req, {
                store,
                bootstrapToken: adminToken,
                pepper,
            });

            const body = req.method === 'POST' ? parseJsonBody(req.body) : {};
            const allowlistedMigrations = loadAllowlistedMigrations({ rootDir });
            const migrations = normalizeRequestedMigrations(body, allowlistedMigrations);
            const dryRun = req.method === 'GET' || body.dry_run === true;
            const client = await clientFactory();
            const results = await runMigrations({ client, migrations, dryRun });

            return sendJson(res, 200, {
                ok: true,
                dry_run: dryRun,
                migrations: results,
            });
        } catch (error) {
            if (handleAuthError(res, error)) return null;
            if (handlePublicMigrationError(res, error)) return null;
            return sendJson(res, 500, {
                ok: false,
                error: 'migration_request_failed',
                message: 'Migration request failed.',
            });
        }
    };
}
