import { beforeAll, describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// AmsService.matchColorsToTrays — the start-time color→tray auto-mapper.
// Material-first, then RGB distance; never silently prints the wrong color.

process.env.MOCK_MODE = 'true';
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.DB_PATH = path.join(os.tmpdir(), 'ams-automap-test.db');

let AmsService;

beforeAll(async () => {
    fs.rmSync(process.env.DB_PATH, { force: true });
    const db = await import('../../src/db/database.js');
    await db.initDb();
    db.runMigrations();
    ({ AmsService } = await import('../../src/services/AmsService.js'));
});

const tray = (amsId, trayId, material, hex, name = null) => ({
    ams_id: amsId, tray_id: trayId,
    configured_material: material, configured_color: hex, configured_color_name: name,
    live_type: material, live_color: hex,
});

describe('AmsService.matchColorsToTrays', () => {
    const slots = [
        tray(0, 0, 'PLA', '#ffffff', 'White'),
        tray(0, 1, 'PLA', '#000000', 'Black'),
        tray(0, 2, 'PETG', '#ffffff', 'White PETG'),
        tray(0, 3, 'PLA', '#e23a3a', 'Red'),
    ];

    it('maps exact colors to their trays (one tray per color)', () => {
        const r = AmsService.matchColorsToTrays(['#000000', '#e23a3a'], slots, 120, 'PLA');
        expect(r.ok).toBe(true);
        expect(r.mapping).toEqual([1, 3]);
    });

    it('material first: a white PETG spool never satisfies a white PLA print', () => {
        const petgOnly = [tray(0, 0, 'PETG', '#ffffff', 'White PETG')];
        const r = AmsService.matchColorsToTrays(['#ffffff'], petgOnly, 120, 'PLA');
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/No PLA spool/i);
    });

    it('close-but-not-exact colors still map (RGB distance within threshold)', () => {
        const r = AmsService.matchColorsToTrays(['#e83f3f'], slots, 120, 'PLA'); // near Red
        expect(r.ok).toBe(true);
        expect(r.mapping).toEqual([3]);
    });

    it('refuses when no loaded spool is close enough (black never prints as white)', () => {
        const whiteOnly = [tray(0, 0, 'PLA', '#ffffff', 'White')];
        const r = AmsService.matchColorsToTrays(['#000000'], whiteOnly, 120, 'PLA');
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/No AMS spool matches/i);
    });

    it('two identical wanted colors need two distinct trays', () => {
        const oneWhite = [tray(0, 0, 'PLA', '#ffffff'), tray(0, 1, 'PLA', '#000000')];
        const r = AmsService.matchColorsToTrays(['#ffffff', '#ffffff'], oneWhite, 120, 'PLA');
        expect(r.ok).toBe(false); // only one white tray — second color has no home
    });

    it('rejects invalid color specs loudly', () => {
        const r = AmsService.matchColorsToTrays(['not-a-color'], slots, 120, null);
        expect(r.ok).toBe(false);
        expect(r.error).toMatch(/Invalid color/i);
    });
});
