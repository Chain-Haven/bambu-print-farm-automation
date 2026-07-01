import { describe, expect, it } from 'vitest';
import { buildPublicFilamentAvailability } from '../../src/cloud/filamentAvailability.js';

describe('public filament availability', () => {
    it('aggregates material and color availability without leaking spool internals', () => {
        const result = buildPublicFilamentAvailability({
            inventory: {
                spools: [
                    {
                        spool_id: 'spool-white-pla',
                        material: 'pla',
                        color_hex: '#fff',
                        color_name: 'White',
                        grams_remaining: 1200,
                        printer_id: 'printer-1',
                        storage_location: 'Rack A',
                        lot_code: 'LOT-SECRET',
                        dry_status: 'ready',
                    },
                    {
                        spool_id: 'spool-black-pla-reserved',
                        material: 'PLA',
                        color_hex: '#000000',
                        color_name: 'Black',
                        grams_remaining: 600,
                        reserved_for_job_id: 'job-1',
                    },
                    {
                        spool_id: 'spool-orange-petg-wet',
                        material: 'PETG',
                        color_hex: '#ffaa00',
                        color_name: 'Orange',
                        grams_remaining: 700,
                        dry_status: 'needs_drying',
                    },
                    {
                        spool_id: 'spool-empty-asa',
                        material: 'ASA',
                        color_hex: '#333333',
                        grams_remaining: 0,
                    },
                ],
            },
        });

        expect(result.materials).toEqual([
            expect.objectContaining({
                material: 'ASA',
                spool_count: 1,
                available_spool_count: 0,
                total_grams_remaining: 0,
            }),
            expect.objectContaining({
                material: 'PETG',
                spool_count: 1,
                available_spool_count: 0,
                total_grams_remaining: 700,
            }),
            expect.objectContaining({
                material: 'PLA',
                spool_count: 2,
                available_spool_count: 1,
                total_grams_remaining: 1800,
                colors: expect.arrayContaining([
                    expect.objectContaining({
                        color_hex: '#FFFFFF',
                        color_name: 'White',
                        available_spool_count: 1,
                    }),
                    expect.objectContaining({
                        color_hex: '#000000',
                        color_name: 'Black',
                        available_spool_count: 0,
                    }),
                ]),
            }),
        ]);
        expect(result.colors).toEqual(expect.arrayContaining([
            expect.objectContaining({
                color_hex: '#FFFFFF',
                color_name: 'White',
                materials: ['PLA'],
                available_spool_count: 1,
            }),
        ]));

        const publicJson = JSON.stringify(result);
        expect(publicJson).not.toContain('spool-white-pla');
        expect(publicJson).not.toContain('printer-1');
        expect(publicJson).not.toContain('Rack A');
        expect(publicJson).not.toContain('LOT-SECRET');
        expect(publicJson).not.toContain('job-1');
    });
});

describe('AMS tray overlay from the cloud printer mirror', () => {
    it('counts loaded AMS slots and surfaces materials that have no spool inventory', () => {
        const result = buildPublicFilamentAvailability({
            inventory: {
                spools: [{
                    spool_id: 'spool-white-pla',
                    material: 'PLA',
                    color_hex: '#FFFFFF',
                    color_name: 'White',
                    grams_remaining: 500,
                }],
            },
            overview: {
                printers: [
                    {
                        printer_id: 'printer-uuid-1',
                        capabilities: {
                            ams_trays: [
                                { ams_id: 0, tray_id: 0, material: 'PLA', color_hex: 'FFFFFFFF', color_name: 'White' },
                                // TPU exists only in an AMS slot, not in the spool inventory
                                { ams_id: 0, tray_id: 1, material: 'TPU', color_hex: 'FF69B4FF', color_name: 'Pink' },
                                { material: null, color_hex: null }, // empty slot — ignored
                            ],
                        },
                    },
                ],
            },
        });

        const pla = result.materials.find((entry) => entry.material === 'PLA');
        expect(pla.spool_count).toBe(1);
        expect(pla.loaded_slot_count).toBe(1);
        expect(pla.colors).toEqual([expect.objectContaining({
            color_hex: '#FFFFFF',
            loaded_slot_count: 1,
            available_spool_count: 1,
        })]);

        const tpu = result.materials.find((entry) => entry.material === 'TPU');
        expect(tpu).toBeDefined();
        expect(tpu.spool_count).toBe(0);
        expect(tpu.loaded_slot_count).toBe(1);
        expect(tpu.colors).toEqual([expect.objectContaining({
            color_hex: '#FF69B4',
            color_name: 'Pink',
            loaded_slot_count: 1,
        })]);

        // AMS colors are normalized to #RRGGBB — no 8-char device format leaks
        expect(JSON.stringify(result)).not.toContain('FF69B4FF');
    });

    it('is unchanged when no overview is provided (backwards compatible)', () => {
        const result = buildPublicFilamentAvailability({
            inventory: { spools: [{ spool_id: 's1', material: 'PLA', color_hex: '#FFFFFF', grams_remaining: 100 }] },
        });
        expect(result.materials).toHaveLength(1);
        expect(result.materials[0].loaded_slot_count).toBe(0);
    });
});
