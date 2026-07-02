import { describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import {
    createCloudAdminBootstrapHandler,
    createCloudAdminLoginHandler,
    createCloudAdminLogoutHandler,
    createCloudAdminMeHandler,
    createCloudAdminPasswordResetHandler,
    createCloudAdminSetPasswordHandler,
    createCloudAdminUsersHandler,
} from '../../src/cloud/adminAuthHandlers.js';
import { hashAdminSecret } from '../../src/cloud/adminAuth.js';

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
    };
}

const now = () => new Date('2026-07-01T12:00:00.000Z');

describe('cloud admin bootstrap handler', () => {
    it('seeds both Chain Haven super admins and can issue first password reset links', async () => {
        const store = {
            upsertPlatformAdminUser: vi.fn()
                .mockResolvedValueOnce({
                    admin_user_id: 'admin-1',
                    email: 'info@chainhaven.co',
                    role: 'super_admin',
                    status: 'active',
                })
                .mockResolvedValueOnce({
                    admin_user_id: 'admin-2',
                    email: 'ianmebert@gmail.com',
                    role: 'super_admin',
                    status: 'active',
                }),
            createAdminPasswordResetToken: vi.fn().mockResolvedValue({ reset_token_id: 'reset-1' }),
        };
        const handler = createCloudAdminBootstrapHandler({
            store,
            bootstrapToken: 'bootstrap-secret',
            pepper: 'pepper',
            now,
            resetTokenFactory: () => 'pkx_admin_reset_secret',
            appBaseUrl: 'https://farm.example.com',
        });
        const res = createMockResponse();

        await handler({
            method: 'POST',
            headers: { authorization: 'Bearer bootstrap-secret' },
            body: { issue_reset_tokens: true },
        }, res);

        expect(store.upsertPlatformAdminUser).toHaveBeenNthCalledWith(1, {
            email: 'info@chainhaven.co',
            role: 'super_admin',
            status: 'active',
        });
        expect(store.upsertPlatformAdminUser).toHaveBeenNthCalledWith(2, {
            email: 'ianmebert@gmail.com',
            role: 'super_admin',
            status: 'active',
        });
        expect(store.createAdminPasswordResetToken).toHaveBeenCalledTimes(2);
        expect(store.createAdminPasswordResetToken).toHaveBeenCalledWith({
            admin_user_id: 'admin-1',
            token_prefix: 'pkx_admin_reset_secret'.slice(0, 24),
            token_hash: hashAdminSecret('pkx_admin_reset_secret', 'pepper'),
            expires_at: '2026-07-01T13:00:00.000Z',
        });
        expect(res.statusCode).toBe(200);
        expect(res.body.admins.map((admin) => admin.email)).toEqual([
            'info@chainhaven.co',
            'ianmebert@gmail.com',
        ]);
        expect(res.body.reset_links[0]).toMatchObject({
            email: 'info@chainhaven.co',
            reset_token: 'pkx_admin_reset_secret',
            reset_url: 'https://farm.example.com/admin-reset?token=pkx_admin_reset_secret',
        });
    });

    it('supports one-shot first-time setup: sets a password and returns a live session', async () => {
        const adminUser = {
            admin_user_id: 'admin-1',
            email: 'info@chainhaven.co',
            role: 'super_admin',
            status: 'active',
        };
        const store = {
            upsertPlatformAdminUser: vi.fn().mockResolvedValue(adminUser),
            findPlatformAdminByEmail: vi.fn().mockResolvedValue(adminUser),
            updatePlatformAdminPassword: vi.fn().mockResolvedValue(adminUser),
            revokeAdminSessions: vi.fn(),
            createAdminSession: vi.fn().mockResolvedValue({
                session_id: 'session-1',
                token_prefix: 'pkx_admin_session_secret'.slice(0, 26),
                expires_at: '2026-07-08T12:00:00.000Z',
            }),
            updatePlatformAdminLastLogin: vi.fn(),
        };
        const handler = createCloudAdminBootstrapHandler({
            store,
            bootstrapToken: 'bootstrap-secret',
            pepper: 'pepper',
            bcryptCost: 4,
            now,
            sessionTokenFactory: () => 'pkx_admin_session_secret',
        });
        const res = createMockResponse();

        await handler({
            method: 'POST',
            headers: { authorization: 'Bearer bootstrap-secret' },
            body: { email: 'INFO@chainhaven.co', password: 'first-time-password' },
        }, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.admin_session_token).toBe('pkx_admin_session_secret');
        const passwordHash = store.updatePlatformAdminPassword.mock.calls[0][1];
        expect(await bcrypt.compare('first-time-password', passwordHash)).toBe(true);
        expect(store.revokeAdminSessions).toHaveBeenCalledWith('admin-1', '2026-07-01T12:00:00.000Z');
        expect(store.createAdminSession).toHaveBeenCalledWith(expect.objectContaining({
            admin_user_id: 'admin-1',
            token_hash: hashAdminSecret('pkx_admin_session_secret', 'pepper'),
        }));
    });

    it('rejects one-shot setup for emails that are not seeded operators', async () => {
        const store = {
            upsertPlatformAdminUser: vi.fn().mockResolvedValue({
                admin_user_id: 'admin-1',
                email: 'info@chainhaven.co',
                role: 'super_admin',
                status: 'active',
            }),
            findPlatformAdminByEmail: vi.fn().mockResolvedValue(null),
        };
        const handler = createCloudAdminBootstrapHandler({
            store,
            bootstrapToken: 'bootstrap-secret',
            pepper: 'pepper',
            now,
        });
        const res = createMockResponse();

        await handler({
            method: 'POST',
            headers: { authorization: 'Bearer bootstrap-secret' },
            body: { email: 'intruder@example.com', password: 'long-enough-password' },
        }, res);

        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ ok: false, error: 'email_not_authorized' });
    });
});

