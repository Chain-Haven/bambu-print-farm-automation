import { createMockBillingAdapter } from './mockBillingAdapter.js';
import { createMockInspectionAdapter } from './mockInspectionAdapter.js';
import { createMockRealtimeAdapter } from './mockRealtimeAdapter.js';
import { createMockShippingAdapter } from './mockShippingAdapter.js';
import { createMockSlicerAdapter } from './mockSlicerAdapter.js';

export {
    createMockBillingAdapter,
    createMockInspectionAdapter,
    createMockRealtimeAdapter,
    createMockShippingAdapter,
    createMockSlicerAdapter,
};

export function createDefaultAdapters({ now = () => new Date() } = {}) {
    return {
        slicer: createMockSlicerAdapter({ now }),
        shipping: createMockShippingAdapter({ now }),
        billing: createMockBillingAdapter({ now }),
        inspection: createMockInspectionAdapter({ now }),
        realtime: createMockRealtimeAdapter({ now }),
    };
}
