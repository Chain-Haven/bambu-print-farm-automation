import crypto from 'node:crypto';

export function createMockShippingAdapter({ now = () => new Date() } = {}) {
    return {
        async createShipment({
            merchant = {},
            order = {},
            address = {},
            packages = [],
        } = {}) {
            const shipmentId = crypto.randomUUID();
            const labelId = crypto.randomUUID();
            const timestamp = now().toISOString();

            return {
                provider: 'mock',
                shipment_id: shipmentId,
                merchant_id: merchant.merchant_id,
                org_id: merchant.org_id,
                order_id: order.order_id,
                status: 'label_created_mock',
                carrier: 'mock_carrier',
                service: 'mock_ground',
                tracking_number: `mock_track_${shipmentId.slice(0, 8)}`,
                address,
                packages,
                created_at: timestamp,
                updated_at: timestamp,
                label: {
                    provider: 'mock',
                    label_id: labelId,
                    shipment_id: shipmentId,
                    format: 'pdf',
                    url: `mock://shipments/${shipmentId}/label.pdf`,
                    created_at: timestamp,
                },
            };
        },
    };
}
