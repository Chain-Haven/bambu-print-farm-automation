import { createBillingHandlers } from '../../../src/cloud/merchantBilling.js';
import {
    createMerchantRouteContext,
    runMerchantRoute,
} from '../../../src/cloud/merchantPublicRoute.js';

export default async function handler(req, res) {
    return runMerchantRoute(req, res, {
        methods: 'GET',
        handle: (requestId) => {
            const context = createMerchantRouteContext();
            const { getRateCard } = createBillingHandlers(context);
            return getRateCard({}, req, requestId);
        },
    });
}
