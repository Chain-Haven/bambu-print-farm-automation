import { describe, expect, it, vi } from 'vitest';
import { createMerchantWebhooksV2Handlers } from '../../src/cloud/merchantWebhooksV2.js';
import { signWebhookPayload } from '../../src/cloud/webhooks.js';

const now = () => new Date('2026-07-01T12:00:00.000Z');

function createMockStore() {
    const endpoints = new Map();
    const deliveries = [];

    return {
        createMerchantWebhookEndpoint: vi.fn().mockImplementation(async (endpoint) => {
            const row = {
                webhook_id: endpoint.webhook_id,
                org_id: endpoint.org_id,
                merchant_id: endpoint.merchant_id,
                url: endpoint.url,
                description: endpoint.description,
                events: endpoint.events,
                secret_hash: endpoint.secret_hash,
                status: endpoint.status,
                last_delivery_at: endpoint.last_delivery_at || null,
                metadata: endpoint.metadata || {},
                created_at: endpoint.created_at,
                updated_at: endpoint.updated_at || endpoint.created_at,
            };
            endpoints.set(row.webhook_id, row);
            return row;
        }),
        listMerchantWebhookEndpoints: vi.fn().mockImplementation(async () => [...endpoints.values()]),
        updateMerchantWebhookEndpoint: vi.fn().mockImplementation(async ({ webhookId, fields }) => {
            const current = endpoints.get(webhookId);
            if (!current) return null;
            const updated = {
                ...current,
                ...fields,
            };
            endpoints.set(webhookId, updated);
            return updated;
        }),
        deleteMerchantWebhookEndpoint: vi.fn().mockImplementation(async ({ webhookId }) => {
            const current = endpoints.get(webhookId);
            if (!current) return null;
            const updated = {
                ...current,
                status: 'disabled',
            };
            endpoints.set(webhookId, updated);
            return updated;
        }),
        createMerchantWebhookDelivery: vi.fn().mockImplementation(async (delivery) => {
            const row = {
                delivery_id: delivery.delivery_id,
                org_id: delivery.org_id,
                merchant_id: delivery.merchant_id,
                webhook_id: delivery.webhook_id,
                event_type: delivery.event_type,
                status: delivery.status,
                request_payload: delivery.request_payload,
                response_status: delivery.response_status || null,
                response_body: delivery.response_body || null,
                attempt_count: delivery.attempt_count,
                next_retry_at: delivery.next_retry_at || null,
                delivered_at: delivery.delivered_at || null,
                metadata: delivery.metadata || {},
                created_at: delivery.created_at,
                updated_at: delivery.updated_at || delivery.created_at,
            };
            deliveries.push(row);
            return row;
        }),
        listMerchantWebhookDeliveries: vi.fn().mockImplementation(async () => deliveries),
    };
}

function createHandlers() {
    const store = createMockStore();
    const authenticateMerchant = vi.fn().mockResolvedValue({
        merchant: {
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            status: 'active',
        },
    });

    return {
        store,
        authenticateMerchant,
        ...createMerchantWebhooksV2Handlers({
            store,
            authenticateMerchant,
            now,
            secretGenerator: () => 'whsec_test_secret_for_task_9',
            signingSecretEncryptionKey: 'test-webhook-signing-secret-key',
            encryptionIvGenerator: () => Buffer.alloc(12, 7),
            idGenerator: () => '11111111-1111-4111-8111-111111111111',
        }),
    };
}

