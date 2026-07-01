import { parseJsonBody } from '../../../../src/cloud/agentProtocol.js';
import { createPostProcessingHandlers } from '../../../../src/cloud/merchantPostProcessing.js';
import {
    createMerchantRouteContext,
    routeQuery,
    runMerchantRoute,
} from '../../../../src/cloud/merchantPublicRoute.js';

export default async function handler(req, res) {
    return runMerchantRoute(req, res, {
        methods: 'GET, POST',
        handle: (requestId) => {
            const context = createMerchantRouteContext();
            const { createTask, listTasks } = createPostProcessingHandlers(context);
            return req.method === 'GET'
                ? listTasks(routeQuery(req), req, requestId)
                : createTask(parseJsonBody(req.body), req, requestId);
        },
    });
}
