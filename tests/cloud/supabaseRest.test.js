import { describe, expect, it, vi } from 'vitest';
import { createSupabaseRestClient } from '../../src/cloud/supabaseRest.js';

function jsonResponse(payload, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(payload),
    };
}

describe('supabase REST cloud admin methods', () => {
    it('checks cloud setup schema, RPC, and storage readiness', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
        const client = createSupabaseRestClient({
            url: 'https://example.supabase.co',
            serviceKey: 'service-key',
            fetchImpl,
        });

        const status = await client.getCloudSetupStatus();

        expect(status.ready).toBe(true);
        expect(status.checked).toBe(true);
        expect(status.checks).toEqual([
            { name: 'organizations_table', ok: true },
            { name: 'platform_settings_table', ok: true },
            { name: 'platform_admin_users_table', ok: true },
            { name: 'platform_admin_sessions_table', ok: true },
            { name: 'platform_admin_password_resets_table', ok: true },
            { name: 'merchants_table', ok: true },
            { name: 'merchant_api_keys_table', ok: true },
            { name: 'merchant_setup_tokens_table', ok: true },
            { name: 'farm_nodes_table', ok: true },
            { name: 'cloud_printers_table', ok: true },
            { name: 'print_jobs_table', ok: true },
            { name: 'node_commands_table', ok: true },
            { name: 'node_events_table', ok: true },
            { name: 'routing_decisions_table', ok: true },
            { name: 'merchant_usage_events_table', ok: true },
            { name: 'merchant_v2_files_table', ok: true },
            { name: 'merchant_v2_slice_jobs_table', ok: true },
            { name: 'merchant_v2_orders_table', ok: true },
            { name: 'merchant_v2_material_reservations_table', ok: true },
            { name: 'merchant_v2_batches_table', ok: true },
            { name: 'merchant_v2_shipments_table', ok: true },
            { name: 'merchant_v2_webhook_endpoints_table', ok: true },
            { name: 'merchant_v2_realtime_tokens_table', ok: true },
            { name: 'merchant_v2_adapter_events_table', ok: true },
            { name: 'claim_node_commands_rpc', ok: true },
            { name: 'print_artifacts_bucket', ok: true },
        ]);
        expect(fetchImpl.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
            '/rest/v1/organizations',
            '/rest/v1/platform_settings',
            '/rest/v1/platform_admin_users',
            '/rest/v1/platform_admin_sessions',
            '/rest/v1/platform_admin_password_resets',
            '/rest/v1/merchants',
            '/rest/v1/merchant_api_keys',
            '/rest/v1/merchant_setup_tokens',
            '/rest/v1/farm_nodes',
            '/rest/v1/cloud_printers',
            '/rest/v1/print_jobs',
            '/rest/v1/node_commands',
            '/rest/v1/node_events',
            '/rest/v1/routing_decisions',
            '/rest/v1/merchant_usage_events',
            '/rest/v1/merchant_files',
            '/rest/v1/merchant_slice_jobs',
            '/rest/v1/merchant_orders',
            '/rest/v1/merchant_material_reservations',
            '/rest/v1/merchant_batches',
            '/rest/v1/merchant_shipments',
            '/rest/v1/merchant_webhook_endpoints',
            '/rest/v1/merchant_realtime_tokens',
            '/rest/v1/merchant_adapter_events',
            '/rest/v1/rpc/claim_node_commands',
            '/storage/v1/bucket/print-artifacts',
        ]);
        expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({
            apikey: 'service-key',
            Authorization: 'Bearer service-key',
        });
    });

    it('sends modern Supabase secret keys only through the apikey header', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
        const client = createSupabaseRestClient({
            url: 'https://example.supabase.co',
            serviceKey: 'sb_secret_test-key',
            fetchImpl,
        });

        await client.getCloudSetupStatus();

        expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({
            apikey: 'sb_secret_test-key',
        });
        expect(fetchImpl.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
    });

    it('reports schema checks as not ready instead of throwing on missing tables', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(jsonResponse([]))
            .mockResolvedValueOnce(jsonResponse({ message: 'relation does not exist' }, 404));
        const client = createSupabaseRestClient({
            url: 'https://example.supabase.co',
            serviceKey: 'service-key',
            fetchImpl,
        });

        const status = await client.getCloudSetupStatus();

        expect(status.ready).toBe(false);
        expect(status.checked).toBe(true);
        expect(status.checks[0]).toEqual({ name: 'organizations_table', ok: true });
        expect(status.checks[1]).toEqual({
            name: 'platform_settings_table',
            ok: false,
            error: 'Supabase GET /rest/v1/platform_settings?select=key&limit=1 failed (404): {"message":"relation does not exist"}',
        });
    });

    it('creates organizations with return representation enabled', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ org_id: 'org-1', name: 'Bambu Lab' }]));
        const client = createSupabaseRestClient({
            url: 'https://example.supabase.co',
            serviceKey: 'service-key',
            fetchImpl,
        });

        const row = await client.createOrganization({ name: 'Bambu Lab' });

        expect(row).toEqual({ org_id: 'org-1', name: 'Bambu Lab' });
        expect(fetchImpl).toHaveBeenCalledWith(
            expect.stringContaining('/rest/v1/organizations?select='),
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    Prefer: 'return=representation',
                    Authorization: 'Bearer service-key',
                }),
                body: JSON.stringify({ name: 'Bambu Lab' }),
            }),
        );
    });

    it('loads a bounded organization overview through service-role REST requests', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(jsonResponse([{ node_id: 'node-1' }]))
            .mockResolvedValueOnce(jsonResponse([{ printer_id: 'printer-1' }]))
            .mockResolvedValueOnce(jsonResponse([{ job_id: 'job-1' }]))
            .mockResolvedValueOnce(jsonResponse([{ command_id: 'command-1' }]))
            .mockResolvedValueOnce(jsonResponse([{ event_id: 'event-1' }]));
        const client = createSupabaseRestClient({
            url: 'https://example.supabase.co/',
            serviceKey: 'service-key',
            fetchImpl,
        });

        const overview = await client.getCloudOverview({ orgId: 'org-1', limit: 500 });

        expect(overview).toEqual({
            nodes: [{ node_id: 'node-1' }],
            printers: [{ printer_id: 'printer-1' }],
            jobs: [{ job_id: 'job-1' }],
            commands: [{ command_id: 'command-1' }],
            events: [{ event_id: 'event-1' }],
        });
        expect(fetchImpl).toHaveBeenCalledTimes(5);
        expect(fetchImpl.mock.calls[0][0]).toContain('https://example.supabase.co/rest/v1/farm_nodes?');
        expect(fetchImpl.mock.calls[0][0]).toContain('org_id=eq.org-1');
        expect(fetchImpl.mock.calls[0][0]).toContain('limit=100');
        expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({
            apikey: 'service-key',
            Authorization: 'Bearer service-key',
        });
    });

    it('creates node commands with return representation enabled', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ command_id: 'command-1' }]));
        const client = createSupabaseRestClient({
            url: 'https://example.supabase.co',
            serviceKey: 'service-key',
            fetchImpl,
        });
        const command = {
            org_id: 'org-1',
            node_id: 'node-1',
            command_type: 'printer.status',
            payload: {},
        };

        const row = await client.createNodeCommand(command);

        expect(row).toEqual({ command_id: 'command-1' });
        expect(fetchImpl).toHaveBeenCalledWith(
            expect.stringContaining('/rest/v1/node_commands?select='),
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    Prefer: 'return=representation',
                    Authorization: 'Bearer service-key',
                }),
                body: JSON.stringify(command),
            }),
        );
    });

    it('creates farm nodes with hashed tokens only', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ node_id: 'node-1' }]));
        const client = createSupabaseRestClient({
            url: 'https://example.supabase.co',
            serviceKey: 'service-key',
            fetchImpl,
        });
        const node = {
            org_id: 'org-1',
            name: 'NUC 1',
            token_hash: 'hash-only',
            capabilities: {},
        };

        const row = await client.createFarmNode(node);

        expect(row).toEqual({ node_id: 'node-1' });
        expect(fetchImpl).toHaveBeenCalledWith(
            expect.stringContaining('/rest/v1/farm_nodes?select='),
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ Prefer: 'return=representation' }),
                body: JSON.stringify(node),
            }),
        );
    });

    it('updates merchant metadata and finds jobs by idempotency key', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(jsonResponse([{ merchant_id: 'merchant-1', metadata: { webhook: { enabled: true } } }]))
            .mockResolvedValueOnce(jsonResponse([{ job_id: 'job-1', options: { idempotency_key: 'idem-1' } }]));
        const client = createSupabaseRestClient({
            url: 'https://example.supabase.co',
            serviceKey: 'service-key',
            fetchImpl,
        });

        const merchant = await client.updateMerchantMetadata('merchant-1', { webhook: { enabled: true } });
        const job = await client.findMerchantPrintJobByIdempotencyKey({
            merchantId: 'merchant-1',
            idempotencyKey: 'idem-1',
        });

        expect(merchant).toEqual({ merchant_id: 'merchant-1', metadata: { webhook: { enabled: true } } });
        expect(job).toEqual({ job_id: 'job-1', options: { idempotency_key: 'idem-1' } });
        expect(fetchImpl.mock.calls[0][0]).toContain('/rest/v1/merchants?merchant_id=eq.merchant-1&select=');
        expect(fetchImpl.mock.calls[0][1]).toMatchObject({
            method: 'PATCH',
            body: JSON.stringify({ metadata: { webhook: { enabled: true } } }),
        });
        expect(fetchImpl.mock.calls[1][0]).toContain('/rest/v1/print_jobs?');
        expect(fetchImpl.mock.calls[1][0]).toContain('merchant_id=eq.merchant-1');
        expect(fetchImpl.mock.calls[1][0]).toContain('options-%3E%3Eidempotency_key=eq.idem-1');
    });

    it('manages platform admin users, reset tokens, and sessions through service-role REST calls', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(jsonResponse([{ admin_user_id: 'admin-1', email: 'info@chainhaven.co' }]))
            .mockResolvedValueOnce(jsonResponse([{ admin_user_id: 'admin-1', email: 'info@chainhaven.co', password_hash: 'hash' }]))
            .mockResolvedValueOnce(jsonResponse([{ admin_user_id: 'admin-1', email: 'info@chainhaven.co' }]))
            .mockResolvedValueOnce(jsonResponse([{ reset_token_id: 'reset-1' }]))
            .mockResolvedValueOnce(jsonResponse([{ reset_token_id: 'reset-1', token_hash: 'reset-hash' }]))
            .mockResolvedValueOnce(jsonResponse([{ reset_token_id: 'reset-1', used_at: '2026-07-01T12:00:00.000Z' }]))
            .mockResolvedValueOnce(jsonResponse([{ session_id: 'session-1' }]))
            .mockResolvedValueOnce(jsonResponse([{ session_id: 'session-1', token_hash: 'session-hash' }]))
            .mockResolvedValueOnce(jsonResponse([{ session_id: 'session-1', last_used_at: '2026-07-01T12:00:00.000Z' }]))
            .mockResolvedValueOnce(jsonResponse(null, 204))
            .mockResolvedValueOnce(jsonResponse([{ admin_user_id: 'admin-1', last_login_at: '2026-07-01T12:00:00.000Z' }]));
        const client = createSupabaseRestClient({
            url: 'https://example.supabase.co',
            serviceKey: 'service-key',
            fetchImpl,
        });

        await client.upsertPlatformAdminUser({ email: 'info@chainhaven.co', role: 'super_admin', status: 'active' });
        await client.findPlatformAdminByEmail('info@chainhaven.co');
        await client.updatePlatformAdminPassword('admin-1', 'bcrypt-hash');
        await client.createAdminPasswordResetToken({ admin_user_id: 'admin-1', token_prefix: 'pkx_admin_reset_', token_hash: 'reset-hash', expires_at: '2026-07-01T13:00:00.000Z' });
        await client.findAdminPasswordResetTokenByHash('reset-hash');
        await client.markAdminPasswordResetTokenUsed('reset-1', '2026-07-01T12:00:00.000Z');
        await client.createAdminSession({ admin_user_id: 'admin-1', token_prefix: 'pkx_admin_session_', token_hash: 'session-hash', expires_at: '2026-07-08T12:00:00.000Z' });
        await client.findAdminSessionByHash('session-hash');
        await client.touchAdminSession('session-1', '2026-07-01T12:00:00.000Z');
        await client.revokeAdminSessions('admin-1', '2026-07-01T12:00:00.000Z');
        await client.updatePlatformAdminLastLogin('admin-1', '2026-07-01T12:00:00.000Z');

        const urls = fetchImpl.mock.calls.map(([url]) => url);
        expect(urls[0]).toContain('/rest/v1/platform_admin_users?on_conflict=email&select=');
        expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({
            Prefer: 'resolution=merge-duplicates,return=representation',
        });
        expect(urls[1]).toContain('/rest/v1/platform_admin_users?email=eq.info%40chainhaven.co');
        expect(urls[2]).toContain('/rest/v1/platform_admin_users?admin_user_id=eq.admin-1');
        expect(fetchImpl.mock.calls[2][1].body).toBe(JSON.stringify({ password_hash: 'bcrypt-hash' }));
        expect(urls[3]).toContain('/rest/v1/platform_admin_password_resets?select=');
        expect(urls[4]).toContain('token_hash=eq.reset-hash');
        expect(urls[5]).toContain('reset_token_id=eq.reset-1');
        expect(urls[6]).toContain('/rest/v1/platform_admin_sessions?select=');
        expect(urls[7]).toContain('token_hash=eq.session-hash');
        expect(urls[8]).toContain('session_id=eq.session-1');
        expect(urls[9]).toContain('admin_user_id=eq.admin-1');
        expect(urls[9]).toContain('revoked_at=is.null');
        expect(urls[10]).toContain('admin_user_id=eq.admin-1');
    });
});
