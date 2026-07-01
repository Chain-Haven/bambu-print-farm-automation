import { describe, expect, it } from 'vitest';
import { buildAmsMappingForPrinter, routeMerchantPrintJob } from '../../src/cloud/merchantRouting.js';

describe('merchant fastest-fulfillment routing', () => {
    it('selects an available matching printer with the shortest active queue', () => {
        const result = routeMerchantPrintJob({
            overview: {
                nodes: [
                    { node_id: 'node-a', status: 'online' },
                    { node_id: 'node-b', status: 'online' },
                ],
                printers: [
                    {
                        printer_id: 'printer-a',
                        node_id: 'node-a',
                        status: 'online',
                        status_snapshot: { print: { gcode_state: 'IDLE' } },
                        capabilities: {
                            max_x: 256,
                            max_y: 256,
                            max_z: 256,
                            materials: ['PLA'],
                            colors: ['#FFFFFF'],
                        },
                    },
                    {
                        printer_id: 'printer-b',
                        node_id: 'node-b',
                        status: 'online',
                        status_snapshot: { print: { gcode_state: 'IDLE' } },
                        capabilities: {
                            max_x: 256,
                            max_y: 256,
                            max_z: 256,
                            materials: ['PLA'],
                            colors: ['#FFFFFF'],
                        },
                    },
                    {
                        printer_id: 'printer-c',
                        node_id: 'node-b',
                        status: 'online',
                        status_snapshot: { print: { gcode_state: 'IDLE' } },
                        capabilities: {
                            max_x: 256,
                            max_y: 256,
                            max_z: 256,
                            materials: ['PLA'],
                            colors: ['#000000'],
                        },
                    },
                ],
                jobs: [
                    { job_id: 'job-1', printer_id: 'printer-b', status: 'queued' },
                    { job_id: 'job-2', printer_id: 'printer-b', status: 'printing' },
                ],
            },
            requirements: {
                dimensions_mm: { x: 100, y: 100, z: 100 },
                materials: ['PLA'],
                colors: ['#fff'],
            },
        });

        expect(result).toMatchObject({
            status: 'routed',
            strategy: 'fastest_fulfillment',
            selected_node_id: 'node-a',
            selected_printer_id: 'printer-a',
            score: {
                queue_depth: 0,
                node_status: 'online',
                printer_state: 'idle',
            },
        });
        expect(result.rejected_candidates).toEqual([
            expect.objectContaining({
                printer_id: 'printer-c',
                reasons: ['missing_color'],
            }),
        ]);
    });

    it('rejects printers that cannot fit the requested build volume', () => {
        const result = routeMerchantPrintJob({
            overview: {
                nodes: [{ node_id: 'node-a', status: 'online' }],
                printers: [{
                    printer_id: 'printer-a',
                    node_id: 'node-a',
                    status: 'online',
                    status_snapshot: { print: { gcode_state: 'IDLE' } },
                    capabilities: { max_x: 180, max_y: 180, max_z: 180 },
                }],
                jobs: [],
            },
            requirements: {
                dimensions_mm: { x: 220, y: 120, z: 120 },
            },
        });

        expect(result.status).toBe('no_capacity');
        expect(result.selected_printer_id).toBeNull();
        expect(result.rejected_candidates).toEqual([
            expect.objectContaining({
                printer_id: 'printer-a',
                reasons: ['build_volume_too_small'],
            }),
        ]);
    });

    it('prefers online nodes over degraded nodes when capacity is otherwise equal', () => {
        const result = routeMerchantPrintJob({
            overview: {
                nodes: [
                    { node_id: 'node-a', status: 'degraded' },
                    { node_id: 'node-b', status: 'online' },
                ],
                printers: [
                    {
                        printer_id: 'printer-a',
                        node_id: 'node-a',
                        status: 'online',
                        status_snapshot: { print: { gcode_state: 'IDLE' } },
                        capabilities: { max_x: 256, max_y: 256, max_z: 256 },
                    },
                    {
                        printer_id: 'printer-b',
                        node_id: 'node-b',
                        status: 'online',
                        status_snapshot: { print: { gcode_state: 'IDLE' } },
                        capabilities: { max_x: 256, max_y: 256, max_z: 256 },
                    },
                ],
                jobs: [],
            },
            requirements: {},
        });

        expect(result.selected_node_id).toBe('node-b');
        expect(result.selected_printer_id).toBe('printer-b');
    });

    it('extracts material and color matches from AMS status snapshots', () => {
        const result = routeMerchantPrintJob({
            overview: {
                nodes: [{ node_id: 'node-a', status: 'online' }],
                printers: [{
                    printer_id: 'printer-a',
                    node_id: 'node-a',
                    status: 'online',
                    status_snapshot: {
                        print: { gcode_state: 'IDLE' },
                        ams: {
                            ams: [{
                                tray: [{
                                    tray_type: 'PETG',
                                    tray_color: 'FFAA00',
                                }],
                            }],
                        },
                    },
                    capabilities: { max_x: 256, max_y: 256, max_z: 256 },
                }],
                jobs: [],
            },
            requirements: {
                materials: ['petg'],
                colors: ['#ffaa00'],
            },
        });

        expect(result.status).toBe('routed');
        expect(result.selected_printer_id).toBe('printer-a');
        expect(result.score).toMatchObject({
            material_matches: 1,
            color_matches: 1,
        });
    });

    it('does not route to offline, busy, or errored printers', () => {
        const result = routeMerchantPrintJob({
            overview: {
                nodes: [
                    { node_id: 'node-a', status: 'offline' },
                    { node_id: 'node-b', status: 'online' },
                    { node_id: 'node-c', status: 'online' },
                ],
                printers: [
                    {
                        printer_id: 'offline-node-printer',
                        node_id: 'node-a',
                        status: 'online',
                        status_snapshot: { print: { gcode_state: 'IDLE' } },
                        capabilities: { max_x: 256, max_y: 256, max_z: 256 },
                    },
                    {
                        printer_id: 'busy-printer',
                        node_id: 'node-b',
                        status: 'online',
                        status_snapshot: { print: { gcode_state: 'RUNNING' } },
                        capabilities: { max_x: 256, max_y: 256, max_z: 256 },
                    },
                    {
                        printer_id: 'error-printer',
                        node_id: 'node-c',
                        status: 'error',
                        status_snapshot: { print: { gcode_state: 'FAILED' } },
                        capabilities: { max_x: 256, max_y: 256, max_z: 256 },
                    },
                ],
                jobs: [],
            },
            requirements: {},
        });

        expect(result.status).toBe('no_capacity');
        expect(result.rejected_candidates).toEqual([
            expect.objectContaining({ printer_id: 'offline-node-printer', reasons: ['node_unavailable'] }),
            expect.objectContaining({ printer_id: 'busy-printer', reasons: ['printer_busy'] }),
            expect.objectContaining({ printer_id: 'error-printer', reasons: ['printer_unavailable'] }),
        ]);
    });

    it('can batch by material even when the matching printer has a small queue', () => {
        const result = routeMerchantPrintJob({
            strategy: 'batch_by_material',
            overview: {
                nodes: [
                    { node_id: 'node-a', status: 'online' },
                    { node_id: 'node-b', status: 'online' },
                ],
                printers: [
                    {
                        printer_id: 'printer-a',
                        node_id: 'node-a',
                        status: 'online',
                        status_snapshot: { print: { gcode_state: 'IDLE' } },
                        capabilities: { max_x: 256, max_y: 256, max_z: 256, materials: ['PLA'], colors: ['#FFFFFF'] },
                    },
                    {
                        printer_id: 'printer-b',
                        node_id: 'node-b',
                        status: 'online',
                        status_snapshot: { print: { gcode_state: 'IDLE' } },
                        capabilities: { max_x: 256, max_y: 256, max_z: 256, materials: ['PLA'], colors: ['#FFFFFF'] },
                    },
                ],
                jobs: [
                    { job_id: 'job-1', printer_id: 'printer-a', status: 'queued', requirements: { materials: ['PLA'] } },
                ],
            },
            requirements: { materials: ['PLA'], colors: ['#FFFFFF'] },
        });

        expect(result.selected_printer_id).toBe('printer-a');
        expect(result.score.material_batch_matches).toBe(1);
    });

    it('can prefer the cheapest compatible printer over a shorter queue', () => {
        const result = routeMerchantPrintJob({
            strategy: 'cheapest',
            overview: {
                nodes: [
                    { node_id: 'node-a', status: 'online' },
                    { node_id: 'node-b', status: 'online' },
                ],
                printers: [
                    {
                        printer_id: 'fast-expensive-printer',
                        node_id: 'node-a',
                        status: 'online',
                        status_snapshot: { print: { gcode_state: 'IDLE' } },
                        capabilities: {
                            max_x: 256,
                            max_y: 256,
                            max_z: 256,
                            materials: ['PLA'],
                            cost_per_job_cents: 3200,
                        },
                    },
                    {
                        printer_id: 'queued-cheap-printer',
                        node_id: 'node-b',
                        status: 'online',
                        status_snapshot: { print: { gcode_state: 'IDLE' } },
                        capabilities: {
                            max_x: 256,
                            max_y: 256,
                            max_z: 256,
                            materials: ['PLA'],
                            cost_per_job_cents: 650,
                        },
                    },
                ],
                jobs: [
                    { job_id: 'job-1', printer_id: 'queued-cheap-printer', status: 'queued' },
                ],
            },
            requirements: { materials: ['PLA'] },
        });

        expect(result.selected_printer_id).toBe('queued-cheap-printer');
        expect(result.score.estimated_cost_cents).toBe(650);
    });

    it('can prefer exact material inventory matches over broad material inventories', () => {
        const result = routeMerchantPrintJob({
            strategy: 'exact_material_match',
            overview: {
                nodes: [
                    { node_id: 'node-a', status: 'online' },
                    { node_id: 'node-b', status: 'online' },
                ],
                printers: [
                    {
                        printer_id: 'multi-material-printer',
                        node_id: 'node-a',
                        status: 'online',
                        status_snapshot: { print: { gcode_state: 'IDLE' } },
                        capabilities: {
                            max_x: 256,
                            max_y: 256,
                            max_z: 256,
                            materials: ['PLA', 'PETG', 'ABS'],
                        },
                    },
                    {
                        printer_id: 'exact-material-printer',
                        node_id: 'node-b',
                        status: 'online',
                        status_snapshot: { print: { gcode_state: 'IDLE' } },
                        capabilities: {
                            max_x: 256,
                            max_y: 256,
                            max_z: 256,
                            materials: ['PLA'],
                        },
                    },
                ],
                jobs: [],
            },
            requirements: { materials: ['PLA'] },
        });

        expect(result.selected_printer_id).toBe('exact-material-printer');
        expect(result.score).toMatchObject({
            exact_material_match: true,
            material_extra_count: 0,
        });
    });

    it('can prefer the least-worn printer when capacity is otherwise equal', () => {
        const result = routeMerchantPrintJob({
            strategy: 'least_printer_wear',
            overview: {
                nodes: [
                    { node_id: 'node-a', status: 'online' },
                    { node_id: 'node-b', status: 'online' },
                ],
                printers: [
                    {
                        printer_id: 'printer-high-hours',
                        node_id: 'node-a',
                        status: 'online',
                        status_snapshot: { print: { gcode_state: 'IDLE' } },
                        capabilities: { max_x: 256, max_y: 256, max_z: 256, print_hours: 1200 },
                    },
                    {
                        printer_id: 'printer-low-hours',
                        node_id: 'node-b',
                        status: 'online',
                        status_snapshot: { print: { gcode_state: 'IDLE' } },
                        capabilities: { max_x: 256, max_y: 256, max_z: 256, print_hours: 200 },
                    },
                ],
                jobs: [],
            },
            requirements: {},
        });

        expect(result.selected_printer_id).toBe('printer-low-hours');
        expect(result.score.printer_wear_hours).toBe(200);
    });
});

