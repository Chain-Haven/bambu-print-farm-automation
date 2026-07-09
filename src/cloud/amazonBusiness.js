// src/cloud/amazonBusiness.js — minimal Amazon Business API client (buyer side).
//
// Used by the filament auto-reorder engine (filamentReorder.js) to place real
// purchase orders for spools. Amazon's buyer-side API suite is credential
// gated: the operator needs an Amazon Business account, a registered developer
// application approved for the Ordering API role, and LWA (Login with Amazon)
// OAuth credentials authorized by a purchasing user.
// Docs: https://developer-docs.amazon.com/amazon-business/
//
// API surface implemented (matches the published Ordering API v1 model):
//   POST {regional host}/ordering/2022-10-30/orders               placeOrder
//   GET  {regional host}/ordering/2022-10-30/orders/{externalId}  orderDetails
// Auth: LWA refresh-token exchange at https://api.amazon.com/auth/o2/token,
// then `x-amz-access-token` + `x-amz-user-email` (purchasing user) headers.
//
// `externalId` doubles as Amazon-side idempotency: it must be unique per
// order, so replays of the same shortage never double-order.

export const AMAZON_BUSINESS_HOSTS = {
    NA: 'https://na.business-api.amazon.com',
    EU: 'https://eu.business-api.amazon.com',
    FE: 'https://jp.business-api.amazon.com',
};

export const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const ORDERING_BASE_PATH = '/ordering/2022-10-30/orders';

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
}

// Credentials can live in the stored config or in server env vars (so secrets
// can stay in Vercel env instead of the database). Config wins when set.
export function resolveAmazonBusinessCredentials(config = {}) {
    const fromConfig = (config && typeof config.credentials === 'object' && config.credentials) || {};
    return {
        client_id: isNonEmptyString(fromConfig.client_id) ? fromConfig.client_id.trim() : (process.env.AB_LWA_CLIENT_ID || null),
        client_secret: isNonEmptyString(fromConfig.client_secret) ? fromConfig.client_secret.trim() : (process.env.AB_LWA_CLIENT_SECRET || null),
        refresh_token: isNonEmptyString(fromConfig.refresh_token) ? fromConfig.refresh_token.trim() : (process.env.AB_LWA_REFRESH_TOKEN || null),
    };
}

export function hasAmazonBusinessCredentials(config = {}) {
    const credentials = resolveAmazonBusinessCredentials(config);
    return Boolean(credentials.client_id && credentials.client_secret && credentials.refresh_token);
}

export function resolveAmazonBusinessHost(config = {}) {
    const region = String(config.region || 'NA').toUpperCase();
    return AMAZON_BUSINESS_HOSTS[region] || AMAZON_BUSINESS_HOSTS.NA;
}

