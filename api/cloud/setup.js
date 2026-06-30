import { createCloudSetupStatusHandler } from '../../src/cloud/adminHandlers.js';
import { createSupabaseRestClient } from '../../src/cloud/supabaseRest.js';

export default function handler(req, res) {
    return createCloudSetupStatusHandler({
        store: createSupabaseRestClient(),
        adminToken: process.env.CLOUD_ADMIN_TOKEN,
        env: process.env,
    })(req, res);
}