describe('cloud admin password reset handlers', () => {
    it('issues reset tokens only after admin authentication', async () => {
        const adminUser = {
            admin_user_id: 'admin-1',
            email: 'info@chainhaven.co',
            role: 'super_admin',
            status: 'active',
        };
        const store = {
            findPlatformAdminByEmail: vi.fn().mockResolvedValue(adminUser),
            createAdminPasswordResetToken: vi.fn().mockResolvedValue({ reset_token_id: 'reset-1' }),
        };
        const handler = createCloudAdminPasswordResetHandler({
            store,
            bootstrapToken: 'bootstrap-secret',
            pepper: 'pepper',
            now,
            resetTokenFactory: () => 'pkx_admin_reset_secret',
            appBaseUrl: 'https://farm.example.com',
        });
        const res = createMockResponse();

        await handler({
            method: 'POST',
            headers: { authorization: 'Bearer bootstrap-secret' },
            body: { email: 'INFO@CHAINHAVEN.CO' },
        }, res);

        expect(store.findPlatformAdminByEmail).toHaveBeenCalledWith('info@chainhaven.co');
        expect(store.createAdminPasswordResetToken).toHaveBeenCalledWith(expect.objectContaining({
            admin_user_id: 'admin-1',
            token_hash: hashAdminSecret('pkx_admin_reset_secret', 'pepper'),
        }));
        expect(res.statusCode).toBe(201);
        expect(res.body).toEqual({
            ok: true,
            admin: {
                admin_user_id: 'admin-1',
                email: 'info@chainhaven.co',
                role: 'super_admin',
                status: 'active',
                last_login_at: undefined,
                created_at: undefined,
                updated_at: undefined,
            },
            reset_token: 'pkx_admin_reset_secret',
            reset_url: 'https://farm.example.com/admin-reset?token=pkx_admin_reset_secret',
            expires_at: '2026-07-01T13:00:00.000Z',
            email_sent: false,
        });
    });

    it('handles public self-service requests with a generic response and emails the link', async () => {
        const adminUser = {
            admin_user_id: 'admin-1',
            email: 'info@chainhaven.co',
            role: 'super_admin',
            status: 'active',
        };
        const store = {
            findPlatformAdminByEmail: vi.fn().mockResolvedValue(adminUser),
            createAdminPasswordResetToken: vi.fn().mockResolvedValue({ reset_token_id: 'reset-1' }),
        };
        const mailer = { enabled: true, send: vi.fn().mockResolvedValue({ sent: true }) };
        const handler = createCloudAdminPasswordResetHandler({
            store,
            bootstrapToken: 'bootstrap-secret',
            pepper: 'pepper',
            now,
            resetTokenFactory: () => 'pkx_admin_reset_secret',
            appBaseUrl: 'https://farm.example.com',
            mailer,
            requestRateLimiter: null,
        });
        const res = createMockResponse();

        await handler({
            method: 'POST',
            headers: {},
            body: { email: 'info@chainhaven.co' },
        }, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.ok).toBe(true);
        // The public response must never contain the token or reveal the account.
        expect(JSON.stringify(res.body)).not.toContain('pkx_admin_reset_secret');
        expect(res.body.admin).toBeUndefined();
        expect(mailer.send).toHaveBeenCalledWith(expect.objectContaining({
            to: 'info@chainhaven.co',
            text: expect.stringContaining('https://farm.example.com/admin-reset?token=pkx_admin_reset_secret'),
        }));
    });

    it('returns the same generic response for unknown emails without leaking existence', async () => {
        const store = {
            findPlatformAdminByEmail: vi.fn().mockResolvedValue(null),
            createAdminPasswordResetToken: vi.fn(),
        };
        const mailer = { enabled: true, send: vi.fn() };
        const handler = createCloudAdminPasswordResetHandler({
            store,
            bootstrapToken: 'bootstrap-secret',
            pepper: 'pepper',
            now,
            appBaseUrl: 'https://farm.example.com',
            mailer,
            requestRateLimiter: null,
        });
        const res = createMockResponse();

        await handler({
            method: 'POST',
            headers: {},
            body: { email: 'nobody@example.com' },
        }, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(store.createAdminPasswordResetToken).not.toHaveBeenCalled();
        expect(mailer.send).not.toHaveBeenCalled();
    });

    it('sets a new password from a valid one-time reset token and revokes old sessions', async () => {
        const store = {
            findAdminPasswordResetTokenByHash: vi.fn().mockResolvedValue({
                reset_token_id: 'reset-1',
                admin_user_id: 'admin-1',
                token_hash: hashAdminSecret('pkx_admin_reset_secret', 'pepper'),
                used_at: null,
                expires_at: '2026-07-01T13:00:00.000Z',
            }),
            findPlatformAdminById: vi.fn().mockResolvedValue({
                admin_user_id: 'admin-1',
                email: 'ianmebert@gmail.com',
                role: 'super_admin',
                status: 'active',
            }),
            updatePlatformAdminPassword: vi.fn().mockResolvedValue({
                admin_user_id: 'admin-1',
                email: 'ianmebert@gmail.com',
                role: 'super_admin',
                status: 'active',
            }),
            markAdminPasswordResetTokenUsed: vi.fn(),
            revokeAdminSessions: vi.fn(),
        };
        const handler = createCloudAdminSetPasswordHandler({
            store,
            pepper: 'pepper',
            bcryptCost: 4,
            now,
        });
        const res = createMockResponse();

        await handler({
            method: 'POST',
            body: {
                reset_token: 'pkx_admin_reset_secret',
                password: 'new-secure-pass',
            },
        }, res);

        expect(store.findAdminPasswordResetTokenByHash).toHaveBeenCalledWith(hashAdminSecret('pkx_admin_reset_secret', 'pepper'));
        const passwordHash = store.updatePlatformAdminPassword.mock.calls[0][1];
        expect(await bcrypt.compare('new-secure-pass', passwordHash)).toBe(true);
        expect(store.markAdminPasswordResetTokenUsed).toHaveBeenCalledWith('reset-1', '2026-07-01T12:00:00.000Z');
        expect(store.revokeAdminSessions).toHaveBeenCalledWith('admin-1', '2026-07-01T12:00:00.000Z');
        expect(res.statusCode).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.admin.email).toBe('ianmebert@gmail.com');
        expect(res.body).not.toHaveProperty('password_hash');
    });
});

