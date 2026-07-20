// src/cloud/meshPreview.js — server-side render of an uploaded mesh.
//
// Agents (and the operator console) get a visual check that the RIGHT file
// was uploaded before money moves: triangles are projected isometrically,
// depth-sorted (painter's algorithm), lambert-shaded, and emitted as a
// compact SVG. No GPU, no canvas dependency — pure geometry → markup.

const MAX_RENDER_TRIANGLES = 6000;

function parseBinaryStlTriangles(buffer) {
    if (buffer.length < 84) return null;
    const count = buffer.readUInt32LE(80);
    if (count === 0 || buffer.length < 84 + count * 50) return null;
    const triangles = [];
    let offset = 84;
    for (let i = 0; i < count; i += 1) {
        offset += 12;
        const triangle = [];
        for (let v = 0; v < 3; v += 1) {
            triangle.push([
                buffer.readFloatLE(offset),
                buffer.readFloatLE(offset + 4),
                buffer.readFloatLE(offset + 8),
            ]);
            offset += 12;
        }
        offset += 2;
        triangles.push(triangle);
    }
    return triangles;
}

function parseAsciiStlTriangles(text) {
    const vertices = [];
    const pattern = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
        vertices.push([Number(match[1]), Number(match[2]), Number(match[3])]);
    }
    if (vertices.length < 3 || vertices.length % 3 !== 0) return null;
    const triangles = [];
    for (let i = 0; i < vertices.length; i += 3) {
        triangles.push([vertices[i], vertices[i + 1], vertices[i + 2]]);
    }
    return triangles;
}

function parseObjTriangles(text) {
    const vertices = [];
    const triangles = [];
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('v ')) {
            const parts = trimmed.slice(2).trim().split(/\s+/).map(Number);
            if (parts.length >= 3) vertices.push(parts.slice(0, 3));
        } else if (trimmed.startsWith('f ')) {
            const refs = trimmed.slice(2).trim().split(/\s+/).map((token) => {
                const index = Number.parseInt(token.split('/')[0], 10);
                return index < 0 ? vertices.length + index : index - 1;
            });
            for (let i = 1; i + 1 < refs.length; i += 1) {
                const a = vertices[refs[0]];
                const b = vertices[refs[i]];
                const c = vertices[refs[i + 1]];
                if (a && b && c) triangles.push([a, b, c]);
            }
        }
    }
    return triangles.length > 0 ? triangles : null;
}

export function extractTriangles({ fileName, buffer }) {
    const lower = String(fileName || '').toLowerCase();
    if (lower.endsWith('.stl')) {
        const startsWithSolid = buffer.subarray(0, 5).toString('ascii').toLowerCase() === 'solid';
        if (startsWithSolid) {
            const ascii = parseAsciiStlTriangles(buffer.toString('utf8'));
            if (ascii) return ascii;
        }
        return parseBinaryStlTriangles(buffer);
    }
    if (lower.endsWith('.obj')) {
        return parseObjTriangles(buffer.toString('utf8'));
    }
    return null; // other formats have no cheap mesh to render
}

// Even decimation keeps overall shape when meshes are huge.
function decimate(triangles) {
    if (triangles.length <= MAX_RENDER_TRIANGLES) return triangles;
    const step = triangles.length / MAX_RENDER_TRIANGLES;
    const out = [];
    for (let i = 0; i < triangles.length; i += step) {
        out.push(triangles[Math.floor(i)]);
    }
    return out;
}

/**
 * Render triangles to a shaded isometric SVG. Returns { svg, triangle_count,
 * bounds: { size: [x,y,z] } } or null when the mesh can't be parsed.
 */
export function renderMeshSvg({ fileName, buffer, colorHex = '#0F766E', width = 480, height = 400 }) {
    const all = extractTriangles({ fileName, buffer });
    if (!all || all.length === 0) return null;
    const triangles = decimate(all);

    // Isometric-ish camera: rotate 45° about Z, then tilt ~35° about X.
    const cosA = Math.SQRT1_2;
    const sinA = Math.SQRT1_2;
    const tilt = (35.264 * Math.PI) / 180;
    const cosT = Math.cos(tilt);
    const sinT = Math.sin(tilt);
    const project = ([x, y, z]) => {
        const rx = x * cosA - y * sinA;
        const ry = x * sinA + y * cosA;
        return {
            x: rx,
            y: -(z * cosT - ry * sinT),
            depth: ry * cosT + z * sinT,
        };
    };

    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const triangle of all) {
        for (const vertex of triangle) {
            for (let axis = 0; axis < 3; axis += 1) {
                if (vertex[axis] < min[axis]) min[axis] = vertex[axis];
                if (vertex[axis] > max[axis]) max[axis] = vertex[axis];
            }
        }
    }

    const faces = triangles.map((triangle) => {
        const points = triangle.map(project);
        // Face normal for shading (world space).
        const [a, b, c] = triangle;
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const normal = [
            u[1] * v[2] - u[2] * v[1],
            u[2] * v[0] - u[0] * v[2],
            u[0] * v[1] - u[1] * v[0],
        ];
        const length = Math.hypot(...normal) || 1;
        const light = Math.max(0.25, Math.min(1.12,
            0.35 + 0.65 * Math.max(0, (normal[0] * 0.35 + normal[1] * -0.4 + normal[2] * 0.85) / length)));
        return {
            points,
            depth: (points[0].depth + points[1].depth + points[2].depth) / 3,
            light,
        };
    }).sort((a, b) => a.depth - b.depth);

    // Fit to viewport.
    let pxMin = [Infinity, Infinity];
    let pxMax = [-Infinity, -Infinity];
    for (const face of faces) {
        for (const point of face.points) {
            pxMin = [Math.min(pxMin[0], point.x), Math.min(pxMin[1], point.y)];
            pxMax = [Math.max(pxMax[0], point.x), Math.max(pxMax[1], point.y)];
        }
    }
    const margin = 24;
    const scale = Math.min(
        (width - margin * 2) / Math.max(pxMax[0] - pxMin[0], 1e-6),
        (height - margin * 2) / Math.max(pxMax[1] - pxMin[1], 1e-6),
    );
    const offsetX = (width - (pxMax[0] - pxMin[0]) * scale) / 2 - pxMin[0] * scale;
    const offsetY = (height - (pxMax[1] - pxMin[1]) * scale) / 2 - pxMin[1] * scale;
    const toPx = (point) => `${(point.x * scale + offsetX).toFixed(1)},${(point.y * scale + offsetY).toFixed(1)}`;

    const base = Number.parseInt(String(colorHex).replace('#', '').slice(0, 6), 16);
    const rgb = Number.isFinite(base)
        ? [(base >> 16) & 255, (base >> 8) & 255, base & 255]
        : [15, 118, 110];
    const polygons = faces.map((face) => {
        const shade = rgb.map((channel) => Math.min(255, Math.round(channel * face.light))).join(',');
        return `<polygon points="${face.points.map(toPx).join(' ')}" fill="rgb(${shade})"/>`;
    }).join('');

    const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
        + `<rect width="100%" height="100%" fill="#f6f8fa"/>`
        + polygons
        + `<text x="12" y="${height - 12}" font-family="monospace" font-size="12" fill="#526073">`
        + `${size.map((value) => value.toFixed(1)).join(' × ')} mm · ${all.length} triangles</text>`
        + '</svg>';

    return { svg, triangle_count: all.length, rendered_triangles: triangles.length, bounds: { size } };
}
