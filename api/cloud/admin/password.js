import { createCloudAdminSetPasswordHandler } from '../../../src/cloud/adminAuthHandlers.js';
import { createSupabaseRestClient } from '../../../src/cloud/supabaseRest.js';

export default function handler(req, res) {
    return createCloudAdminSetPasswordHandler({
        store: createSupabaseRestClient(),
        pepper: process.env.ADMIN_SESSION_PEPPER || process.env.NODE_TOKEN_PEPPER,
    })(req, res);
}
