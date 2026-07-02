import { parseJsonBody } from '../../../../../../src/cloud/agentProtocol.js';
import { createMerchantWebhooksV2Handlers } from '../../../../../../src/cloud/merchantWebhooksV2.js';
import {
    createMerchantRouteContext,
    routeParam,
    runMerchantRoute,
} from '../../../../../../src/cloud/merchantPublicRoute.js';

export default async function handler(req, res) {
    return runMerchantRoute(req, res, {
        methods: 'POST',
        handle: (requestId) => {
            const context = createMerchantRouteContext();
            const { replayDelivery } = createMerchantWebhooksV2Handlers(context);
            return replayDelivery(
                {
                    ...parseJsonBody(req.body),
                    webhook_id: routeParam(req, 'webhook_id'),
                    delivery_id: routeParam(req, 'delivery_id'),
                },
                req,
                requestId,
            );
        },
    });
}