describe('routing result printer identity', () => {
    it('exposes the node-local printer id needed by node commands', () => {
        const result = routeMerchantPrintJob({
            overview: {
                nodes: [{ node_id: 'node-a', status: 'online' }],
                printers: [{
                    printer_id: 'cloud-uuid-1',
                    node_id: 'node-a',
                    local_printer_id: 'local-a1-01',
                    name: 'A1 #1',
                    status: 'online',
                    status_snapshot: { print: { gcode_state: 'IDLE' } },
                    capabilities: { max_x: 256, max_y: 256, max_z: 256 },
                }],
                jobs: [],
            },
            requirements: {},
        });

        expect(result.selected_printer_id).toBe('cloud-uuid-1');
        expect(result.selected_local_printer_id).toBe('local-a1-01');
        expect(result.selected_printer_name).toBe('A1 #1');
    });
});

describe('smart_material_queue strategy', () => {
    it('prefers the printer already running the same material', () => {
        const printers = [
            {
                printer_id: 'printer-empty',
                node_id: 'node-a',
                status: 'online',
                status_snapshot: { print: { gcode_state: 'IDLE' } },
                capabilities: { max_x: 256, max_y: 256, max_z: 256, materials: ['PLA'] },
            },
            {
                printer_id: 'printer-batching',
                node_id: 'node-a',
                status: 'online',
                status_snapshot: { print: { gcode_state: 'IDLE' } },
                capabilities: { max_x: 256, max_y: 256, max_z: 256, materials: ['PLA'] },
            },
        ];
        const jobs = [
            // two queued PLA jobs already on printer-batching → strong batch signal
            { printer_id: 'printer-batching', status: 'queued', requirements: { materials: ['PLA'] } },
            { printer_id: 'printer-batching', status: 'queued', requirements: { materials: ['PLA'] } },
        ];

        const result = routeMerchantPrintJob({
            overview: { nodes: [{ node_id: 'node-a', status: 'online' }], printers, jobs },
            requirements: { materials: ['PLA'] },
            strategy: 'smart_material_queue',
        });

        expect(result.status).toBe('routed');
        expect(result.selected_printer_id).toBe('printer-batching');
    });
});

