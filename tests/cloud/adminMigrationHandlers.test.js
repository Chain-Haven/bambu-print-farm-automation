import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
    ALLOWED_SUPABASE_MIGRATION_FILES,
    createCloudAdminMigrationHandler,
    normalizePostgresConnectionStringForPg,
    resolvePostgresConnectionString,
} from '../../src/cloud/adminMigrationHandlers.js';

function createMockResponse() {
    return {
        statusCode: 200,
        body: null,
        headers: {},
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        },
        setHeader(name, value) {
            this.headers[name] = value;
        },
        end(payload) {
            this.body = payload ? JSON.parse(payload) : null;
            return this;
        },
    };
}

function createMockPgClient({ appliedVersions = [], failOnConnect = false, failOnMigration = false } = {}) {
    const client = {
        connect: vi.fn(async () => {
            if (failOnConnect) {
                throw new Error(
                    'connect failed for postgres://deploy:secret@db.example.com:5432/postgres?password=secret',
                );
            }
        }),
        end: vi.fn().mockResolvedValue(undefined),
        query: vi.fn(async (sql, params) => {
            if (typeof sql === 'string' && sql.toLowerCase().includes('select version')) {
                return { rows: appliedVersions.map((version) => ({ version })) };
            }

            if (
                failOnMigration
                && typeof sql === 'string'
                && sql.includes('create table public.merchant_files')
            ) {
                const error = new Error(
                    'relation failed near postgres://deploy:secret@db.example.com:5432/postgres create table public.merchant_files',
                );
                error.stack = 'Error: relation failed\n    at internal.js:42';
                throw error;
            }

            return { rows: [], rowCount: params ? 1 : 0 };
        }),
    };
    return client;
}

function querySql(client) {
    return client.query.mock.calls.map(([sql]) => sql).join('\n\n');
}

describe('cloud admin migration handler auth gate', () => {
    it('rejects missing and invalid admin tokens before creating a database client', async () => {
        const clientFactory = vi.fn();
        const handler = createCloudAdminMigrationHandler({
            store: {},
            adminToken: 'admin-secret',
            clientFactory,
        });

        const missingRes = createMockResponse();
        await handler({ method: 'POST', headers: {}, body: {} }, missingRes);

        const invalidRes = createMockResponse();
        await handler({
            method: 'POST',
            headers: { authorization: 'Bearer wrong-secret' },
            body: {},
        }, invalidRes);

        expect(missingRes.statusCode).toBe(401);
        expect(missingRes.body).toEqual({ ok: false, error: 'missing_admin_token' });
        expect(invalidRes.statusCode).toBe(403);
        expect(invalidRes.body).toEqual({ ok: false, error: 'invalid_admin_token' });
        expect(clientFactory).not.toHaveBeenCalled();
    });
});

describe('cloud admin migration allowlist', () => {
    it('rejects malformed JSON and non-object POST bodies before touching Postgres', async () => {
        const clientFactory = vi.fn();
        const handler = createCloudAdminMigrationHandler({
            store: {},
            adminToken: 'admin-secret',
            clientFactory,
        });

        const malformedRes = createMockResponse();
        await handler({
            method: 'POST',
            headers: { authorization: 'Bearer admin-secret' },
            body: '{"migrations": [',
        }, malformedRes);

        const arrayRes = createMockResponse();
        await handler({
            method: 'POST',
            headers: { authorization: 'Bearer admin-secret' },
            body: '["20260701050000_merchant_api_v2_adapter_backbone.sql"]',
        }, arrayRes);

        expect(malformedRes.statusCode).toBe(400);
        expect(malformedRes.body).toEqual({ ok: false, error: 'invalid_json_body' });
        expect(arrayRes.statusCode).toBe(400);
        expect(arrayRes.body).toEqual({ ok: false, error: 'invalid_json_body' });
        expect(clientFactory).not.toHaveBeenCalled();
    });

    it('rejects arbitrary SQL and non-allowlisted migration names before touching Postgres', async () => {
        const clientFactory = vi.fn();
        const handler = createCloudAdminMigrationHandler({
            store: {},
            adminToken: 'admin-secret',
            clientFactory,
        });

        const sqlRes = createMockResponse();
        await handler({
            method: 'POST',
            headers: { authorization: 'Bearer admin-secret' },
            body: { sql: 'drop table public.merchants' },
        }, sqlRes);

        const unknownRes = createMockResponse();
        await handler({
            method: 'POST',
            headers: { authorization: 'Bearer admin-secret' },
            body: { migrations: ['20260701004316_merchant_api_v1.sql'] },
        }, unknownRes);

        expect(sqlRes.statusCode).toBe(400);
        expect(sqlRes.body).toEqual({ ok: false, error: 'sql_not_allowed' });
        expect(unknownRes.statusCode).toBe(400);
        expect(unknownRes.body).toEqual({
            ok: false,
            error: 'migration_not_allowed',
            allowed_migrations: ALLOWED_SUPABASE_MIGRATION_FILES,
        });
        expect(clientFactory).not.toHaveBeenCalled();
    });
});

