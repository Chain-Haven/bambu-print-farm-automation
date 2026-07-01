import { describe, expect, it, vi } from 'vitest';
import { createCloudFarmAutomationHandler } from '../../src/cloud/adminHandlers.js';

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

describe('cloud farm automation handler', () => {
    it('returns farm automation settings and an operations plan', async () => {
        const store = {
            getPlatformSetting: vi.fn()
                .mockResolvedValueOnce({ smart_queue_enabled: true, auto_eject_enabled: true })
                .mockResolvedValueOnce({ spools: [{ spool_id: 'spool-1', material: 'PLA', color_hex: '#FFFFFF' }] })
                .mockResolvedValueOnce({ alerts: [{ type: 'slack', enabled: true }] }),
            getCloudOverview: vi.fn().mockResolvedValue({
                nodes: [{ node_id: 'node-1', status: 'online' }],
                printers: [{
                    printer_id: 'printer-1',
                    node_id: 'node-1',
                    status: 'online',
                    capabilities: { materials: ['PLA'], colors: ['#FFFFFF'], auto_eject: true },
                    status_snapshot: { print: { gcode_state: 'IDLE' } },
                }],
                jobs: [],
                commands: [],
                events: [],
            }),
        };
        const handler = createCloudFarmAutomationHandler({ store, adminToken: 'admin-secret' });
        const res = createMockResponse();

        await handler({
            method: 'GET',
            headers: { authorization: 'Bearer admin-secret' },
            query: { org_id: 'org-1', limit: '25' },
        }, res);

        expect(store.getCloudOverview).toHaveBeenCalledWith({ orgId: 'org-1', limit: 25 });
        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({
            ok: true,
            automation: {
                settings: {
                    policy: expect.objectContaining({ auto_eject_enabled: true }),
                    inventory: { spools: [{ spool_id: 'spool-1', material: 'PLA', color_hex: '#FFFFFF' }] },
                    integrations: { alerts: [{ type: 'slack', enabled: true }] },
                },
                plan: {
                    summary: expect.objectContaining({ printers_total: 1 }),
                    feature_map: expect.objectContaining({ auto_ejection: true }),
                },
            },
        });
    });

    it('updates automation policy, filament inventory, and integrations through platform settings', async () => {
        const store = {
            getPlatformSetting: vi.fn()
                .mockResolvedValueOnce({ smart_queue_enabled: true, auto_eject_enabled: false })
                .mockResolvedValueOnce({ spools: [] })
                .mockResolvedValueOnce({ alerts: [] })
                .mockResolvedValueOnce({ smart_queue_enabled: true, auto_eject_enabled: true })
                .mockResolvedValueOnce({
                    spools: [{
                        spool_id: 'spool-pla-white',
                        material: 'PLA',
                        color_hex: '#FFFFFF',
                        grams_remaining: 950,
                    }],
                })
                .mockResolvedValueOnce({
                    ecommerce: [{ type: 'shopify', enabled: true }],
                    alerts: [{ type: 'email', enabled: true }],
                }),
            upsertPlatformSetting: vi.fn().mockResolvedValue({ key: 'ok', value: {} }),
            getCloudOverview: vi.fn().mockResolvedValue({ nodes: [], printers: [], jobs: [], commands: [], events: [] }),
        };
        const handler = createCloudFarmAutomationHandler({ store, adminToken: 'admin-secret' });
        const res = createMockResponse();

        await handler({
            method: 'PATCH',
            headers: { authorization: 'Bearer admin-secret' },
            body: {
                policy: {
                    auto_eject_enabled: true,
                    release_temperature_c: 28,
                    max_eject_attempts: 4,
                },
                inventory: {
                    spools: [{
                        spool_id: 'spool-pla-white',
                        material: 'PLA',
                        color_hex: '#ffffff',
                        grams_remaining: 950,
                        ams_id: 0,
                        tray_id: 1,
                    }],
                },
                integrations: {
                    ecommerce: [{ type: 'shopify', enabled: true }],
                    alerts: [{ type: 'email', enabled: true }],
                },
            },
            query: {},
        }, res);

        expect(store.upsertPlatformSetting).toHaveBeenCalledWith('farm_automation_policy', expect.objectContaining({
            auto_eject_enabled: true,
            release_temperature_c: 28,
            max_eject_attempts: 4,
        }));
        expect(store.upsertPlatformSetting).toHaveBeenCalledWith('farm_filament_inventory', {
            spools: [expect.objectContaining({
                spool_id: 'spool-pla-white',
                material: 'PLA',
                color_hex: '#FFFFFF',
                grams_remaining: 950,
            })],
        });
        expect(store.upsertPlatformSetting).toHaveBeenCalledWith('farm_integrations', expect.objectContaining({
            ecommerce: [expect.objectContaining({ type: 'shopify', enabled: true })],
            alerts: [expect.objectContaining({ type: 'email', enabled: true })],
        }));
        expect(res.statusCode).toBe(200);
        expect(res.body.automation.settings.inventory.spools[0].color_hex).toBe('#FFFFFF');
    });
});
