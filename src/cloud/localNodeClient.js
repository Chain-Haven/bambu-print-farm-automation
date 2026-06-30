function requireValue(value, name) {
    if (!value || typeof value !== 'string') {
        throw new Error(`${name} is required`);
    }
    return value;
}

function normalizeCloudUrl(url) {
    return requireValue(url, 'CLOUD_API_URL').replace(/\/+$/, '');
}

function buildUrl(baseUrl, path, query = null) {
    const url = new URL(`${baseUrl}${path}`);
    if (query) {
        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined && value !== null) {
                url.searchParams.set(key, String(value));
            }
        }
    }
    return url.toString();
}

export function createLocalNodeClient({
    cloudApiUrl = process.env.CLOUD_API_URL,
    token = process.env.LOCAL_NODE_TOKEN,
    fetchImpl = globalThis.fetch,
} = {}) {
    const baseUrl = normalizeCloudUrl(cloudApiUrl);
    const nodeToken = requireValue(token, 'LOCAL_NODE_TOKEN');
    if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');

    async function request(path, { method = 'GET', query = null, body = null } = {}) {
        const init = {
            method,
            headers: {
                Authorization: `Bearer ${nodeToken}`,
                'Content-Type': 'application/json',
            },
        };
        if (body !== null) {
            init.body = JSON.stringify(body);
        }

        const response = await fetchImpl(buildUrl(baseUrl, path, query), init);
        const text = await response.text();
        const payload = text ? JSON.parse(text) : null;

        if (!response.ok) {
            const error = new Error(payload?.error || `cloud request failed (${response.status})`);
            error.status = response.status;
            error.payload = payload;
            throw error;
        }

        return payload;
    }

    return {
        sendHeartbeat(payload) {
            return request('/api/agent/heartbeat', { method: 'POST', body: payload });
        },

        claimCommands({ limit = 10 } = {}) {
            return request('/api/agent/commands', { method: 'GET', query: { limit } });
        },

        sendEvents(events) {
            return request('/api/agent/events', { method: 'POST', body: { events } });
        },
    };
}
