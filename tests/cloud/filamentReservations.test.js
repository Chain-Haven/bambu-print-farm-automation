import { describe, expect, it } from 'vitest';
import {
    releaseFilamentReservation,
    reserveFilamentForJob,
} from '../../src/cloud/filamentReservations.js';

describe('filament reservations', () => {
    it('reserves the best matching dry unreserved spool for a job', () => {
        const result = reserveFilamentForJob({
            inventory: {
                spools: [
                    { spool_id: 'wrong-color', material: 'PLA', color_hex: '#000000', grams_remaining: 800 },
                    { spool_id: 'wet-spool', material: 'PLA', color_hex: '#FFFFFF', grams_remaining: 900, dry_status: 'wet' },
                    { spool_id: 'target-spool', material: 'PLA', color_hex: '#FFFFFF', grams_remaining: 500, dry_status: 'ready' },
                ],
            },
            jobId: 'job-1',
            requirements: {
                materials: ['pla'],
                colors: ['#fff'],
                estimated_grams: 200,
            },
        });

        expect(result).toMatchObject({
            status: 'reserved',
            reservation: {
                spool_id: 'target-spool',
                material: 'PLA',
                color_hex: '#FFFFFF',
                reserved_grams: 200,
            },
        });
        expect(result.inventory.spools.find((spool) => spool.spool_id === 'target-spool').reserved_for_job_id).toBe('job-1');
    });

    it('releases any spool reserved by the job', () => {
        const result = releaseFilamentReservation({
            inventory: {
                spools: [
                    { spool_id: 'target-spool', material: 'PLA', color_hex: '#FFFFFF', grams_remaining: 500, reserved_for_job_id: 'job-1' },
                    { spool_id: 'other-spool', material: 'PLA', color_hex: '#000000', grams_remaining: 500, reserved_for_job_id: 'job-2' },
                ],
            },
            jobId: 'job-1',
        });

        expect(result.released).toEqual(['target-spool']);
        expect(result.inventory.spools[0].reserved_for_job_id).toBeNull();
        expect(result.inventory.spools[1].reserved_for_job_id).toBe('job-2');
    });
});
