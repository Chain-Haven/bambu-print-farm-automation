import { createStorefrontCancelHandler } from '../../../src/cloud/storefrontHandlers.js';
import { createMailer } from '../../../src/cloud/mailer.js';
import { createSupabaseRestClient } from '../../../src/cloud/supabaseRest.js';

export default function handler(req, res) {
    return createStorefrontCancelHandler({
        store: createSupabaseRestClient(),
        mailer: createMailer(),
    })(req, res);
}
