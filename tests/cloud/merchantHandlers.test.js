import { describe, expect, it, vi } from 'vitest';
import { hashMerchantApiKey } from '../../src/cloud/merchantAuth.js';
import {
    createMerchantApiKeyRevokeHandler,
    createMerchantApiKeysHandler,
    createMerchantMeHandler,
    createMerchantSignupHandler,
} from '../../src/cloud/merchantHandlers.js';

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

describe('merchant signup handler', () => {
    it('creates approval-required pending merchants by default and does not mint credentials', async () => {
        const merchant = {
            merchant_id: 'merchant-1',
            org_id: 'org-1',
            company_name: 'Widget Store',
            contact_email: 'ops@example.com',
            status: 'pending',
            approval_mode: 'approval_required',
        };
        const store = {
            getPlatformSetting: vi.fn().mockResolvedValue({ enabled: false }),
            findMerchantByEmail: vi.fn().mockResolvedValue(null),
            createOrganization: vi.fn().mockResolvedValue({ org_id: 'org-1', name: 'Widget Store' }),
            createMerchant: vi.fn().mockResolvedValue(merchant),
            createMerchantSetupToken: vi.fn(),
        };
        const handler = createMerchantSignupHandler({
            store,
            pepper: 'pepper',
            now,
            setupTokenFactory: () => 'pkx_setup_secret',
        });
        const res = createMockResponse();

        await handler({
            method: 'POST',
            body: {
                company_name: ' Widget Store ',
                contact_email: ' OPS@EXAMPLE.COM ',
                contact_name: ' Ops Lead ',
                website: ' https://example.com ',
                status: 'active',
                metadata: { plan: 'spoofed' },
            },
        }, res);

        expect(store.getPlatformSetting).toHaveBeenCalledWith('full_auto_merchant_mode', { enabled: false });
        expect(store.findMerchantByEmail).toHaveBeenCalledWith('ops@example.com');
        expect(store.createOrganization).toHaveBeenCalledWith({ name: 'Widget Store' });
        expect(store.createMerchant).toHaveBeenCalledWith({
            org_id: 'org-1',
            company_name: 'Widget Store',
            contact_email: 'ops@example.com',
            contact_name: 'Ops Lead',
            website: 'https://example.com',
            status: 'pending',
            approval_mode: 'approval_required',
            metadata: { signup_source: 'public_api' },
        });
        expect(store.createMerchantSetupToken).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(201);
        expect(res.body).toEqual({
            ok: true,
            merchant,
            approval_required: true,
        });
    });

    it('can auto-approve signups only when full-auto mode is explicitly enabled', async () => {
        const merchant = {
            merchant_id: 'merchant-1',
            org_id: 'org-1',
            company_name: 'Widget Store',
            contact_email: 'ops@example.com',
            status: 'active',
            approval_mode: 'full_auto',
            approved_at: '2026-07-01T12:00:00.000Z',
        };
        const store = {
            getPlatformSetting: vi.fn().mockResolvedValue({ enabled: true }),
            findMerchantByEmail: vi.fn().mockResolvedValue(null),
            createOrganization: vi.fn().mockResolvedValue({ org_id: 'org-1', name: 'Widget Store' }),
            createMerchant: vi.fn().mockResolvedValue(merchant),
            createMerchantSetupToken: vi.fn().mockResolvedValue({
                setup_token_id: 'setup-1',
                merchant_id: 'merchant-1',
                org_id: 'org-1',
                token_prefix: 'pkx_setup_secret',
                expires_at: '2026-07-08T12:00:00.000Z',
            }),
        };
        const handler = createMerchantSignupHandler({
            store,
            pepper: 'pepper',
            now,
            setupTokenFactory: () => 'pkx_setup_secret',
        });
        const res = createMockResponse();

        await handler({
            method: 'POST',
            body: {
                company_name: 'Widget Store',
                contact_email: 'ops@example.com',
            },
        }, res);

        expect(store.createMerchant).toHaveBeenCalledWith(expect.objectContaining({
            status: 'active',
            approval_mode: 'full_auto',
            approved_at: '2026-07-01T12:00:00.000Z',
        }));
        expect(store.createMerchantSetupToken).toHaveBeenCalledWith({
            merchant_id: 'merchant-1',
            org_id: 'org-1',
            token_prefix: 'pkx_setup_secret',
            token_hash: hashMerchantApiKey('pkx_setup_secret', 'pepper'),
            expires_at: '2026-07-08T12:00:00.000Z',
        });
        expect(JSON.stringify(store.createMerchantSetupToken.mock.calls[0][0])).not.toContain('raw');
        expect(res.statusCode).toBe(201);
        expect(res.body).toEqual({
            ok: true,
            merchant,
            approval_required: false,
            merchant_setup_token: 'pkx_setup_secret',
            setup_token_expires_at: '2026-07-08T12:00:00.000Z',
        });
    });

    it('rejects duplicate signup emails before creating an organization', async () => {
        const store = {
            getPlatformSetting: vi.fn().mockResolvedValue({ enabled: false }),
            findMerchantByEmail: vi.fn().mockResolvedValue({ merchant_id: 'existing' }),
            createOrganization: vi.fn(),
            createMerchant: vi.fn(),
        };
        const handler = createMerchantSignupHandler({ store, pepper: 'pepper' });
        const res = createMockResponse();

        await handler({
            method: 'POST',
            body: {
                company_name: 'Widget Store',
                contact_email: 'ops@example.com',
            },
        }, res);

        expect(res.statusCode).toBe(409);
        expect(res.body).toEqual({ ok: false, error: 'merchant_already_exists' });
        expect(store.createOrganization).not.toHaveBeenCalled();
        expect(store.createMerchant).not.toHaveBeenCalled();
    });
});