export async function getLwaAccessToken({ credentials, fetchImpl = fetch }) {
    if (!credentials?.client_id || !credentials?.client_secret || !credentials?.refresh_token) {
        throw new Error('amazon_business_missing_credentials');
    }
    const response = await fetchImpl(LWA_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: credentials.refresh_token,
            client_id: credentials.client_id,
            client_secret: credentials.client_secret,
        }).toString(),
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`amazon_business_lwa_failed: HTTP ${response.status} ${text.slice(0, 300)}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error('amazon_business_lwa_failed: non-JSON token response');
    }
    if (!parsed.access_token) throw new Error('amazon_business_lwa_failed: no access_token in response');
    return parsed.access_token;
}

// PhysicalAddress attribute for the Ordering API's polymorphic Address model.
// Only emitted when the config carries a complete street address; otherwise
// orders fall back to the Amazon Business account's default address.
export function buildShippingAddressAttribute(shippingAddress = {}) {
    const address = shippingAddress || {};
    const required = [address.address_line1, address.city, address.state_or_region, address.postal_code, address.country_code];
    if (required.some((value) => !isNonEmptyString(value))) return null;
    return {
        attributeType: 'ShippingAddress',
        address: {
            addressType: 'PhysicalAddress',
            fullName: isNonEmptyString(address.full_name) ? address.full_name.trim() : 'Print Farm Receiving',
            ...(isNonEmptyString(address.company_name) ? { companyName: address.company_name.trim() } : {}),
            ...(isNonEmptyString(address.phone_number) ? { phoneNumber: address.phone_number.trim() } : {}),
            addressLine1: address.address_line1.trim(),
            ...(isNonEmptyString(address.address_line2) ? { addressLine2: address.address_line2.trim() } : {}),
            city: address.city.trim(),
            stateOrRegion: address.state_or_region.trim(),
            postalCode: address.postal_code.trim(),
            countryCode: address.country_code.trim().toUpperCase(),
        },
    };
}

// Build a PlaceOrderRequest for one reorder rule. Attributes/expectations use
// the Ordering API's typed-attribute model (SelectedProductReference, Region,
// UserEmail, ShippingAddress, TrialMode, ExpectedUnitPrice). While
// `trial_mode` is on (the safe default) Amazon treats the order as a test and
// nothing is charged/shipped — flip it off in the console once a trial order
// round-trips.
export function buildPlaceOrderPayload({ rule, config, externalId, quantity }) {
    if (!isNonEmptyString(externalId)) throw new Error('externalId is required');
    if (!isNonEmptyString(rule?.asin)) throw new Error('rule.asin is required');
    const qty = Math.max(1, Number.parseInt(quantity, 10) || 1);
    const currencyCode = isNonEmptyString(config?.currency) ? config.currency.trim().toUpperCase() : 'USD';

    const lineExpectations = [];
    if (Number(rule.max_unit_price_usd) > 0) {
        lineExpectations.push({
            expectationType: 'ExpectedUnitPrice',
            amount: { currencyCode, amount: Number(rule.max_unit_price_usd) },
        });
    }

    const orderAttributes = [
        { attributeType: 'Region', region: isNonEmptyString(config?.country_code) ? config.country_code.trim().toUpperCase() : 'US' },
    ];
    if (isNonEmptyString(config?.user_email)) {
        orderAttributes.push({ attributeType: 'UserEmail', userEmail: config.user_email.trim() });
    }
    const shippingAttribute = buildShippingAddressAttribute(config?.shipping_address);
    if (shippingAttribute) orderAttributes.push(shippingAttribute);
    if (isNonEmptyString(config?.purchase_order_number)) {
        orderAttributes.push({ attributeType: 'PurchaseOrderNumber', purchaseOrderNumber: config.purchase_order_number.trim() });
    }
    if (config?.trial_mode !== false) {
        orderAttributes.push({ attributeType: 'TrialMode' });
    }

    return {
        externalId,
        lineItems: [{
            externalId: `${externalId}-li1`,
            quantity: qty,
            attributes: [{
                attributeType: 'SelectedProductReference',
                productReference: { productReferenceType: 'ProductIdentifier', id: rule.asin.trim() },
            }],
            ...(lineExpectations.length > 0 ? { expectations: lineExpectations } : {}),
        }],
        attributes: orderAttributes,
    };
}

async function orderingRequest({ config, method, path, body = null, fetchImpl = fetch }) {
    const credentials = resolveAmazonBusinessCredentials(config);
    const accessToken = await getLwaAccessToken({ credentials, fetchImpl });
    const headers = {
        'x-amz-access-token': accessToken,
        Accept: 'application/json',
    };
    if (isNonEmptyString(config?.user_email)) headers['x-amz-user-email'] = config.user_email.trim();
    if (body) headers['Content-Type'] = 'application/json';

    const response = await fetchImpl(`${resolveAmazonBusinessHost(config)}${path}`, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`amazon_business_request_failed: ${method} ${path} HTTP ${response.status} ${text.slice(0, 300)}`);
    }
    try {
        return text ? JSON.parse(text) : {};
    } catch {
        return { raw: text };
    }
}

export async function placeAmazonBusinessOrder({ config, payload, fetchImpl = fetch }) {
    // MOCK_MODE (and explicit config.mock) short-circuits with a simulated
    // acceptance so the whole reorder loop is testable offline — same pattern
    // as the mock camera frame and mock slicer.
    if (config?.mock === true || process.env.MOCK_MODE === 'true') {
        return {
            mock: true,
            orderIdentifier: { externalId: payload.externalId, orderId: `mock-ab-${payload.externalId}` },
            acceptedItems: (payload.lineItems || []).map((item) => ({ externalId: item.externalId, quantity: item.quantity })),
        };
    }
    return orderingRequest({ config, method: 'POST', path: ORDERING_BASE_PATH, body: payload, fetchImpl });
}

export async function getAmazonBusinessOrderDetails({ config, externalId, fetchImpl = fetch }) {
    if (!isNonEmptyString(externalId)) throw new Error('externalId is required');
    if (config?.mock === true || process.env.MOCK_MODE === 'true') {
        return { mock: true, orderIdentifier: { externalId }, status: 'PLACED' };
    }
    return orderingRequest({ config, method: 'GET', path: `${ORDERING_BASE_PATH}/${encodeURIComponent(externalId)}`, fetchImpl });
}

// Cheap connectivity probe: proves the LWA credentials round-trip without
// touching the Ordering API (no order side effects).
export async function testAmazonBusinessConnection({ config, fetchImpl = fetch }) {
    if (config?.mock === true || process.env.MOCK_MODE === 'true') {
        return { ok: true, mock: true };
    }
    const credentials = resolveAmazonBusinessCredentials(config);
    if (!credentials.client_id || !credentials.client_secret || !credentials.refresh_token) {
        return { ok: false, error: 'missing_credentials', message: 'Set LWA client id, client secret, and refresh token (config or AB_LWA_* env vars).' };
    }
    try {
        await getLwaAccessToken({ credentials, fetchImpl });
        return { ok: true };
    } catch (error) {
        return { ok: false, error: 'lwa_exchange_failed', message: error.message };
    }
}
