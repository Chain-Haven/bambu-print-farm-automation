import { createMerchantWebhooksHandler } from '../../../src/cloud/merchantWebhookHandlers.js';
import { createSupabaseRestClient } from '../../../src/cloud/supabaseRest.js';

export default function handler(req, res) {
    return createMerchantWebhooksHandler({
        store: createSupabaseRestClient(),
        pepper: process.env.MERCHANT_API_KEY_PEPPER || process.env.NODE_TOKEN_PEPPER,
    })(req, res);
}
