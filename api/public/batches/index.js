import { parseJsonBody } from '../../../src/cloud/agentProtocol.js';
import { createBatchHandlers } from '../../../src/cloud/merchantBatches.js';
import { createMerchantRouteContext, runMerchantRoute } from '../../../src/cloud/merchantPublicRoute.js';

export default async function handler(req, res) {
    return runMerchantRoute(req, res, {
        methods: 'POST',
        successStatus: 201,
        handle: (requestId) => {
            const context = createMerchantRouteContext();
            const { createBatch } = createBatchHandlers(context);
            return createBatch(parseJsonBody(req.body), req, requestId);
        },
    });
}
