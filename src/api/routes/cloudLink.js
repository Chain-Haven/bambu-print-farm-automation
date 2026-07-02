// src/api/routes/cloudLink.js — manage this print server's connection to the
// PrintKinetix cloud control plane from the local dashboard. The node token is
// write-only: GET returns a masked hint, never the stored secret.
import { Router } from 'express';
import { requireAuth, requireAdmin } from '../../auth/auth.js';
import { SettingsModel } from '../../models/Settings.js';
import {
    CLOUD_LINK_SETTING_KEY,
    getCloudAgentStatus,
    isCloudAgentRunning,
    maskNodeToken,
    resolveCloudLinkConfig,
    startCloudAgent,
    stopCloudAgent,
} from '../../cloud/cloudAgentRuntime.js';
import { createLocalNodeClient } from '../../cloud/localNodeClient.js';
import { createLogger } from '../../utils/logger.js';

const router = Router();
const log = createLogger('CloudLink');

function readStoredConfig() {
    const stored = SettingsModel.get(CLOUD_LINK_SETTING_KEY, null);
    return stored && typeof stored === 'object' ? stored : null;
}

function buildStatusPayload() {
    const stored = readStoredConfig();
    const envConfigured = Boolean(process.env.CLOUD_API_URL && process.env.LOCAL_NODE_TOKEN);
    const agent = getCloudAgentStatus();

    return {
        ok: true,
        configured: Boolean(stored?.cloud_api_url && stored?.local_node_token) || envConfigured,
        enabled: stored ? stored.enabled !== false : envConfigured,
        source: stored?.cloud_api_url || stored?.local_node_token ? 'settings' : (envConfigured ? 'env' : null),
        cloud_api_url: stored?.cloud_api_url || process.env.CLOUD_API_URL || null,
        token_hint: maskNodeToken(stored?.local_node_token || process.env.LOCAL_NODE_TOKEN || null),
        mock_mode: process.env.MOCK_MODE === 'true',
        agent,
    };
}

router.get('/', requireAuth, (req, res) => {
    res.json(buildStatusPayload());
});

// Save the link and (re)connect. Body: { cloud_api_url, local_node_token?, enabled? }.
// Omitting local_node_token keeps the stored one, so toggling enabled or fixing
// the URL never requires re-pasting the secret.
router.put('/', requireAuth, requireAdmin, async (req, res) => {
    try {
        const body = req.body || {};
        const stored = readStoredConfig() || {};
        const cloudApiUrl = typeof body.cloud_api_url === 'string' && body.cloud_api_url.trim()
            ? body.cloud_api_url.trim().replace(/\/+$/, '')
            : stored.cloud_api_url || process.env.CLOUD_API_URL || null;
        const token = typeof body.local_node_token === 'string' && body.local_node_token.trim()
            ? body.local_node_token.trim()
            : stored.local_node_token || process.env.LOCAL_NODE_TOKEN || null;
        const enabled = body.enabled !== false;

        if (enabled && (!cloudApiUrl || !token)) {
            return res.status(400).json({ ok: false, error: 'cloud_api_url and local_node_token are required' });
        }

        SettingsModel.set(CLOUD_LINK_SETTING_KEY, {
            cloud_api_url: cloudApiUrl,
            local_node_token: token,
            enabled,
        });

        if (!enabled) {
            await stopCloudAgent();
            return res.json(buildStatusPayload());
        }

        await startCloudAgent({ cloudApiUrl, token, logger: log });
        return res.json(buildStatusPayload());
    } catch (error) {
        log.error(`Cloud link update failed: ${error.message}`);
        return res.status(400).json({ ok: false, error: error.message });
    }
});

// Disconnect and forget the stored link (env-configured deployments fall back
// to env on next restart — the .env file is the operator's to remove).
router.delete('/', requireAuth, requireAdmin, async (req, res) => {
    await stopCloudAgent();
    SettingsModel.remove(CLOUD_LINK_SETTING_KEY);
    res.json(buildStatusPayload());
});

// One-shot connectivity test: sends a heartbeat with the candidate (or stored)
// credentials without touching the running agent.
router.post('/test', requireAuth, async (req, res) => {
    try {
        const body = req.body || {};
        const config = await resolveCloudLinkConfig();
        const cloudApiUrl = (typeof body.cloud_api_url === 'string' && body.cloud_api_url.trim())
            || config?.cloudApiUrl;
        const token = (typeof body.local_node_token === 'string' && body.local_node_token.trim())
            || config?.token;
        if (!cloudApiUrl || !token) {
            return res.status(400).json({ ok: false, error: 'cloud_api_url and local_node_token are required' });
        }

        const client = createLocalNodeClient({ cloudApiUrl, token, requestTimeoutMs: 10000 });
        const result = await client.sendHeartbeat({
            status: 'online',
            agent_version: process.env.npm_package_version || '0.1.0',
            host_info: { test: true },
            capabilities: { connectivity_test: true },
            printers: [],
        });
        return res.json({ ok: true, node: result?.node || null, agent_running: isCloudAgentRunning() });
    } catch (error) {
        return res.status(502).json({ ok: false, error: error.message });
    }
});

export default router;
