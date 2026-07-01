import { describe, expect, it } from 'vitest';
import { buildPublicFarmCapabilities } from '../../src/cloud/farmCapabilities.js';

describe('public farm capabilities', () => {
    it('summarizes safe farm capabilities without leaking printer or node internals', () => {
        const capabilities = buildPublicFarmCapabilities({
            overview: {
                nodes: [{ node_id: 'node-secret', status: 'online' }],
                printers: [{
                    printer_id: 'printer-secret',
                    node_id: 'node-secret',
                    status: 'online',
                    capabilities: {
                        max_x: 256,
                        max_y: 256,
                        max_z: 256,
                        auto_eject: true,
                        failure_detection: true,
                    },
                }],
                jobs: [{ job_id: 'job-1', status: 'queued' }],
            },
            settings: {
                policy: { smart_queue_enabled: true, auto_eject_enabled: true, failure_detection_enabled: true },
                inventory: {
                    spools: [{
                        spool_id: 'spool-secret',
                        material: 'PLA',
                        color_hex: '#ffffff',
                        grams_remaining: 850,
                    }],
                },
                integrations: {
                    ecommerce: [{ type: 'shopify', enabled: true }],
                    alerts: [{ type: 'slack', enabled: true }],
                },
            },
        });

        expect(capabilities).toMatchObject({
            accepting_jobs: true,
            file_types: {
                ready_to_print: ['.gcode.3mf', '.3mf', '.gcode'],
                source_model: ['.stl', '.obj', '.step', '.stp'],
            },
            routing_strategies: expect.arrayContaining([
                'fastest_fulfillment',
                'batch_by_material',
                'least_printer_wear',
                'ship_cutoff',
            ]),
            max_build_volume_mm: { x: 256, y: 256, z: 256 },
            features: expect.objectContaining({
                smart_queue: true,
                auto_ejection: true,
                filament_inventory: true,
                failure_detection: true,
                webhooks: true,
                shopify: true,
                slack_alerts: true,
            }),
            filaments: {
                materials: [expect.objectContaining({ material: 'PLA', available_spool_count: 1 })],
            },
        });

        const publicJson = JSON.stringify(capabilities);
        expect(publicJson).not.toContain('node-secret');
        expect(publicJson).not.toContain('printer-secret');
        expect(publicJson).not.toContain('spool-secret');
    });
});
