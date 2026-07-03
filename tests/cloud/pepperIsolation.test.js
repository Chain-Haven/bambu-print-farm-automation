import { describe, expect, it } from 'vitest';
import { createMemoryCloudStore } from '../../src/cloud/memoryCloudStore.js';
import { hashNodeToken } from '../../src/cloud/agentProtocol.js';
import {
    MerchantAuthError,
    authenticateMerchantRequest,
    buildMerchantApiKeyRecord,
    generateMerchantApiKey,
} from '../../src/cloud/merchantAuth.js';
import { createHeartbeatHandler } from '../../src/cloud/agentHandlers.js';

// The pepper story (documented in .env.example): every pkx_* credential is
// stored as sha256("pepper:token"). These tests prove the credential families
// stay isolated — a token peppered for one family can never authenticate
// against another family's pepper, even if the raw secret leaks across.

const NODE_PEPPER = 'node-pepper';
const MERCHANT_PEPPER = 'merchant-pepper';

function createMockResponse() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
        setHeader() {},
    };
}

describe('pepper isolation between credential families', () => {
    it('a merchant key hashed with the merchant pepper does not validate under the node pepper', async () => {
        const store = createMemoryCloudStore();
        const org = await store.createOrganization({ name: 'Pepper Org' });
        const merchant = await store.createMerchant({
            org_id: org.org_id,
            company_name: 'Pepper Co',
            contact_email: 'pepper@example.com',
            status: 'active',
        });

        const rawKey = generateMerchantApiKey();
        const built = buildMerchantApiKeyRecord({
            merchant,
            name: 'Production',
            rawKey,
            pepper: MERCHANT_PEPPER,
        });
        await store.createMerchantApiKey(built.record);

        // Correct pepper: authenticates.
        const context = await authenticateMerchantRequest(
            { headers: { authorization: `Bearer ${rawKey}` } },
            { store, pepper: MERCHANT_PEPPER },
        );
        expect(context.merchant.merchant_id).toBe(merchant.merchant_id);

        // Same raw token under the node pepper: invalid.
        await expect(authenticateMerchantRequest(
            { headers: { authorization: `Bearer ${rawKey}` } },
            { store, pepper: NODE_PEPPER },
        )).rejects.toThrow(MerchantAuthError);
    });

    it('a merchant key can never authenticate as a farm node (agent routes use the node pepper only)', async () => {
        const store = createMemoryCloudStore();
        const org = await store.createOrganization({ name: 'Pepper Org' });
        const merchant = await store.createMerchant({
            org_id: org.org_id,
            company_name: 'Pepper Co',
            contact_email: 'pepper@example.com',
            status: 'active',
        });

        const rawKey = generateMerchantApiKey();
        await store.createMerchantApiKey(buildMerchantApiKeyRecord({
            merchant,
            name: 'Production',
            rawKey,
            pepper: MERCHANT_PEPPER,
        }).record);

        // A real node exists too, provisioned under the node pepper.
        await store.createFarmNode({
            org_id: org.org_id,
            name: 'Real Node',
            token_hash: hashNodeToken('pkx_node_real', NODE_PEPPER),
        });

        const handler = createHeartbeatHandler({ store, pepper: NODE_PEPPER });

        // The merchant key is rejected on the agent channel.
        const res = createMockResponse();
        await handler({
            method: 'POST',
            headers: { authorization: `Bearer ${rawKey}` },
            body: { status: 'online', printers: [] },
        }, res);
        expect(res.statusCode).toBe(403);
        expect(res.body.error).toBe('unknown_agent_token');

        // The real node token still works.
        const ok = createMockResponse();
        await handler({
            method: 'POST',
            headers: { authorization: 'Bearer pkx_node_real' },
            body: { status: 'online', printers: [] },
        }, ok);
        expect(ok.statusCode).toBe(200);
    });

    it('node tokens hashed under different peppers never collide', () => {
        expect(hashNodeToken('pkx_node_same_token', NODE_PEPPER))
            .not.toBe(hashNodeToken('pkx_node_same_token', MERCHANT_PEPPER));
    });
});
