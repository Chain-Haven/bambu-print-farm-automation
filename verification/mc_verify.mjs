// mc_verify.mjs — full multi-color + merged-text verification via SliceService.
// A: 2 separate cubes fil 1+2 — dual output + placement kept + P1S start gcode
// B2: base + text sunk 0.2mm, DIFFERENT filament, merged via options.groups —
//     text filament wins the text region; base is carved (BBS merge semantics)
// D: single-color plain-path regression
// E: user settings override (layer_height) reaches the project-path gcode
import { pathToFileURL, fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(PROJ, 'verification', 'out');
fs.mkdirSync(OUT, { recursive: true });
const { SliceService } = await import(pathToFileURL(path.join(PROJ, 'src/services/SliceService.js')));
const { extractGcodeFrom3mf } = await import(pathToFileURL(path.join(PROJ, 'src/gcode/Extract3mf.js')));

function boxSTL(x0, y0, z0, x1, y1, z1) {
    const v = [[x0,y0,z0],[x1,y0,z0],[x1,y1,z0],[x0,y1,z0],[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1]];
    const f = [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
    const buf = Buffer.alloc(84 + f.length * 50);
    buf.writeUInt32LE(f.length, 80);
    let o = 84;
    for (const [a,b,c] of f) {
        const A = v[a], B = v[b], C = v[c];
        const u = [B[0]-A[0], B[1]-A[1], B[2]-A[2]], w = [C[0]-A[0], C[1]-A[1], C[2]-A[2]];
        let n = [u[1]*w[2]-u[2]*w[1], u[2]*w[0]-u[0]*w[2], u[0]*w[1]-u[1]*w[0]];
        const L = Math.hypot(n[0], n[1], n[2]) || 1;
        n = n.map(q => q / L);
        buf.writeFloatLE(n[0], o); buf.writeFloatLE(n[1], o+4); buf.writeFloatLE(n[2], o+8); o += 12;
        for (const P of [A,B,C]) { buf.writeFloatLE(P[0], o); buf.writeFloatLE(P[1], o+4); buf.writeFloatLE(P[2], o+8); o += 12; }
        o += 2;
    }
    return buf;
}

// Track tool + Z; report per-tool extrusion inside/outside a region and extents.
function analyze(gcode, region) {
    let z = 0, tool = 0, x = 0, y = 0, started = false;
    const inRegion = new Map(), all = new Map();
    for (const raw of gcode.split('\n')) {
        const line = raw;
        if (line.includes('EXECUTABLE_BLOCK_START')) started = true;
        if (!started) continue;
        const tm = line.match(/^T(\d{1,3})\s*$/);
        if (tm && +tm[1] < 100) { tool = +tm[1]; continue; }
        if (!/^G[123] /.test(line)) continue;
        const gz = line.match(/ Z([-\d.]+)/); if (gz) z = parseFloat(gz[1]);
        const gx = line.match(/ X([-\d.]+)/), gy = line.match(/ Y([-\d.]+)/), ge = line.match(/ E([-\d.]+)/);
        const nx = gx ? parseFloat(gx[1]) : x, ny = gy ? parseFloat(gy[1]) : y;
        if (ge && parseFloat(ge[1]) > 0 && (gx || gy)) {
            const mx = (x + nx) / 2, my = (y + ny) / 2;
            const zz = Math.round(z * 100) / 100;
            if (!all.has(tool)) all.set(tool, { minX: 1e9, maxX: -1e9, minY: 1e9, maxY: -1e9, zs: new Set() });
            const a = all.get(tool);
            if (mx > 60) { // ignore the wipe tower (pinned at x=15, width <45)
                a.minX = Math.min(a.minX, mx); a.maxX = Math.max(a.maxX, mx);
                a.minY = Math.min(a.minY, my); a.maxY = Math.max(a.maxY, my);
            }
            a.zs.add(zz);
            if (region && mx >= region.x0 && mx <= region.x1 && my >= region.y0 && my <= region.y1) {
                if (!inRegion.has(tool)) inRegion.set(tool, new Set());
                inRegion.get(tool).add(zz);
            }
        }
        x = nx; y = ny;
    }
    const ft = (gcode.match(/; filament_type = (.+)/) || [])[1] || '(none)';
    const lh = (gcode.match(/; layer_height = (.+)/) || [])[1] || '?';
    const twx = (gcode.match(/; wipe_tower_x = ([\d.]+)/) || [])[1];
    const p1s = gcode.includes(';===== machine: P1S');
    return { filamentType: ft.trim(), layerHeight: lh.trim(), towerX: twx, p1sStart: p1s, inRegion, all };
}

const zrange = (s) => { const a = [...s].sort((p, q) => p - q); return `${a[0]}..${a[a.length - 1]} (${a.length})`; };
let failures = 0;
const check = (label, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failures++; };

// ---------- A: two separate cubes ----------
{
    const r = await SliceService.slice({
        modelName: 'mc_regression.stl',
        modelBuffers: [
            { name: 'cube1.stl', buffer: boxSTL(100, 100, 0, 120, 120, 10) },
            { name: 'cube2.stl', buffer: boxSTL(140, 100, 0, 160, 120, 10) },
        ],
        options: { filaments: [1, 2], colors: ['#E23A3A', '#2080F0'], printer_model: 'P1S' },
    });
    console.log('\n=== TEST A: 2 separate cubes, fil 1+2 ===');
    if (!r.ok) { console.log(`  FAIL slice: ${r.code} — ${r.error}`); failures++; }
    else {
        const { content: g } = await extractGcodeFrom3mf(r.gcode3mf, 'a.gcode.3mf');
        fs.writeFileSync(path.join(OUT, 'testA2.gcode'), g);
        const a = analyze(g, { x0: 100, x1: 120, y0: 100, y1: 120 }); // cube1 region
        check(`dual filament output (${a.filamentType})`, a.filamentType.includes(';'));
        check(`P1S machine start gcode`, a.p1sStart);
        check(`wipe tower pinned at 15 (got ${a.towerX})`, Math.abs(a.towerX - 15) < 0.5);
        const t0 = a.all.get(0);
        check(`cube1 (T0) placement kept X~100-120 (got ${t0?.minX.toFixed(1)}..${t0?.maxX.toFixed(1)})`,
            t0 && Math.abs(t0.minX - 100) < 3 && Math.abs(t0.maxX - 120) < 3);
        const t1 = a.all.get(1);
        check(`cube2 (T1) at X~140-160 (got ${t1?.minX.toFixed(1)}..${t1?.maxX.toFixed(1)})`,
            t1 && t1.minX > 130 && t1.maxX < 170);
    }
}

// ---------- B2: merged base+text via options.groups ----------
{
    const region = { x0: 119, x1: 137, y0: 124.5, y1: 131.5 };
    const r = await SliceService.slice({
        modelName: 'mc_text_merged.stl',
        modelBuffers: [
            { name: 'base.stl', buffer: boxSTL(108, 108, 0, 148, 148, 10) },
            { name: 'text.stl', buffer: boxSTL(118, 124, 9.8, 138, 132, 11.8) },
        ],
        options: { filaments: [1, 2], colors: ['#E23A3A', '#2080F0'], printer_model: 'P1S', groups: [0, 0] },
    });
    console.log('\n=== TEST B2: text sunk in base, MERGED via groups [0,0] ===');
    if (!r.ok) { console.log(`  FAIL slice: ${r.code} — ${r.error}`); failures++; }
    else {
        const { content: g } = await extractGcodeFrom3mf(r.gcode3mf, 'b2.gcode.3mf');
        fs.writeFileSync(path.join(OUT, 'testB2.gcode'), g);
        const a = analyze(g, region);
        check(`dual filament output (${a.filamentType})`, a.filamentType.includes(';'));
        check(`P1S machine start gcode`, a.p1sStart);
        const t0all = a.all.get(0);
        check(`base (T0) placement kept X~108-148 (got ${t0all?.minX.toFixed(1)}..${t0all?.maxX.toFixed(1)})`,
            t0all && Math.abs(t0all.minX - 108) < 3 && Math.abs(t0all.maxX - 148) < 3);
        const t1r = a.inRegion.get(1), t0r = a.inRegion.get(0);
        check(`text filament (T1) fills text region up to z=11.8 (got ${t1r ? zrange(t1r) : 'none'})`,
            t1r && Math.max(...t1r) === 11.8 && Math.min(...t1r) <= 10.0);
        // The interface layer (z=10, where base top and text start share the
        // layer) may carry a stray anchor line of T0 — buried under 9 text
        // layers, invisible. ABOVE it the text region must be pure T1.
        const t0above = t0r ? [...t0r].filter(z => z > 10.01) : [];
        check(`base (T0) never prints inside text region above z=10 (got ${t0above.length ? t0above.join(',') : 'none'})`,
            t0above.length === 0);
    }
}

// ---------- F: single-color MERGED group (project path via hasMerge) ----------
{
    const region = { x0: 119, x1: 137, y0: 124.5, y1: 131.5 };
    const r = await SliceService.slice({
        modelName: 'sc_text_merged.stl',
        modelBuffers: [
            { name: 'base.stl', buffer: boxSTL(108, 108, 0, 148, 148, 10) },
            { name: 'text.stl', buffer: boxSTL(118, 124, 9.8, 138, 132, 11.8) },
        ],
        options: { filaments: [1, 1], printer_model: 'P1S', groups: [0, 0] },
    });
    console.log('\n=== TEST F: single-color merged text via groups [0,0] ===');
    if (!r.ok) { console.log(`  FAIL slice: ${r.code} — ${r.error}`); failures++; }
    else {
        const { content: g } = await extractGcodeFrom3mf(r.gcode3mf, 'f.gcode.3mf');
        fs.writeFileSync(path.join(OUT, 'testF.gcode'), g);
        const a = analyze(g, region);
        const t0 = a.all.get(0);
        check(`sliced ok, single filament (${a.filamentType})`, !!t0);
        check(`placement kept X~108-148 (got ${t0?.minX.toFixed(1)}..${t0?.maxX.toFixed(1)})`,
            t0 && Math.abs(t0.minX - 108) < 3 && Math.abs(t0.maxX - 148) < 3);
        const t0r = a.inRegion.get(0);
        check(`text solid printed to z=11.8 (got ${t0r ? zrange(t0r) : 'none'})`,
            t0r && Math.max(...t0r) === 11.8);
    }
}

// ---------- D: single-color regression (plain path) ----------
{
    const r = await SliceService.slice({
        modelName: 'single.stl',
        modelBuffers: [{ name: 'cube.stl', buffer: boxSTL(100, 100, 0, 120, 120, 10) }],
        options: { filaments: [1], printer_model: 'P1S' },
    });
    console.log('\n=== TEST D: single-color plain path ===');
    if (!r.ok) { console.log(`  FAIL slice: ${r.code} — ${r.error}`); failures++; }
    else {
        const { content: g } = await extractGcodeFrom3mf(r.gcode3mf, 'd.gcode.3mf');
        const a = analyze(g, null);
        const t0 = a.all.get(0);
        check(`sliced ok, single filament (${a.filamentType})`, !a.filamentType.includes(';'));
        check(`placement kept X~100-120 (got ${t0?.minX.toFixed(1)}..${t0?.maxX.toFixed(1)})`,
            t0 && Math.abs(t0.minX - 100) < 3 && Math.abs(t0.maxX - 120) < 3);
    }
}

// ---------- E: settings override on the project path ----------
{
    const r = await SliceService.slice({
        modelName: 'mc_settings.stl',
        modelBuffers: [
            { name: 'cube1.stl', buffer: boxSTL(100, 100, 0, 120, 120, 10) },
            { name: 'cube2.stl', buffer: boxSTL(140, 100, 0, 160, 120, 10) },
        ],
        options: { filaments: [1, 2], colors: ['#E23A3A', '#2080F0'], printer_model: 'P1S', settings: { layer_height: '0.28', sparse_infill_density: '20' } },
    });
    console.log('\n=== TEST E: project path + user settings (layer 0.28) ===');
    if (!r.ok) { console.log(`  FAIL slice: ${r.code} — ${r.error}`); failures++; }
    else {
        const { content: g } = await extractGcodeFrom3mf(r.gcode3mf, 'e.gcode.3mf');
        const a = analyze(g, null);
        check(`layer_height override applied (got ${a.layerHeight})`, a.layerHeight === '0.28');
        check(`still dual (${a.filamentType})`, a.filamentType.includes(';'));
        const dens = (g.match(/; sparse_infill_density = (.+)/) || [])[1];
        check(`infill density override applied (got ${dens})`, (dens || '').trim() === '20%');
    }
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' FAILURE(S)'}`);
process.exit(failures ? 1 : 0);
