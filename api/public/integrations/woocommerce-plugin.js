import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWooPluginDownloadHandler } from '../../../src/cloud/woocommercePlugin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '../../..');

export default function handler(req, res) {
    return createWooPluginDownloadHandler({ rootDir })(req, res);
}