describe('merchant account handler', () => {
    it('returns the authenticated merchant without exposing key hashes', async () => {
        const keyHash = hashMerchantApiKey('pkx_live_secret', 'pepper');
        const store = {
            findMerchantApiKeyByHash: vi.fn().mockResolvedValue({
                key_id: 'key-1',
                merchant_id: 'merchant-1',
                org_id: 'org-1',
                name: 'Production',
                key_hash: keyHash,
            }),
            findMerchantById: vi.fn().mockResolvedValue({
                merchant_id: 'merchant-1',
                org_id: 'org-1',
                company_name: 'Widget Store',
                contact_email: 'ops@example.com',
                status: 'active',
            }),
            touchMerchantApiKey: vi.fn(),
        };
        const handler = createMerchantMeHandler({ store, pepper: 'pepper', now });
        const res = createMockResponse();

        await handler({
            method: 'GET',
            headers: { authorization: 'Bearer pkx_live_secret' },
        }, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            ok: true,
            auth_type: 'api_key',
            merchant: {
                merchant_id: 'merchant-1',
                org_id: 'org-1',
                company_name: 'Widget Store',
                contact_email: 'ops@example.com',
                status: 'active',
            },
            api_key: {
                key_id: 'key-1',
                merchant_id: 'merchant-1',
                org_id: 'org-1',
                name: 'Production',
                scopes: ['*'],
            },
        });
        expect(JSON.stringify(res.body)).not.toContain(keyHash);
    });
});

