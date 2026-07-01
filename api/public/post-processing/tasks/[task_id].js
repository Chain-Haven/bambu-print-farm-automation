import { createPostProcessingHandlers } from '../../../../src/cloud/merchantPostProcessing.js';
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
            const { getTask } = createPostProcessingHandlers(context);
            return getTask({ task_id: routeParam(req, 'task_id') }, req, requestId);
        },
    });
}
