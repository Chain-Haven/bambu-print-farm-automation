#!/usr/bin/env node
// Apply one or more allowlisted Supabase SQL migrations using POSTGRES_URL.
// Usage:
//   POSTGRES_URL="postgres://..." node scripts/apply-supabase-migration.mjs merchant_user_auth
//   node scripts/apply-supabase-migration.mjs --all
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { ALLOWED_SUPABASE_MIGRATION_FILES } from '../src/cloud/adminMigrationHandlers.js';
import {
    normalizePostgresConnectionStringForPg,
    resolvePostgresConnectionString,
} from '../src/cloud/adminMigrationHandlers.js';

const { Client } = pg;

function migrationMeta(filename) {
    const match = filename.match(/^(\d{14})_(.+)\.sql$/);
    if (!match) throw new Error(`invalid migration filename: ${filename}`);
    return { filename, version: match[1], name: match[2] };
}

function loadMigration(filename) {
    if (!ALLOWED_SUPABASE_MIGRATION_FILES.includes(filename)) {
        throw new Error(`migration not allowlisted: ${filename}`);
    }
    const meta = migrationMeta(filename);
    const sql = fs.readFileSync(
        path.join(process.cwd(), 'supabase', 'migrations', filename),
        'utf8',
    );
    return { ...meta, sql };
}

async function ensureSchemaMigrationsTable(client) {
    await client.query(`
        create schema if not exists supabase_migrations;
        create table if not exists supabase_migrations.schema_migrations (
            version text primary key,
            name text,
            statements text[]
        );
    `);
}

async function listAppliedVersions(client) {
    const result = await client.query('select version from supabase_migrations.schema_migrations');
    return new Set((result.rows || []).map((row) => row.version));
}

async function applyMigration(client, migration) {
    await client.query('BEGIN');
    try {
        await client.query(migration.sql);
        await client.query(
            `insert into supabase_migrations.schema_migrations (version, name, statements)
             values ($1, $2, $3)
             on conflict (version) do nothing`,
            [migration.version, migration.name, [migration.sql]],
        );
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    }
}

function resolveRequestedFilenames(argv) {
    if (argv.includes('--all')) {
        return [...ALLOWED_SUPABASE_MIGRATION_FILES];
    }

    const names = argv.filter((arg) => !arg.startsWith('-'));
    if (names.length === 0) {
        throw new Error('Pass a migration name (e.g. merchant_user_auth) or --all');
    }

    return ALLOWED_SUPABASE_MIGRATION_FILES.filter((filename) => {
        const meta = migrationMeta(filename);
        return names.some((name) => filename === name || meta.name === name || meta.version === name);
    });
}

async function main() {
    const filenames = resolveRequestedFilenames(process.argv.slice(2));
    if (filenames.length === 0) {
        throw new Error('No matching allowlisted migrations found for the requested names');
    }

    const connectionString = normalizePostgresConnectionStringForPg(
        resolvePostgresConnectionString(process.env),
    );
    const client = new Client({ connectionString });
    await client.connect();

    try {
        await ensureSchemaMigrationsTable(client);
        const applied = await listAppliedVersions(client);

        for (const filename of filenames) {
            const migration = loadMigration(filename);
            if (applied.has(migration.version)) {
                console.log(`skip ${filename} (already applied)`);
                continue;
            }
            await applyMigration(client, migration);
            console.log(`applied ${filename}`);
        }
    } finally {
        await client.end().catch(() => {});
    }
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
