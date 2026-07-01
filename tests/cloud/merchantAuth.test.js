import { describe, expect, it, vi } from 'vitest';
import {
    MerchantAuthError,
    authenticateMerchantRequest,
    buildMerchantApiKeyRecord,
    generateMerchantApiKey,
    getMerchantBearerToken,
    hashMerchantApiKey,
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
        });
        expect(JSON.stringify(payload.record)).not.toContain(rawKey);
    });

    it('extracts bearer tokens from public API request headers', () => {
        expect(getMerchantBearerToken({ authorization: 'Bearer pkx_live_secret' })).toBe('pkx_live_secret');
        expect(getMerchantBearerToken({ Authorization: 'Bearer pkx_live_other' })).toBe('pkx_live_other');
        expect(getMerchantBearerToken({ authorization: 'Basic abc' })).toBeNull();
        expect(getMerchantBearerToken({})).toBeNull();
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
});
