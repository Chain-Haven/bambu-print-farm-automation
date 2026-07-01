import { parseJsonBody } from '../../../src/cloud/agentProtocol.js';
import { createMerchantWebhooksV2Handlers } from '../../../src/cloud/merchantWebhooksV2.js';
import {
    createMerchantRouteContext,
    routeQuery,
    runMerchantRoute,
} from '../../../src/cloud/merchantPublicRoute.js';

export default async function handler(req, res) {
    return runMerchantRoute(req, res, {
        methods: 'GET, POST',
        handle: (requestId) => {
            const context = createMerchantRouteContext();
            const { createEndpoint, listEndpoints } = createMerchantWebhooksV2Handlers(context);
            if (req.method === 'GET') return listEndpoints(routeQuery(req), req, requestId);
            return createEndpoint(parseJsonBody(req.body), req, requestId);
        },
    });
}
