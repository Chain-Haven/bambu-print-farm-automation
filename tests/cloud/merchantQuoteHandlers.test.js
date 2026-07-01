import { describe, expect, it, vi } from 'vitest';
import { hashMerchantApiKey } from '../../src/cloud/merchantAuth.js';
import {
    createMerchantPreflightHandler,
    createMerchantQuoteHandler,
} from '../../src/cloud/merchantQuoteHandlers.js';

function createMockResponse() {
    return {
        statusCode: 200,
        body: null,
        headers: {},
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        },
        setHeader(name, value) {
            this.headers[name] = value;
        },
    };
}

function createAuthStore(overrides = {}) {
    const keyHash = hashMerchantApiKey('pkx_live_secret', 'pepper');
    return {
        findMerchantApiKeyByHash: vi.fn().mockResolvedValue({
            key_id: 'key-1',
            merchant_id: 'merchant-1',
            org_id: 'org-1',
            key_hash: keyHash,
        }),
        findMerchantById: vi.fn().mockResolvedValue({
            merchant_id: 'merchant-1',
            org_id: 'org-1',
            status: 'active',
            company_name: 'Widget Store',
        }),
        touchMerchantApiKey: vi.fn(),
        getCloudOverview: vi.fn().mockResolvedValue({
            nodes: [{ node_id: 'node-1', status: 'online' }],
            printers: [{
                printer_id: 'printer-1',
                node_id: 'node-1',
                status: 'online',
                status_snapshot: { print: { gcode_state: 'IDLE' } },
                capabilities: { max_x: 256, max_y: 256, max_z: 256, materials: ['PLA'], colors: ['#FFFFFF'] },
            }],
            jobs: [],
        }),
        createMerchantUsageEvent: vi.fn().mockResolvedValue({ usage_event_id: 'usage-1' }),
        ...overrides,
    };
}

const now = () => new Date('2026-07-01T12:00:00.000Z');

describe('merchant quote and preflight handlers', () => {
    it('returns a merchant-authenticated quote without creating a print job', async () => {
        const store = createAuthStore();
        const handler = createMerchantQuoteHandler({ store, pepper: 'pepper', now });
        const res = createMockResponse();

        await handler({
            method: 'POST',
            headers: { authorization: 'Bearer pkx_live_secret' },
            body: {
                requirements: {
                    dimensions_mm: { x: 80, y: 80, z: 80 },
                    materials: ['PLA'],
                    colors: ['#fff'],
                    estimated_grams: 100,
                },
                options: { routing_strategy: 'least_printer_wear' },
            },
        }, res);

        expect(store.getCloudOverview).toHaveBeenCalledWith({ orgId: 'org-1', limit: 100 });
        expect(store.createMerchantUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
            event_type: 'quote.created',
            quantity: 1,
        }));
        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({
            ok: true,
            quote: {
                routing_status: 'routed',
                routing_strategy: 'least_printer_wear',
                totals: { estimated_total_cents: expect.any(Number) },
            },
            routing: { selected_printer_id: 'printer-1' },
        });
    });

    it('preflights source models with review warnings', async () => {
        const store = createAuthStore();
        const handler = createMerchantPreflightHandler({ store, pepper: 'pepper', now });
        const res = createMockResponse();

        await handler({
            method: 'POST',
            headers: { authorization: 'Bearer pkx_live_secret' },
            body: {
                file: { name: 'part.stl', byte_size: 1024 },
                requirements: { dimensions_mm: { x: 80, y: 80, z: 80 }, materials: ['PLA'] },
            },
        }, res);

        expect(res.statusCode).toBe(200);
        expect(res.body.preflight).toMatchObject({
            review_required: true,
            warnings: expect.arrayContaining([
                expect.objectContaining({ code: 'source_model_requires_slicing' }),
            ]),
        });
    });
});