describe('cloud admin login and me handlers', () => {
    it('logs in super admins with email/password and returns a session token once', async () => {
        const passwordHash = await bcrypt.hash('correct-password', 4);
        const adminUser = {
            admin_user_id: 'admin-1',
            email: 'info@chainhaven.co',
            role: 'super_admin',
            status: 'active',
            password_hash: passwordHash,
        };
        const store = {
            findPlatformAdminByEmail: vi.fn().mockResolvedValue(adminUser),
            createAdminSession: vi.fn().mockResolvedValue({
                session_id: 'session-1',
                admin_user_id: 'admin-1',
                token_prefix: 'pkx_admin_session_secret'.slice(0, 26),
                expires_at: '2026-07-08T12:00:00.000Z',
            }),
            updatePlatformAdminLastLogin: vi.fn(),
        };
        const handler = createCloudAdminLoginHandler({
            store,
            pepper: 'pepper',
            sessionTokenFactory: () => 'pkx_admin_session_secret',
            now,
        });
        const res = createMockResponse();

        await handler({
            method: 'POST',
            body: {
                email: 'info@chainhaven.co',
                password: 'correct-password',
            },
        }, res);

        expect(store.createAdminSession).toHaveBeenCalledWith({
            admin_user_id: 'admin-1',
            token_prefix: 'pkx_admin_session_secret'.slice(0, 26),
            token_hash: hashAdminSecret('pkx_admin_session_secret', 'pepper'),
            expires_at: '2026-07-08T12:00:00.000Z',
        });
        expect(store.updatePlatformAdminLastLogin).toHaveBeenCalledWith('admin-1', '2026-07-01T12:00:00.000Z');
        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({
            ok: true,
            admin_session_token: 'pkx_admin_session_secret',
            admin: {
                admin_user_id: 'admin-1',
                email: 'info@chainhaven.co',
                role: 'super_admin',
                status: 'active',
            },
        });
        expect(JSON.stringify(res.body)).not.toContain(passwordHash);
    });

    it('returns current admin details for bootstrap or session auth', async () => {
        const store = {
            findAdminSessionByHash: vi.fn().mockResolvedValue({
                session_id: 'session-1',
                admin_user_id: 'admin-1',
                token_hash: hashAdminSecret('pkx_admin_session_secret', 'pepper'),
                expires_at: '2026-07-08T12:00:00.000Z',
                revoked_at: null,
            }),
            findPlatformAdminById: vi.fn().mockResolvedValue({
                admin_user_id: 'admin-1',
                email: 'info@chainhaven.co',
                role: 'super_admin',
                status: 'active',
            }),
            touchAdminSession: vi.fn(),
        };
        const handler = createCloudAdminMeHandler({
            store,
            bootstrapToken: 'bootstrap-secret',
            pepper: 'pepper',
            now,
        });
        const res = createMockResponse();

        await handler({
            method: 'GET',
            headers: { authorization: 'Bearer pkx_admin_session_secret' },
        }, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            ok: true,
            auth_type: 'session',
            admin: {
                admin_user_id: 'admin-1',
                email: 'info@chainhaven.co',
                role: 'super_admin',
                status: 'active',
                last_login_at: undefined,
                created_at: undefined,
                updated_at: undefined,
            },
        });
    });

    it('logout revokes the presented session', async () => {
        const store = {
            findAdminSessionByHash: vi.fn().mockResolvedValue({
                session_id: 'session-1',
                admin_user_id: 'admin-1',
                token_hash: hashAdminSecret('pkx_admin_session_secret', 'pepper'),
                expires_at: '2026-07-08T12:00:00.000Z',
                revoked_at: null,
            }),
            findPlatformAdminById: vi.fn().mockResolvedValue({
                admin_user_id: 'admin-1',
                email: 'info@chainhaven.co',
                role: 'super_admin',
                status: 'active',
            }),
            touchAdminSession: vi.fn(),
            revokeAdminSession: vi.fn(),
        };
        const handler = createCloudAdminLogoutHandler({
            store,
            bootstrapToken: 'bootstrap-secret',
            pepper: 'pepper',
            now,
        });
        const res = createMockResponse();

        await handler({
            method: 'POST',
            headers: { authorization: 'Bearer pkx_admin_session_secret' },
        }, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ ok: true });
        expect(store.revokeAdminSession).toHaveBeenCalledWith('session-1', '2026-07-01T12:00:00.000Z');
    });
});

