import fs from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.DB_PATH = process.env.DB_PATH || '/tmp/event-retention-test.db';

let EventModel;
let dbRun;
let dbGet;

beforeAll(async () => {
    // Start from a clean database: the fresh event this test inserts survives
    // pruning, so a leftover DB from a previous run breaks the counts.
    fs.rmSync(process.env.DB_PATH, { force: true });
    const db = await import('../../src/db/database.js');
    await db.initDb();
    db.runMigrations();
    ({ dbRun, dbGet } = db);
    ({ EventModel } = await import('../../src/models/Event.js'));
});

describe('EventModel.pruneOlderThan', () => {
    it('deletes events older than the retention window and keeps recent ones', () => {
        // Fresh event (kept).
        EventModel.create({ entity_type: 'printer', entity_id: 'ret-1', event_type: 'printer.error', payload: { code: 1 } });
        // Backdated event (pruned).
        dbRun(
            "INSERT INTO events (event_id, entity_type, entity_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?, datetime('now','-40 days'))",
            ['old-evt-1', 'printer', 'ret-1', 'printer.error', '{}'],
        );

        const before = dbGet("SELECT COUNT(*) AS n FROM events WHERE entity_id = 'ret-1'").n;
        expect(before).toBe(2);

        const removed = EventModel.pruneOlderThan(30);
        expect(removed).toBeGreaterThanOrEqual(1);

        const rows = EventModel.findByEntity('printer', 'ret-1', { limit: 50 });
        expect(rows.length).toBe(1); // only the fresh one survives
        expect(rows[0].event_id).not.toBe('old-evt-1');
    });
});
