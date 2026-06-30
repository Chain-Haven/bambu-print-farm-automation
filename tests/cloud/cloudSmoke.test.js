import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadCloudSmokeEnv } from '../../src/cloud/cloudSmokeEnv.js';
import { runCloudSmokeTest } from '../../src/cloud/cloudSmokeTest.js';

const tempRoots = [];

function makeTempRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkx-cloud-smoke-'));
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

describe('cloud smoke test runner', () => {
    it('loads local smoke-test defaults from ignored env files without overriding shell env', () => {
        const cwd = makeTempRoot();
        fs.writeFileSync(path.join(cwd, '.env'), [
            'CLOUD_API_URL=https://env-file.example.com',
            'CLOUD_ADMIN_TOKEN=env-admin',
        ].join('\n'));
        fs.writeFileSync(path.join(cwd, '.env.local'), [
            'CLOUD_API_URL=https://local-file.example.com',
            'NODE_TOKEN_PEPPER=local-pepper',
        ].join('\n'));
        const env = {
            CLOUD_ADMIN_TOKEN: 'shell-admin',
        };

        loadCloudSmokeEnv({ cwd, env });

        expect(env).toEqual({
            CLOUD_API_URL: 'https://env-file.example.com',
            CLOUD_ADMIN_TOKEN: 'shell-admin',
            NODE_TOKEN_PEPPER: 'local-pepper',
        });
    });

    it('provisions a cloud node and proves the local agent command loop through HTTP APIs', async () => {
        const calls = [];
        const fetchImpl = vi.fn(async (url, init = {}) => {
            calls.push({
                url,
                method: init.method || 'GET',
                authorization: init.headers?.Authorization,
                body: init.body ? JSON.parse(init.body) : null,
            });

            if (url === 'https://farm.example.com/api/cloud/organizations') {
                expect(init.headers.Authorization).toBe('Bearer admin-secret');
                return jsonResponse({
                    ok: true,
                    organization: { org_id: 'org-smoke', name: 'Smoke Org' },
                }, 201);
            }

            if (url === 'https://farm.example.com/api/cloud/nodes') {
                expect(init.headers.Authorization).toBe('Bearer admin-secret');
                return jsonResponse({
                    ok: true,
                    node: { node_id: 'node-smoke', org_id: 'org-smoke', name: 'Smoke NUC' },
                    local_node_token: 'pkx_node_smoke_secret',
                }, 201);
            }

            if (url === 'https://farm.example.com/api/agent/heartbeat') {
                expect(init.headers.Authorization).toBe('Bearer pkx_node_smoke_secret');
                return jsonResponse({ ok: true, node_id: 'node-smoke', status: 'online' });
            }

            if (url === 'https://farm.example.com/api/cloud/commands') {
                expect(init.headers.Authorization).toBe('Bearer admin-secret');
                return jsonResponse({
                    ok: true,
                    command: {
                        command_id: 'cmd-smoke',
                        org_id: 'org-smoke',
                        node_id: 'node-smoke',
                        command_type: 'printer.status',
                        payload: { local_printer_id: 'smoke-printer' },
                    },
                }, 201);
            }

            if (url === 'https://farm.example.com/api/agent/commands?limit=10') {
                expect(init.headers.Authorization).toBe('Bearer pkx_node_smoke_secret');
                return jsonResponse({
                    ok: true,
                    commands: [{
                        command_id: 'cmd-smoke',
                        command_type: 'printer.status',
                        payload: { local_printer_id: 'smoke-printer' },
                    }],
                });
            }

            if (url === 'https://farm.example.com/api/agent/command-result') {
                expect(init.headers.Authorization).toBe('Bearer pkx_node_smoke_secret');
                return jsonResponse({ ok: true, command_id: 'cmd-smoke', status: calls.at(-1).body.status });
            }

            throw new Error(`Unexpected request: ${url}`);
        });
        const executeCommand = vi.fn().mockResolvedValue({ state: 'idle', smoke: true });

        const summary = await runCloudSmokeTest({
            cloudApiUrl: 'https://farm.example.com/',
            adminToken: 'admin-secret',
            fetchImpl,
            executeCommand,
            organizationName: 'Smoke Org',
            nodeName: 'Smoke NUC',
            localPrinterId: 'smoke-printer',
        });

        expect(summary).toEqual({
            ok: true,
            organization_id: 'org-smoke',
            node_id: 'node-smoke',
            command_id: 'cmd-smoke',
            local_node_token_issued: true,
            agent: { claimed: 1, succeeded: 1, failed: 0 },
        });
        expect(executeCommand).toHaveBeenCalledWith({
            command_id: 'cmd-smoke',
            command_type: 'printer.status',
            payload: { local_printer_id: 'smoke-printer' },
        });
        expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}${new URL(call.url).search}`)).toEqual([
            'POST /api/cloud/organizations',
            'POST /api/cloud/nodes',
            'POST /api/agent/heartbeat',
            'POST /api/cloud/commands',
            'GET /api/agent/commands?limit=10',
            'POST /api/agent/command-result',
            'POST /api/agent/command-result',
        ]);
    });

    it('requires explicit live cloud credentials before creating smoke data', async () => {
        await expect(runCloudSmokeTest({
            cloudApiUrl: '',
            adminToken: 'admin-secret',
            fetchImpl: vi.fn(),
        })).rejects.toThrow('CLOUD_API_URL is required');

        await expect(runCloudSmokeTest({
            cloudApiUrl: 'https://farm.example.com',
            adminToken: '',
            fetchImpl: vi.fn(),
        })).rejects.toThrow('CLOUD_ADMIN_TOKEN is required');
    });
});
