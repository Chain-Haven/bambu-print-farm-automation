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
            { name: 'farm_nodes_table', ok: true },
            { name: 'cloud_printers_table', ok: true },
            { name: 'print_jobs_table', ok: true },
            { name: 'node_commands_table', ok: true },
            { name: 'node_events_table', ok: true },
            { name: 'claim_node_commands_rpc', ok: true },
            { name: 'print_artifacts_bucket', ok: true },
        ]);
        expect(fetchImpl.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
            '/rest/v1/organizations',
            '/rest/v1/farm_nodes',
            '/rest/v1/cloud_printers',
            '/rest/v1/print_jobs',
            '/rest/v1/node_commands',
            '/rest/v1/node_events',
            '/rest/v1/rpc/claim_node_commands',
            '/storage/v1/bucket/print-artifacts',
        ]);
        expect(fetchImpl.mock.calls[0][1].headers).toMatchObject({
            apikey: 'service-key',
            Authorization: 'Bearer service-key',
        });
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
            name: 'farm_nodes_table',
            ok: false,
            error: 'Supabase GET /rest/v1/farm_nodes?select=node_id&limit=1 failed (404): {"message":"relation does not exist"}',
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
});
