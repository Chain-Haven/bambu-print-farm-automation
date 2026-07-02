import { createMerchantSetPasswordHandler } from '../../../src/cloud/merchantUserHandlers.js';
import { createSupabaseRestClient } from '../../../src/cloud/supabaseRest.js';

export default function handler(req, res) {
    return createMerchantSetPasswordHandler({
        store: createSupabaseRestClient(),
        pepper: process.env.MERCHANT_API_KEY_PEPPER || process.env.NODE_TOKEN_PEPPER,
    })(req, res);
}
