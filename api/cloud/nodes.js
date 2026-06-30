import { createCloudNodeProvisionHandler } from '../../src/cloud/adminHandlers.js';
import { createSupabaseRestClient } from '../../src/cloud/supabaseRest.js';

export default function handler(req, res) {
    return createCloudNodeProvisionHandler({
        store: createSupabaseRestClient(),
        adminToken: process.env.CLOUD_ADMIN_TOKEN,
        pepper: process.env.NODE_TOKEN_PEPPER,
    })(req, res);
}
