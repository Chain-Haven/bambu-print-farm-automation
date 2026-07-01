import { describe, expect, it } from 'vitest';
import { buildPrintPreflight, estimatePrintQuote } from '../../src/cloud/quoteEstimator.js';

const now = () => new Date('2026-07-01T12:00:00.000Z');

describe('merchant quote estimator', () => {
    it('estimates price, material usage, machine time, lead time, and route status', () => {
        const quote = estimatePrintQuote({
            requirements: {
                dimensions_mm: { x: 100, y: 80, z: 40 },
                materials: ['PETG'],
                colors: ['#ffaa00'],
                estimated_grams: 120,
            },
            routing: {
                status: 'routed',
                strategy: 'ship_cutoff',
                score: { queue_depth: 2 },
            },
            now,
        });

        expect(quote).toMatchObject({
            currency: 'USD',
            routing_status: 'routed',
            routing_strategy: 'ship_cutoff',
            estimates: {
                material_grams: 120,
                queue_minutes: 90,
            },
            totals: {
                estimated_total_cents: expect.any(Number),
            },
            lead_time: {
                earliest_ready_at: '2026-07-01T18:10:00.000Z',
                confidence: 'standard',
            },
        });
        expect(quote.totals.estimated_total_cents).toBeGreaterThan(1000);
    });

    it('flags source models, oversize dimensions, and unavailable routing during preflight', () => {
        const preflight = buildPrintPreflight({
            file: { name: 'large-bracket.stl', byte_size: 1024, file_mode: 'source_model' },
            requirements: { dimensions_mm: { x: 400, y: 100, z: 100 }, materials: ['ASA'] },
            route: { status: 'no_capacity', rejected_candidates: [{ reasons: ['build_volume_too_small'] }] },
            maxBuildVolume: { x: 256, y: 256, z: 256 },
            now,
        });

        expect(preflight.accepted).toBe(false);
        expect(preflight.review_required).toBe(true);
        expect(preflight.warnings).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'source_model_requires_slicing' }),
            expect.objectContaining({ code: 'build_volume_too_small' }),
            expect.objectContaining({ code: 'no_current_capacity' }),
        ]));
    });
});
