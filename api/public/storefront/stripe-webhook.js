import { createStorefrontStripeWebhookHandler } from '../../../src/cloud/storefrontHandlers.js';
import { createSupabaseRestClient } from '../../../src/cloud/supabaseRest.js';

export default function handler(req, res) {
    return createStorefrontStripeWebhookHandler({ store: createSupabaseRestClient() })(req, res);
}
