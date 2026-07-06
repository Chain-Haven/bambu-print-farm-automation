import { createCloudStatsHandler } from '../../src/cloud/adminOpsHandlers.js';
import { createSupabaseRestClient } from '../../src/cloud/supabaseRest.js';

export default function handler(req, res) {
    return createCloudStatsHandler({
        store: createSupabaseRestClient(),
        adminToken: process.env.CLOUD_ADMIN_TOKEN,
    })(req, res);
}
