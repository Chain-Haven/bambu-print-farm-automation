// printer_matrix.mjs — REAL STL through the full pipeline for EVERY printer
// model: slice (single + dual color) → verify machine identity, placement,
// bed size, filament → loop/eject transform with the model's own anchors.
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

import { fileURLToPath } from 'node:url';
const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { SliceService } = await import(pathToFileURL(path.join(PROJ, 'src/services/SliceService.js')));
const { extractGcodeFrom3mf } = await import(pathToFileURL(path.join(PROJ, 'src/gcode/Extract3mf.js')));
const { automate } = await import(pathToFileURL(path.join(PROJ, 'src/gcode/Automator.js')));

// Real production STL: name-tag base plate, printer coords x 98..158 y 116..140
const realSTL = fs.readFileSync(path.join(PROJ, 'verification/fixtures/nametag_base.stl'));

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

function extentsAtBody(gcode) {
    let z = 0, x = 0, y = 0, started = false;
    const e = { minX: 1e9, maxX: -1e9, minY: 1e9, maxY: -1e9 };
    for (const line of gcode.split('\n')) {
        if (line.includes('EXECUTABLE_BLOCK_START')) started = true;
        if (!started) continue;
        if (!/^G[123] /.test(line)) continue;
        const gz = line.match(/ Z([-\d.]+)/); if (gz) z = parseFloat(gz[1]);
        const gx = line.match(/ X([-\d.]+)/), gy = line.match(/ Y([-\d.]+)/), ge = line.match(/ E([-\d.]+)/);
        const nx = gx ? parseFloat(gx[1]) : x, ny = gy ? parseFloat(gy[1]) : y;
        if (ge && parseFloat(ge[1]) > 0 && (gx || gy) && z > 0.1 && z < 4.1) {
            const mx = (x + nx) / 2, my = (y + ny) / 2;
            if (mx > 55) { // ignore wipe tower zone
                e.minX = Math.min(e.minX, mx); e.maxX = Math.max(e.maxX, mx);
                e.minY = Math.min(e.minY, my); e.maxY = Math.max(e.maxY, my);
            }
        }
        x = nx; y = ny;
    }
    return e;
}

// Per-model expectations. Machine identity: the resolved machine preset's
// printer_model lands in the gcode header.
const MODELS = {
    P1S: { header: /; printer_model = (Bambu Lab )?P1S/, bed: '256x256' },
    X1: { header: /; printer_model = (Bambu Lab )?X1/, bed: '256x256' },
    A1: { header: /; printer_model = (Bambu Lab )?A1(?! mini)/i, bed: '256x256' },
    A1_MINI: { header: /; printer_model = (Bambu Lab )?A1 ?mini/i, bed: '180x180' },
};

let failures = 0;
const check = (label, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failures++; };

for (const [model, exp] of Object.entries(MODELS)) {
    // ---------- single color, real STL ----------
    {
        const r = await SliceService.slice({
            modelName: 'nametag.stl',
            modelBuffers: [{ name: 'base.stl', buffer: realSTL }],
            options: { filaments: [1], printer_model: model, material: 'PLA' },
        });
        console.log(`\n=== ${model} — single-color real STL ===`);
        if (!r.ok) { console.log(`  FAIL slice: ${r.code} — ${(r.error || '').slice(0, 140)}`); failures++; continue; }
        const { content: g } = await extractGcodeFrom3mf(r.gcode3mf, 'x');
        const pm = (g.match(/; printer_model = (.+)/) || [])[1]?.trim();
        const pa = (g.match(/; printable_area = ([\d]+x[\d]+),[\d]+x[\d]+,([\d]+x[\d]+)/) || []);
        check(`sliced ok (${r.report.plates} plate)`, r.report.plates === 1);
        check(`machine identity "${pm}"`, exp.header.test(`; printer_model = ${pm}`));
        check(`bed size ${pa[2] || '?'} (expect ${exp.bed})`, (pa[2] || '') === exp.bed);
        const e = extentsAtBody(g);
        check(`placement kept X ${e.minX.toFixed(1)}..${e.maxX.toFixed(1)} (expect ~98..158)`,
            Math.abs(e.minX - 98) < 3 && Math.abs(e.maxX - 158) < 3);
        // ---------- loop/eject transform with the model's own anchors ----------
        const t = automate(g, { printerModel: model, loopsN: 2 });
        check(`transform: purge removed (${t.report.purgeRemoval.method}, ${t.report.purgeRemoval.linesCommented} lines)`, t.report.purgeRemoval.found);
        check(`transform: ejection inserted (${t.report.insertionPoint.method})`, t.report.insertionPoint.line > 0);
        const sweeps = (t.output.match(/; --- Sweep Eject/g) || []).length;
        const m190 = (t.output.match(/^M190 S24/gm) || []).length;
        check(`transform: 2 loops → ${sweeps} sweep blocks, ${m190} cooldown waits`, sweeps === 2 && m190 >= 30);
    }
    // ---------- dual color: real STL + small cube ----------
    {
        const r = await SliceService.slice({
            modelName: 'nametag2c.stl',
            modelBuffers: [
                { name: 'base.stl', buffer: realSTL },
                { name: 'accent.stl', buffer: boxSTL(70, 116, 0, 90, 136, 4) },
            ],
            options: { filaments: [1, 2], colors: ['#ffffff', '#000000'], printer_model: model, material: 'PLA' },
        });
        console.log(`--- ${model} — dual-color ---`);
        if (!r.ok) { console.log(`  FAIL slice: ${r.code} — ${(r.error || '').slice(0, 140)}`); failures++; continue; }
        const { content: g } = await extractGcodeFrom3mf(r.gcode3mf, 'x');
        const ft = ((g.match(/; filament_type = (.+)/) || [])[1] || '').trim();
        check(`dual output (${ft})`, ft === 'PLA;PLA');
        check(`toolchanges present`, /^M620 S\dA/m.test(g));
        const tower = (g.match(/; enable_prime_tower = (\S+)/) || [])[1];
        const expTower = (model === 'A1' || model === 'A1_MINI') ? '0' : '1';
        check(`prime tower default ${tower} (expect ${expTower})`, tower === expTower);
        const t = automate(g, { printerModel: model, loopsN: 1 });
        check(`transform on dual gcode ok (${t.report.insertionPoint.method})`, t.report.insertionPoint.line > 0);
    }
}

console.log(`\n${failures === 0 ? '✅ ALL PRINTER MODELS PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures ? 1 : 0);
