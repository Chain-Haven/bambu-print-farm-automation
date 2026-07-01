import { describe, expect, it } from 'vitest';
import { routeMerchantPrintJob } from '../../src/cloud/merchantRouting.js';

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
