import { createBillingHandlers } from '../../../../src/cloud/merchantBilling.js';
import {
    createMerchantRouteContext,
    routeQuery,
    runMerchantRoute,
} from '../../../../src/cloud/merchantPublicRoute.js';

export default async function handler(req, res) {
    return runMerchantRoute(req, res, {
        methods: 'GET',
        handle: (requestId) => {
            const context = createMerchantRouteContext();
            const { listInvoices } = createBillingHandlers(context);
            return listInvoices(routeQuery(req), req, requestId);
        },
    });
}
