// src/cloud/shippingLabels.js — carrier labels via the EasyPost REST API.
//
// Buying a label is the last manual step between "printed" and "at the
// customer's door". EasyPost's flow: create a shipment (addresses + parcel)
// → it returns live carrier rates → buy the cheapest (or preferred-service)
// rate → get a tracking code + label URL. Auth is HTTP Basic with the API
// key; test keys (EZTK…) buy fake labels, so trial runs are free.
// Docs: https://docs.easypost.com/docs/shipments
//
// MOCK_MODE (or a missing key with mock enabled) simulates a purchase so the
// auto-ship loop is testable offline — consistent with Stripe/Amazon here.

const EASYPOST_API_BASE = 'https://api.easypost.com/v2';

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
}

export function resolveEasyPostConfig(settings = {}) {
    const shipping = (settings && typeof settings.shipping === 'object' && settings.shipping) || {};
    return {
        api_key: isNonEmptyString(shipping.easypost_api_key)
            ? shipping.easypost_api_key.trim()
            : (process.env.EASYPOST_API_KEY || null),
        mock: shipping.mock === true || process.env.MOCK_MODE === 'true',
    };
}

export function isShippingConfigured(settings = {}) {
    const config = resolveEasyPostConfig(settings);
    return config.mock || Boolean(config.api_key);
}

function toEasyPostAddress(address = {}, { name = null, phone = null, email = null } = {}) {
    return {
        name: name || address.full_name || address.name || 'Recipient',
        ...(address.company_name ? { company: address.company_name } : {}),
        street1: address.line1 || address.address_line1 || '',
        ...(address.line2 || address.address_line2 ? { street2: address.line2 || address.address_line2 } : {}),
        city: address.city || '',
        state: address.region || address.state_or_region || '',
        zip: address.postal_code || '',
        country: address.country || address.country_code || 'US',
        ...(phone || address.phone_number ? { phone: phone || address.phone_number } : {}),
        ...(email ? { email } : {}),
    };
}

async function easyPostRequest({ config, method, path, body = null, fetchImpl = fetch }) {
    if (!config.api_key) throw new Error('shipping_not_configured');
    const response = await fetchImpl(`${EASYPOST_API_BASE}${path}`, {
        method,
        headers: {
            Authorization: `Basic ${Buffer.from(`${config.api_key}:`).toString('base64')}`,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let parsed;
    try {
        parsed = text ? JSON.parse(text) : {};
    } catch {
        parsed = { raw: text };
    }
    if (!response.ok) {
        const message = parsed?.error?.message || text.slice(0, 300);
        throw new Error(`easypost_request_failed: ${method} ${path} HTTP ${response.status} ${message}`);
    }
    return parsed;
}

function pickRate(rates, preferredService = null) {
    const usable = (Array.isArray(rates) ? rates : []).filter((rate) => rate?.id && rate?.rate);
    if (usable.length === 0) return null;
    if (preferredService) {
        const preferred = usable.find(
            (rate) => String(rate.service || '').toLowerCase() === String(preferredService).toLowerCase(),
        );
        if (preferred) return preferred;
    }
    return usable.reduce((best, rate) => (Number(rate.rate) < Number(best.rate) ? rate : best));
}

/**
 * Create a shipment and buy the best rate. Returns
 * { tracking_code, label_url, carrier, service, rate_usd, shipment_id, mock }.
 * Weight is grams (converted to oz for EasyPost); parcel dims are cm.
 */
export async function buyShippingLabel({
    settings,
    toAddress,
    toName,
    toEmail = null,
    fromAddress,
    weightGrams,
    parcel = {},
    preferredService = null,
    fetchImpl = fetch,
}) {
    const config = resolveEasyPostConfig(settings);
    const weightOz = Math.max(1, Math.round(((Number(weightGrams) || 200) / 28.3495) * 10) / 10);

    if (config.mock || !config.api_key) {
        if (!config.mock) throw new Error('shipping_not_configured');
        return {
            mock: true,
            shipment_id: `shp_mock_${Math.round(weightOz * 10)}`,
            tracking_code: `MOCKTRACK${String(Math.round(weightOz)).padStart(4, '0')}`,
            label_url: 'https://example.invalid/mock-label.pdf',
            carrier: 'MockPost',
            service: preferredService || 'Ground',
            rate_usd: 7.5,
        };
    }

    const shipment = await easyPostRequest({
        config,
        method: 'POST',
        path: '/shipments',
        fetchImpl,
        body: {
            shipment: {
                to_address: toEasyPostAddress(toAddress, { name: toName, email: toEmail }),
                from_address: toEasyPostAddress(fromAddress, { name: fromAddress?.full_name }),
                parcel: {
                    // Defaults suit a spool-sized/small-part box; configurable
                    // through storefront shipping settings.
                    length: Number(parcel.length_cm) || 25,
                    width: Number(parcel.width_cm) || 20,
                    height: Number(parcel.height_cm) || 15,
                    weight: weightOz,
                },
            },
        },
    });

    const rate = pickRate(shipment.rates, preferredService);
    if (!rate) {
        throw new Error(`easypost_no_rates: ${JSON.stringify(shipment.messages || []).slice(0, 200)}`);
    }

    const bought = await easyPostRequest({
        config,
        method: 'POST',
        path: `/shipments/${encodeURIComponent(shipment.id)}/buy`,
        fetchImpl,
        body: { rate: { id: rate.id } },
    });

    return {
        mock: false,
        shipment_id: bought.id,
        tracking_code: bought.tracking_code || bought.tracker?.tracking_code || null,
        label_url: bought.postage_label?.label_url || null,
        carrier: rate.carrier || null,
        service: rate.service || null,
        rate_usd: Number(rate.rate) || null,
    };
}
