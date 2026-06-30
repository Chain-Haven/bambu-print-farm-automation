import { createLocalNodeAgent } from './localNodeAgent.js';
import { createLocalNodeClient } from './localNodeClient.js';

function requiredString(value, name) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${name} is required`);
    }
    return value.trim();
}

function normalizeCloudUrl(url) {
    return requiredString(url, 'CLOUD_API_URL').replace(/\/+$/, '');
}

function jsonFetchClient({ cloudApiUrl, adminToken, fetchImpl }) {
    const baseUrl = normalizeCloudUrl(cloudApiUrl);
    const token = requiredString(adminToken, 'CLOUD_ADMIN_TOKEN');
    if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');

    async function request(path, body) {
        const response = await fetchImpl(`${baseUrl}${path}`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });
        const text = await response.text();
        const payload = text ? JSON.parse(text) : null;

        if (!response.ok) {
            const message = payload?.message || payload?.error || `cloud request failed (${response.status})`;
            throw new Error(`${path} failed: ${message}`);
        }

        return payload;
    }

    return { request };
}

export async function runCloudSmokeTest({
    cloudApiUrl = process.env.CLOUD_API_URL,
    adminToken = process.env.CLOUD_ADMIN_TOKEN,
    fetchImpl = globalThis.fetch,
    executeCommand = async () => ({ ok: true, smoke: true }),
    organizationName = `PrintKinetix Smoke ${new Date().toISOString()}`,
    nodeName = 'Smoke Windows NUC',
    localPrinterId = 'smoke-printer',
} = {}) {
    const baseUrl = normalizeCloudUrl(cloudApiUrl);
    const admin = jsonFetchClient({ cloudApiUrl: baseUrl, adminToken, fetchImpl });

    const organizationResponse = await admin.request('/api/cloud/organizations', {
        name: requiredString(organizationName, 'organizationName'),
    });
    const organization = organizationResponse?.organization;
    const organizationId = requiredString(organization?.org_id, 'organization.org_id');

    const nodeResponse = await admin.request('/api/cloud/nodes', {
        org_id: organizationId,
        name: requiredString(nodeName, 'nodeName'),
        capabilities: { smoke_test: true },
    });
    const node = nodeResponse?.node;
    const nodeId = requiredString(node?.node_id, 'node.node_id');
    const localNodeToken = requiredString(nodeResponse?.local_node_token, 'local_node_token');

    const client = createLocalNodeClient({
        cloudApiUrl: baseUrl,
        token: localNodeToken,
        fetchImpl,
    });

    await client.sendHeartbeat({
        status: 'online',
        agent_version: 'smoke-test',
        host_info: { runner: 'cloud-smoke-test' },
        capabilities: { smoke_test: true },
    });

    const commandResponse = await admin.request('/api/cloud/commands', {
        org_id: organizationId,
        node_id: nodeId,
        command_type: 'printer.status',
        payload: { local_printer_id: requiredString(localPrinterId, 'localPrinterId') },
    });
    const command = commandResponse?.command;
    const commandId = requiredString(command?.command_id, 'command.command_id');

    const agent = createLocalNodeAgent({ client, executeCommand });
    const agentSummary = await agent.runOnce();

    return {
        ok: agentSummary.claimed === 1 && agentSummary.succeeded === 1 && agentSummary.failed === 0,
        organization_id: organizationId,
        node_id: nodeId,
        command_id: commandId,
        local_node_token_issued: true,
        agent: agentSummary,
    };
}
