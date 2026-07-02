import { withCors } from '../../../src/cloud/httpServerUtils.js';
import { createPublicFarmCapabilitiesHandler } from '../../../src/cloud/publicFarmHandlers.js';
import { createSupabaseRestClient } from '../../../src/cloud/supabaseRest.js';

export default withCors(function handler(req, res) {
    return createPublicFarmCapabilitiesHandler({
        store: createSupabaseRestClient(),
    })(req, res);
});