describe('cloud admin users handler', () => {
    function superAdminStore(extra = {}) {
        return {
            findAdminSessionByHash: vi.fn().mockResolvedValue({
                session_id: 'session-1',
                admin_user_id: 'admin-1',
                token_hash: hashAdminSecret('pkx_admin_session_secret', 'pepper'),
                expires_at: '2026-07-08T12:00:00.000Z',
                revoked_at: null,
            }),
            findPlatformAdminById: vi.fn().mockResolvedValue({
                admin_user_id: 'admin-1',
                email: 'info@chainhaven.co',
                role: 'super_admin',
                status: 'active',
            }),
            touchAdminSession: vi.fn(),
            ...extra,
        };
    }

    it('lists operator accounts for super admins', async () => {
        const store = superAdminStore({
            listPlatformAdminUsers: vi.fn().mockResolvedValue([
                { admin_user_id: 'admin-1', email: 'info@chainhaven.co', role: 'super_admin', status: 'active', password_hash: 'hash' },
            ]),
        });
        const handler = createCloudAdminUsersHandler({ store, bootstrapToken: 'bootstrap-secret', pepper: 'pepper', now });
        const res = createMockResponse();

        await handler({ method: 'GET', headers: { authorization: 'Bearer pkx_admin_session_secret' } }, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.admins).toHaveLength(1);
        expect(JSON.stringify(res.body)).not.toContain('hash');
    });

    it('creates a new admin with an invite reset link', async () => {
        const store = superAdminStore({
            findPlatformAdminByEmail: vi.fn().mockResolvedValue(null),
            upsertPlatformAdminUser: vi.fn().mockResolvedValue({
                admin_user_id: 'admin-2',
                email: 'teammate@example.com',
                role: 'admin',
                status: 'active',
            }),
            createAdminPasswordResetToken: vi.fn().mockResolvedValue({ reset_token_id: 'reset-1' }),
        });
        const mailer = { enabled: true, send: vi.fn().mockResolvedValue({ sent: true }) };
        const handler = createCloudAdminUsersHandler({
            store,
            bootstrapToken: 'bootstrap-secret',
            pepper: 'pepper',
            now,
            resetTokenFactory: () => 'pkx_admin_reset_invite',
            appBaseUrl: 'https://farm.example.com',
            mailer,
        });
        const res = createMockResponse();

        await handler({
            method: 'POST',
            headers: { authorization: 'Bearer pkx_admin_session_secret' },
            body: { action: 'create', email: 'teammate@example.com', role: 'admin' },
        }, res);

        expect(res.statusCode).toBe(201);
        expect(store.upsertPlatformAdminUser).toHaveBeenCalledWith({
            email: 'teammate@example.com',
            role: 'admin',
            status: 'active',
        });
        expect(res.body.reset_url).toBe('https://farm.example.com/admin-reset?token=pkx_admin_reset_invite');
        expect(res.body.email_sent).toBe(true);
    });

    it('refuses to disable the default Chain Haven super admins', async () => {
        const store = superAdminStore({
            findPlatformAdminByEmail: vi.fn().mockResolvedValue({
                admin_user_id: 'admin-2',
                email: 'ianmebert@gmail.com',
                role: 'super_admin',
                status: 'active',
            }),
            updatePlatformAdminStatus: vi.fn(),
        });
        const handler = createCloudAdminUsersHandler({ store, bootstrapToken: 'bootstrap-secret', pepper: 'pepper', now });
        const res = createMockResponse();

        await handler({
            method: 'POST',
            headers: { authorization: 'Bearer pkx_admin_session_secret' },
            body: { action: 'disable', email: 'ianmebert@gmail.com' },
        }, res);

        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ ok: false, error: 'cannot_disable_default_super_admin' });
        expect(store.updatePlatformAdminStatus).not.toHaveBeenCalled();
    });

    it('rejects non-super admins', async () => {
        const store = superAdminStore({
            findPlatformAdminById: vi.fn().mockResolvedValue({
                admin_user_id: 'admin-1',
                email: 'ops@example.com',
                role: 'admin',
                status: 'active',
            }),
        });
        const handler = createCloudAdminUsersHandler({ store, bootstrapToken: 'bootstrap-secret', pepper: 'pepper', now });
        const res = createMockResponse();

        await handler({ method: 'GET', headers: { authorization: 'Bearer pkx_admin_session_secret' } }, res);

        expect(res.statusCode).toBe(403);
        expect(res.body).toEqual({ ok: false, error: 'super_admin_required' });
    });
});
