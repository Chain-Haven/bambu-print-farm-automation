import { parseJsonBody } from '../../../src/cloud/agentProtocol.js';
import { createReservationHandlers } from '../../../src/cloud/merchantReservations.js';
import { createMerchantRouteContext, runMerchantRoute } from '../../../src/cloud/merchantPublicRoute.js';

export default async function handler(req, res) {
    return runMerchantRoute(req, res, {
        methods: 'POST',
        successStatus: 201,
        handle: (requestId) => {
            const context = createMerchantRouteContext();
            const { createReservation } = createReservationHandlers(context);
            return createReservation(parseJsonBody(req.body), req, requestId);
        },
    });
}
