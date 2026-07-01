import { createMerchantWebhooksV2Handlers } from '../../../../src/cloud/merchantWebhooksV2.js';
import {
    createMerchantRouteContext,
    routeParam,
    runMerchantRoute,
} from '../../../../src/cloud/merchantPublicRoute.js';

export default async function handler(req, res) {
    return runMerchantRoute(req, res, {
        methods: 'POST',
        handle: (requestId) => {
            const context = createMerchantRouteContext();
            const { testEndpoint } = createMerchantWebhooksV2Handlers(context);
            return testEndpoint({ webhook_id: routeParam(req, 'webhook_id') }, req, requestId);
        },
    });
}
