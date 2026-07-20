// public/js/logo3d.js — SVG -> printable logo geometry.
// Shared browser/Node module (like text3d.js): the import map resolves
// 'three/addons/…' to the vendored SVGLoader in the browser; Node resolves it
// through the npm `three` package at the IDENTICAL version.
import * as THREE from 'three';
import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';

/** Logos are always this thick (directive: fixed 0.5mm, single color). */
export const LOGO_THICKNESS_MM = 0.5;

/**
 * Parse an SVG document into a single extruded solid, centered on X/Y with the
 * base at z=0 and thickness along +Z (same convention as buildTextGeometry).
 * All paths are merged into one single-color solid; fill-rule holes are kept.
 * The largest XY dimension is scaled to `widthMm` (thickness stays exact).
 * Returns null if the SVG produced no fillable shapes.
 */
export function svgToLogoGeometry(svgText, { widthMm = 20, thicknessMm = LOGO_THICKNESS_MM } = {}) {
    const data = new SVGLoader().parse(svgText);
    const shapes = [];
    for (const p of data.paths || []) {
        for (const s of SVGLoader.createShapes(p)) shapes.push(s);
    }
    if (!shapes.length) return null;
    const geometry = new THREE.ExtrudeGeometry(shapes, { depth: thicknessMm, bevelEnabled: false, curveSegments: 12 });
    geometry.deleteAttribute('uv'); // match model geometry (position+normal only)
    // SVG is y-down: rotate 180° about X — a PROPER rotation (no mirror, no
    // winding flip) — then shift so the base sits at z=0, thickness along +Z.
    geometry.rotateX(Math.PI);
    geometry.translate(0, 0, thicknessMm);
    // scale XY to the requested width; thickness is fixed by contract
    geometry.computeBoundingBox();
    const size = new THREE.Vector3(); geometry.boundingBox.getSize(size);
    const s = widthMm / Math.max(size.x, size.y, 1e-6);
    geometry.scale(s, s, 1);
    geometry.computeBoundingBox();
    const c = new THREE.Vector3(); geometry.boundingBox.getCenter(c);
    geometry.translate(-c.x, -c.y, -geometry.boundingBox.min.z);
    geometry.computeVertexNormals();
    return geometry;
}

/**
 * Mirror a geometry across its local X axis, BAKED into the vertices with the
 * triangle winding re-flipped (a negative mesh.scale would export inside-out
 * STLs — facet normals come from winding). Returns the (possibly new,
 * de-indexed) geometry.
 */
export function mirrorGeometryX(geometry) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    const pos = g.attributes.position.array;
    for (let i = 0; i < pos.length; i += 3) pos[i] *= -1;
    // swap the 2nd and 3rd vertex of every triangle to restore outward winding
    for (let t = 0; t + 8 < pos.length; t += 9) {
        for (let a = 0; a < 3; a++) {
            const tmp = pos[t + 3 + a];
            pos[t + 3 + a] = pos[t + 6 + a];
            pos[t + 6 + a] = tmp;
        }
    }
    g.attributes.position.needsUpdate = true;
    g.computeVertexNormals();
    return g;
}

export default { LOGO_THICKNESS_MM, svgToLogoGeometry, mirrorGeometryX };
