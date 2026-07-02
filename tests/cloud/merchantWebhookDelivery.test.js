import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryCloudStore } from '../../src/cloud/memoryCloudStore.js';
import { deliverMerchantWebhookEvent, replayMerchantWebhookDelivery } from '../../src/cloud/merchantWebhookDelivery.js';

const now = () => new Date('2026-07-01T12:00:00.000Z');
const ENCRYPTION_KEY = 'test-webhook-signing-secret-key';

function okResponse(status = 200, body = '') {
    return { ok: status >= 200 && status < 300, status, text: async () => body };
}

// Mirror the v2 handler's AES-256-GCM encryption so the in-memory endpoint has
// a decryptable signing secret.
function encryptWithNodeCrypto(secret, keyMaterial) {
    const key = crypto.createHash('sha256').update(String(keyMaterial), 'utf8').digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return {
        alg: 'aes-256-gcm',
        iv: iv.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
    };
}

function makeStore() {
    const store = createMemoryCloudStore({ now });
    store.createMerchantWebhookEndpoint({
        org_id: 'org-1',
        merchant_id: 'merchant-1',
        webhook_id: 'wh-1',
        url: 'https://merchant.example/hook',
        events: ['job.completed'],
        secret_hash: 'hash',
        status: 'active',
        last_delivery_at: null,
        metadata: {
            webhook_signing_secret: encryptWithNodeCrypto('whsec_secret_one', ENCRYPTION_KEY),
        },
        created_at: now().toISOString(),
        updated_at: now().toISOString(),
    });
    return store;
}

const merchant = { org_id: 'org-1', merchant_id: 'merchant-1' };

describe('merchantWebhookDelivery fan-out', () => {
    it('delivers to active v2 endpoints subscribed to the event and persists a delivery row', async () => {
        const store = makeStore();
        const fetchImpl = vi.fn().mockResolvedValue(okResponse(200, 'ok'));
        const result = await deliverMerchantWebhookEvent({
            store,
            merchant,
            eventType: 'job.completed',
            data: { job: { job_id: 'job-1' } },
            fetchImpl,
            now,
            signingSecretEncryptionKey: ENCRYPTION_KEY,
        });

        expect(result.delivered).toBe(1);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const deliveries = await store.listMerchantWebhookDeliveries({ merchantId: 'merchant-1' });
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0]).toMatchObject({
            webhook_id: 'wh-1',
            event_type: 'job.completed',
            status: 'delivered',
            response_status: 200,
            attempt_count: 1,
        });
    });

    it('skips endpoints not subscribed to the event and records a failed delivery with next_retry_at', async () => {
        const store = makeStore();
        // Add an endpoint subscribed to a different event.
        store.createMerchantWebhookEndpoint({
            org_id: 'org-1', merchant_id: 'merchant-1', webhook_id: 'wh-2',
            url: 'https://merchant.example/other', events: ['job.failed'], secret_hash: 'h',
            status: 'active', last_delivery_at: null,
            metadata: { webhook_signing_secret: encryptWithNodeCrypto('whsec_two', ENCRYPTION_KEY) },
            created_at: now().toISOString(), updated_at: now().toISOString(),
        });
        const fetchImpl = vi.fn().mockResolvedValue(okResponse(500, 'boom'));

        const result = await deliverMerchantWebhookEvent({
            store, merchant, eventType: 'job.completed',
            data: { job: { job_id: 'job-1' } }, fetchImpl, now,
            signingSecretEncryptionKey: ENCRYPTION_KEY,
        });

        // wh-1 accepts job.completed and 500s; wh-2 is skipped (different event).
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(result.delivered).toBe(0);
        const deliveries = await store.listMerchantWebhookDeliveries({ merchantId: 'merchant-1' });
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0]).toMatchObject({ webhook_id: 'wh-1', status: 'failed', response_status: 500 });
        expect(deliveries[0].next_retry_at).toBeTruthy();
    });

    it('replays a failed delivery, increments attempts, and clears next_retry_at on success', async () => {
        const store = makeStore();
        const fetchFail = vi.fn().mockResolvedValue(okResponse(503, 'down'));
        await deliverMerchantWebhookEvent({
            store, merchant, eventType: 'job.completed',
            data: { job: { job_id: 'job-1' } }, fetchImpl: fetchFail, now,
            signingSecretEncryptionKey: ENCRYPTION_KEY,
        });
        const [failed] = await store.listMerchantWebhookDeliveries({ merchantId: 'merchant-1' });
        expect(failed.status).toBe('failed');

        const fetchOk = vi.fn().mockResolvedValue(okResponse(200, 'ok'));
        const replayed = await replayMerchantWebhookDelivery({
            store, merchant, deliveryId: failed.delivery_id,
            fetchImpl: fetchOk, now, signingSecretEncryptionKey: ENCRYPTION_KEY,
        });
        expect(replayed).toMatchObject({ status: 'delivered', response_status: 200, attempt_count: 2 });
        expect(replayed.next_retry_at).toBeNull();
    });
});
