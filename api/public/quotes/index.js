import { createMerchantQuoteHandler } from '../../../src/cloud/merchantQuoteHandlers.js';
import { createSupabaseRestClient } from '../../../src/cloud/supabaseRest.js';

export default function handler(req, res) {
    return createMerchantQuoteHandler({
        store: createSupabaseRestClient(),
        pepper: process.env.MERCHANT_API_KEY_PEPPER || process.env.NODE_TOKEN_PEPPER,
    })(req, res);
}
