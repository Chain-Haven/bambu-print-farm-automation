import { parseJsonBody } from '../../../src/cloud/agentProtocol.js';
import { createShippingHandlers } from '../../../src/cloud/merchantShipments.js';
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
            const { listShipments, createShipment } = createShippingHandlers(context);
            if (req.method === 'GET') return listShipments(routeQuery(req), req, requestId);
            return createShipment(parseJsonBody(req.body), req, requestId);
        },
    });
}
