import { createTimelineHandlers } from '../../../../src/cloud/merchantTimeline.js';
import {
    createMerchantRouteContext,
    routeParam,
    routeQuery,
    runMerchantRoute,
} from '../../../../src/cloud/merchantPublicRoute.js';

export default async function handler(req, res) {
    return runMerchantRoute(req, res, {
        methods: 'GET',
        handle: (requestId) => {
            const context = createMerchantRouteContext();
            const { listJobArtifacts } = createTimelineHandlers(context);
            return listJobArtifacts({
                ...routeQuery(req),
                job_id: routeParam(req, 'job_id'),
            }, req, requestId);
        },
    });
}
