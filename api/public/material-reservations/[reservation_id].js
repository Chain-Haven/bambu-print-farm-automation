import { createReservationHandlers } from '../../../src/cloud/merchantReservations.js';
import { createMerchantRouteContext, routeParam, runMerchantRoute } from '../../../src/cloud/merchantPublicRoute.js';

export default async function handler(req, res) {
    return runMerchantRoute(req, res, {
        methods: 'GET',
        handle: (requestId) => {
            const context = createMerchantRouteContext();
            const { getReservation } = createReservationHandlers(context);
            return getReservation({ reservation_id: routeParam(req, 'reservation_id') }, req, requestId);
        },
    });
}
