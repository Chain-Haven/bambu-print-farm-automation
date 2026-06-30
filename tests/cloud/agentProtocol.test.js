import { describe, expect, it, vi } from 'vitest';
import {
    getBearerToken,
    hashNodeToken,
    normalizeAgentEvents,
    normalizeHeartbeat,
} from '../../src/cloud/agentProtocol.js';
import {
    createClaimCommandsHandler,
    createEventsHandler,
    createHeartbeatHandler,
} from '../../src/cloud/agentHandlers.js';
import { createLocalNodeClient } from '../../src/cloud/localNodeClient.js';

function createMockResponse() {
    return {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        },
    };
}

describe('agent protocol', () => {
    it('extracts bearer tokens from Vercel-style request headers', () => {
        expect(getBearerToken({ authorization: 'Bearer pkx_node_secret' })).toBe('pkx_node_secret');
        expect(getBearerToken({ Authorization: 'Bearer pkx_node_other' })).toBe('pkx_node_other');
        expect(getBearerToken({ authorization: 'Basic abc' })).toBeNull();
        expect(getBearerToken({})).toBeNull();
    });

    it('hashes node tokens with a server-side pepper', () => {
        const hash = hashNodeToken('pkx_node_secret', 'pepper-a');

        expect(hash).toMatch(/^[a-f0-9]{64}$/);
        expect(hash).toBe(hashNodeToken('pkx_node_secret', 'pepper-a'));
        expect(hash).not.toBe(hashNodeToken('pkx_node_secret', 'pepper-b'));
    });

    it('normalizes heartbeats without trusting arbitrary client fields', () => {
        const heartbeat = normalizeHeartbeat(
            {
                status: 'online',
                agent_version: '1.2.3',
                host_info: { hostname: 'nuc-01', os: 'Windows 11' },
                capabilities: { printers: 12, camera_proxy: true },
                node_id: 'client-spoof',
                org_id: 'client-spoof',
            },
            () => new Date('2026-06-30T22:00:00.000Z'),
        );

        expect(heartbeat).toEqual({
            status: 'online',
            agent_version: '1.2.3',
            host_info: { hostname: 'nuc-01', os: 'Windows 11' },
            capabilities: { printers: 12, camera_proxy: true },
            last_seen_at: '2026-06-30T22:00:00.000Z',
        });
    });

    it('normalizes agent events and drops malformed rows', () => {
        const events = normalizeAgentEvents(
            {
                events: [
                    {
                        event_type: 'printer.status',
                        printer_id: 'printer-1',
                        command_id: 'command-1',
                        payload: { state: 'idle' },
                    },
                    { event_type: '', payload: { ignored: true } },
                    { payload: { ignored: true } },
                ],
            },
            () => new Date('2026-06-30T22:10:00.000Z'),
        );

        expect(events).toEqual([
            {
                event_type: 'printer.status',
                printer_id: 'printer-1',
                command_id: 'command-1',
                payload: { state: 'idle' },
                created_at: '2026-06-30T22:10:00.000Z',
            },
        ]);
    });
});

describe('heartbeat handler', () => {
    it('rejects requests without a bearer token', async () => {
        const handler = createHeartbeatHandler({
            pepper: 'pepper',
            store: {
                findNodeByTokenHash: vi.fn(),
                recordNodeHeartbeat: vi.fn(),
            },
        });
        const res = createMockResponse();

        await handler({ method: 'POST', headers: {}, body: {} }, res);

        expect(res.statusCode).toBe(401);
        expect(res.body).toEqual({ ok: false, error: 'missing_agent_token' });
    });

    it('records a heartbeat for a registered local node', async () => {
        const store = {
            findNodeByTokenHash: vi.fn().mockResolvedValue({
                node_id: 'node-1',
                organization_id: 'org-1',
                name: 'NUC 1',
            }),
            recordNodeHeartbeat: vi.fn().mockResolvedValue(undefined),
        };
        const handler = createHeartbeatHandler({
            pepper: 'pepper',
            store,
            now: () => new Date('2026-06-30T22:05:00.000Z'),
        });
        const res = createMockResponse();

        await handler(
            {
                method: 'POST',
                headers: { authorization: 'Bearer pkx_node_secret' },
                body: {
                    status: 'online',
                    agent_version: '0.1.0',
                    host_info: { hostname: 'print-nuc' },
                    capabilities: { max_concurrent_jobs: 4 },
                },
            },
            res,
        );

        expect(store.findNodeByTokenHash).toHaveBeenCalledWith(hashNodeToken('pkx_node_secret', 'pepper'));
        expect(store.recordNodeHeartbeat).toHaveBeenCalledWith('node-1', {
            status: 'online',
            agent_version: '0.1.0',
            host_info: { hostname: 'print-nuc' },
            capabilities: { max_concurrent_jobs: 4 },
            last_seen_at: '2026-06-30T22:05:00.000Z',
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            ok: true,
            node_id: 'node-1',
            organization_id: 'org-1',
            status: 'online',
        });
    });
});