describe('merchant webhooks v2 public handlers', () => {
    it('creates, redacts, patches, tests, and disables webhook endpoints', async () => {
        const {
            createEndpoint,
            listEndpoints,
            getEndpoint,
            updateEndpoint,
            deleteEndpoint,
            testEndpoint,
            store,
        } = createHandlers();

        const created = await createEndpoint({
            url: 'https://merchant.example/webhooks/printkinetix',
            description: 'Fulfillment events',
            events: ['job.created', 'shipment.created'],
            metadata: {
                label: 'primary',
                secret: 'merchant-supplied-secret',
            },
        });
        const list = await listEndpoints();
        const fetched = await getEndpoint({ webhook_id: created.webhook_id });
        const patched = await updateEndpoint({
            webhook_id: created.webhook_id,
            events: ['job.created', 'shipment.created'],
            metadata: {
                label: 'updated',
                webhook_signing_secret: 'attacker-supplied-secret',
                secret: 'metadata-update-secret',
            },
        });
        const testDelivery = await testEndpoint({ webhook_id: created.webhook_id });
        const deleted = await deleteEndpoint({ webhook_id: created.webhook_id });

        expect(created).toMatchObject({
            ok: true,
            status: 'active',
            secret: expect.stringMatching(/^whsec_/),
        });
        expect(created.webhook_id).toBe('11111111-1111-4111-8111-111111111111');
        expect(created).not.toHaveProperty('secret_hash');

        expect(list.endpoints[0]).not.toHaveProperty('secret');
        expect(list.endpoints[0]).not.toHaveProperty('secret_hash');
        expect(fetched).not.toHaveProperty('secret');
        expect(fetched).not.toHaveProperty('secret_hash');
        const publicResponses = { list, fetched, patched, testDelivery, deleted };
        expect(JSON.stringify(publicResponses)).not.toContain('whsec_test_secret');
        expect(JSON.stringify(publicResponses)).not.toContain('secret_hash');
        expect(JSON.stringify(publicResponses)).not.toContain('webhook_signing_secret');
        expect(JSON.stringify(publicResponses)).not.toContain('encrypted_signing_secret');
        expect(JSON.stringify(publicResponses)).not.toContain('merchant-supplied-secret');
        expect(JSON.stringify(publicResponses)).not.toContain('attacker-supplied-secret');
        expect(JSON.stringify(publicResponses)).not.toContain('metadata-update-secret');
        expect(JSON.stringify({ created, ...publicResponses })).not.toContain('merchant-supplied-secret');

        expect(patched).toMatchObject({
            ok: true,
            events: ['job.created', 'shipment.created'],
            status: 'active',
        });
        expect(testDelivery).toMatchObject({
            ok: true,
            status: 'mock_recorded',
            event_type: 'webhook.test',
        });
        expect(deleted).toMatchObject({
            ok: true,
            status: 'disabled',
        });

        const persistedEndpoint = store.createMerchantWebhookEndpoint.mock.calls[0][0];
        expect(persistedEndpoint).toMatchObject({
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            url: 'https://merchant.example/webhooks/printkinetix',
            events: ['job.created', 'shipment.created'],
            status: 'active',
        });
        expect(persistedEndpoint.secret_hash).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
        expect(persistedEndpoint.secret_hash).not.toBe(created.secret);
        expect(JSON.stringify(persistedEndpoint.metadata)).not.toContain(created.secret);
        expect(persistedEndpoint.metadata).toMatchObject({
            label: 'primary',
            webhook_signing_secret: {
                alg: 'aes-256-gcm',
                ciphertext: expect.any(String),
                iv: expect.any(String),
                tag: expect.any(String),
            },
        });
        const metadataPatch = store.updateMerchantWebhookEndpoint.mock.calls.find((call) => (
            call[0].fields?.metadata
        ))[0].fields.metadata;
        expect(metadataPatch).toMatchObject({
            label: 'updated',
            webhook_signing_secret: persistedEndpoint.metadata.webhook_signing_secret,
        });
        expect(JSON.stringify(metadataPatch)).not.toContain(created.secret);
        expect(JSON.stringify(metadataPatch)).not.toContain('attacker-supplied-secret');

        expect(store.deleteMerchantWebhookEndpoint).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            webhookId: created.webhook_id,
        });
        const storedDelivery = store.createMerchantWebhookDelivery.mock.calls[0][0];
        const expectedSignature = signWebhookPayload({
            secret: created.secret,
            timestamp: storedDelivery.metadata.timestamp,
            body: JSON.stringify(storedDelivery.request_payload),
        });
        expect(storedDelivery.metadata.signature).toBe(expectedSignature);
        expect(storedDelivery.metadata.signature).not.toBe(signWebhookPayload({
            secret: persistedEndpoint.secret_hash,
            timestamp: storedDelivery.metadata.timestamp,
            body: JSON.stringify(storedDelivery.request_payload),
        }));
        expect(store.createMerchantWebhookDelivery).toHaveBeenCalledWith(expect.objectContaining({
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            webhook_id: created.webhook_id,
            event_type: 'webhook.test',
            status: 'mock_recorded',
            attempt_count: 1,
            request_payload: expect.objectContaining({
                type: 'webhook.test',
                data: expect.objectContaining({
                    webhook_id: created.webhook_id,
                }),
            }),
            metadata: expect.objectContaining({
                signature: expectedSignature,
                timestamp: '1782907200',
            }),
        }));
    });

    it('throws a public 404 when an endpoint is not found', async () => {
        const { getEndpoint } = createHandlers();

        await expect(getEndpoint({ webhook_id: 'wh_missing' })).rejects.toMatchObject({
            statusCode: 404,
            code: 'webhook_not_found',
        });
    });

    it('exposes thin public route modules for collection, item, and test delivery routes', async () => {
        const [{ default: indexRoute }, { default: itemRoute }, { default: testRoute }] = await Promise.all([
            import('../../api/public/webhooks/index.js'),
            import('../../api/public/webhooks/[webhook_id].js'),
            import('../../api/public/webhooks/[webhook_id]/test.js'),
        ]);

        expect(indexRoute).toEqual(expect.any(Function));
        expect(itemRoute).toEqual(expect.any(Function));
        expect(testRoute).toEqual(expect.any(Function));
    });
});
