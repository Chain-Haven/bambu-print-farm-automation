import { describe, expect, it, vi } from 'vitest';
import { createMerchantWebhooksV2Handlers } from '../../src/cloud/merchantWebhooksV2.js';
import { signWebhookPayload } from '../../src/cloud/webhooks.js';

const now = () => new Date('2026-07-01T12:00:00.000Z');

function okResponse(status = 200, body = '') {
    return { ok: status >= 200 && status < 300, status, text: async () => body };
}

function createMockStore(overrides = {}) {
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
        getMerchantWebhookEndpoint: vi.fn().mockImplementation(async ({ webhookId }) => endpoints.get(webhookId) || null),
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
        getMerchantWebhookDelivery: vi.fn().mockImplementation(async ({ deliveryId }) => (
            deliveries.find((d) => d.delivery_id === deliveryId) || null
        )),
        updateMerchantWebhookDelivery: vi.fn().mockImplementation(async ({ deliveryId, fields }) => {
            const current = deliveries.find((d) => d.delivery_id === deliveryId);
            if (!current) return null;
            Object.assign(current, fields);
            return current;
        }),
        ...overrides,
    };
}

function createHandlers({
    store: providedStore = null,
    handlerOptions = {},
} = {}) {
    const store = providedStore || createMockStore();
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
            fetchImpl: vi.fn().mockResolvedValue(okResponse(200, '')),
            ...handlerOptions,
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
            status: 'delivered',
            event_type: 'webhook.test',
            response_status: 200,
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
            status: 'delivered',
            response_status: 200,
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

    it('fails closed when the signing secret encryption key is missing', async () => {
        const originalKey = process.env.MERCHANT_WEBHOOK_SIGNING_SECRET_KEY;
        delete process.env.MERCHANT_WEBHOOK_SIGNING_SECRET_KEY;
        try {
            const { createEndpoint, store } = createHandlers({
                handlerOptions: {
                    signingSecretEncryptionKey: undefined,
                    secretPepper: 'api-pepper-must-not-be-used-for-encryption',
                },
            });

            await expect(createEndpoint({
                url: 'https://merchant.example/webhooks/printkinetix',
            })).rejects.toMatchObject({
                statusCode: 500,
                code: 'webhook_signing_secret_key_missing',
            });
            expect(store.createMerchantWebhookEndpoint).not.toHaveBeenCalled();
        } finally {
            if (originalKey === undefined) delete process.env.MERCHANT_WEBHOOK_SIGNING_SECRET_KEY;
            else process.env.MERCHANT_WEBHOOK_SIGNING_SECRET_KEY = originalKey;
        }
    });

    it('uses direct endpoint lookup for item reads, updates, deletes, and tests beyond the first list page', async () => {
        const store = createMockStore();
        const handlers = createHandlers({ store });
        const created = await handlers.createEndpoint({
            url: 'https://merchant.example/webhooks/printkinetix',
            events: ['job.created'],
        });
        store.listMerchantWebhookEndpoints.mockClear();
        store.listMerchantWebhookEndpoints.mockResolvedValue([]);

        await expect(handlers.getEndpoint({ webhook_id: created.webhook_id })).resolves.toMatchObject({
            ok: true,
            webhook_id: created.webhook_id,
        });
        await expect(handlers.updateEndpoint({
            webhook_id: created.webhook_id,
            description: 'Updated endpoint',
        })).resolves.toMatchObject({
            ok: true,
            description: 'Updated endpoint',
        });
        await expect(handlers.testEndpoint({ webhook_id: created.webhook_id })).resolves.toMatchObject({
            ok: true,
            status: 'delivered',
            response_status: 200,
        });
        await expect(handlers.deleteEndpoint({ webhook_id: created.webhook_id })).resolves.toMatchObject({
            ok: true,
            status: 'disabled',
        });

        expect(store.getMerchantWebhookEndpoint).toHaveBeenCalledTimes(4);
        expect(store.getMerchantWebhookEndpoint).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            webhookId: created.webhook_id,
        });
        expect(store.listMerchantWebhookEndpoints).not.toHaveBeenCalled();
    });

    it('rejects disabled test deliveries and malformed encrypted signing metadata safely', async () => {
        const store = createMockStore();
        const handlers = createHandlers({ store });
        const created = await handlers.createEndpoint({
            url: 'https://merchant.example/webhooks/printkinetix',
            events: ['job.created'],
        });

        await handlers.deleteEndpoint({ webhook_id: created.webhook_id });
        await expect(handlers.testEndpoint({ webhook_id: created.webhook_id })).rejects.toMatchObject({
            statusCode: 409,
            code: 'webhook_disabled',
        });

        await store.updateMerchantWebhookEndpoint({
            merchantId: 'merchant-1',
            webhookId: created.webhook_id,
            fields: {
                status: 'active',
                metadata: { webhook_signing_secret: { alg: 'aes-256-gcm' } },
            },
        });
        await expect(handlers.testEndpoint({ webhook_id: created.webhook_id })).rejects.toMatchObject({
            statusCode: 409,
            code: 'webhook_secret_unavailable',
        });
    });

    it('throws a public 404 when an endpoint is not found', async () => {
        const { getEndpoint } = createHandlers();

        await expect(getEndpoint({ webhook_id: 'wh_missing' })).rejects.toMatchObject({
            statusCode: 404,
            code: 'webhook_not_found',
        });
    });

    it('exposes thin public route modules for collection, item, test delivery, deliveries list, and replay routes', async () => {
        const [
            { default: indexRoute },
            { default: itemRoute },
            { default: testRoute },
            { default: deliveriesRoute },
            { default: replayRoute },
        ] = await Promise.all([
            import('../../api/public/webhooks/index.js'),
            import('../../api/public/webhooks/[webhook_id].js'),
            import('../../api/public/webhooks/[webhook_id]/test.js'),
            import('../../api/public/webhooks/[webhook_id]/deliveries/index.js'),
            import('../../api/public/webhooks/[webhook_id]/deliveries/[delivery_id]/replay.js'),
        ]);

        expect(indexRoute).toEqual(expect.any(Function));
        expect(itemRoute).toEqual(expect.any(Function));
        expect(testRoute).toEqual(expect.any(Function));
        expect(deliveriesRoute).toEqual(expect.any(Function));
        expect(replayRoute).toEqual(expect.any(Function));
    });

    it('lists deliveries for an endpoint and replays a failed delivery', async () => {
        const store = createMockStore();
        const handlers = createHandlers({
            store,
            handlerOptions: { fetchImpl: vi.fn().mockResolvedValue(okResponse(200, 'ok')) },
        });
        const created = await handlers.createEndpoint({
            url: 'https://merchant.example/webhooks/printkinetix',
            events: ['job.completed'],
        });

        const list = await handlers.listDeliveries({ webhook_id: created.webhook_id });
        expect(list).toMatchObject({ ok: true });
        expect(Array.isArray(list.deliveries)).toBe(true);

        // Seed a failed delivery manually, then replay it with a succeeding fetch.
        const failed = await store.createMerchantWebhookDelivery({
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            delivery_id: 'delivery-1',
            webhook_id: created.webhook_id,
            event_type: 'job.completed',
            status: 'failed',
            request_payload: { id: 'evt_1', type: 'job.completed', created_at: now().toISOString(), data: { job: { job_id: 'job-1' } } },
            response_status: 500,
            response_body: 'boom',
            attempt_count: 1,
            next_retry_at: now().toISOString(),
            delivered_at: null,
            metadata: { signature: 'v1=x', timestamp: '1782907200', endpoint_url: created.url },
            created_at: now().toISOString(),
            updated_at: now().toISOString(),
        });
        store.getMerchantWebhookDelivery = vi.fn().mockResolvedValue(failed);

        const replayed = await handlers.replayDelivery({ delivery_id: 'delivery-1' });
        expect(replayed).toMatchObject({
            ok: true,
            delivery_id: 'delivery-1',
            status: 'delivered',
            response_status: 200,
            attempt_count: 2,
        });
        expect(store.updateMerchantWebhookDelivery).toHaveBeenCalledWith(expect.objectContaining({
            merchantId: 'merchant-1',
            deliveryId: 'delivery-1',
            fields: expect.objectContaining({ status: 'delivered', attempt_count: 2 }),
        }));
        expect(store.getMerchantWebhookDelivery).toHaveBeenCalledWith({
            merchantId: 'merchant-1',
            deliveryId: 'delivery-1',
        });
    });
});
