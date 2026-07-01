import { parseJsonBody } from '../../../src/cloud/agentProtocol.js';
import { createRealtimeHandlers } from '../../../src/cloud/merchantRealtime.js';
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
            const { createToken, listTokens } = createRealtimeHandlers(context);
            if (req.method === 'GET') return listTokens(routeQuery(req), req, requestId);
            return createToken(parseJsonBody(req.body), req, requestId);
        },
    });
}
