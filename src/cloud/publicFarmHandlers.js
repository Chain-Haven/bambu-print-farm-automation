import { buildPublicFarmCapabilities } from './farmCapabilities.js';
import { buildPublicFilamentAvailability } from './filamentAvailability.js';

const FARM_AUTOMATION_POLICY_KEY = 'farm_automation_policy';
const FARM_FILAMENT_INVENTORY_KEY = 'farm_filament_inventory';
const FARM_INTEGRATIONS_KEY = 'farm_integrations';

function sendJson(res, statusCode, payload) {
    if (typeof res.status === 'function' && typeof res.json === 'function') {
        return res.status(statusCode).json(payload);
    }

    res.statusCode = statusCode;
    if (typeof res.setHeader === 'function') {
        res.setHeader('Content-Type', 'application/json');
    }
    return res.end(JSON.stringify(payload));
}

function methodNotAllowed(res, methods) {
    if (typeof res.setHeader === 'function') {
        res.setHeader('Allow', methods);
    }
    return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
}

export function createPublicFarmFilamentsHandler({ store }) {
    if (!store) throw new Error('store is required');

    return async function publicFarmFilamentsHandler(req, res) {
        if (req.method && req.method !== 'GET') {
            return methodNotAllowed(res, 'GET');
        }

        try {
            const inventory = await store.getPlatformSetting(FARM_FILAMENT_INVENTORY_KEY, { spools: [] });
            return sendJson(res, 200, {
                ok: true,
                filaments: buildPublicFilamentAvailability({ inventory }),
            });
        } catch (error) {
            return sendJson(res, 500, {
                ok: false,
                error: 'farm_filaments_failed',
                message: error.message,
            });
        }
    };
}

export function createPublicFarmCapabilitiesHandler({ store }) {
    if (!store) throw new Error('store is required');

    return async function publicFarmCapabilitiesHandler(req, res) {
        if (req.method && req.method !== 'GET') {
            return methodNotAllowed(res, 'GET');
        }

        try {
            const [policy, inventory, integrations, overview] = await Promise.all([
                store.getPlatformSetting(FARM_AUTOMATION_POLICY_KEY, {}),
                store.getPlatformSetting(FARM_FILAMENT_INVENTORY_KEY, { spools: [] }),
                store.getPlatformSetting(FARM_INTEGRATIONS_KEY, {}),
                store.getCloudOverview({ orgId: null, limit: 100 }),
            ]);

            return sendJson(res, 200, {
                ok: true,
                capabilities: buildPublicFarmCapabilities({
                    overview,
                    settings: { policy, inventory, integrations },
                }),
            });
        } catch (error) {
            return sendJson(res, 500, {
                ok: false,
                error: 'farm_capabilities_failed',
                message: error.message,
            });
        }
    };
}
