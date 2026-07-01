import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalNodeAgent } from '../../src/cloud/localNodeAgent.js';
import { createLocalNodeClient } from '../../src/cloud/localNodeClient.js';
import { createLocalResultOutbox } from '../../src/cloud/localResultOutbox.js';
import { collectNetworkInterfaces, findInterfaceForAddress } from '../../src/cloud/localNetwork.js';

const tempRoots = [];

function makeTempRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkx-node-reliability-'));
    tempRoots.push(root);
    return root;
}

function jsonResponse(payload, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(payload),
    };
}

afterEach(() => {
    while (tempRoots.length) {
        fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
    }
});

describe('local node cloud reliability', () => {
    it('retries transient Vercel agent API failures with bounded backoff', async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(jsonResponse({ ok: false, error: 'temporarily_unavailable' }, 503))
            .mockResolvedValueOnce(jsonResponse({ ok: true, node_id: 'node-1' }));
        const sleep = vi.fn().mockResolvedValue(undefined);
        const client = createLocalNodeClient({
            cloudApiUrl: 'https://print.example.com',
            token: 'pkx_node_secret',
            fetchImpl,
            sleep,
            retry: { maxAttempts: 2, baseDelayMs: 25, maxDelayMs: 100 },
            requestTimeoutMs: 5000,
        });

        const result = await client.sendHeartbeat({ status: 'online' });

        expect(result).toEqual({ ok: true, node_id: 'node-1' });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledWith(25);
        expect(fetchImpl.mock.calls[0][1].signal).toBeDefined();
    });

    it('persists command results locally until Vercel/Supabase accepts them', () => {
        const filePath = path.join(makeTempRoot(), 'cloud-result-outbox.json');
        const outbox = createLocalResultOutbox({
            filePath,
            now: () => new Date('2026-07-01T18:00:00.000Z'),
        });

        const entry = outbox.enqueueCommandResult('cmd-1', {
            status: 'succeeded',
            result: { remote_file_name: 'part.gcode.3mf' },
        });
        const reloaded = createLocalResultOutbox({ filePath });

        expect(reloaded.list()).toEqual([{
            id: entry.id,
            type: 'command_result',
            command_id: 'cmd-1',
            payload: {
                status: 'succeeded',
                result: { remote_file_name: 'part.gcode.3mf' },
            },
            attempts: 0,
            created_at: '2026-07-01T18:00:00.000Z',
            last_attempt_at: null,
            last_error: null,
        }]);

        reloaded.remove(entry.id);
        expect(createLocalResultOutbox({ filePath }).list()).toEqual([]);
    });

    it('defers final command results when cloud reporting is down and flushes them before new claims', async () => {
        const outbox = createLocalResultOutbox({ filePath: path.join(makeTempRoot(), 'outbox.json') });
        const client = {
            claimCommands: vi.fn()
                .mockResolvedValueOnce({ commands: [{ command_id: 'cmd-1', command_type: 'printer.status', payload: {} }] })
                .mockResolvedValueOnce({ commands: [] }),
            reportCommandResult: vi.fn()
                .mockResolvedValueOnce({ ok: true })
                .mockRejectedValueOnce(new Error('cloud unavailable'))
                .mockResolvedValueOnce({ ok: true }),
        };
        const executeCommand = vi.fn().mockResolvedValue({ state: 'idle' });
        const agent = createLocalNodeAgent({
            client,
            executeCommand,
            resultOutbox: outbox,
            logger: { warn: vi.fn(), info: vi.fn() },
        });

        const first = await agent.runOnce();
        expect(first).toMatchObject({ claimed: 1, succeeded: 1, failed: 0, deferred: 1 });
        expect(outbox.list()).toHaveLength(1);

        const second = await agent.runOnce();

        expect(second).toMatchObject({ claimed: 0, flushed: 1, deferred: 0 });
        expect(outbox.list()).toEqual([]);
        expect(client.reportCommandResult).toHaveBeenNthCalledWith(3, 'cmd-1', {
            status: 'succeeded',
            result: { state: 'idle' },
        });
    });

    it('reports Windows network interfaces so operators can see printer-network coverage', () => {
        const interfaces = collectNetworkInterfaces({
            networkInterfaces: () => ({
                Ethernet: [
                    { family: 'IPv4', internal: false, address: '192.168.10.20', netmask: '255.255.255.0', mac: '00:11:22:33:44:55' },
                ],
                WiFi: [
                    { family: 'IPv4', internal: false, address: '10.0.4.12', netmask: '255.255.255.0', mac: '66:77:88:99:aa:bb' },
                    { family: 'IPv6', internal: false, address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', mac: '66:77:88:99:aa:bb' },
                ],
                Loopback: [
                    { family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0', mac: '00:00:00:00:00:00' },
                ],
            }),
        });

        expect(interfaces).toEqual([
            {
                name: 'Ethernet',
                family: 'IPv4',
                address: '192.168.10.20',
                netmask: '255.255.255.0',
                cidr: '192.168.10.20/24',
                mac: '00:11:22:33:44:55',
            },
            {
                name: 'WiFi',
                family: 'IPv4',
                address: '10.0.4.12',
                netmask: '255.255.255.0',
                cidr: '10.0.4.12/24',
                mac: '66:77:88:99:aa:bb',
            },
        ]);
        expect(findInterfaceForAddress('10.0.4.88', interfaces)?.name).toBe('WiFi');
        expect(findInterfaceForAddress('172.16.1.5', interfaces)).toBeNull();
    });
});
