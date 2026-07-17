// src/services/CustomizationCompositor.js — turn a storefront customization
// (the merchant-intake `customization.placement[]` contract) into a plate the
// slicing core prints as ONE merged object.
//
// This is the missing consumer of the placement contract: customers order a
// case with a logo/text on a chosen face, and until now the logo arrived as a
// separate STL that never met the case. The compositor:
//   1. auto-ORIENTS each asset onto the requested face of the case
//      (rotates the flat logo/text so its thickness points along the face's
//      outward normal, positions it at the face-plane offsets, sinks it 0.2mm
//      so the slicer treats it as attached), and
//   2. emits modelBuffers + groups so SliceService slices everything as PARTS
//      of one object — the asset comes LAST in the group, so it WINS the
//      shared volume and shows through in its own color (BBS "merge"
//      semantics; overlapping separate objects would abort the CLI).
//
// Faces use the model's own axes (Z-up): top/bottom/front/back/left/right.
// x_mm/y_mm are offsets IN THE FACE PLANE from the face's center (as seen
// from outside the case: +x right, +y up). mode: 'emboss' (proud, default)
// or 'engrave'/'deboss'/'inlay' (near-flush colored inlay, 0.2mm proud).
//
// BOTTOM-face logos default to 0.5mm thick, flush inlays: they occupy the
// case's first ~2 layers and read on the underside. ENGINE LIMITATION
// (verified empirically): on the FIRST layer only, the engine absorbs
// NARROW color regions (strokes ≲3mm wide) into the surrounding filament —
// solid/wide logo areas keep their color from layer 1; hairline strokes may
// show the case color on the outermost underside layer.
//
// The engine still does ALL slicing — the compositor only builds geometry.

import * as THREE from 'three';
import { Evaluator, Brush, SUBTRACTION } from 'three-bvh-csg';
import { svgToLogoGeometry, LOGO_THICKNESS_MM } from '../../public/js/logo3d.js';
import { parseFont, buildTextGeometry } from '../../public/js/text3d.js';
import { geomFromSTLBuffer, geometryToBinarySTL } from './TextTemplateService.js';
import { normalizeModel } from '../models/PrinterModels.js';
import { resolveColorSpec } from '../utils/colors.js';
import { createLogger } from '../utils/logger.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const log = createLogger('Compositor');

// SVGLoader needs a DOMParser; Node doesn't have one natively.
async function ensureDomParser() {
    if (typeof globalThis.DOMParser !== 'undefined') return;
    const { DOMParser } = await import('@xmldom/xmldom');
    globalThis.DOMParser = DOMParser;
}

const FONTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'vendor', 'fonts');
const FONT_FILES = { sans: 'DejaVuSans.ttf', 'sans-bold': 'DejaVuSans-Bold.ttf', serif: 'DejaVuSerif.ttf', script: 'GreatVibes-Regular.ttf' };
const fontCache = new Map();
function loadFontById(fontId) {
    const file = FONT_FILES[fontId] || FONT_FILES.sans;
    if (!fontCache.has(file)) {
        const buf = fs.readFileSync(path.join(FONTS_DIR, file));
        fontCache.set(file, parseFont(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
    }
    return fontCache.get(file);
}

// Face → outward normal n and in-plane basis (u = "right", v = "up" as seen
// from OUTSIDE the case). Model axes, Z-up.
const FACES = {
    top: { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    bottom: { n: [0, 0, -1], u: [1, 0, 0], v: [0, -1, 0] },
    front: { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    back: { n: [0, 1, 0], u: [-1, 0, 0], v: [0, 0, 1] },
    left: { n: [-1, 0, 0], u: [0, -1, 0], v: [0, 0, 1] },
    right: { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
};

const ATTACH_SINK_MM = 0.2;   // sink into the surface so the parts fuse
const INLAY_PROUD_MM = 0.2;   // engrave/inlay: how much stays above the face

function vec(a) { return new THREE.Vector3(a[0], a[1], a[2]); }

/**
 * Build the asset geometry for one placement, flat in XY with its base at
 * z=0, thickness along +Z, centered on X/Y (logo3d/text3d convention).
 */
async function buildPlacementGeometry(placement) {
    const widthMm = Number(placement.width_mm) > 0 ? Number(placement.width_mm) : 20;
    if (placement.text) {
        const font = loadFontById(placement.font || 'sans');
        const geo = buildTextGeometry(font, {
            text: String(placement.text),
            sizeMm: Number(placement.height_mm) > 0 ? Number(placement.height_mm) : 10,
            thicknessMm: Number(placement.thickness_mm) > 0 ? Number(placement.thickness_mm) : 1.6,
        });
        if (!geo) throw new Error(`Placement text "${placement.text}" produced no geometry`);
        // buildTextGeometry centers XY with base at z=0 (same convention)
        return geo;
    }
    const buf = placement.asset_buffer;
    if (!buf?.length) throw new Error(`Placement has no asset data (asset ${placement.asset_file_id || '?'})`);
    const name = String(placement.original_name || '').toLowerCase();
    const looksSvg = name.endsWith('.svg') || buf.slice(0, 256).toString('utf8').includes('<svg');
    if (looksSvg) {
        await ensureDomParser();
        const geo = svgToLogoGeometry(buf.toString('utf8'), { widthMm });
        if (!geo) throw new Error(`SVG asset ${placement.original_name || placement.asset_file_id} has no fillable shapes`);
        return geo;
    }
    // Binary STL asset: recenter to the same convention, scale XY to
    // width_mm, and normalize thickness to 0.5mm (placement.thickness_mm
    // overrides) — logos are thin surface marks, not 3D inserts, and 0.5mm
    // keeps them inside the first couple of layers on a bottom face.
    const geo = geomFromSTLBuffer(buf);
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const size = new THREE.Vector3(); bb.getSize(size);
    const center = new THREE.Vector3(); bb.getCenter(center);
    geo.translate(-center.x, -center.y, -bb.min.z);
    const maxXY = Math.max(size.x, size.y) || 1;
    const s = widthMm / maxXY;
    const wantThick = Number(placement.thickness_mm) > 0 ? Number(placement.thickness_mm) : LOGO_THICKNESS_MM;
    const sz = size.z > 0 ? wantThick / size.z : 1;
    geo.scale(s, s, sz);
    return geo;
}

/**
 * Compose a base case model + customization placements into a merged plate.
 *
 * @param {Object} p
 * @param {Buffer} p.baseBuffer      binary STL of the case
 * @param {string} p.baseName
 * @param {Array}  p.placements     [{ face, x_mm, y_mm, width_mm, rotation_deg,
 *                                     mode, color, asset_buffer?, original_name?,
 *                                     text?, font?, height_mm?, thickness_mm? }]
 * @param {string} [p.baseColor]    color spec ('#hex' or palette name)
 * @param {string} [p.printerModel] slicer model key (bed centering)
 * @returns {{ modelBuffers, groups, filaments, colors, summary }}
 */
export async function composeCustomizedPlate({ baseBuffer, baseName = 'case.stl', placements = [], baseColor = null, printerModel = 'P1S' }) {
    if (!baseBuffer?.length) throw new Error('Compositor: no base model buffer');
    const base = geomFromSTLBuffer(baseBuffer);
    base.computeBoundingBox();
    const bb = base.boundingBox;

    const composedParts = [];
    const colorList = [];
    const colorSlot = (hex) => {
        const norm = (hex || '').toLowerCase();
        let idx = colorList.indexOf(norm);
        if (idx === -1) { colorList.push(norm); idx = colorList.length - 1; }
        return idx + 1; // filament slots are 1-based
    };

    const resolvedBase = resolveColorSpec(baseColor) || '#ffffff';
    const baseSlot = colorSlot(resolvedBase);

    const summary = [];
    for (const [i, p] of placements.entries()) {
        const faceKey = String(p.face || 'top').toLowerCase();
        const face = FACES[faceKey];
        if (!face) throw new Error(`Unknown face "${p.face}" (use ${Object.keys(FACES).join('/')})`);

        const geo = await buildPlacementGeometry(p);
        geo.computeBoundingBox();
        const thickness = geo.boundingBox.max.z - geo.boundingBox.min.z;

        // Mode → how deep the asset sits in the surface.
        // BOTTOM face is always a FLUSH inlay: the logo occupies the case's
        // first ~0.5mm (the first two layers print in the logo's color and it
        // reads on the underside) — anything proud of the bottom would poke
        // below the build plate.
        const mode = String(p.mode || 'emboss').toLowerCase();
        const sink = faceKey === 'bottom'
            ? thickness
            : (mode === 'engrave' || mode === 'deboss' || mode === 'inlay')
                ? Math.max(ATTACH_SINK_MM, thickness - INLAY_PROUD_MM)
                : ATTACH_SINK_MM;

        // Orient: logo local x→u, y→v, z→n (outward face normal), then spin
        // about the normal by rotation_deg.
        const n = vec(face.n), u = vec(face.u), v = vec(face.v);
        const basis = new THREE.Matrix4().makeBasis(u, v, n);
        const m = new THREE.Matrix4();
        if (p.rotation_deg) {
            m.makeRotationZ((Number(p.rotation_deg) || 0) * Math.PI / 180); // pre-rotation about local z (= face normal after basis)
        }
        geo.applyMatrix4(m);
        geo.applyMatrix4(basis);

        // Face center on the base AABB + in-plane offsets, sunk along -n.
        const c = new THREE.Vector3(
            (bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2);
        const half = new THREE.Vector3(
            (bb.max.x - bb.min.x) / 2, (bb.max.y - bb.min.y) / 2, (bb.max.z - bb.min.z) / 2);
        // Distance from the AABB center to the face plane (axis-aligned
        // normal → the matching half-extent).
        const faceDist = half.x * Math.abs(n.x) + half.y * Math.abs(n.y) + half.z * Math.abs(n.z);
        const surface = c.clone()
            .add(n.clone().multiplyScalar(faceDist))
            .add(u.clone().multiplyScalar(Number(p.x_mm) || 0))
            .add(v.clone().multiplyScalar(Number(p.y_mm) || 0));
        const anchor = surface.sub(n.clone().multiplyScalar(sink));
        geo.translate(anchor.x, anchor.y, anchor.z);

        const hex = resolveColorSpec(p.color) || (resolvedBase === '#000000' ? '#ffffff' : '#000000');
        const flush = sink >= thickness - 0.01;
        composedParts.push({ geo, slot: colorSlot(hex), name: p.text ? `text_${i}.stl` : `logo_${i}.stl`, flush });
        summary.push(`${p.text ? `text "${p.text}"` : (p.original_name || p.asset_file_id || 'asset')} → ${faceKey}${p.x_mm || p.y_mm ? ` @(${p.x_mm || 0},${p.y_mm || 0})` : ''} ${mode}${flush ? '/flush' : ''} ${hex}`);
    }

    // FLUSH inlays (bottom-face logos, engrave mode) are fully EMBEDDED in the
    // case, and the engine's later-part-wins overlap rule does NOT hold on the
    // very first layer (engine-verified: a flush bottom logo printed its
    // visible underside layer in the CASE color). Make ownership unambiguous:
    // CARVE the inlay's volume out of the base with real CSG so the parts
    // never overlap. Proud embosses keep the proven 0.2mm-sink overlap.
    let baseGeo = base;
    const flushParts = composedParts.filter(p => p.flush);
    if (flushParts.length) {
        const evaluator = new Evaluator();
        evaluator.attributes = ['position', 'normal'];
        let brush = new Brush(baseGeo);
        brush.updateMatrixWorld();
        for (const p of flushParts) {
            const cut = new Brush(p.geo);
            cut.updateMatrixWorld();
            brush = evaluator.evaluate(brush, cut, SUBTRACTION);
            brush.updateMatrixWorld();
        }
        baseGeo = brush.geometry;
        log.info(`Carved ${flushParts.length} flush inlay(s) out of the base (CSG)`);
    }

    // Position the whole assembly on the bed: base center → bed center, base
    // min z → 0 (the merged project path slices with --arrange 0).
    const bed = normalizeModel(printerModel)?.bed || { x: 256, y: 256 };
    const dx = bed.x / 2 - (bb.min.x + bb.max.x) / 2;
    const dy = bed.y / 2 - (bb.min.y + bb.max.y) / 2;
    const dz = -bb.min.z;
    baseGeo.translate(dx, dy, dz);
    for (const part of composedParts) part.geo.translate(dx, dy, dz);

    // Base first, assets after — within a merged group the LATER part wins the
    // shared volume, which is exactly the show-through we need.
    const modelBuffers = [
        { name: baseName.replace(/\.[^.]+$/, '') + '.stl', buffer: geometryToBinarySTL(baseGeo), filament: baseSlot },
        ...composedParts.map(p => ({ name: p.name, buffer: geometryToBinarySTL(p.geo), filament: p.slot })),
    ];
    const groups = modelBuffers.map(() => 0); // one merged object
    const filaments = modelBuffers.map(b => b.filament);

    log.info(`Composed plate: base(${resolvedBase}) + ${composedParts.length} placement(s) [${summary.join('; ')}]`);
    return { modelBuffers, groups, filaments, colors: colorList, summary };
}

export default { composeCustomizedPlate };
