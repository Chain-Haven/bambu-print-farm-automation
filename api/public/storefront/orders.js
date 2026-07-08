import { createStorefrontOrderStatusHandler } from '../../../src/cloud/storefrontHandlers.js';
import { createSupabaseRestClient } from '../../../src/cloud/supabaseRest.js';

export default function handler(req, res) {
    return createStorefrontOrderStatusHandler({ store: createSupabaseRestClient() })(req, res);
}