describe('cloud admin migration database execution', () => {
    it('applies allowlisted committed migration files transactionally and records schema_migrations rows', async () => {
        const client = createMockPgClient();
        const handler = createCloudAdminMigrationHandler({
            store: {},
            adminToken: 'admin-secret',
            clientFactory: vi.fn().mockResolvedValue(client),
        });
        const res = createMockResponse();

        await handler({
            method: 'POST',
            headers: { authorization: 'Bearer admin-secret' },
            body: {
                migrations: ['20260701050000_merchant_api_v2_adapter_backbone.sql'],
            },
        }, res);

        expect(client.connect).toHaveBeenCalledOnce();
        expect(client.end).toHaveBeenCalledOnce();
        expect(querySql(client)).toContain('create schema if not exists supabase_migrations');
        expect(querySql(client)).toContain('create table if not exists supabase_migrations.schema_migrations');
        expect(querySql(client)).toContain('BEGIN');
        expect(querySql(client)).toContain('create table public.merchant_files');
        expect(querySql(client)).toContain('insert into supabase_migrations.schema_migrations');
        expect(querySql(client)).toContain('COMMIT');
        expect(client.query).toHaveBeenCalledWith(
            expect.stringContaining('insert into supabase_migrations.schema_migrations'),
            [
                '20260701050000',
                'merchant_api_v2_adapter_backbone',
                [expect.stringContaining('create table public.merchant_files')],
            ],
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            ok: true,
            dry_run: false,
            migrations: [{
                filename: '20260701050000_merchant_api_v2_adapter_backbone.sql',
                version: '20260701050000',
                name: 'merchant_api_v2_adapter_backbone',
                status: 'applied',
            }],
        });
        expect(JSON.stringify(res.body)).not.toContain('create table public.merchant_files');
    });

    it('skips already-recorded migrations and applies only pending allowlisted files', async () => {
        const client = createMockPgClient({ appliedVersions: ['20260701050000'] });
        const handler = createCloudAdminMigrationHandler({
            store: {},
            adminToken: 'admin-secret',
            clientFactory: vi.fn().mockResolvedValue(client),
        });
        const res = createMockResponse();

        await handler({
            method: 'POST',
            headers: { authorization: 'Bearer admin-secret' },
            body: {},
        }, res);

        expect(querySql(client)).not.toContain('create table public.merchant_files');
        expect(querySql(client)).toContain('alter table public.merchant_shipments');
        expect(res.statusCode).toBe(200);
        expect(res.body.migrations).toEqual([
            {
                filename: '20260701050000_merchant_api_v2_adapter_backbone.sql',
                version: '20260701050000',
                name: 'merchant_api_v2_adapter_backbone',
                status: 'skipped',
            },
            {
                filename: '20260701153253_merchant_shipping_claims.sql',
                version: '20260701153253',
                name: 'merchant_shipping_claims',
                status: 'applied',
            },
        ]);
    });

    it('returns a redacted failure when a bundled migration fails', async () => {
        const client = createMockPgClient({ failOnMigration: true });
        const handler = createCloudAdminMigrationHandler({
            store: {},
            adminToken: 'admin-secret',
            clientFactory: vi.fn().mockResolvedValue(client),
            env: {
                POSTGRES_URL_NON_POOLING: 'postgres://deploy:secret@db.example.com:5432/postgres',
            },
        });
        const res = createMockResponse();

        await handler({
            method: 'POST',
            headers: { authorization: 'Bearer admin-secret' },
            body: {
                migrations: ['20260701050000_merchant_api_v2_adapter_backbone.sql'],
            },
        }, res);

        const responseText = JSON.stringify(res.body);
        expect(querySql(client)).toContain('ROLLBACK');
        expect(res.statusCode).toBe(500);
        expect(res.body).toEqual({
            ok: false,
            error: 'migration_apply_failed',
            migration: '20260701050000_merchant_api_v2_adapter_backbone.sql',
            message: 'A bundled migration failed while applying.',
        });
        expect(responseText).not.toContain('postgres://deploy:secret@db.example.com');
        expect(responseText).not.toContain('create table public.merchant_files');
        expect(responseText).not.toContain('internal.js');
        expect(responseText).not.toContain('stack');
    });

    it('returns a redacted database connection failure without running SQL', async () => {
        const client = createMockPgClient({ failOnConnect: true });
        const handler = createCloudAdminMigrationHandler({
            store: {},
            adminToken: 'admin-secret',
            clientFactory: vi.fn().mockResolvedValue(client),
        });
        const res = createMockResponse();

        await handler({
            method: 'GET',
            headers: { authorization: 'Bearer admin-secret' },
        }, res);

        const responseText = JSON.stringify(res.body);
        expect(client.connect).toHaveBeenCalledOnce();
        expect(client.query).not.toHaveBeenCalled();
        expect(client.end).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(500);
        expect(res.body).toMatchObject({
            ok: false,
            error: 'migration_database_unavailable',
            message: 'Migration database connection failed.',
        });
        expect(res.body.detail).toContain('connect failed for postgres://[redacted]');
        expect(responseText).not.toContain('deploy:secret');
        expect(responseText).not.toContain('password=secret');
    });
});