describe('merchant API key handler', () => {
    it('exchanges a one-time setup token for a live API key and marks setup token used', async () => {
        const setupToken = 'pkx_setup_secret';
        const liveKey = 'pkx_live_secret';
        const store = {
            findMerchantSetupTokenByHash: vi.fn().mockResolvedValue({
                setup_token_id: 'setup-1',
                merchant_id: 'merchant-1',
                org_id: 'org-1',
                token_hash: hashMerchantApiKey(setupToken, 'pepper'),
                used_at: null,
                expires_at: '2026-07-08T12:00:00.000Z',
            }),
            findMerchantById: vi.fn().mockResolvedValue({
                merchant_id: 'merchant-1',
                org_id: 'org-1',
                status: 'active',
            }),
            createMerchantApiKey: vi.fn().mockResolvedValue({
                key_id: 'key-1',
                merchant_id: 'merchant-1',
                org_id: 'org-1',
                name: 'Production',
                key_prefix: liveKey.slice(0, 18),
                key_hash: hashMerchantApiKey(liveKey, 'pepper'),
                revoked_at: null,
                created_at: '2026-07-01T12:00:00.000Z',
            }),
            markMerchantSetupTokenUsed: vi.fn().mockResolvedValue({
                setup_token_id: 'setup-1',
                used_at: '2026-07-01T12:00:00.000Z',
            }),
        };
        const handler = createMerchantApiKeysHandler({
            store,
            pepper: 'pepper',
            now,
            liveKeyFactory: () => liveKey,
        });
        const res = createMockResponse();

        await handler({
            method: 'POST',
            headers: { 'x-merchant-setup-token': setupToken },
            body: { name: ' Production ' },
        }, res);

        expect(store.createMerchantApiKey).toHaveBeenCalledWith({
            merchant_id: 'merchant-1',
            org_id: 'org-1',
            name: 'Production',
            key_prefix: liveKey.slice(0, 18),
            key_hash: hashMerchantApiKey(liveKey, 'pepper'),
            scopes: ['*'],
        });
        expect(store.markMerchantSetupTokenUsed).toHaveBeenCalledWith('setup-1', '2026-07-01T12:00:00.000Z');
        expect(res.statusCode).toBe(201);
        expect(res.body).toEqual({
            ok: true,
            api_key: {
                key_id: 'key-1',
                merchant_id: 'merchant-1',
                org_id: 'org-1',
                name: 'Production',
                key_prefix: liveKey.slice(0, 18),
                scopes: ['*'],
                revoked_at: null,
                created_at: '2026-07-01T12:00:00.000Z',
            },
            api_key_secret: liveKey,
        });
    });

    it('rejects a setup token that was already consumed and mints no key', async () => {
        const setupToken = 'pkx_setup_secret';
        const store = {
            findMerchantSetupTokenByHash: vi.fn().mockResolvedValue({
                setup_token_id: 'setup-1',
                merchant_id: 'merchant-1',
                org_id: 'org-1',
                token_hash: hashMerchantApiKey(setupToken, 'pepper'),
                used_at: null,
                expires_at: '2026-07-08T12:00:00.000Z',
            }),
            findMerchantById: vi.fn().mockResolvedValue({
                merchant_id: 'merchant-1',
                org_id: 'org-1',
                status: 'active',
            }),
            createMerchantApiKey: vi.fn(),
            // Conditional consume loses the race: no row updated -> null.
            markMerchantSetupTokenUsed: vi.fn().mockResolvedValue(null),
        };
        const handler = createMerchantApiKeysHandler({ store, pepper: 'pepper', now });
        const res = createMockResponse();

        await handler({
            method: 'POST',
            headers: { 'x-merchant-setup-token': setupToken },
            body: { name: 'Production' },
        }, res);

        expect(res.statusCode).toBe(401);
        expect(res.body).toMatchObject({ ok: false, error: 'setup_token_used' });
        expect(store.createMerchantApiKey).not.toHaveBeenCalled();
    });

    it('lists live API keys for authenticated merchants without hashes', async () => {
        const keyHash = hashMerchantApiKey('pkx_live_secret', 'pepper');
        const store = {
            findMerchantApiKeyByHash: vi.fn().mockResolvedValue({
                key_id: 'key-1',
                merchant_id: 'merchant-1',
                org_id: 'org-1',
                key_hash: keyHash,
            }),
            findMerchantById: vi.fn().mockResolvedValue({
                merchant_id: 'merchant-1',
                org_id: 'org-1',
                status: 'active',
            }),
            touchMerchantApiKey: vi.fn(),
            listMerchantApiKeys: vi.fn().mockResolvedValue([
                {
                    key_id: 'key-1',
                    merchant_id: 'merchant-1',
                    org_id: 'org-1',
                    name: 'Production',
                    key_prefix: 'pkx_live_abc',
                    key_hash: keyHash,
                    revoked_at: null,
                },
            ]),
        };
        const handler = createMerchantApiKeysHandler({ store, pepper: 'pepper', now });
        const res = createMockResponse();

        await handler({
            method: 'GET',
            headers: { authorization: 'Bearer pkx_live_secret' },
        }, res);

        expect(store.listMerchantApiKeys).toHaveBeenCalledWith('merchant-1');
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            ok: true,
            api_keys: [{
                key_id: 'key-1',
                merchant_id: 'merchant-1',
                org_id: 'org-1',
                name: 'Production',
                key_prefix: 'pkx_live_abc',
                scopes: ['*'],
                revoked_at: null,
            }],
        });
        expect(JSON.stringify(res.body)).not.toContain(keyHash);
    });

    it('revokes keys via the canonical DELETE verb on the same endpoint', async () => {
        const keyHash = hashMerchantApiKey('pkx_live_secret', 'pepper');
        const store = {
            findMerchantApiKeyByHash: vi.fn().mockResolvedValue({
                key_id: 'auth-key',
                merchant_id: 'merchant-1',
                org_id: 'org-1',
                key_hash: keyHash,
            }),
            findMerchantById: vi.fn().mockResolvedValue({
                merchant_id: 'merchant-1',
                org_id: 'org-1',
                status: 'active',
            }),
            touchMerchantApiKey: vi.fn(),
            revokeMerchantApiKey: vi.fn().mockResolvedValue({
                key_id: 'key-2',
                merchant_id: 'merchant-1',
                org_id: 'org-1',
                name: 'Old key',
                key_prefix: 'pkx_live_old',
                revoked_at: '2026-07-01T12:00:00.000Z',
            }),
        };
        const handler = createMerchantApiKeysHandler({ store, pepper: 'pepper', now });
        const res = createMockResponse();

        await handler({
            method: 'DELETE',
            headers: { authorization: 'Bearer pkx_live_secret' },
            query: { key_id: 'key-2' },
        }, res);

        expect(store.revokeMerchantApiKey).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            keyId: 'key-2',
            revokedAt: '2026-07-01T12:00:00.000Z',
        });
        expect(res.statusCode).toBe(200);
        expect(res.body.api_key.key_id).toBe('key-2');
    });

    it('returns 404 when DELETE targets an unknown key', async () => {
        const keyHash = hashMerchantApiKey('pkx_live_secret', 'pepper');
        const store = {
            findMerchantApiKeyByHash: vi.fn().mockResolvedValue({
                key_id: 'auth-key',
                merchant_id: 'merchant-1',
                org_id: 'org-1',
                key_hash: keyHash,
            }),
            findMerchantById: vi.fn().mockResolvedValue({
                merchant_id: 'merchant-1',
                org_id: 'org-1',
                status: 'active',
            }),
            touchMerchantApiKey: vi.fn(),
            revokeMerchantApiKey: vi.fn().mockResolvedValue(null),
        };
        const handler = createMerchantApiKeysHandler({ store, pepper: 'pepper', now });
        const res = createMockResponse();

        await handler({
            method: 'DELETE',
            headers: { authorization: 'Bearer pkx_live_secret' },
            body: { key_id: 'missing' },
        }, res);

        expect(res.statusCode).toBe(404);
        expect(res.body).toEqual({ ok: false, error: 'api_key_not_found' });
    });
});

