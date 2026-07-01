import { createPublicFarmFilamentsHandler } from '../../../src/cloud/publicFarmHandlers.js';
import { createSupabaseRestClient } from '../../../src/cloud/supabaseRest.js';

export default function handler(req, res) {
    return createPublicFarmFilamentsHandler({
        store: createSupabaseRestClient(),
    })(req, res);
}
