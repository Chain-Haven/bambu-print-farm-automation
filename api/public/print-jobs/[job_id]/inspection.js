import { parseJsonBody } from '../../../../src/cloud/agentProtocol.js';
import { createDefaultAdapters } from '../../../../src/cloud/adapters/index.js';
import { createInspectionHandlers } from '../../../../src/cloud/merchantInspections.js';
import {
    createMerchantRouteContext,
    routeParam,
    routeQuery,
    runMerchantRoute,
} from '../../../../src/cloud/merchantPublicRoute.js';

export default async function handler(req, res) {
    return runMerchantRoute(req, res, {
        methods: 'GET, POST',
        handle: (requestId) => {
            const context = createMerchantRouteContext();
            const { getInspectionForJob, requestInspection } = createInspectionHandlers({
                ...context,
                adapters: createDefaultAdapters({ now: context.now }),
            });
            const body = req.method === 'GET' ? routeQuery(req) : parseJsonBody(req.body);
            const payload = {
                ...body,
                job_id: routeParam(req, 'job_id'),
            };
            return req.method === 'GET'
                ? getInspectionForJob(payload, req, requestId)
                : requestInspection(payload, req, requestId);
        },
    });
}