describe('merchant API key revoke handler', () => {
    it('revokes merchant-scoped live API keys', async () => {
        const keyHash = hashMerchantApiKey('pkx_live_secret', 'pepper');
        const store = {
            findMerchantApiKeyByHash: vi.fn().mockResolvedValue({
                key_id: 'auth-key',
                merchant_id: 'merchant-1',
                org_id: 'org-1',
                key_hash: keyHash,
            }),
            findMerchantById: vi.fn().mockResolvedValue({
                merchant_id: 'merchant-1',
                org_id: 'org-1',
                status: 'active',
            }),
            touchMerchantApiKey: vi.fn(),
            revokeMerchantApiKey: vi.fn().mockResolvedValue({
                key_id: 'key-2',
                merchant_id: 'merchant-1',
                org_id: 'org-1',
                name: 'Old key',
                key_prefix: 'pkx_live_old',
                revoked_at: '2026-07-01T12:00:00.000Z',
            }),
        };
        const handler = createMerchantApiKeyRevokeHandler({ store, pepper: 'pepper', now });
        const res = createMockResponse();

        await handler({
            method: 'POST',
            headers: { authorization: 'Bearer pkx_live_secret' },
            body: { key_id: ' key-2 ' },
        }, res);

        expect(store.revokeMerchantApiKey).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            keyId: 'key-2',
            revokedAt: '2026-07-01T12:00:00.000Z',
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            ok: true,
            api_key: {
                key_id: 'key-2',
                merchant_id: 'merchant-1',
                org_id: 'org-1',
                name: 'Old key',
                key_prefix: 'pkx_live_old',
                scopes: ['*'],
                revoked_at: '2026-07-01T12:00:00.000Z',
            },
        });
    });
});
