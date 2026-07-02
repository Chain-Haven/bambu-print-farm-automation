import { parseJsonBody } from '../../../../src/cloud/agentProtocol.js';
import { createMerchantPrintJobControlHandler } from '../../../../src/cloud/merchantLifecycleHandlers.js';
import { createSupabaseRestClient } from '../../../../src/cloud/supabaseRest.js';

export default function handler(req, res) {
    const handlerFn = createMerchantPrintJobControlHandler({
        store: createSupabaseRestClient(),
        pepper: process.env.MERCHANT_API_KEY_PEPPER || process.env.NODE_TOKEN_PEPPER,
    });
    // Merge the path param into the JSON body so the handler reads a single job_id.
    const mergedReq = {
        ...req,
        body: { ...(isPlainObject(req.body) ? req.body : parseJsonBody(req.body)), job_id: req.query?.job_id },
    };
    return handlerFn(mergedReq, res);
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
