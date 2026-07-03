import { createCloudPrintFilesHandler } from '../../src/cloud/adminPrintHandlers.js';
import { createSupabaseRestClient } from '../../src/cloud/supabaseRest.js';

export default function handler(req, res) {
    return createCloudPrintFilesHandler({
        store: createSupabaseRestClient(),
        adminToken: process.env.CLOUD_ADMIN_TOKEN,
    })(req, res);
}
