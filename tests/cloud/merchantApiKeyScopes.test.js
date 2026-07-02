import { describe, expect, it } from 'vitest';
import {
    API_KEY_SCOPES,
    buildMerchantApiKeyRecord,
    keyHasScope,
    normalizeScopes,
    requireScope,
    MerchantAuthError,
} from '../../src/cloud/merchantAuth.js';

const merchant = { merchant_id: 'm-1', org_id: 'o-1' };

describe('merchant API key scopes', () => {
    it('normalizes scopes, defaults to ["*"], and rejects unknown scopes', () => {
        expect(normalizeScopes(undefined)).toEqual(['*']);
        expect(normalizeScopes([])).toEqual(['*']);
        expect(normalizeScopes(['print:submit', 'print:read'])).toEqual(['print:submit', 'print:read']);
        expect(normalizeScopes(['Print:Submit', 'print:submit'])).toEqual(['print:submit']);
        expect(() => normalizeScopes(['bogus'])).toThrow(/unsupported api key scope/);
    });

    it('buildMerchantApiKeyRecord stores validated scopes on the record', () => {
        const { record } = buildMerchantApiKeyRecord({
            merchant, name: 'storefront', rawKey: 'pkx_live_secret', pepper: 'p',
            scopes: ['print:submit', 'files:write'],
        });
        expect(record.scopes).toEqual(['print:submit', 'files:write']);
        expect(record.merchant_id).toBe('m-1');
    });

    it('buildMerchantApiKeyRecord defaults to unrestricted when no scopes given', () => {
        const { record } = buildMerchantApiKeyRecord({ merchant, name: 'full', rawKey: 'k', pepper: 'p' });
        expect(record.scopes).toEqual(['*']);
    });

    it('keyHasScope treats ["*"] as unrestricted and otherwise checks membership', () => {
        expect(keyHasScope({ scopes: ['*'] }, 'print:control')).toBe(true);
        expect(keyHasScope({ scopes: ['print:submit'] }, 'print:control')).toBe(false);
        expect(keyHasScope({ scopes: ['print:control'] }, 'print:control')).toBe(true);
        // Missing scopes field falls back to unrestricted for backward compat.
        expect(keyHasScope({}, 'print:control')).toBe(true);
        expect(keyHasScope(null, 'print:control')).toBe(true);
    });

    it('requireScope throws a 403 MerchantAuthError when the scope is missing', () => {
        expect(() => requireScope({ scopes: ['print:read'] }, 'print:control')).toThrow(MerchantAuthError);
        try {
            requireScope({ scopes: ['print:read'] }, 'print:control');
        } catch (error) {
            expect(error.statusCode).toBe(403);
            expect(error.code).toBe('insufficient_scope');
        }
        expect(() => requireScope({ scopes: ['*'] }, 'print:control')).not.toThrow();
    });

    it('exposes a stable, allowlisted scope set', () => {
        expect(API_KEY_SCOPES).toContain('print:control');
        expect(API_KEY_SCOPES).toContain('files:write');
        expect(API_KEY_SCOPES).toContain('*');
    });
});
