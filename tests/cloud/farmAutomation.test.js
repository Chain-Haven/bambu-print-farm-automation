import { describe, expect, it } from 'vitest';
import { buildFarmAutomationPlan, normalizeFarmAutomationSettings } from '../../src/cloud/farmAutomation.js';

describe('farm automation planner', () => {
    it('builds 3DQue-style farm recommendations from inventory, AMS trays, and ejection policy', () => {
        const settings = normalizeFarmAutomationSettings({
            policy: {
                smart_queue_enabled: true,
                auto_eject_enabled: true,
                bed_clear_verification: 'camera_or_operator',
                release_temperature_c: 27,
                max_eject_attempts: 3,
                failure_detection_enabled: true,
            },
            inventory: {
                spools: [
                    {
                        spool_id: 'spool-white-pla',
                        material: 'PLA',
                        color_hex: '#FFFFFF',
                        grams_remaining: 1200,
                        printer_id: 'printer-ready',
                        ams_id: 0,
                        tray_id: 0,
                        dry_status: 'ready',
                    },
                    {
                        spool_id: 'spool-orange-petg',
                        material: 'PETG',
                        color_hex: '#FFAA00',
                        grams_remaining: 80,
                        reorder_threshold_grams: 150,
                        storage_location: 'Rack A',
                    },
                ],
            },
            integrations: {
                alerts: [{ type: 'slack', enabled: true }],
                ecommerce: [{ type: 'shopify', enabled: false }],
                vision: [{ type: 'camera_ai_webhook', enabled: true }],
            },
        });

        const plan = buildFarmAutomationPlan({
            settings,
            overview: {
                nodes: [
                    { node_id: 'node-1', status: 'online' },
                    { node_id: 'node-2', status: 'online' },
                ],
                printers: [
                    {
                        printer_id: 'printer-ready',
                        node_id: 'node-1',
                        name: 'A1 White PLA',
                        status: 'online',
                        status_snapshot: {
                            print: { gcode_state: 'IDLE' },
                            ams: {
                                ams: [{
                                    tray: [{ id: 0, tray_type: 'PLA', tray_color: 'FFFFFF' }],
                                }],
                            },
                        },
                        capabilities: {
                            max_x: 256,
                            max_y: 256,
                            max_z: 256,
                            auto_eject: true,
                        },
                    },
                    {
                        printer_id: 'printer-finished',
                        node_id: 'node-2',
                        name: 'P1S Finished',
                        status: 'online',
                        status_snapshot: { print: { gcode_state: 'FINISH' }, bed_temp: 26.5 },
                        capabilities: {
                            max_x: 256,
                            max_y: 256,
                            max_z: 256,
                            auto_eject: true,
                            bed_clear: false,
                        },
                    },
                ],
                jobs: [
                    {
                        job_id: 'job-white-pla',
                        status: 'queued',
                        name: 'Merchant order 1001',
                        options: {
                            requirements: {
                                materials: ['PLA'],
                                colors: ['#fff'],
                                estimated_grams: 240,
                            },
                        },
                    },
                ],
            },
        });

        expect(plan.feature_map).toMatchObject({
            central_dashboard: true,
            smart_queue: true,
            auto_ejection: true,
            ams_filament_mapping: true,
            failure_detection_hooks: true,
            ecommerce_hooks: true,
        });
        expect(plan.summary).toMatchObject({
            printers_total: 2,
            printers_online: 2,
            low_spool_count: 1,
            auto_eject_ready_count: 1,
        });
        expect(plan.job_recommendations).toEqual([
            expect.objectContaining({
                job_id: 'job-white-pla',
                selected_printer_id: 'printer-ready',
                strategy: 'smart_material_queue',
            }),
        ]);
        expect(plan.ejection_queue).toEqual([
            expect.objectContaining({
                printer_id: 'printer-finished',
                action: 'auto_eject',
                release_temperature_c: 27,
            }),
        ]);
        expect(plan.alerts).toEqual(expect.arrayContaining([
            expect.objectContaining({
                severity: 'warning',
                type: 'low_filament',
                spool_id: 'spool-orange-petg',
            }),
        ]));
        expect(plan.platform_strategy).toMatchObject({
            integration_modes: expect.arrayContaining([
                expect.objectContaining({ mode: 'fleet_hub' }),
                expect.objectContaining({ mode: 'bambu_connect' }),
                expect.objectContaining({ mode: 'lan_developer_mode' }),
            ]),
            printer_adapters: expect.arrayContaining([
                expect.objectContaining({
                    printer_id: 'printer-ready',
                    model_family: 'a1_series',
                }),
            ]),
            readiness: expect.arrayContaining([
                expect.objectContaining({
                    gate: 'edge_agent_online',
                    status: 'ready',
                }),
            ]),
        });
    });

    it('uses assigned filament inventory for smart routing when live AMS telemetry is unavailable', () => {
        const plan = buildFarmAutomationPlan({
            settings: normalizeFarmAutomationSettings({
                inventory: {
                    spools: [{
                        spool_id: 'spool-black-asa',
                        printer_id: 'printer-with-inventory',
                        material: 'ASA',
                        color_hex: '#000000',
                        grams_remaining: 600,
                    }],
                },
            }),
            overview: {
                nodes: [{ node_id: 'node-1', status: 'online' }],
                printers: [{
                    printer_id: 'printer-with-inventory',
                    node_id: 'node-1',
                    status: 'online',
                    status_snapshot: { print: { gcode_state: 'IDLE' } },
                    capabilities: { max_x: 256, max_y: 256, max_z: 256 },
                }],
                jobs: [{
                    job_id: 'job-asa-black',
                    status: 'queued',
                    options: {
                        requirements: {
                            materials: ['ASA'],
                            colors: ['#000'],
                        },
                    },
                }],
            },
        });

        expect(plan.job_recommendations).toEqual([
            expect.objectContaining({
                job_id: 'job-asa-black',
                selected_printer_id: 'printer-with-inventory',
                status: 'routed',
            }),
        ]);
    });
});
