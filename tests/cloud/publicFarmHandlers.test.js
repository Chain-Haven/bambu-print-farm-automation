import { describe, expect, it, vi } from 'vitest';
import { createPublicFarmFilamentsHandler } from '../../src/cloud/publicFarmHandlers.js';

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

describe('public farm filament handler', () => {
    it('publishes aggregate filament availability without merchant or admin auth', async () => {
        const store = {
            getPlatformSetting: vi.fn().mockResolvedValue({
                spools: [{
                    spool_id: 'internal-spool-1',
                    material: 'PLA',
                    color_hex: '#ffffff',
                    color_name: 'White',
                    grams_remaining: 900,
                    printer_id: 'internal-printer-1',
                    storage_location: 'Private Rack',
                    lot_code: 'LOT-PRIVATE',
                }],
            }),
        };
        const handler = createPublicFarmFilamentsHandler({ store });
        const res = createMockResponse();

        await handler({ method: 'GET', headers: {}, query: {} }, res);

        expect(store.getPlatformSetting).toHaveBeenCalledWith('farm_filament_inventory', { spools: [] });
        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({
            ok: true,
            filaments: {
                materials: [expect.objectContaining({
                    material: 'PLA',
                    available_spool_count: 1,
                    total_grams_remaining: 900,
                })],
                colors: [expect.objectContaining({
                    color_hex: '#FFFFFF',
                    color_name: 'White',
                    materials: ['PLA'],
                })],
            },
        });

        const publicJson = JSON.stringify(res.body);
        expect(publicJson).not.toContain('internal-spool-1');
        expect(publicJson).not.toContain('internal-printer-1');
        expect(publicJson).not.toContain('Private Rack');
        expect(publicJson).not.toContain('LOT-PRIVATE');
    });

    it('rejects non-GET methods', async () => {
        const handler = createPublicFarmFilamentsHandler({
            store: { getPlatformSetting: vi.fn() },
        });
        const res = createMockResponse();

        await handler({ method: 'POST', headers: {}, query: {} }, res);

        expect(res.statusCode).toBe(405);
        expect(res.headers.Allow).toBe('GET');
    });
});
