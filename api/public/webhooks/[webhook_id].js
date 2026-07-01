import { parseJsonBody } from '../../../src/cloud/agentProtocol.js';
import { createMerchantWebhooksV2Handlers } from '../../../src/cloud/merchantWebhooksV2.js';
import {
    createMerchantRouteContext,
    routeParam,
    runMerchantRoute,
} from '../../../src/cloud/merchantPublicRoute.js';

export default async function handler(req, res) {
    return runMerchantRoute(req, res, {
        methods: 'GET, PATCH, DELETE',
        handle: (requestId) => {
            const context = createMerchantRouteContext();
            const {
                deleteEndpoint,
                getEndpoint,
                updateEndpoint,
            } = createMerchantWebhooksV2Handlers(context);
            const webhookId = routeParam(req, 'webhook_id');
            if (req.method === 'GET') return getEndpoint({ webhook_id: webhookId }, req, requestId);
            if (req.method === 'DELETE') return deleteEndpoint({ webhook_id: webhookId }, req, requestId);
            return updateEndpoint({
                ...parseJsonBody(req.body),
                webhook_id: webhookId,
            }, req, requestId);
        },
    });
}
