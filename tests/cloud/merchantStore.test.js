import { describe, expect, it, vi } from 'vitest';
import { createSupabaseRestClient } from '../../src/cloud/supabaseRest.js';

function jsonResponse(payload, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(payload),
    };
}

describe('merchant Supabase store methods', () => {
    it('loads and upserts platform settings as JSON values', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(jsonResponse([{ key: 'full_auto_merchant_mode', value: { enabled: false } }]))
            .mockResolvedValueOnce(jsonResponse([{ key: 'full_auto_merchant_mode', value: { enabled: true } }]));
        const client = createSupabaseRestClient({
            url: 'https://example.supabase.co',
            serviceKey: 'service-key',
            fetchImpl,
        });

        const setting = await client.getPlatformSetting('full_auto_merchant_mode', { enabled: false });
        const updated = await client.upsertPlatformSetting('full_auto_merchant_mode', { enabled: true });

        expect(setting).toEqual({ enabled: false });
        expect(updated).toEqual({ key: 'full_auto_merchant_mode', value: { enabled: true } });
        expect(fetchImpl.mock.calls[0][0]).toContain('/rest/v1/platform_settings?');
        expect(fetchImpl.mock.calls[0][0]).toContain('key=eq.full_auto_merchant_mode');
        expect(fetchImpl.mock.calls[1][0]).toContain('/rest/v1/platform_settings?on_conflict=key&select=');
        expect(fetchImpl.mock.calls[1][1]).toMatchObject({
            method: 'POST',
            headers: expect.objectContaining({
                Prefer: 'resolution=merge-duplicates,return=representation',
            }),
            body: JSON.stringify({
                key: 'full_auto_merchant_mode',
                value: { enabled: true },
            }),
        });
    });

    it('creates merchants without trusting client-controlled status changes elsewhere', async () => {
        const merchant = {
            merchant_id: 'merchant-1',
            org_id: 'org-1',
            company_name: 'Widget Store',
            contact_email: 'ops@example.com',
            status: 'pending',
        };
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([merchant], 201));
        const client = createSupabaseRestClient({
            url: 'https://example.supabase.co',
            serviceKey: 'service-key',
            fetchImpl,
        });

        const row = await client.createMerchant({
            org_id: 'org-1',
            company_name: 'Widget Store',
            contact_email: 'ops@example.com',
            contact_name: 'Ops Lead',
            website: 'https://example.com',
            status: 'pending',
            metadata: { source: 'signup' },
        });

        expect(row).toEqual(merchant);
        expect(fetchImpl).toHaveBeenCalledWith(
            expect.stringContaining('/rest/v1/merchants?select='),
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ Prefer: 'return=representation' }),
                body: JSON.stringify({
                    org_id: 'org-1',
                    company_name: 'Widget Store',
                    contact_email: 'ops@example.com',
                    contact_name: 'Ops Lead',
                    website: 'https://example.com',
                    status: 'pending',
                    metadata: { source: 'signup' },
                }),
            }),
        );
    });

    it('stores merchant API keys by hash and never requires raw key storage', async () => {
        const apiKey = {
            key_id: 'key-1',
            merchant_id: 'merchant-1',
            org_id: 'org-1',
            name: 'Production',
            key_prefix: 'pkx_live_abc123',
            created_at: '2026-07-01T00:00:00.000Z',
            revoked_at: null,
        };
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(jsonResponse([apiKey], 201))
            .mockResolvedValueOnce(jsonResponse([{ ...apiKey, key_hash: 'hash-only' }]));
        const client = createSupabaseRestClient({
            url: 'https://example.supabase.co',
            serviceKey: 'service-key',
            fetchImpl,
        });

        const created = await client.createMerchantApiKey({
            merchant_id: 'merchant-1',
            org_id: 'org-1',
            name: 'Production',
            key_prefix: 'pkx_live_abc123',
            key_hash: 'hash-only',
        });
        const found = await client.findMerchantApiKeyByHash('hash-only');

        expect(created).toEqual(apiKey);
        expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
            merchant_id: 'merchant-1',
            org_id: 'org-1',
            name: 'Production',
            key_prefix: 'pkx_live_abc123',
            key_hash: 'hash-only',
        });
        expect(JSON.stringify(fetchImpl.mock.calls[0][1].body)).not.toContain('pkx_live_secret');
        expect(fetchImpl.mock.calls[1][0]).toContain('/rest/v1/merchant_api_keys?');
        expect(fetchImpl.mock.calls[1][0]).toContain('key_hash=eq.hash-only');
        expect(fetchImpl.mock.calls[1][0]).toContain('revoked_at=is.null');
        expect(found).toEqual({ ...apiKey, key_hash: 'hash-only' });
    });

    it('creates merchant-scoped files, jobs, routing decisions, commands, and usage events', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(jsonResponse([{ file_id: 'file-1', merchant_id: 'merchant-1' }], 201))
            .mockResolvedValueOnce(jsonResponse([{ job_id: 'job-1', merchant_id: 'merchant-1', status: 'queued' }], 201))
            .mockResolvedValueOnce(jsonResponse([{ decision_id: 'decision-1', job_id: 'job-1' }], 201))
            .mockResolvedValueOnce(jsonResponse([{ command_id: 'command-1', job_id: 'job-1' }], 201))
            .mockResolvedValueOnce(jsonResponse([{ usage_event_id: 'usage-1', job_id: 'job-1' }], 201));
        const client = createSupabaseRestClient({
            url: 'https://example.supabase.co',
            serviceKey: 'service-key',
            fetchImpl,
        });

        await client.createJobFile({
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            storage_path: 'org-1/merchant-1/job-1/file.gcode',
            original_name: 'file.gcode',
            content_type: 'text/plain',
            byte_size: 123,
            checksum_sha256: 'abc',
            file_mode: 'ready_to_print',
        });
        await client.createPrintJob({
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            file_id: 'file-1',
            name: 'Order 1001',
            status: 'queued',
            options: { material: 'PLA' },
        });
        await client.createRoutingDecision({
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            job_id: 'job-1',
            selected_node_id: 'node-1',
            selected_printer_id: 'printer-1',
            status: 'routed',
            strategy: 'fastest_fulfillment',
            score: { queue_depth: 0 },
            rejected_candidates: [],
        });
        await client.createNodeCommand({
            org_id: 'org-1',
            node_id: 'node-1',
            printer_id: 'printer-1',
            job_id: 'job-1',
            command_type: 'cloud.print.ready',
            payload: { file_id: 'file-1' },
        });
        await client.createMerchantUsageEvent({
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            job_id: 'job-1',
            file_id: 'file-1',
            event_type: 'job.submitted',
            quantity: 1,
            metrics: { byte_size: 123 },
        });

        expect(fetchImpl.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
            '/rest/v1/job_files',
            '/rest/v1/print_jobs',
            '/rest/v1/routing_decisions',
            '/rest/v1/node_commands',
            '/rest/v1/merchant_usage_events',
        ]);
        expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({
            merchant_id: 'merchant-1',
            file_mode: 'ready_to_print',
        });
        expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toMatchObject({
            merchant_id: 'merchant-1',
            status: 'queued',
        });
    });
});
