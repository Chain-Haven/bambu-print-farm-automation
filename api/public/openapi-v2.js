import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const specPath = path.resolve(__dirname, '../../public/openapi/merchant-api-v2.json');

function sendJson(res, statusCode, payload) {
    if (typeof res.setHeader === 'function') {
        res.setHeader('Content-Type', 'application/json');
    }
    if (typeof res.status === 'function') {
        return res.status(statusCode).json(payload);
    }
    res.statusCode = statusCode;
    return res.json(payload);
}

export default function handler(req, res) {
    if (req.method && req.method !== 'GET') {
        if (typeof res.setHeader === 'function') res.setHeader('Allow', 'GET');
        return sendJson(res, 405, {
            ok: false,
            error: 'method_not_allowed',
            message: 'Method not allowed',
        });
    }
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    return sendJson(res, 200, spec);
}
