import { createCloudMerchantSettingsHandler } from '../../src/cloud/adminHandlers.js';
import { createSupabaseRestClient } from '../../src/cloud/supabaseRest.js';

export default function handler(req, res) {
    return createCloudMerchantSettingsHandler({
        store: createSupabaseRestClient(),
        adminToken: process.env.CLOUD_ADMIN_TOKEN,
    })(req, res);
}
