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
