import { withCors } from '../../../src/cloud/httpServerUtils.js';
import { createPublicFarmFilamentsHandler } from '../../../src/cloud/publicFarmHandlers.js';
import { createSupabaseRestClient } from '../../../src/cloud/supabaseRest.js';

export default withCors(function handler(req, res) {
    return createPublicFarmFilamentsHandler({
        store: createSupabaseRestClient(),
    })(req, res);
});
