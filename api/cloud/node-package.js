import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCloudNodePackageHandler } from '../../src/cloud/adminHandlers.js';
import { createSupabaseRestClient } from '../../src/cloud/supabaseRest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../..');

export default function handler(req, res) {
    return createCloudNodePackageHandler({
        store: createSupabaseRestClient(),
        adminToken: process.env.CLOUD_ADMIN_TOKEN,
        rootDir,
    })(req, res);
}
