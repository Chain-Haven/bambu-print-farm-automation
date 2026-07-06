import { describe, expect, it } from 'vitest';
import { createHeartbeatHandler } from '../../src/cloud/agentHandlers.js';
import { createMemoryCloudStore } from '../../src/cloud/memoryCloudStore.js';
import { createLocalNodeClient } from '../../src/cloud/localNodeClient.js';
import { hashNodeToken } from '../../src/cloud/agentProtocol.js';

const PEPPER = 'test-pepper';

function res() {
    return {
        statusCode: 200,
        body: null,
        headers: {},
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
        setHeader(name, value) { this.headers[name] = value; },
    };
}

async function seedNode(store, { status = 'online' } = {}) {
    const org = await store.createOrganization({ name: 'Farm' });
    const token = 'pkx_node_secret_token';
    const node = await store.createFarmNode({
        org_id: org.org_id,
        name: 'NUC',
        token_hash: hashNodeToken(token, PEPPER),
    });
    if (status !== 'online') {
        await store.recordNodeHeartbeat(node.node_id, {
            status, last_seen_at: new Date().toISOString(), agent_version: 'x', host_info: {}, capabilities: {},
        });
    }
    return { org, node, token };
}

describe('agent auth hardening', () => {
    it('rejects a revoked node token even though the row still exists', async () => {
        const store = createMemoryCloudStore();
        const { token } = await seedNode(store, { status: 'revoked' });
        const handler = createHeartbeatHandler({ store, pepper: PEPPER });
        const r = res();

        await handler({ method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '9.9.9.9' }, body: {} }, r);

        expect(r.statusCode).toBe(403);
        expect(r.body.error).toBe('agent_token_revoked');
    });

    it('accepts an active node token', async () => {
        const store = createMemoryCloudStore();
        const { token } = await seedNode(store);
        const handler = createHeartbeatHandler({ store, pepper: PEPPER });
        const r = res();

        await handler({ method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '1.1.1.1' }, body: {} }, r);

        expect(r.statusCode).toBe(200);
        expect(r.body.ok).toBe(true);
    });

    it('findNodeByTokenHash requires an exact hash (no partial/length match)', async () => {
        const store = createMemoryCloudStore();
        const { token } = await seedNode(store);
        const goodHash = hashNodeToken(token, PEPPER);

        expect(await store.findNodeByTokenHash(goodHash)).not.toBeNull();
        expect(await store.findNodeByTokenHash(goodHash.slice(0, -1))).toBeNull(); // shorter
        expect(await store.findNodeByTokenHash(`${goodHash}00`)).toBeNull(); // longer
        expect(await store.findNodeByTokenHash('')).toBeNull();
    });
});

describe('node client transport enforcement', () => {
    it('rejects a plaintext http cloud URL for a remote host', () => {
        expect(() => createLocalNodeClient({ cloudApiUrl: 'http://farm.example.com', token: 't' }))
            .toThrow(/https/);
    });

    it('allows https and loopback http', () => {
        expect(() => createLocalNodeClient({ cloudApiUrl: 'https://farm.example.com', token: 't' })).not.toThrow();
        expect(() => createLocalNodeClient({ cloudApiUrl: 'http://127.0.0.1:4620', token: 't' })).not.toThrow();
        expect(() => createLocalNodeClient({ cloudApiUrl: 'http://localhost:3000', token: 't' })).not.toThrow();
    });
});
