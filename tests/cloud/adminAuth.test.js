import { describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import {
    AdminAuthError,
    DEFAULT_SUPER_ADMIN_EMAILS,
    authenticateCloudAdmin,
    buildAdminPasswordResetRecord,
    buildAdminSessionRecord,
    generateAdminPasswordResetToken,
    generateAdminSessionToken,
    hashAdminSecret,
    normalizeAdminEmail,
} from '../../src/cloud/adminAuth.js';

const now = () => new Date('2026-07-01T12:00:00.000Z');

describe('cloud platform admin auth', () => {
    it('seeds Chain Haven operators as super admins', () => {
        expect(DEFAULT_SUPER_ADMIN_EMAILS).toEqual([
            'info@chainhaven.co',
            'ianmebert@gmail.com',
        ]);
    });

    it('normalizes admin emails before storage or lookup', () => {
        expect(normalizeAdminEmail(' Info@ChainHaven.CO ')).toBe('info@chainhaven.co');
        expect(() => normalizeAdminEmail('not-an-email')).toThrow('admin email must be valid');
    });

    it('generates and hashes reset and session secrets without storing raw values', () => {
        const resetToken = generateAdminPasswordResetToken({
            randomBytes: () => Buffer.from('a'.repeat(32)),
        });
        const sessionToken = generateAdminSessionToken({
            randomBytes: () => Buffer.from('b'.repeat(32)),
        });

        expect(resetToken).toMatch(/^pkx_admin_reset_/);
        expect(sessionToken).toMatch(/^pkx_admin_session_/);
        expect(hashAdminSecret(resetToken, 'pepper')).toMatch(/^[a-f0-9]{64}$/);
        expect(hashAdminSecret(resetToken, 'pepper')).not.toBe(hashAdminSecret(resetToken, 'other-pepper'));

        const adminUser = { admin_user_id: 'admin-1' };
        const resetRecord = buildAdminPasswordResetRecord({
            adminUser,
            rawToken: resetToken,
            pepper: 'pepper',
            expiresAt: '2026-07-01T13:00:00.000Z',
        });
        const sessionRecord = buildAdminSessionRecord({
            adminUser,
            rawToken: sessionToken,
            pepper: 'pepper',
            expiresAt: '2026-07-08T12:00:00.000Z',
        });

        expect(resetRecord.secret).toBe(resetToken);
        expect(sessionRecord.secret).toBe(sessionToken);
        expect(resetRecord.record).toEqual({
            admin_user_id: 'admin-1',
            token_prefix: resetToken.slice(0, 24),
            token_hash: hashAdminSecret(resetToken, 'pepper'),
            expires_at: '2026-07-01T13:00:00.000Z',
        });
        expect(sessionRecord.record).toEqual({
            admin_user_id: 'admin-1',
            token_prefix: sessionToken.slice(0, 26),
            token_hash: hashAdminSecret(sessionToken, 'pepper'),
            expires_at: '2026-07-08T12:00:00.000Z',
        });
        expect(JSON.stringify(resetRecord.record)).not.toContain(resetToken);
        expect(JSON.stringify(sessionRecord.record)).not.toContain(sessionToken);
    });

    it('accepts the bootstrap token for backwards-compatible admin access', async () => {
        const context = await authenticateCloudAdmin({
            headers: { authorization: 'Bearer bootstrap-secret' },
        }, {
            store: {},
            bootstrapToken: 'bootstrap-secret',
            pepper: 'pepper',
            now,
        });

        expect(context).toEqual({
            type: 'bootstrap',
            adminUser: {
                admin_user_id: 'bootstrap',
                email: 'bootstrap',
                role: 'super_admin',
                status: 'active',
            },
        });
    });

    it('authenticates active super admin sessions and touches last use', async () => {
        const rawToken = 'pkx_admin_session_secret';
        const session = {
            session_id: 'session-1',
            admin_user_id: 'admin-1',
            token_hash: hashAdminSecret(rawToken, 'pepper'),
            expires_at: '2026-07-08T12:00:00.000Z',
            revoked_at: null,
        };
        const adminUser = {
            admin_user_id: 'admin-1',
            email: 'info@chainhaven.co',
            role: 'super_admin',
            status: 'active',
        };
        const store = {
            findAdminSessionByHash: vi.fn().mockResolvedValue(session),
            findPlatformAdminById: vi.fn().mockResolvedValue(adminUser),
            touchAdminSession: vi.fn(),
        };

        const context = await authenticateCloudAdmin({
            headers: { authorization: `Bearer ${rawToken}` },
        }, {
            store,
            bootstrapToken: 'bootstrap-secret',
            pepper: 'pepper',
            now,
        });

        expect(store.findAdminSessionByHash).toHaveBeenCalledWith(hashAdminSecret(rawToken, 'pepper'));
        expect(store.findPlatformAdminById).toHaveBeenCalledWith('admin-1');
        expect(store.touchAdminSession).toHaveBeenCalledWith('session-1', '2026-07-01T12:00:00.000Z');
        expect(context).toEqual({ type: 'session', adminUser, session });
    });

    it('rejects missing, unknown, expired, revoked, and disabled sessions', async () => {
        await expect(authenticateCloudAdmin({ headers: {} }, {
            store: {},
            bootstrapToken: 'bootstrap-secret',
            pepper: 'pepper',
        })).rejects.toMatchObject(new AdminAuthError(401, 'missing_admin_token'));

        await expect(authenticateCloudAdmin({
            headers: { authorization: 'Bearer pkx_admin_session_missing' },
        }, {
            store: { findAdminSessionByHash: vi.fn().mockResolvedValue(null) },
            bootstrapToken: 'bootstrap-secret',
            pepper: 'pepper',
        })).rejects.toMatchObject(new AdminAuthError(403, 'invalid_admin_token'));

        await expect(authenticateCloudAdmin({
            headers: { authorization: 'Bearer pkx_admin_session_secret' },
        }, {
            store: {
                findAdminSessionByHash: vi.fn().mockResolvedValue({
                    session_id: 'session-1',
                    admin_user_id: 'admin-1',
                    token_hash: hashAdminSecret('pkx_admin_session_secret', 'pepper'),
                    expires_at: '2026-06-30T12:00:00.000Z',
                    revoked_at: null,
                }),
            },
            bootstrapToken: 'bootstrap-secret',
            pepper: 'pepper',
            now,
        })).rejects.toMatchObject(new AdminAuthError(401, 'admin_session_expired'));

        await expect(authenticateCloudAdmin({
            headers: { authorization: 'Bearer pkx_admin_session_secret' },
        }, {
            store: {
                findAdminSessionByHash: vi.fn().mockResolvedValue({
                    session_id: 'session-1',
                    admin_user_id: 'admin-1',
                    token_hash: hashAdminSecret('pkx_admin_session_secret', 'pepper'),
                    expires_at: '2026-07-08T12:00:00.000Z',
                    revoked_at: '2026-07-01T11:00:00.000Z',
                }),
            },
            bootstrapToken: 'bootstrap-secret',
            pepper: 'pepper',
            now,
        })).rejects.toMatchObject(new AdminAuthError(401, 'admin_session_revoked'));

        await expect(authenticateCloudAdmin({
            headers: { authorization: 'Bearer pkx_admin_session_secret' },
        }, {
            store: {
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
                    status: 'disabled',
                }),
            },
            bootstrapToken: 'bootstrap-secret',
            pepper: 'pepper',
            now,
        })).rejects.toMatchObject(new AdminAuthError(403, 'admin_not_active'));
    });

    it('uses bcrypt-compatible password hashes for platform admin passwords', async () => {
        const hash = await bcrypt.hash('reset-pass-123', 4);
        expect(await bcrypt.compare('reset-pass-123', hash)).toBe(true);
        expect(await bcrypt.compare('wrong-pass', hash)).toBe(false);
    });
});
