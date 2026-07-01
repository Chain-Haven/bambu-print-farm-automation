import { createShippingHandlers } from '../../../../src/cloud/merchantShipments.js';
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
            const { createLabel } = createShippingHandlers(context);
            return createLabel({ shipment_id: routeParam(req, 'shipment_id') }, req, requestId);
        },
    });
}