describe('buildAmsMappingForPrinter', () => {
    const printer = {
        capabilities: {
            ams_trays: [
                { ams_id: 0, tray_id: 0, material: 'PLA', color_hex: 'FFFFFFFF' },
                { ams_id: 0, tray_id: 1, material: 'PLA Silk', material_base: 'PLA', color_hex: 'FF0000FF' },
                { ams_id: 1, tray_id: 2, material: 'PETG', color_hex: '000000FF' },
            ],
        },
    };

    it('maps a single color/material requirement to the matching global tray index', () => {
        expect(buildAmsMappingForPrinter(printer, { materials: ['PLA'], colors: ['#FF0000'] })).toEqual([1]);
        // second AMS unit: global index = ams_id*4 + tray_id
        expect(buildAmsMappingForPrinter(printer, { materials: ['PETG'], colors: ['#000000'] })).toEqual([6]);
    });

    it('matches material subtypes through material_base', () => {
        expect(buildAmsMappingForPrinter(printer, { materials: ['PLA'], colors: ['#ff0000'] })).toEqual([1]);
    });

    it('maps multi-filament requirements without reusing a tray', () => {
        expect(buildAmsMappingForPrinter(printer, {
            materials: ['PLA', 'PETG'],
            colors: ['#FFFFFF', '#000000'],
        })).toEqual([0, 6]);
    });

    it('returns an empty mapping when any required filament is missing', () => {
        expect(buildAmsMappingForPrinter(printer, { materials: ['ASA'] })).toEqual([]);
        expect(buildAmsMappingForPrinter(printer, { materials: ['PLA'], colors: ['#00FF00'] })).toEqual([]);
    });

    it('returns an empty mapping when there are no requirements or trays', () => {
        expect(buildAmsMappingForPrinter(printer, {})).toEqual([]);
        expect(buildAmsMappingForPrinter({ capabilities: {} }, { materials: ['PLA'] })).toEqual([]);
    });
});
