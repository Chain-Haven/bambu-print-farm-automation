import { createBatchHandlers } from '../../../src/cloud/merchantBatches.js';
import { createMerchantRouteContext, routeParam, runMerchantRoute } from '../../../src/cloud/merchantPublicRoute.js';

export default async function handler(req, res) {
    return runMerchantRoute(req, res, {
        methods: 'GET',
        handle: (requestId) => {
            const context = createMerchantRouteContext();
            const { getBatch } = createBatchHandlers(context);
            return getBatch({ batch_id: routeParam(req, 'batch_id') }, req, requestId);
        },
    });
}
