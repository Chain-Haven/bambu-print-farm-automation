// Automatic host→cloud sync: the node reports LAN-discovered printers in every
// heartbeat (host_info.discovered_printers), so the fleet board fills in with
// zero manual "Discover LAN Printers" commands. These are wiring checks — the
// full loop is covered by the offline e2e (which boots the real bundle).
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('automatic heartbeat printer discovery', () => {
    it('runLocalNode attaches discovered printers to every heartbeat', () => {
        const source = fs.readFileSync('src/cloud/runLocalNode.js', 'utf8');
        expect(source).toContain('collectDiscoveredPrinterRecords');
        expect(source).toContain('discovered_printers: discoveredPrinters');
    });

    it('snapshot module sanitizes discovered printers for the wire', () => {
        const source = fs.readFileSync('src/cloud/localPrinterSnapshot.js', 'utf8');
        expect(source).toContain('export async function collectDiscoveredPrinterRecords');
        // Only wire-safe fields — no raw SSDP blobs.
        for (const field of ['serial', 'model_code', 'connection_mode', 'already_added', 'last_seen']) {
            expect(source).toContain(field);
        }
        // Best-effort contract: discovery failures must never break heartbeats.
        expect(source).toMatch(/catch\s*\{\s*\n?\s*return \[\];/);
    });

    it('fleet board adopts from heartbeat-discovered printers, keyed to the reporting node', () => {
        const source = fs.readFileSync('public/js/fleet-view.js', 'utf8');
        expect(source).toContain('host_info?.discovered_printers');
        // Each adoptable entry carries the node that saw it, so adoption goes
        // through the right host even with several nodes online.
        expect(source).toContain('openAdoptModal(found, found.node_id)');
    });
});
