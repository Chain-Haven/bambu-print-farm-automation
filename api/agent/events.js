import { createEventsHandler } from '../../src/cloud/agentHandlers.js';
import { createSupabaseRestClient } from '../../src/cloud/supabaseRest.js';

export default function handler(req, res) {
    return createEventsHandler({
        pepper: process.env.NODE_TOKEN_PEPPER,
        store: createSupabaseRestClient(),
    })(req, res);
}