describe('command claim handler', () => {
    it('claims queued commands for a registered local node', async () => {
        const commands = [
            {
                command_id: 'cmd-1',
                command_type: 'start_job',
                payload: { job_id: 'job-1' },
            },
        ];
        const store = {
            findNodeByTokenHash: vi.fn().mockResolvedValue({
                node_id: 'node-1',
                organization_id: 'org-1',
                name: 'NUC 1',
            }),
            claimNodeCommands: vi.fn().mockResolvedValue(commands),
        };
        const handler = createClaimCommandsHandler({ pepper: 'pepper', store });
        const res = createMockResponse();

        await handler(
            {
                method: 'GET',
                headers: { authorization: 'Bearer pkx_node_secret' },
                query: { limit: '2' },
            },
            res,
        );

        expect(store.findNodeByTokenHash).toHaveBeenCalledWith(hashNodeToken('pkx_node_secret', 'pepper'));
        expect(store.claimNodeCommands).toHaveBeenCalledWith('node-1', 2);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({
            ok: true,
            node_id: 'node-1',
            commands,
        });
    });

    it('caps command claim limits to protect the cloud backend', async () => {
        const store = {
            findNodeByTokenHash: vi.fn().mockResolvedValue({
                node_id: 'node-1',
                organization_id: 'org-1',
            }),
            claimNodeCommands: vi.fn().mockResolvedValue([]),
        };
        const handler = createClaimCommandsHandler({ pepper: 'pepper', store });
        const res = createMockResponse();

        await handler(
            {
                method: 'GET',
                headers: { authorization: 'Bearer pkx_node_secret' },
                query: { limit: '500' },
            },
            res,
        );

        expect(store.claimNodeCommands).toHaveBeenCalledWith('node-1', 50);
        expect(res.body).toEqual({ ok: true, node_id: 'node-1', commands: [] });
    });
});

describe('events handler', () => {
    it('records local node events for cloud visibility', async () => {
        const store = {
            findNodeByTokenHash: vi.fn().mockResolvedValue({
                node_id: 'node-1',
                organization_id: 'org-1',
            }),
            recordNodeEvents: vi.fn().mockResolvedValue(undefined),
        };
        const handler = createEventsHandler({
            pepper: 'pepper',
            store,
            now: () => new Date('2026-06-30T22:15:00.000Z'),
        });
        const res = createMockResponse();

        await handler(
            {
                method: 'POST',
                headers: { authorization: 'Bearer pkx_node_secret' },
                body: {
                    events: [
                        {
                            event_type: 'command.succeeded',
                            printer_id: 'printer-1',
                            command_id: 'command-1',
                            payload: { message: 'started print' },
                        },
                    ],
                },
            },
            res,
        );

        expect(store.recordNodeEvents).toHaveBeenCalledWith(
            {
                node_id: 'node-1',
                organization_id: 'org-1',
            },
            [
                {
                    event_type: 'command.succeeded',
                    printer_id: 'printer-1',
                    command_id: 'command-1',
                    payload: { message: 'started print' },
                    created_at: '2026-06-30T22:15:00.000Z',
                },
            ],
        );
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ ok: true, accepted: 1 });
    });
});

describe('local node client', () => {
    it('sends authenticated outbound requests to the Vercel agent API', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ ok: true }),
            })
            .mockResolvedValueOnce({
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ ok: true, commands: [] }),
            });
        const client = createLocalNodeClient({
            cloudApiUrl: 'https://print.example.com/',
            token: 'pkx_node_secret',
            fetchImpl,
        });

        await client.sendHeartbeat({ status: 'online', agent_version: '0.1.0' });
        await client.claimCommands({ limit: 5 });

        expect(fetchImpl).toHaveBeenNthCalledWith(1, 'https://print.example.com/api/agent/heartbeat', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer pkx_node_secret',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ status: 'online', agent_version: '0.1.0' }),
        });
        expect(fetchImpl).toHaveBeenNthCalledWith(2, 'https://print.example.com/api/agent/commands?limit=5', {
            method: 'GET',
            headers: {
                Authorization: 'Bearer pkx_node_secret',
                'Content-Type': 'application/json',
            },
        });
    });
});
