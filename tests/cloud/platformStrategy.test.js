import { describe, expect, it } from 'vitest';
import { buildPlatformStrategy, detectBambuModelFamily } from '../../src/cloud/platformStrategy.js';

describe('platform strategy planner', () => {
    it('detects Bambu model families from common model labels', () => {
        expect(detectBambuModelFamily('Bambu Lab P1S')).toBe('p1_series');
        expect(detectBambuModelFamily('A1 Combo')).toBe('a1_series');
        expect(detectBambuModelFamily('P2S')).toBe('p2_series');
        expect(detectBambuModelFamily('H2D Pro')).toBe('h2_series');
        expect(detectBambuModelFamily('Unknown Farm Printer')).toBe('generic_bambu');
    });

    it('recommends model-aware adapter modes and platform readiness gates', () => {
        const strategy = buildPlatformStrategy({
            overview: {
                nodes: [{ node_id: 'node-1', status: 'online' }],
                printers: [
                    {
                        printer_id: 'printer-p1s',
                        model: 'P1S',
                        status: 'online',
                        capabilities: {
                            lan_mode: true,
                            developer_mode: true,
                            auto_eject: true,
                        },
                    },
                    {
                        printer_id: 'printer-h2d',
                        model: 'H2D Pro',
                        status: 'online',
                        capabilities: {
                            fleet_hub: true,
                            ethernet: true,
                        },
                    },
                ],
                commands: [{ command_id: 'cmd-1', status: 'queued' }],
                jobs: [{ job_id: 'job-1', status: 'queued' }],
            },
            automationPlan: {
                summary: {
                    spools_total: 2,
                    low_spool_count: 0,
                    active_job_count: 1,
                },
                feature_map: {
                    smart_queue: true,
                    auto_ejection: true,
                    filament_inventory: true,
                    failure_detection_hooks: true,
                    alerting_hooks: true,
                },
            },
        });

        expect(strategy.integration_modes.map((mode) => mode.mode)).toEqual([
            'fleet_hub',
            'bambu_connect',
            'lan_developer_mode',
            'community_lan',
        ]);
        expect(strategy.printer_adapters).toEqual(expect.arrayContaining([
            expect.objectContaining({
                printer_id: 'printer-p1s',
                model_family: 'p1_series',
                recommended_mode: 'lan_developer_mode',
                fallback_mode: 'bambu_connect',
                risk_level: 'medium',
            }),
            expect.objectContaining({
                printer_id: 'printer-h2d',
                model_family: 'h2_series',
                recommended_mode: 'fleet_hub',
                fallback_mode: 'bambu_connect',
                risk_level: 'low',
            }),
        ]));
        expect(strategy.readiness).toEqual(expect.arrayContaining([
            expect.objectContaining({ gate: 'edge_agent_online', status: 'ready' }),
            expect.objectContaining({ gate: 'command_intents', status: 'ready' }),
            expect.objectContaining({ gate: 'inventory_traceability', status: 'ready' }),
            expect.objectContaining({ gate: 'operator_alerting', status: 'ready' }),
        ]));
    });

    it('surfaces blockers when the farm is not ready for unattended automation', () => {
        const strategy = buildPlatformStrategy({
            overview: {
                nodes: [{ node_id: 'node-1', status: 'offline' }],
                printers: [{
                    printer_id: 'printer-a1',
                    model: 'A1 Mini',
                    status: 'offline',
                    capabilities: {},
                }],
                commands: [],
                jobs: [],
            },
            automationPlan: {
                summary: { spools_total: 0 },
                feature_map: {
                    smart_queue: false,
                    auto_ejection: false,
                    failure_detection_hooks: false,
                    alerting_hooks: false,
                },
            },
        });

        expect(strategy.printer_adapters[0]).toMatchObject({
            recommended_mode: 'bambu_connect',
            fallback_mode: 'lan_developer_mode',
            risk_level: 'medium',
        });
        expect(strategy.readiness).toEqual(expect.arrayContaining([
            expect.objectContaining({
                gate: 'edge_agent_online',
                status: 'blocked',
                next_action: expect.stringContaining('Start Farm Node.bat'),
            }),
            expect.objectContaining({
                gate: 'inventory_traceability',
                status: 'blocked',
            }),
        ]));
        expect(strategy.risks).toEqual(expect.arrayContaining([
            expect.objectContaining({ risk: 'bambu_authorization_changes', severity: 'high' }),
        ]));
    });

    it('treats a stale "online" node as offline for the edge agent gate', () => {
        const now = () => new Date('2026-07-01T12:00:00Z');
        const strategy = buildPlatformStrategy({
            overview: {
                nodes: [{ node_id: 'node-1', status: 'online', last_seen_at: '2026-07-01T11:00:00Z' }],
                printers: [],
                commands: [],
                jobs: [],
            },
            automationPlan: { summary: {}, feature_map: {} },
            now,
        });

        expect(strategy.readiness.find((gate) => gate.gate === 'edge_agent_online').status).toBe('blocked');

        const fresh = buildPlatformStrategy({
            overview: {
                nodes: [{ node_id: 'node-1', status: 'online', last_seen_at: '2026-07-01T11:59:00Z' }],
                printers: [],
                commands: [],
                jobs: [],
            },
            automationPlan: { summary: {}, feature_map: {} },
            now,
        });
        expect(fresh.readiness.find((gate) => gate.gate === 'edge_agent_online').status).toBe('ready');
    });

    it('counts AMS filament synced from printers as traceable inventory', () => {
        const strategy = buildPlatformStrategy({
            overview: {
                nodes: [{ node_id: 'node-1', status: 'online' }],
                printers: [{
                    printer_id: 'printer-a1',
                    model: 'A1',
                    status: 'online',
                    capabilities: {
                        ams_trays: [{ material: 'PLA', color_hex: '#FFFFFF', ams_id: 0, tray_id: 0 }],
                    },
                }],
                commands: [],
                jobs: [],
            },
            automationPlan: { summary: { spools_total: 0 }, feature_map: {} },
        });

        expect(strategy.readiness.find((gate) => gate.gate === 'inventory_traceability').status).toBe('ready');
    });
});
