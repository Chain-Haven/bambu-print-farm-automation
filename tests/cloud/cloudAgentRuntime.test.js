import { afterEach, describe, expect, it } from 'vitest';
import {
    getCloudAgentStatus,
    isCloudAgentRunning,
    maskNodeToken,
    resolveCloudLinkConfig,
    startCloudAgent,
} from '../../src/cloud/cloudAgentRuntime.js';

const ENV_KEYS = ['CLOUD_API_URL', 'LOCAL_NODE_TOKEN'];
const saved = {};

afterEach(() => {
    for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
    }
});

for (const key of ENV_KEYS) saved[key] = process.env[key];

describe('cloud agent runtime', () => {
    it('masks node tokens down to a prefix + suffix hint', () => {
        expect(maskNodeToken('pkx_node_abcdefghijklmnop1234')).toBe('pkx_node_…1234');
        expect(maskNodeToken(null)).toBe(null);
        expect(maskNodeToken('short')).toBe('••••');
    });

    it('reports not running before any agent starts', () => {
        expect(isCloudAgentRunning()).toBe(false);
        expect(getCloudAgentStatus()).toEqual({ running: false });
    });

    it('requires both url and token to start', async () => {
        await expect(startCloudAgent({ cloudApiUrl: 'https://cloud.example' })).rejects.toThrow(/required/);
        await expect(startCloudAgent({ token: 'pkx_node_x' })).rejects.toThrow(/required/);
    });

    it('resolves env config only when both values are present', async () => {
        delete process.env.CLOUD_API_URL;
        delete process.env.LOCAL_NODE_TOKEN;
        expect(await resolveCloudLinkConfig()).toBe(null);

        process.env.CLOUD_API_URL = 'https://cloud.example';
        expect(await resolveCloudLinkConfig()).toBe(null);

        process.env.LOCAL_NODE_TOKEN = 'pkx_node_env_token';
        expect(await resolveCloudLinkConfig()).toEqual({
            cloudApiUrl: 'https://cloud.example',
            token: 'pkx_node_env_token',
            source: 'env',
        });
    });
});
