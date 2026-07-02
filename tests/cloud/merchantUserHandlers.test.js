import { describe, expect, it, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { createMemoryCloudStore } from '../../src/cloud/memoryCloudStore.js';
import { createMerchantSignupHandler } from '../../src/cloud/merchantHandlers.js';
import {
    createMerchantLoginHandler,
    createMerchantLogoutHandler,
    createMerchantPasswordResetRequestHandler,
    createMerchantPortalMeHandler,
    createMerchantSetPasswordHandler,
} from '../../src/cloud/merchantUserHandlers.js';
import { hashMerchantUserSecret } from '../../src/cloud/merchantUserAuth.js';

const PEPPER = 'unit-pepper';
const now = () => new Date('2026-07-02T12:00:00.000Z');

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

async function signupMerchant(store, { password = 'a-long-portal-password' } = {}) {
    const handler = createMerchantSignupHandler({ store, pepper: PEPPER, now, bcryptCost: 4 });
    const res = createMockResponse();
    await handler({
        method: 'POST',
        body: {
            company_name: 'Widget Store',
            contact_email: 'owner@widgets.example',
            contact_name: 'Wendy Widget',
            password,
        },
    }, res);
    return res;
}

describe('merchant signup with password', () => {
    it('creates the portal owner account alongside the merchant', async () => {
        const store = createMemoryCloudStore({ now });
        const res = await signupMerchant(store);

        expect(res.statusCode).toBe(201);
        expect(res.body.merchant_user).toMatchObject({
            email: 'owner@widgets.example',
            role: 'owner',
            status: 'active',
        });
        expect(JSON.stringify(res.body)).not.toContain('password_hash');

        const stored = await store.findMerchantUserByEmail('owner@widgets.example');
        expect(await bcrypt.compare('a-long-portal-password', stored.password_hash)).toBe(true);
    });

    it('rejects short passwords', async () => {
        const store = createMemoryCloudStore({ now });
        const res = await signupMerchant(store, { password: 'short' });

        expect(res.statusCode).toBe(400);
        expect(res.body.message).toContain('12 characters');
    });

    it('rejects duplicate merchant user emails', async () => {
        const store = createMemoryCloudStore({ now });
        await signupMerchant(store);

        const handler = createMerchantSignupHandler({ store, pepper: PEPPER, now, bcryptCost: 4 });
        const res = createMockResponse();
        await handler({
            method: 'POST',
            body: {
                company_name: 'Widget Store 2',
                contact_email: 'owner@widgets.example',
                password: 'another-long-password',
            },
        }, res);

        expect(res.statusCode).toBe(409);
        expect(res.body.error).toBe('merchant_already_exists');
    });
});

describe('merchant login / session / logout', () => {
    async function loginOwner(store) {
        const handler = createMerchantLoginHandler({
            store,
            pepper: PEPPER,
            now,
            loginRateLimiter: null,
        });
        const res = createMockResponse();
        await handler({
            method: 'POST',
            body: { email: 'OWNER@widgets.example', password: 'a-long-portal-password' },
        }, res);
        return res;
    }

    it('signs in with email/password and returns a one-time session token', async () => {
        const store = createMemoryCloudStore({ now });
        await signupMerchant(store);

        const res = await loginOwner(store);

        expect(res.statusCode).toBe(200);
        expect(res.body.merchant_session_token).toMatch(/^pkx_muser_session_/);
        expect(res.body.merchant_user.email).toBe('owner@widgets.example');
        expect(res.body.merchant.company_name).toBe('Widget Store');
        expect(JSON.stringify(res.body)).not.toContain('password_hash');

        const session = await store.findMerchantUserSessionByHash(
            hashMerchantUserSecret(res.body.merchant_session_token, PEPPER),
        );
        expect(session).toBeTruthy();
    });

    it('rejects bad passwords with a generic error', async () => {
        const store = createMemoryCloudStore({ now });
        await signupMerchant(store);

        const handler = createMerchantLoginHandler({ store, pepper: PEPPER, now, loginRateLimiter: null });
        const res = createMockResponse();
        await handler({
            method: 'POST',
            body: { email: 'owner@widgets.example', password: 'wrong-password-entirely' },
        }, res);

        expect(res.statusCode).toBe(401);
        expect(res.body.error).toBe('invalid_merchant_credentials');
    });

    it('serves the portal session and revokes it on logout', async () => {
        const store = createMemoryCloudStore({ now });
        await signupMerchant(store);
        const login = await loginOwner(store);
        const token = login.body.merchant_session_token;

        const meHandler = createMerchantPortalMeHandler({ store, pepper: PEPPER, now });
        const meRes = createMockResponse();
        await meHandler({ method: 'GET', headers: { authorization: `Bearer ${token}` } }, meRes);
        expect(meRes.statusCode).toBe(200);
        expect(meRes.body.merchant_user.email).toBe('owner@widgets.example');

        const logoutHandler = createMerchantLogoutHandler({ store, pepper: PEPPER, now });
        const logoutRes = createMockResponse();
        await logoutHandler({ method: 'POST', headers: { authorization: `Bearer ${token}` } }, logoutRes);
        expect(logoutRes.statusCode).toBe(200);

        const afterRes = createMockResponse();
        await meHandler({ method: 'GET', headers: { authorization: `Bearer ${token}` } }, afterRes);
        expect(afterRes.statusCode).toBe(401);
        expect(afterRes.body.error).toBe('session_revoked');
    });
});

describe('merchant password reset', () => {
    it('emails a reset link, keeps the response generic, and completes the reset', async () => {
        const store = createMemoryCloudStore({ now });
        await signupMerchant(store);

        const sent = [];
        const mailer = {
            enabled: true,
            send: vi.fn(async (message) => {
                sent.push(message);
                return { sent: true };
            }),
        };
        const requestHandler = createMerchantPasswordResetRequestHandler({
            store,
            pepper: PEPPER,
            now,
            appBaseUrl: 'https://farm.example.com',
            mailer,
            requestRateLimiter: null,
        });
        const requestRes = createMockResponse();
        await requestHandler({
            method: 'POST',
            body: { email: 'owner@widgets.example' },
        }, requestRes);

        expect(requestRes.statusCode).toBe(200);
        expect(JSON.stringify(requestRes.body)).not.toContain('pkx_muser_reset_');
        expect(sent).toHaveLength(1);
        const match = sent[0].text.match(/reset_token=(pkx_muser_reset_[A-Za-z0-9_-]+)/);
        expect(match).toBeTruthy();

        const setHandler = createMerchantSetPasswordHandler({ store, pepper: PEPPER, now, bcryptCost: 4 });
        const setRes = createMockResponse();
        await setHandler({
            method: 'POST',
            body: { reset_token: match[1], password: 'a-brand-new-password' },
        }, setRes);
        expect(setRes.statusCode).toBe(200);

        // The token is one-time.
        const reuseRes = createMockResponse();
        await setHandler({
            method: 'POST',
            body: { reset_token: match[1], password: 'yet-another-password' },
        }, reuseRes);
        expect(reuseRes.statusCode).toBe(401);
        expect(reuseRes.body.error).toBe('reset_token_used');

        // And the new password works.
        const loginHandler = createMerchantLoginHandler({ store, pepper: PEPPER, now, loginRateLimiter: null });
        const loginRes = createMockResponse();
        await loginHandler({
            method: 'POST',
            body: { email: 'owner@widgets.example', password: 'a-brand-new-password' },
        }, loginRes);
        expect(loginRes.statusCode).toBe(200);
    });

    it('responds generically for unknown emails without creating tokens', async () => {
        const store = createMemoryCloudStore({ now });
        const mailer = { enabled: true, send: vi.fn() };
        const handler = createMerchantPasswordResetRequestHandler({
            store,
            pepper: PEPPER,
            now,
            appBaseUrl: 'https://farm.example.com',
            mailer,
            requestRateLimiter: null,
        });
        const res = createMockResponse();

        await handler({ method: 'POST', body: { email: 'nobody@example.com' } }, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(mailer.send).not.toHaveBeenCalled();
    });
});
