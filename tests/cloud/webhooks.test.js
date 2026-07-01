import { describe, expect, it, vi } from 'vitest';
import {
    deliverMerchantWebhook,
    normalizeWebhookConfig,
    signWebhookPayload,
} from '../../src/cloud/webhooks.js';

const now = () => new Date('2026-07-01T12:00:00.000Z');

describe('merchant webhooks', () => {
    it('normalizes webhook config with an event allowlist and redacts secrets', () => {
        const config = normalizeWebhookConfig({
            endpoint_url: 'https://merchant.example/webhooks/printkinetix',
            enabled: true,
            secret: 'whsec_test',
            events: ['job.accepted', 'job.shipped', 'unknown.event'],
        });

        expect(config).toEqual({
            endpoint_url: 'https://merchant.example/webhooks/printkinetix',
            enabled: true,
            secret: 'whsec_test',
            events: ['job.accepted', 'job.shipped'],
        });
    });

    it('signs webhook payloads with a stable v1 hmac signature', () => {
        const signature = signWebhookPayload({
            secret: 'whsec_test',
            timestamp: '1782916800',
            body: '{"type":"job.accepted"}',
        });

        expect(signature).toMatch(/^v1=[a-f0-9]{64}$/);
    });

    it('delivers enabled matching webhook events with signature headers', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
        const delivery = await deliverMerchantWebhook({
            merchant: {
                merchant_id: 'merchant-1',
                metadata: {
                    webhook: {
                        endpoint_url: 'https://merchant.example/webhooks/printkinetix',
                        enabled: true,
                        secret: 'whsec_test',
                        events: ['job.accepted'],
                    },
                },
            },
            eventType: 'job.accepted',
            data: { job_id: 'job-1' },
            fetchImpl,
            now,
        });

        expect(delivery.status).toBe('delivered');
        expect(fetchImpl).toHaveBeenCalledWith(
            'https://merchant.example/webhooks/printkinetix',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    'Content-Type': 'application/json',
                    'X-PrintKinetix-Event': 'job.accepted',
                    'X-PrintKinetix-Signature': expect.stringMatching(/^v1=[a-f0-9]{64}$/),
                }),
            }),
        );
    });
});
