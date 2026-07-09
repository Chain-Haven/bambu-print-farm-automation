import { createHeartbeatHandler } from '../../src/cloud/agentHandlers.js';
import { createMailer } from '../../src/cloud/mailer.js';
import { createSupabaseRestClient } from '../../src/cloud/supabaseRest.js';

export default function handler(req, res) {
    return createHeartbeatHandler({
        pepper: process.env.NODE_TOKEN_PEPPER,
        store: createSupabaseRestClient(),
        mailer: createMailer(),
    })(req, res);
}
