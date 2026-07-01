import { createBatchHandlers } from '../../../../src/cloud/merchantBatches.js';
import { createMerchantRouteContext, routeParam, runMerchantRoute } from '../../../../src/cloud/merchantPublicRoute.js';

export default async function handler(req, res) {
    return runMerchantRoute(req, res, {
        methods: 'POST',
        handle: (requestId) => {
            const context = createMerchantRouteContext();
            const { pauseBatch } = createBatchHandlers(context);
            return pauseBatch({ batch_id: routeParam(req, 'batch_id') }, req, requestId);
        },
    });
}
