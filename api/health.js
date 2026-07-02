// Public, unauthenticated liveness endpoint for the PrintKinetix cloud.
// Used by the landing page status badge and external monitors. Intentionally
// lightweight: no Supabase probes (those can time out and cascade), just a
// deterministic "the API is up and answering" signal.
import { withCors } from '../src/cloud/httpServerUtils.js';

function sendJson(res, statusCode, payload) {
    if (typeof res.setHeader === 'function') {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
    }
    if (typeof res.status === 'function' && typeof res.json === 'function') {
        return res.status(statusCode).json(payload);
    }
    res.statusCode = statusCode;
    return res.end(JSON.stringify(payload));
}

function healthHandler(req, res) {
    if (req.method && req.method !== 'GET' && req.method !== 'HEAD') {
        if (typeof res.setHeader === 'function') res.setHeader('Allow', 'GET, HEAD');
        return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
    }

    return sendJson(res, 200, {
        ok: true,
        status: 'operational',
        service: 'printkinetix-cloud',
        time: new Date().toISOString(),
        env: process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
        region: process.env.VERCEL_REGION || null,
        commit: process.env.VERCEL_GIT_COMMIT_SHA ? process.env.VERCEL_GIT_COMMIT_SHA.slice(0, 10) : null,
    });
}

export default withCors(healthHandler);
