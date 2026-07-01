import { beforeAll, describe, expect, it } from 'vitest';

process.env.MOCK_MODE = 'true';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.DB_PATH = '/tmp/filament-spool-test.db';

let FilamentSpoolModel;

beforeAll(async () => {
    const fs = await import('node:fs');
    for (const ext of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(process.env.DB_PATH + ext); } catch { /* fresh db */ }
    }
    const db = await import('../../src/db/database.js');
    await db.initDb();
    db.runMigrations();
    ({ FilamentSpoolModel } = await import('../../src/models/FilamentSpool.js'));
});

describe('FilamentSpoolModel', () => {
    it('creates a spool defaulting remaining to total', () => {
        const spool = FilamentSpoolModel.create({ name: 'Matte Black', material: 'PLA', total_grams: 1000, low_threshold_grams: 150 });
        expect(spool.remaining_grams).toBe(1000);
        expect(spool.low_stock).toBe(false);
        expect(spool.material).toBe('PLA');
    });

    it('decrements on consume and records a ledger entry', () => {
        const spool = FilamentSpoolModel.create({ total_grams: 500, low_threshold_grams: 100 });
        const r1 = FilamentSpoolModel.consume(spool.spool_id, 120, { jobId: 'job-1' });
        expect(r1.spool.remaining_grams).toBe(380);
        expect(r1.consumed).toBe(120);
        expect(r1.low).toBe(false);
        expect(r1.crossedLowThreshold).toBe(false);

        const ledger = FilamentSpoolModel.ledger(spool.spool_id);
        expect(ledger).toHaveLength(1);
        expect(ledger[0].grams).toBe(120);
        expect(ledger[0].job_id).toBe('job-1');
    });

    it('flags the low-stock threshold crossing exactly once', () => {
        const spool = FilamentSpoolModel.create({ total_grams: 300, low_threshold_grams: 100 });
        const first = FilamentSpoolModel.consume(spool.spool_id, 150); // 300 -> 150, still above 100
        expect(first.crossedLowThreshold).toBe(false);
        const second = FilamentSpoolModel.consume(spool.spool_id, 100); // 150 -> 50, crosses 100
        expect(second.crossedLowThreshold).toBe(true);
        expect(second.low).toBe(true);
        const third = FilamentSpoolModel.consume(spool.spool_id, 10); // 50 -> 40, already low
        expect(third.crossedLowThreshold).toBe(false);
        expect(third.low).toBe(true);
    });

    it('clamps remaining at zero and marks depleted', () => {
        const spool = FilamentSpoolModel.create({ total_grams: 100, low_threshold_grams: 20 });
        const r = FilamentSpoolModel.consume(spool.spool_id, 250);
        expect(r.spool.remaining_grams).toBe(0);
        expect(r.consumed).toBe(100); // only what was actually available
        expect(r.depleted).toBe(true);
    });

    it('filters low-stock spools and refills via update', () => {
        const spool = FilamentSpoolModel.create({ name: 'Refillable', total_grams: 1000, low_threshold_grams: 900 });
        FilamentSpoolModel.consume(spool.spool_id, 200); // 800 <= 900 threshold -> low
        const low = FilamentSpoolModel.findAll({ lowStockOnly: true });
        expect(low.some((s) => s.spool_id === spool.spool_id)).toBe(true);

        const refilled = FilamentSpoolModel.update(spool.spool_id, { remaining_grams: 1000 });
        expect(refilled.remaining_grams).toBe(1000);
        expect(refilled.low_stock).toBe(false);
    });
});
