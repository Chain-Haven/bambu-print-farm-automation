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
