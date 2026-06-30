import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCloudNodePackageHandler } from '../../src/cloud/adminHandlers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../..');

export default function handler(req, res) {
    return createCloudNodePackageHandler({
        adminToken: process.env.CLOUD_ADMIN_TOKEN,
        rootDir,
    })(req, res);
}
