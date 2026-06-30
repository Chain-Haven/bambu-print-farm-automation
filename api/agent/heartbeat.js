import { createHeartbeatHandler } from '../../src/cloud/agentHandlers.js';
import { createSupabaseRestClient } from '../../src/cloud/supabaseRest.js';

export default function handler(req, res) {
    return createHeartbeatHandler({
        pepper: process.env.NODE_TOKEN_PEPPER,
        store: createSupabaseRestClient(),
    })(req, res);
}
