import { createShippingHandlers } from '../../../src/cloud/merchantShipments.js';
import {
    createMerchantRouteContext,
    routeParam,
    runMerchantRoute,
} from '../../../src/cloud/merchantPublicRoute.js';

export default async function handler(req, res) {
    return runMerchantRoute(req, res, {
        methods: 'GET',
        handle: (requestId) => {
            const context = createMerchantRouteContext();
            const { getShipment } = createShippingHandlers(context);
            return getShipment({ shipment_id: routeParam(req, 'shipment_id') }, req, requestId);
        },
    });
}
