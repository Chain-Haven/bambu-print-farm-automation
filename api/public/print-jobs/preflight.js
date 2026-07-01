import { createMerchantPreflightHandler } from '../../../src/cloud/merchantQuoteHandlers.js';
import { createSupabaseRestClient } from '../../../src/cloud/supabaseRest.js';

export default function handler(req, res) {
    return createMerchantPreflightHandler({
        store: createSupabaseRestClient(),
        pepper: process.env.MERCHANT_API_KEY_PEPPER || process.env.NODE_TOKEN_PEPPER,
    })(req, res);
}
