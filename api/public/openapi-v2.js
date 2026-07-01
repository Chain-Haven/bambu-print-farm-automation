import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const specPath = path.resolve(__dirname, '../../public/openapi/merchant-api-v2.json');

export default function handler(_req, res) {
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    if (typeof res.setHeader === 'function') {
        res.setHeader('Content-Type', 'application/json');
    }
    if (typeof res.status === 'function') {
        return res.status(200).json(spec);
    }
    res.statusCode = 200;
    return res.json(spec);
}
