import { createMerchantWebhooksV2Handlers } from '../../../../../src/cloud/merchantWebhooksV2.js';
import {
    createMerchantRouteContext,
    routeParam,
    routeQuery,
    runMerchantRoute,
} from '../../../../../src/cloud/merchantPublicRoute.js';

export default async function handler(req, res) {
    return runMerchantRoute(req, res, {
        methods: 'GET',
        handle: (requestId) => {
            const context = createMerchantRouteContext();
            const { listDeliveries } = createMerchantWebhooksV2Handlers(context);
            return listDeliveries(
                { webhook_id: routeParam(req, 'webhook_id'), ...routeQuery(req) },
                req,
                requestId,
            );
        },
    });
}