describe('cloud admin migration connection config', () => {
    it('uses production Postgres URLs by priority and can construct one from split env vars', () => {
        expect(resolvePostgresConnectionString({
            POSTGRES_URL_NON_POOLING: 'postgres://nonpooling.example/db',
            POSTGRES_URL: 'postgres://pool.example/db',
            POSTGRES_PRISMA_URL: 'postgres://prisma.example/db',
        })).toBe('postgres://nonpooling.example/db');

        expect(resolvePostgresConnectionString({
            POSTGRES_URL: 'postgres://pool.example/db',
            POSTGRES_PRISMA_URL: 'postgres://prisma.example/db',
        })).toBe('postgres://pool.example/db');

        expect(resolvePostgresConnectionString({
            POSTGRES_PRISMA_URL: 'postgres://prisma.example/db',
        })).toBe('postgres://prisma.example/db');

        expect(resolvePostgresConnectionString({
            POSTGRES_HOST: 'db.example.com',
            POSTGRES_PORT: '6543',
            POSTGRES_USER: 'postgres.user',
            POSTGRES_PASSWORD: 'p@ss word',
            POSTGRES_DATABASE: 'postgres',
        })).toBe('postgres://postgres.user:p%40ss%20word@db.example.com:6543/postgres?sslmode=require');
    });

    it('adds pg libpq compatibility for sslmode=require without changing other URLs', () => {
        expect(normalizePostgresConnectionStringForPg(
            'postgres://user:pass@db.example.com:5432/postgres?sslmode=require',
        )).toBe('postgres://user:pass@db.example.com:5432/postgres?sslmode=require&uselibpqcompat=true');

        expect(normalizePostgresConnectionStringForPg(
            'postgres://user:pass@db.example.com:5432/postgres?sslmode=require&uselibpqcompat=true',
        )).toBe('postgres://user:pass@db.example.com:5432/postgres?sslmode=require&uselibpqcompat=true');

        expect(normalizePostgresConnectionStringForPg(
            'postgres://user:pass@db.example.com:5432/postgres',
        )).toBe('postgres://user:pass@db.example.com:5432/postgres');
    });
});

describe('cloud admin migration operator docs', () => {
    it('documents the required direct Postgres connection env for production migrations', () => {
        const envExample = fs.readFileSync('.env.example', 'utf8');
        const cloudDocs = fs.readFileSync('docs/cloud-control-plane.md', 'utf8');
        const docs = `${envExample}\n${cloudDocs}`;

        expect(docs).toContain('POSTGRES_URL_NON_POOLING');
        expect(docs).toContain('POSTGRES_URL');
        expect(docs).toContain('POSTGRES_PRISMA_URL');
        expect(docs).toContain('POSTGRES_HOST');
        expect(cloudDocs).toContain('/api/cloud/admin/migrations');
        expect(cloudDocs).toContain('20260701050000_merchant_api_v2_adapter_backbone.sql');
        expect(cloudDocs).toContain('20260701153253_merchant_shipping_claims.sql');
    });
});

describe('cloud admin migration route wrapper', () => {
    it('mounts the admin migration handler at the Vercel API route', async () => {
        vi.resetModules();
        const routeHandler = vi.fn().mockResolvedValue('handled');
        const createCloudAdminMigrationHandlerMock = vi.fn(() => routeHandler);
        const store = { id: 'store' };
        vi.doMock('../../src/cloud/adminMigrationHandlers.js', () => ({
            createCloudAdminMigrationHandler: createCloudAdminMigrationHandlerMock,
        }));
        vi.doMock('../../src/cloud/supabaseRest.js', () => ({
            createSupabaseRestClient: vi.fn(() => store),
        }));

        const route = await import('../../api/cloud/admin/migrations.js');
        const req = { method: 'POST' };
        const res = createMockResponse();
        await route.default(req, res);

        expect(createCloudAdminMigrationHandlerMock).toHaveBeenCalledWith({
            store,
            adminToken: process.env.CLOUD_ADMIN_TOKEN,
            pepper: process.env.ADMIN_SESSION_PEPPER || process.env.NODE_TOKEN_PEPPER,
        });
        expect(routeHandler).toHaveBeenCalledWith(req, res);

        vi.doUnmock('../../src/cloud/adminMigrationHandlers.js');
        vi.doUnmock('../../src/cloud/supabaseRest.js');
    });
});
