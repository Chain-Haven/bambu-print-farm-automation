import { withCors } from '../../src/cloud/httpServerUtils.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const v1SpecPath = path.resolve(__dirname, '../../public/openapi/merchant-api-v1.json');
const v2SpecPath = path.resolve(__dirname, '../../public/openapi/merchant-api-v2.json');

function sendJson(res, statusCode, payload) {
    if (typeof res.setHeader === 'function') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'public, max-age=300');
    }
    if (typeof res.status === 'function' && typeof res.json === 'function') {
        return res.status(statusCode).json(payload);
    }
    res.statusCode = statusCode;
    return res.end(JSON.stringify(payload));
}

function summarize(spec) {
    if (!spec) return null;
    return {
        openapi: spec.openapi,
        title: spec.info?.title,
        version: spec.info?.version,
        path_count: spec.paths ? Object.keys(spec.paths).length : 0,
    };
}

// Public OpenAPI index: points clients at the v1 and v2 specs (static JSON)
// and the live v2 route, so the "Live OpenAPI index" link on the landing page
// resolves instead of 404ing.
export default withCors(function handler(req, res) {
    if (req.method && req.method !== 'GET') {
        if (typeof res.setHeader === 'function') res.setHeader('Allow', 'GET');
        return sendJson(res, 405, {
            ok: false,
            error: 'method_not_allowed',
        });
    }

    const base = `https://${req.headers?.host || 'bambu-print-farm-automation.vercel.app'}`;
    let v1 = null;
    let v2 = null;
    try { v1 = JSON.parse(fs.readFileSync(v1SpecPath, 'utf8')); } catch { /* v1 spec optional */ }
    try { v2 = JSON.parse(fs.readFileSync(v2SpecPath, 'utf8')); } catch { /* v2 spec optional */ }

    return sendJson(res, 200, {
        ok: true,
        service: 'printkinetix-merchant-api',
        specs: {
            v1: { ...summarize(v1), url: `${base}/openapi/merchant-api-v1.json` },
            v2: { ...summarize(v2), url: `${base}/openapi/merchant-api-v2.json`, live_route: `${base}/api/public/openapi-v2` },
        },
        docs_url: `${base}/merchant-api.html`,
    });
});
