function requireValue(value, name) {
    if (!value || typeof value !== 'string') {
        throw new Error(`${name} is required`);
    }
    return value;
}

function isLoopbackUrl(parsed) {
    const host = parsed.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || /^127\./.test(host) || host === '::1';
}

// The node sends its LOCAL_NODE_TOKEN as a bearer on every request, so the
// cloud transport MUST be encrypted. Reject a plaintext http:// CLOUD_API_URL
// (which would leak the token on the wire) unless it targets loopback — the
// self-hosted control plane and the offline tests run on http://127.0.0.1.
function normalizeCloudUrl(url) {
    const raw = requireValue(url, 'CLOUD_API_URL').replace(/\/+$/, '');
    let parsed;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error('CLOUD_API_URL must be a valid URL');
    }
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackUrl(parsed))) {
        throw new Error('CLOUD_API_URL must use https (http is only allowed for localhost)');
    }
    return raw;
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

function defaultSleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(attempt, { baseDelayMs, maxDelayMs }) {
    return Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, attempt - 1)));
}

function isRetryableStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
}

function normalizeRetryConfig(retry = {}) {
    return {
        maxAttempts: Math.max(1, Number.parseInt(retry.maxAttempts, 10) || 1),
        baseDelayMs: Math.max(0, Number.parseInt(retry.baseDelayMs, 10) || 250),
        maxDelayMs: Math.max(0, Number.parseInt(retry.maxDelayMs, 10) || 5000),
    };
}

function parseJsonPayload(text) {
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch {
        return { text };
    }
}

export function createLocalNodeClient({
    cloudApiUrl = process.env.CLOUD_API_URL,
    token = process.env.LOCAL_NODE_TOKEN,
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    retry = {
        maxAttempts: process.env.CLOUD_RETRY_MAX_ATTEMPTS,
        baseDelayMs: process.env.CLOUD_RETRY_BASE_DELAY_MS,
        maxDelayMs: process.env.CLOUD_RETRY_MAX_DELAY_MS,
    },
    requestTimeoutMs = Number.parseInt(process.env.CLOUD_REQUEST_TIMEOUT_MS || '0', 10),
} = {}) {
    const baseUrl = normalizeCloudUrl(cloudApiUrl);
    const nodeToken = requireValue(token, 'LOCAL_NODE_TOKEN');
    if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
    const retryConfig = normalizeRetryConfig(retry);
    const timeoutMs = Math.max(0, Number.parseInt(requestTimeoutMs, 10) || 0);

    async function request(path, { method = 'GET', query = null, body = null } = {}) {
        const url = buildUrl(baseUrl, path, query);
        let lastError = null;

        for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt += 1) {
            const controller = timeoutMs > 0 ? new AbortController() : null;
            const timeout = controller
                ? setTimeout(() => controller.abort(), timeoutMs)
                : null;
            const init = {
                method,
                headers: {
                    Authorization: `Bearer ${nodeToken}`,
                    'Content-Type': 'application/json',
                },
            };
            if (controller) init.signal = controller.signal;
            if (body !== null) init.body = JSON.stringify(body);

            try {
                const response = await fetchImpl(url, init);
                const text = await response.text();
                const payload = parseJsonPayload(text);

                if (!response.ok) {
                    const error = new Error(payload?.error || `cloud request failed (${response.status})`);
                    error.status = response.status;
                    error.payload = payload;
                    throw error;
                }

                return payload;
            } catch (error) {
                lastError = error;
                const retryable = !error.status || isRetryableStatus(error.status);
                if (!retryable || attempt >= retryConfig.maxAttempts) throw error;
                await sleep(retryDelay(attempt, retryConfig));
            } finally {
                if (timeout) clearTimeout(timeout);
            }
        }

        throw lastError;
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

        reportCommandResult(commandId, payload) {
            return request('/api/agent/command-result', {
                method: 'POST',
                body: {
                    command_id: commandId,
                    ...payload,
                },
            });
        },
    };
}
