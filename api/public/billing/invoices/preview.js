import { parseJsonBody } from '../../../../src/cloud/agentProtocol.js';
import { createBillingHandlers } from '../../../../src/cloud/merchantBilling.js';
import {
    createMerchantRouteContext,
    runMerchantRoute,
} from '../../../../src/cloud/merchantPublicRoute.js';

export default async function handler(req, res) {
    return runMerchantRoute(req, res, {
        methods: 'POST',
        handle: (requestId) => {
            const context = createMerchantRouteContext();
            const { previewInvoice } = createBillingHandlers(context);
            return previewInvoice(parseJsonBody(req.body), req, requestId);
        },
    });
}
