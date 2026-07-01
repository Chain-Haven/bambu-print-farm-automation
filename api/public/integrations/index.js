import { createMerchantIntegrationsHandler } from '../../../src/cloud/merchantWebhookHandlers.js';

export default function handler(req, res) {
    return createMerchantIntegrationsHandler()(req, res);
}
