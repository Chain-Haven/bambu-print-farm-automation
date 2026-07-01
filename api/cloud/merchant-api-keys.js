import { createCloudMerchantApiKeysHandler } from '../../src/cloud/adminHandlers.js';
import { createSupabaseRestClient } from '../../src/cloud/supabaseRest.js';

export default function handler(req, res) {
    return createCloudMerchantApiKeysHandler({
        store: createSupabaseRestClient(),
        adminToken: process.env.CLOUD_ADMIN_TOKEN,
        merchantPepper: process.env.MERCHANT_API_KEY_PEPPER || process.env.NODE_TOKEN_PEPPER,
    })(req, res);
}
