import { describe, expect, it, vi } from 'vitest';
import {
    MerchantAuthError,
    authenticateMerchantRequest,
    buildMerchantApiKeyRecord,
    buildMerchantSetupTokenRecord,
    generateMerchantApiKey,
    generateMerchantSetupToken,
    getMerchantBearerToken,
    getMerchantSetupToken,
    hashMerchantApiKey,
    authenticateMerchantSetupToken,
    merchantKeyHashesMatch,
} from '../../src/cloud/merchantAuth.js';

describe('merchant API key auth', () => {
    it('generates live merchant API keys with the public prefix', () => {
        const key = generateMerchantApiKey({
            randomBytes: () => Buffer.from('a'.repeat(32)),
        });

        expect(key).toMatch(/^pkx_live_/);
        expect(key.length).toBeGreaterThan(40);
    });

    it('generates one-time setup tokens with a distinct prefix', () => {
        const token = generateMerchantSetupToken({
            randomBytes: () => Buffer.from('b'.repeat(32)),
        });

        expect(token).toMatch(/^pkx_setup_/);
        expect(token.length).toBeGreaterThan(40);
    });

    it('hashes API keys with a server-side pepper and compares hashes safely', () => {
        const hash = hashMerchantApiKey('pkx_live_secret', 'pepper-a');

        expect(hash).toMatch(/^[a-f0-9]{64}$/);
        expect(hash).toBe(hashMerchantApiKey('pkx_live_secret', 'pepper-a'));
        expect(hash).not.toBe(hashMerchantApiKey('pkx_live_secret', 'pepper-b'));
        expect(merchantKeyHashesMatch(hash, hash)).toBe(true);
        expect(merchantKeyHashesMatch(hash, hashMerchantApiKey('other', 'pepper-a'))).toBe(false);
    });

    it('builds one-time API key creation payloads without storing the raw key', () => {
        const rawKey = 'pkx_live_abcdefghijklmnopqrstuvwxyz0123456789';
        const payload = buildMerchantApiKeyRecord({
            merchant: { merchant_id: 'merchant-1', org_id: 'org-1' },
            name: 'Production',
            rawKey,
            pepper: 'pepper',
        });

        expect(payload.secret).toBe(rawKey);
        expect(payload.record).toEqual({
            merchant_id: 'merchant-1',
            org_id: 'org-1',
            name: 'Production',
            key_prefix: rawKey.slice(0, 18),
            key_hash: hashMerchantApiKey(rawKey, 'pepper'),
            scopes: ['*'],
        });
        expect(JSON.stringify(payload.record)).not.toContain(rawKey);
    });

    it('builds one-time setup token records without storing the raw setup token', () => {
        const rawToken = 'pkx_setup_abcdefghijklmnopqrstuvwxyz0123456789';
        const payload = buildMerchantSetupTokenRecord({
            merchant: { merchant_id: 'merchant-1', org_id: 'org-1' },
            rawToken,
            pepper: 'pepper',
            expiresAt: '2026-07-08T00:00:00.000Z',
        });

        expect(payload.secret).toBe(rawToken);
        expect(payload.record).toEqual({
            merchant_id: 'merchant-1',
            org_id: 'org-1',
            token_prefix: rawToken.slice(0, 20),
            token_hash: hashMerchantApiKey(rawToken, 'pepper'),
            expires_at: '2026-07-08T00:00:00.000Z',
        });
        expect(JSON.stringify(payload.record)).not.toContain(rawToken);
    });

    it('extracts bearer tokens from public API request headers', () => {
        expect(getMerchantBearerToken({ authorization: 'Bearer pkx_live_secret' })).toBe('pkx_live_secret');
        expect(getMerchantBearerToken({ Authorization: 'Bearer pkx_live_other' })).toBe('pkx_live_other');
        expect(getMerchantBearerToken({ authorization: 'Basic abc' })).toBeNull();
        expect(getMerchantBearerToken({})).toBeNull();
        expect(getMerchantSetupToken({ 'x-merchant-setup-token': 'pkx_setup_secret' })).toBe('pkx_setup_secret');
        expect(getMerchantSetupToken({ 'X-Merchant-Setup-Token': ' pkx_setup_other ' })).toBe('pkx_setup_other');
    });

    it('authenticates active merchants and touches key usage', async () => {
        const store = {
            findMerchantApiKeyByHash: vi.fn().mockResolvedValue({
                key_id: 'key-1',
                merchant_id: 'merchant-1',
                org_id: 'org-1',
                key_hash: hashMerchantApiKey('pkx_live_secret', 'pepper'),
            }),
            findMerchantById: vi.fn().mockResolvedValue({
                merchant_id: 'merchant-1',
                org_id: 'org-1',
                status: 'active',
                company_name: 'Widget Store',
            }),
            touchMerchantApiKey: vi.fn(),
        };

        const context = await authenticateMerchantRequest({
            headers: { authorization: 'Bearer pkx_live_secret' },
        }, {
            store,
            pepper: 'pepper',
            now: () => new Date('2026-07-01T00:00:00.000Z'),
        });

        expect(context).toEqual({
            merchant: {
                merchant_id: 'merchant-1',
                org_id: 'org-1',
                status: 'active',
                company_name: 'Widget Store',
            },
            apiKey: {
                key_id: 'key-1',
                merchant_id: 'merchant-1',
                org_id: 'org-1',
                key_hash: hashMerchantApiKey('pkx_live_secret', 'pepper'),
            },
        });
        expect(store.findMerchantApiKeyByHash).toHaveBeenCalledWith(hashMerchantApiKey('pkx_live_secret', 'pepper'));
        expect(store.touchMerchantApiKey).toHaveBeenCalledWith('key-1', '2026-07-01T00:00:00.000Z');
    });

    it('rejects missing, revoked, mismatched, and inactive merchant keys', async () => {
        await expect(authenticateMerchantRequest({ headers: {} }, {
            store: {},
            pepper: 'pepper',
        })).rejects.toMatchObject(new MerchantAuthError(401, 'missing_api_key'));

        await expect(authenticateMerchantRequest({
            headers: { authorization: 'Bearer pkx_live_missing' },
        }, {
            store: {
                findMerchantApiKeyByHash: vi.fn().mockResolvedValue(null),
            },
            pepper: 'pepper',
        })).rejects.toMatchObject(new MerchantAuthError(401, 'invalid_api_key'));

        await expect(authenticateMerchantRequest({
            headers: { authorization: 'Bearer pkx_live_secret' },
        }, {
            store: {
                findMerchantApiKeyByHash: vi.fn().mockResolvedValue({
                    key_id: 'key-1',
                    merchant_id: 'merchant-1',
                    org_id: 'org-1',
                    key_hash: hashMerchantApiKey('different', 'pepper'),
                }),
            },
            pepper: 'pepper',
        })).rejects.toMatchObject(new MerchantAuthError(401, 'invalid_api_key'));

        await expect(authenticateMerchantRequest({
            headers: { authorization: 'Bearer pkx_live_secret' },
        }, {
            store: {
                findMerchantApiKeyByHash: vi.fn().mockResolvedValue({
                    key_id: 'key-1',
                    merchant_id: 'merchant-1',
                    org_id: 'org-1',
                    key_hash: hashMerchantApiKey('pkx_live_secret', 'pepper'),
                }),
                findMerchantById: vi.fn().mockResolvedValue({
                    merchant_id: 'merchant-1',
                    org_id: 'org-1',
                    status: 'pending',
                }),
            },
            pepper: 'pepper',
        })).rejects.toMatchObject(new MerchantAuthError(403, 'merchant_not_active'));
    });

    it('authenticates one-time setup tokens for active merchants', async () => {
        const setupToken = 'pkx_setup_secret';
        const store = {
            findMerchantSetupTokenByHash: vi.fn().mockResolvedValue({
                setup_token_id: 'setup-1',
                merchant_id: 'merchant-1',
                org_id: 'org-1',
                token_hash: hashMerchantApiKey(setupToken, 'pepper'),
                used_at: null,
                expires_at: '2026-07-08T00:00:00.000Z',
            }),
            findMerchantById: vi.fn().mockResolvedValue({
                merchant_id: 'merchant-1',
                org_id: 'org-1',
                status: 'active',
            }),
        };

        const context = await authenticateMerchantSetupToken({
            headers: { 'x-merchant-setup-token': setupToken },
        }, {
            store,
            pepper: 'pepper',
            now: () => new Date('2026-07-01T00:00:00.000Z'),
        });

        expect(context.merchant.merchant_id).toBe('merchant-1');
        expect(context.setupToken.setup_token_id).toBe('setup-1');
    });

    it('rejects missing, expired, used, and inactive setup tokens', async () => {
        await expect(authenticateMerchantSetupToken({ headers: {} }, {
            store: {},
            pepper: 'pepper',
        })).rejects.toMatchObject(new MerchantAuthError(401, 'missing_setup_token'));

        await expect(authenticateMerchantSetupToken({
            headers: { 'x-merchant-setup-token': 'pkx_setup_secret' },
        }, {
            store: {
                findMerchantSetupTokenByHash: vi.fn().mockResolvedValue({
                    setup_token_id: 'setup-1',
                    merchant_id: 'merchant-1',
                    org_id: 'org-1',
                    token_hash: hashMerchantApiKey('pkx_setup_secret', 'pepper'),
                    used_at: '2026-07-01T00:00:00.000Z',
                    expires_at: '2026-07-08T00:00:00.000Z',
                }),
            },
            pepper: 'pepper',
        })).rejects.toMatchObject(new MerchantAuthError(401, 'setup_token_used'));

        await expect(authenticateMerchantSetupToken({
            headers: { 'x-merchant-setup-token': 'pkx_setup_secret' },
        }, {
            store: {
                findMerchantSetupTokenByHash: vi.fn().mockResolvedValue({
                    setup_token_id: 'setup-1',
                    merchant_id: 'merchant-1',
                    org_id: 'org-1',
                    token_hash: hashMerchantApiKey('pkx_setup_secret', 'pepper'),
                    used_at: null,
                    expires_at: '2026-06-30T00:00:00.000Z',
                }),
            },
            pepper: 'pepper',
            now: () => new Date('2026-07-01T00:00:00.000Z'),
        })).rejects.toMatchObject(new MerchantAuthError(401, 'setup_token_expired'));
    });
});
