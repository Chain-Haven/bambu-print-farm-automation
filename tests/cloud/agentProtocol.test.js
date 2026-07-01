import { describe, expect, it, vi } from 'vitest';
import {
    getBearerToken,
    hashNodeToken,
    normalizeAgentEvents,
    normalizeCommandResult,
    normalizeHeartbeat,
} from '../../src/cloud/agentProtocol.js';
import {
    createClaimCommandsHandler,
    createCommandResultHandler,
    createEventsHandler,
    createHeartbeatHandler,
} from '../../src/cloud/agentHandlers.js';
import { createLocalNodeAgent } from '../../src/cloud/localNodeAgent.js';
import { createLocalNodeClient } from '../../src/cloud/localNodeClient.js';
import { executeCloudCommand } from '../../src/cloud/localCommandExecutor.js';

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

    it('normalizes command results without trusting node or org fields', () => {
        const result = normalizeCommandResult(
            {
                command_id: 'command-1',
                status: 'succeeded',
                result: { started: true },
                error: 'ignored on success',
                node_id: 'spoof',
            },
            () => new Date('2026-06-30T22:20:00.000Z'),
        );

        expect(result).toEqual({
            command_id: 'command-1',
            status: 'succeeded',
            result: { started: true },
            error: null,
            finished_at: '2026-06-30T22:20:00.000Z',
        });
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

describe('command result handler', () => {
    it('records command lifecycle updates for a registered local node', async () => {
        const store = {
            findNodeByTokenHash: vi.fn().mockResolvedValue({
                node_id: 'node-1',
                organization_id: 'org-1',
            }),
            recordCommandResult: vi.fn().mockResolvedValue(undefined),
        };
        const handler = createCommandResultHandler({
            pepper: 'pepper',
            store,
            now: () => new Date('2026-06-30T22:25:00.000Z'),
        });
        const res = createMockResponse();

        await handler(
            {
                method: 'POST',
                headers: { authorization: 'Bearer pkx_node_secret' },
                body: {
                    command_id: 'command-1',
                    status: 'failed',
                    error: 'printer offline',
                    result: { ignored: true },
                },
            },
            res,
        );

        expect(store.recordCommandResult).toHaveBeenCalledWith('node-1', {
            command_id: 'command-1',
            status: 'failed',
            result: null,
            error: 'printer offline',
            finished_at: '2026-06-30T22:25:00.000Z',
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ ok: true, command_id: 'command-1', status: 'failed' });
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

describe('local command executor', () => {
    it('returns local printer status using the existing runtime worker', async () => {
        const worker = {
            state: 'idle',
            connected: true,
            latestStatus: { state: 'idle', bed_temp: 25 },
            getPreflightStatus: vi.fn().mockReturnValue({ ok: true, state: 'idle' }),
        };

        const result = await executeCloudCommand(
            {
                command_id: 'cmd-1',
                command_type: 'printer.status',
                payload: { local_printer_id: 'local-printer-1' },
            },
            {
                getWorker: vi.fn().mockReturnValue(worker),
            },
        );

        expect(result).toEqual({
            state: 'idle',
            connected: true,
            status: { state: 'idle', bed_temp: 25 },
            preflight: { ok: true, state: 'idle' },
        });
    });

    it('starts an existing local job through JobOrchestrator', async () => {
        const startJob = vi.fn().mockResolvedValue({ job: { job_id: 'local-job-1', status: 'printing' } });

        const result = await executeCloudCommand(
            {
                command_id: 'cmd-2',
                command_type: 'job.start',
                payload: { local_job_id: 'local-job-1' },
            },
            { startJob },
        );

        expect(startJob).toHaveBeenCalledWith('local-job-1');
        expect(result).toEqual({ job: { job_id: 'local-job-1', status: 'printing' } });
    });
});

describe('local node agent', () => {
    it('claims commands, executes them locally, and reports running plus final states', async () => {
        const client = {
            claimCommands: vi.fn().mockResolvedValue({
                commands: [{ command_id: 'cmd-1', command_type: 'printer.status', payload: {} }],
            }),
            reportCommandResult: vi.fn().mockResolvedValue({ ok: true }),
        };
        const executeCommand = vi.fn().mockResolvedValue({ state: 'idle' });
        const agent = createLocalNodeAgent({ client, executeCommand });

        const summary = await agent.runOnce();

        expect(client.claimCommands).toHaveBeenCalledWith({ limit: 10 });
        expect(client.reportCommandResult).toHaveBeenNthCalledWith(1, 'cmd-1', { status: 'running' });
        expect(client.reportCommandResult).toHaveBeenNthCalledWith(2, 'cmd-1', {
            status: 'succeeded',
            result: { state: 'idle' },
        });
        expect(summary).toEqual({ claimed: 1, succeeded: 1, failed: 0, deferred: 0, flushed: 0 });
    });

    it('reports failed command execution back to the cloud', async () => {
        const client = {
            claimCommands: vi.fn().mockResolvedValue({
                commands: [{ command_id: 'cmd-1', command_type: 'printer.status', payload: {} }],
            }),
            reportCommandResult: vi.fn().mockResolvedValue({ ok: true }),
        };
        const executeCommand = vi.fn().mockRejectedValue(new Error('printer offline'));
        const agent = createLocalNodeAgent({ client, executeCommand });

        const summary = await agent.runOnce();

        expect(client.reportCommandResult).toHaveBeenNthCalledWith(2, 'cmd-1', {
            status: 'failed',
            error: 'printer offline',
        });
        expect(summary).toEqual({ claimed: 1, succeeded: 0, failed: 1, deferred: 0, flushed: 0 });
    });
});
