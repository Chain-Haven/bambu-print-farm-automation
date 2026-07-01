import { createMerchantPrintJobLifecycleHandler } from '../../../src/cloud/merchantLifecycleHandlers.js';
import { createSupabaseRestClient } from '../../../src/cloud/supabaseRest.js';

export default function handler(req, res) {
    return createMerchantPrintJobLifecycleHandler({
        store: createSupabaseRestClient(),
        action: 'approve',
        pepper: process.env.MERCHANT_API_KEY_PEPPER || process.env.NODE_TOKEN_PEPPER,
    })(req, res);
}
