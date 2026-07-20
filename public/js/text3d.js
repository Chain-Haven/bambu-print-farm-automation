// public/js/text3d.js — 3D text geometry from real TTF fonts (DIRECTIVE §4).
//
// opentype.js parses the TTF and gives true glyph outlines; we convert them to
// THREE.Shape[] (with holes) and extrude to a solid. Pure geometry — used by the
// browser slicer UI and reusable headless in Node for the §7 customer-text
// automation (both resolve 'three'/'opentype.js' via import map / node_modules).

import * as THREE from 'three';
import opentype from 'opentype.js';

/** Fonts bundled under public/vendor/fonts/ (real TTFs, offline). */
export const FONTS = [
    { id: 'sans', label: 'Sans (DejaVu)', url: '/vendor/fonts/DejaVuSans.ttf' },
    { id: 'sans-bold', label: 'Sans Bold', url: '/vendor/fonts/DejaVuSans-Bold.ttf' },
    { id: 'serif', label: 'Serif (DejaVu)', url: '/vendor/fonts/DejaVuSerif.ttf' },
    { id: 'script', label: 'Script (Great Vibes)', url: '/vendor/fonts/GreatVibes-Regular.ttf' },
];

const fontCache = new Map();

/** Load + parse a TTF (browser fetch). Cached per URL. */
export async function loadFont(url) {
    if (fontCache.has(url)) return fontCache.get(url);
    const buf = await (await fetch(url)).arrayBuffer();
    const font = opentype.parse(buf);
    fontCache.set(url, font);
    return font;
}

/** Parse a TTF from an ArrayBuffer/Buffer (Node path). */
export function parseFont(arrayBuffer) {
    return opentype.parse(arrayBuffer);
}

/**
 * Convert a string to THREE.Shape[] using real glyph outlines.
 * opentype paths are y-down; we flip to y-up. Size is the CAP height target in
 * mm (approximated via font unitsPerEm scaling of the nominal size).
 */
export function textToShapes(font, text, sizeMm, letterSpacing = 0) {
    if (!text) return [];
    const path = font.getPath(text, 0, 0, sizeMm, { kerning: true, letterSpacing });
    const shapePath = new THREE.ShapePath();
    let started = false;
    for (const cmd of path.commands) {
        switch (cmd.type) {
            case 'M': shapePath.moveTo(cmd.x, -cmd.y); started = true; break;
            case 'L': shapePath.lineTo(cmd.x, -cmd.y); break;
            case 'Q': shapePath.quadraticCurveTo(cmd.x1, -cmd.y1, cmd.x, -cmd.y); break;
            case 'C': shapePath.bezierCurveTo(cmd.x1, -cmd.y1, cmd.x2, -cmd.y2, cmd.x, -cmd.y); break;
            case 'Z': if (started && shapePath.currentPath) shapePath.currentPath.closePath(); break;
        }
    }
    // TTF winding after the y-flip: outer contours are counter-clockwise.
    return shapePath.toShapes(false);
}

/**
 * Build extruded 3D text geometry, centered on X/Y, base at Z=0, thickness
 * along +Z. Returns null if no printable glyphs.
 * @param {object} font opentype font
 * @param {{text:string, sizeMm?:number, thicknessMm?:number, letterSpacing?:number}} opts
 */
export function buildTextGeometry(font, opts) {
    const { text, sizeMm = 10, thicknessMm = 2, letterSpacing = 0 } = opts;
    const shapes = textToShapes(font, text, sizeMm, letterSpacing);
    if (!shapes.length) return null;
    const geometry = new THREE.ExtrudeGeometry(shapes, {
        depth: thicknessMm,
        bevelEnabled: false,
        curveSegments: 8,
    });
    geometry.deleteAttribute('uv'); // models have position+normal only; keep CSG attributes aligned
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    const c = new THREE.Vector3();
    geometry.boundingBox.getCenter(c);
    geometry.translate(-c.x, -c.y, 0); // center XY, keep base at z=0
    return geometry;
}

export default { FONTS, loadFont, parseFont, textToShapes, buildTextGeometry };
