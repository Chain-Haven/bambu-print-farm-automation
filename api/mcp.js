import { createMcpHandler } from '../src/cloud/mcpServer.js';
import { createMailer } from '../src/cloud/mailer.js';
import { createSupabaseRestClient } from '../src/cloud/supabaseRest.js';

export default function handler(req, res) {
    return createMcpHandler({
        store: createSupabaseRestClient(),
        mailer: createMailer(),
    })(req, res);
}
