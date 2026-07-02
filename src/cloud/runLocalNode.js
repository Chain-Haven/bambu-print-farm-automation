// src/cloud/runLocalNode.js — packaged farm-node entry point.
//
// Boots the full local print server (Express + WebSocket + RuntimeSupervisor)
// and the cloud agent in ONE process. All of the agent logic lives in
// cloudAgentRuntime.js; server.js auto-starts it from the cloud-link settings
// (DB) or the CLOUD_API_URL / LOCAL_NODE_TOKEN env vars this bundle ships in
// its .env. This file stays as the bundle entry for backward compatibility —
// today it only needs to load env and start the server.
import 'dotenv/config';
import { createLogger } from '../utils/logger.js';

const log = createLogger('CloudNode');

async function main() {
    if (!process.env.CLOUD_API_URL || !process.env.LOCAL_NODE_TOKEN) {
        log.warn('CLOUD_API_URL / LOCAL_NODE_TOKEN not set — starting local-only; connect from the dashboard Cloud Link panel.');
    }
    await import('../../server.js');
}

main().catch((error) => {
    log.error(`Cloud node failed to start: ${error.message}`);
    process.exit(1);
});
