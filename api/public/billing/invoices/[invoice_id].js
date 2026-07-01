import { createBillingHandlers } from '../../../../src/cloud/merchantBilling.js';
import {
    createMerchantRouteContext,
    routeParam,
    runMerchantRoute,
} from '../../../../src/cloud/merchantPublicRoute.js';

export default async function handler(req, res) {
    return runMerchantRoute(req, res, {
        methods: 'GET',
        handle: (requestId) => {
            const context = createMerchantRouteContext();
            const { getInvoice } = createBillingHandlers(context);
            return getInvoice({ invoice_id: routeParam(req, 'invoice_id') }, req, requestId);
        },
    });
}
