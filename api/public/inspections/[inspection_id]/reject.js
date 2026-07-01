import { createInspectionHandlers } from '../../../../src/cloud/merchantInspections.js';
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
            const { rejectInspection } = createInspectionHandlers(context);
            return rejectInspection({ inspection_id: routeParam(req, 'inspection_id') }, req, requestId);
        },
    });
}
