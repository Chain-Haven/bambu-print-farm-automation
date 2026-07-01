import { createCloudAdminBootstrapHandler } from '../../../src/cloud/adminAuthHandlers.js';
import { createSupabaseRestClient } from '../../../src/cloud/supabaseRest.js';

export default function handler(req, res) {
    return createCloudAdminBootstrapHandler({
        store: createSupabaseRestClient(),
        bootstrapToken: process.env.CLOUD_ADMIN_TOKEN,
        pepper: process.env.ADMIN_SESSION_PEPPER || process.env.NODE_TOKEN_PEPPER,
    })(req, res);
}
