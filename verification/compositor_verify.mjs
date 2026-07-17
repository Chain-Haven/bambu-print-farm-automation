// compositor_verify.mjs — the storefront customization compositor, end-to-end
// through the REAL engine: a case (box) + an SVG logo placed on 'top' + a text
// placement on 'front', two colors, composed into ONE merged object.
// Asserts: dual-filament output, the logo prints in ITS filament in the top
// region (show-through), the case is carved there, and the assembly lands
// centered on the bed at z=0.
import { pathToFileURL, fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const PROJ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(PROJ, 'verification', 'out');
fs.mkdirSync(OUT, { recursive: true });
const { composeCustomizedPlate } = await import(pathToFileURL(path.join(PROJ, 'src/services/CustomizationCompositor.js')));
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

let failures = 0;
const check = (label, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) failures++; };

// The case: a 40×40×12 box modeled at arbitrary coords (compositor re-centers).
const caseStl = boxSTL(10, 10, 0, 50, 50, 12);
// A square-border SVG logo (ring with a real hole).
const logoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M5 5 H95 V95 H5 Z M25 25 V75 H75 V25 Z" fill="black" fill-rule="evenodd"/>
</svg>`;

console.log('\n=== Compositor: SVG logo on top + text on front, 2 colors, merged ===');
const composed = await composeCustomizedPlate({
    baseBuffer: caseStl,
    baseName: 'case.stl',
    placements: [
        { asset_buffer: Buffer.from(logoSvg), original_name: 'logo.svg', face: 'top', width_mm: 20, mode: 'emboss', color: '#000000' },
        { text: 'IAN', face: 'front', height_mm: 8, thickness_mm: 1.2, mode: 'emboss', color: '#000000' },
    ],
    baseColor: '#e23a3a',
    printerModel: 'P1S',
});

check(`composed 3 parts (base + logo + text), got ${composed.modelBuffers.length}`, composed.modelBuffers.length === 3);
check(`one merged group`, new Set(composed.groups).size === 1);
check(`2 colors (${composed.colors.join(', ')})`, composed.colors.length === 2);

const r = await SliceService.slice({
    modelName: 'composed_case.stl',
    modelBuffers: composed.modelBuffers,
    options: { printer_model: 'P1S', filaments: composed.filaments, groups: composed.groups, colors: composed.colors },
});
if (!r.ok) { console.log(`  FAIL slice: ${r.code} — ${r.error}`); failures++; }
else {
    const { content: g } = await extractGcodeFrom3mf(r.gcode3mf, 'c.gcode.3mf');
    fs.writeFileSync(path.join(OUT, 'compositor.gcode'), g);
    const ft = (g.match(/; filament_type = (.+)/) || [])[1] || '';
    check(`dual filament output (${ft.trim()})`, ft.includes(';'));

    // Case is 40×40 centered on the 256 bed → X/Y 108..148; logo on top face
    // (z=12) sunk 0.2 → logo band z in (11.8 .. 12.3]; logo width 20 → X 118..138.
    let z = 0, tool = 0, x = 0, y = 0, started = false;
    const logoRegion = { hits: new Map() };  // tool -> extrusions in logo XY at z>12
    let maxZbyTool = new Map();
    for (const line of g.split('\n')) {
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
            if (mx > 60) maxZbyTool.set(tool, Math.max(maxZbyTool.get(tool) ?? 0, z));
            if (z > 12.01 && mx >= 116 && mx <= 140 && my >= 116 && my <= 140) {
                logoRegion.hits.set(tool, (logoRegion.hits.get(tool) || 0) + 1);
            }
        }
        x = nx; y = ny;
    }
    const t1Hits = logoRegion.hits.get(1) || 0, t0Hits = logoRegion.hits.get(0) || 0;
    check(`logo filament (T1) prints above the top face (${t1Hits} segments)`, t1Hits > 10);
    check(`case filament (T0) stays out of the logo band above z=12 (got ${t0Hits})`, t0Hits === 0);
    check(`case top at z≈12 (T0 max z ${maxZbyTool.get(0)})`, Math.abs((maxZbyTool.get(0) ?? 0) - 12) < 0.45);
}

// ===== Bottom-face logo: flush inlay in the FIRST layers =====
// A solid logo (the guaranteed case). The engine absorbs strokes ≲3mm wide
// into the surrounding filament ON LAYER 1 ONLY — so thin frame-style logos
// may show the case color on the outermost underside layer (documented in
// CustomizationCompositor.js; verified empirically 2026-07-17).
console.log('\n=== Compositor: bottom-face logo — flush 0.5mm inlay, first-two-layers ===');
{
    const solidLogoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="5" y="5" width="90" height="90" fill="black"/></svg>`;
    const composed = await composeCustomizedPlate({
        baseBuffer: caseStl,
        baseName: 'case.stl',
        placements: [
            { asset_buffer: Buffer.from(solidLogoSvg), original_name: 'logo.svg', face: 'bottom', width_mm: 20, color: '#000000' },
        ],
        baseColor: '#e23a3a',
        printerModel: 'P1S',
    });
    const r = await SliceService.slice({
        modelName: 'bottom_logo_case.stl',
        modelBuffers: composed.modelBuffers,
        options: { printer_model: 'P1S', filaments: composed.filaments, groups: composed.groups, colors: composed.colors },
    });
    if (!r.ok) { console.log(`  FAIL slice: ${r.code} — ${r.error}`); failures++; }
    else {
        const { content: g } = await extractGcodeFrom3mf(r.gcode3mf, 'b.gcode.3mf');
        fs.writeFileSync(path.join(OUT, 'compositor_bottom.gcode'), g);
        let z = 0, tool = 0, x = 0, y = 0, started = false;
        let logoMinZ = 1e9, logoMaxZ = -1e9, anyBelowBed = false;
        let l1T0 = 0, l1T1 = 0; // first-layer ownership in the logo interior
        for (const line of g.split('\n')) {
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
                if (z < -0.01) anyBelowBed = true;
                // logo XY footprint: 20mm at bed center → 118..138
                if (mx >= 118 && mx <= 138 && my >= 118 && my <= 138 && tool === 1) {
                    logoMinZ = Math.min(logoMinZ, z); logoMaxZ = Math.max(logoMaxZ, z);
                }
                // interior probe, clear of the logo's walls
                if (mx >= 122 && mx <= 134 && my >= 122 && my <= 134 && Math.abs(z - 0.2) < 0.01) {
                    if (tool === 0) l1T0++; else if (tool === 1) l1T1++;
                }
                x = nx; y = ny;
                continue;
            }
            x = nx; y = ny;
        }
        check(`logo (T1) prints only in the first layers (z ${logoMinZ.toFixed(2)}..${logoMaxZ.toFixed(2)})`,
            logoMinZ <= 0.25 && logoMaxZ <= 0.65);
        check(`underside (layer 1) is logo-colored: T1 only in the interior (T1 ${l1T1}, T0 ${l1T0})`,
            l1T1 > 5 && l1T0 === 0);
        check(`nothing extrudes below the bed`, !anyBelowBed);
        const ft = (g.match(/; filament_type = (.+)/) || [])[1] || '';
        check(`dual filament output (${ft.trim()})`, ft.includes(';'));
    }
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
