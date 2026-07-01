import { describe, expect, it, vi } from 'vitest';
import { createRoutingV2Handlers } from '../../src/cloud/merchantRoutingV2.js';

function createMockStore(overrides = {}) {
    return {
        getCloudOverview: vi.fn().mockResolvedValue({
            nodes: [{ node_id: 'node-1', status: 'online' }],
            printers: [{
                printer_id: 'printer-1',
                node_id: 'node-1',
                status: 'online',
                status_snapshot: { print: { gcode_state: 'IDLE' } },
                capabilities: {
                    max_x: 256,
                    max_y: 256,
                    max_z: 256,
                    materials: ['PLA'],
                    colors: ['#FFFFFF'],
                },
            }],
            jobs: [],
        }),
        ...overrides,
    };
}

function createHandlers(overrides = {}) {
    const store = createMockStore(overrides.store);
    const authenticateMerchant = vi.fn().mockResolvedValue({
        merchant: {
            org_id: 'org-1',
            merchant_id: 'merchant-1',
            status: 'active',
        },
    });

    return {
        store,
        authenticateMerchant,
        ...createRoutingV2Handlers({
            store,
            authenticateMerchant,
            now: () => new Date('2026-07-01T12:00:00.000Z'),
        }),
    };
}

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
        end(payload) {
            this.body = payload ? JSON.parse(payload) : null;
            return this;
        },
    };
}

async function importRoutingOptionsRoute(store = createMockStore()) {
    vi.resetModules();
    vi.doMock('../../src/cloud/supabaseRest.js', () => ({
        createSupabaseRestClient: vi.fn(() => store),
    }));
    const route = await import('../../api/public/routing/options.js');
    vi.doUnmock('../../src/cloud/supabaseRest.js');
    return route.default;
}

async function importRoutingEstimateRoute(store = createMockStore()) {
    vi.resetModules();
    vi.doMock('../../src/cloud/supabaseRest.js', () => ({
        createSupabaseRestClient: vi.fn(() => store),
    }));
    const route = await import('../../api/public/routing/estimate.js');
    vi.doUnmock('../../src/cloud/supabaseRest.js');
    return route.default;
}

describe('merchant routing v2 handlers', () => {
    it('lists merchant-facing routing strategies', async () => {
        const { getRoutingOptions } = createHandlers();

        const options = await getRoutingOptions();

        expect(options.strategies).toEqual([
            'fastest_fulfillment',
            'batch_by_material',
            'least_printer_wear',
            'ship_cutoff',
        ]);
        expect(options.strategies).not.toContain('cheapest');
        expect(options.strategies).not.toContain('exact_material_match');
        expect(options.default_strategy).toBe('fastest_fulfillment');
    });

    it('returns a safe route estimate without internal farm identifiers', async () => {
        const { estimateRouting, store } = createHandlers();

        const estimate = await estimateRouting({
            strategy: 'fastest_fulfillment',
            requirements: {
                dimensions_mm: { x: 100, y: 100, z: 100 },
                materials: ['PLA'],
                colors: ['#fff'],
                estimated_print_minutes: 75,
            },
        });

        expect(estimate).toMatchObject({
            strategy: 'fastest_fulfillment',
            confidence: expect.stringMatching(/^(low|medium|high)$/),
            eta: expect.objectContaining({ queue_minutes: expect.any(Number) }),
        });
        expect(estimate).toMatchObject({
            compatible: true,
            rejection_reasons: [],
        });
        expect(store.getCloudOverview).toHaveBeenCalledWith({ orgId: 'org-1', limit: 100 });
        expect(JSON.stringify(estimate)).not.toContain('node_id');
        expect(JSON.stringify(estimate)).not.toContain('printer_id');
        expect(JSON.stringify(estimate)).not.toContain('spool_id');
    });

    it('redacts internal routing ids from no-capacity estimates', async () => {
        const { estimateRouting } = createHandlers({
            store: {
                getCloudOverview: vi.fn().mockResolvedValue({
                    nodes: [{ node_id: 'node-secret', status: 'online' }],
                    printers: [{
                        printer_id: 'printer-secret',
                        node_id: 'node-secret',
                        status: 'online',
                        status_snapshot: { print: { gcode_state: 'IDLE' } },
                        capabilities: {
                            max_x: 256,
                            max_y: 256,
                            max_z: 256,
                            materials: ['PLA'],
                        },
                    }],
                    jobs: [],
                }),
            },
        });

        const estimate = await estimateRouting({
            strategy: 'fastest_fulfillment',
            requirements: { materials: ['NYLON'] },
        });

        expect(estimate).toMatchObject({
            compatible: false,
            confidence: 'low',
            rejection_reasons: ['missing_material'],
        });
        expect(JSON.stringify(estimate)).not.toContain('node-secret');
        expect(JSON.stringify(estimate)).not.toContain('printer-secret');
        expect(JSON.stringify(estimate)).not.toContain('node_id');
        expect(JSON.stringify(estimate)).not.toContain('printer_id');
        expect(JSON.stringify(estimate)).not.toContain('spool_id');
    });
});

describe('merchant routing v2 public routes', () => {
    it('returns v2 public error envelopes for unsupported methods', async () => {
        const optionsHandler = await importRoutingOptionsRoute();
        const estimateHandler = await importRoutingEstimateRoute();
        const optionsRes = createMockResponse();
        const estimateRes = createMockResponse();

        await optionsHandler({ method: 'POST', headers: {} }, optionsRes);
        await estimateHandler({ method: 'GET', headers: {} }, estimateRes);

        expect(optionsRes.statusCode).toBe(405);
        expect(optionsRes.headers.Allow).toBe('GET');
        expect(optionsRes.body).toMatchObject({
            ok: false,
            error: 'method_not_allowed',
            request_id: expect.stringMatching(/^req_/),
        });
        expect(estimateRes.statusCode).toBe(405);
        expect(estimateRes.headers.Allow).toBe('POST');
        expect(estimateRes.body).toMatchObject({
            ok: false,
            error: 'method_not_allowed',
            request_id: expect.stringMatching(/^req_/),
        });
    });
});
