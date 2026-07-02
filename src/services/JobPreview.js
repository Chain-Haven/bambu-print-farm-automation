// src/services/JobPreview.js — build a visual preview of what a job prints.
//
// Two strategies, in order:
//   1. Slicer thumbnail: Bambu Studio embeds rendered plate PNGs inside
//      .gcode.3mf (Metadata/plate_1.png etc). If present, that IS a 3D render
//      of the model — extract and ship it.
//   2. Toolpath render: for plain .gcode (or 3mf without a thumbnail), parse
//      the extrusion moves and project them isometrically into an SVG — a
//      lightweight 3D wireframe of the actual print.
//
// Previews are returned as data URIs (PNG or SVG) so they can ride the node
// heartbeat into the cloud console with no extra endpoints. Results are cached
// per job so heartbeats stay cheap.
import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { getUploadRoot } from '../utils/uploadPaths.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('JobPreview');

const MAX_PREVIEW_BYTES = 350 * 1024;     // keep heartbeats light
const MAX_GCODE_PARSE_BYTES = 24 * 1024 * 1024; // parse at most the first 24MB
const MAX_RAW_SEGMENTS = 200000;
const MAX_SVG_SEGMENTS = 5000;

const THUMBNAIL_CANDIDATES = [
    'Metadata/plate_1.png',
    'Metadata/plate_no_light_1.png',
    'Metadata/plate_1_small.png',
    'Metadata/top_1.png',
    'Metadata/pick_1.png',
];

const cache = new Map(); // job_id -> { key, preview }

function isZipBuffer(buffer) {
    return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
}

function extractThumbnailFromZip(buffer) {
    try {
        const zip = new AdmZip(buffer);
        for (const name of THUMBNAIL_CANDIDATES) {
            const entry = zip.getEntry(name);
            if (!entry) continue;
            const data = entry.getData();
            if (data.length > 0 && data.length <= MAX_PREVIEW_BYTES) {
                return `data:image/png;base64,${data.toString('base64')}`;
            }
        }
        // Any other plate render (multi-plate files).
        const fallback = zip.getEntries().find((entry) => (
            /^Metadata\/plate_\d+\.png$/.test(entry.entryName)
        ));
        if (fallback) {
            const data = fallback.getData();
            if (data.length > 0 && data.length <= MAX_PREVIEW_BYTES) {
                return `data:image/png;base64,${data.toString('base64')}`;
            }
        }
    } catch { /* not a readable zip — fall through to gcode parsing */ }
    return null;
}

function extractGcodeTextFromZip(buffer) {
    try {
        const zip = new AdmZip(buffer);
        const entry = zip.getEntries().find((item) => item.entryName.endsWith('.gcode'));
        if (!entry) return null;
        const data = entry.getData();
        return data.slice(0, MAX_GCODE_PARSE_BYTES).toString('utf8');
    } catch {
        return null;
    }
}

/**
 * Parse extrusion segments out of gcode text. Tracks absolute X/Y/Z and
 * relative-or-absolute E; a G1 move with XY travel and positive extrusion is a
 * printed segment.
 */
export function parseGcodeSegments(text, maxSegments = MAX_RAW_SEGMENTS) {
    const segments = [];
    let x = 0; let y = 0; let z = 0; let e = 0;
    let absoluteE = true;

    for (let start = 0; start < text.length && segments.length < maxSegments;) {
        let end = text.indexOf('\n', start);
        if (end === -1) end = text.length;
        const line = text.slice(start, end);
        start = end + 1;

        if (line.length < 2 || line.charCodeAt(0) === 59) continue; // ';'
        const code = line.slice(0, 3);
        if (code === 'M82') { absoluteE = true; continue; }
        if (code === 'M83') { absoluteE = false; continue; }
        if (code === 'G92') {
            const match = /E(-?\d+\.?\d*)/.exec(line);
            if (match) e = Number.parseFloat(match[1]);
            continue;
        }
        if (!/^G[01]\b/.test(line)) continue;

        let nx = x; let ny = y; let nz = z; let ne = null;
        const parts = line.split(' ');
        for (let i = 1; i < parts.length; i += 1) {
            const part = parts[i];
            if (!part) continue;
            const value = Number.parseFloat(part.slice(1));
            if (!Number.isFinite(value)) continue;
            const axis = part[0];
            if (axis === 'X') nx = value;
            else if (axis === 'Y') ny = value;
            else if (axis === 'Z') nz = value;
            else if (axis === 'E') ne = value;
        }

        const extruded = ne !== null && (absoluteE ? ne > e + 1e-6 : ne > 1e-6);
        if (extruded && (nx !== x || ny !== y)) {
            segments.push([x, y, z, nx, ny]);
        }
        x = nx; y = ny; z = nz;
        if (ne !== null) e = absoluteE ? ne : e + ne;
    }

    return segments;
}

function downsample(segments, target) {
    if (segments.length <= target) return segments;
    const stride = segments.length / target;
    const out = [];
    for (let i = 0; i < target; i += 1) {
        out.push(segments[Math.floor(i * stride)]);
    }
    return out;
}

/**
 * Render extrusion segments to an isometric SVG "3D wireframe" data URI.
 * Lower layers are darker, top layers brighter, so the shape reads as 3D.
 */
export function renderSegmentsToSvg(rawSegments, { width = 320, height = 300 } = {}) {
    if (!rawSegments || rawSegments.length === 0) return null;
    const segments = downsample(rawSegments, MAX_SVG_SEGMENTS);

    const COS = Math.cos(Math.PI / 6);
    const SIN = Math.sin(Math.PI / 6);
    const project = (px, py, pz) => [(px - py) * COS, (px + py) * SIN - pz];

    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    let minZ = Infinity; let maxZ = -Infinity;
    const projected = segments.map(([x1, y1, z, x2, y2]) => {
        const a = project(x1, y1, z);
        const b = project(x2, y2, z);
        minX = Math.min(minX, a[0], b[0]); maxX = Math.max(maxX, a[0], b[0]);
        minY = Math.min(minY, a[1], b[1]); maxY = Math.max(maxY, a[1], b[1]);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
        return { a, b, z };
    });

    const spanX = Math.max(maxX - minX, 1);
    const spanY = Math.max(maxY - minY, 1);
    const scale = Math.min((width - 20) / spanX, (height - 20) / spanY);
    const offsetX = (width - spanX * scale) / 2 - minX * scale;
    const offsetY = (height - spanY * scale) / 2 - minY * scale;
    const zSpan = Math.max(maxZ - minZ, 0.001);

    // Bucket segments into z-bands so each band is one <path> (small output).
    const BANDS = 12;
    const bands = Array.from({ length: BANDS }, () => []);
    for (const segment of projected) {
        const band = Math.min(BANDS - 1, Math.floor(((segment.z - minZ) / zSpan) * BANDS));
        bands[band].push(segment);
    }

    const paths = bands.map((band, index) => {
        if (band.length === 0) return '';
        const t = index / (BANDS - 1);
        const lightness = 32 + t * 38;
        const data = band.map(({ a, b }) => (
            `M${(a[0] * scale + offsetX).toFixed(1)} ${(a[1] * scale + offsetY).toFixed(1)}L${(b[0] * scale + offsetX).toFixed(1)} ${(b[1] * scale + offsetY).toFixed(1)}`
        )).join('');
        return `<path d="${data}" stroke="hsl(160 45% ${lightness.toFixed(0)}%)" stroke-width="0.9" fill="none" stroke-linecap="round"/>`;
    }).join('');

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${paths}</svg>`;
    if (svg.length > MAX_PREVIEW_BYTES) return null;
    return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

/** Build a preview data URI from a print artifact buffer (3mf or plain gcode). */
export function buildPreviewFromArtifact(buffer, fileName = '') {
    if (!buffer || buffer.length === 0) return null;

    if (isZipBuffer(buffer)) {
        const thumbnail = extractThumbnailFromZip(buffer);
        if (thumbnail) return thumbnail;
        const gcodeText = extractGcodeTextFromZip(buffer);
        if (gcodeText) return renderSegmentsToSvg(parseGcodeSegments(gcodeText));
        return null;
    }

    if (/\.gcode$/i.test(fileName) || buffer.slice(0, 512).toString('utf8').includes('G1')) {
        const text = buffer.slice(0, MAX_GCODE_PARSE_BYTES).toString('utf8');
        return renderSegmentsToSvg(parseGcodeSegments(text));
    }

    return null;
}

function findJobArtifactPath(job) {
    const root = getUploadRoot();
    const candidates = [
        job.transformed_file_name ? `${job.job_id}_${job.transformed_file_name}` : null,
        job.source_file_name ? `${job.job_id}_${job.source_file_name}` : null,
    ].filter(Boolean);

    for (const name of candidates) {
        const filePath = path.join(root, name);
        if (fs.existsSync(filePath)) return filePath;
    }
    return null;
}

/**
 * Cached preview for a job. Returns a data URI string or null.
 * Cache key includes the transformed file name so re-transforms refresh it.
 */
export function getJobPreview(job) {
    if (!job?.job_id) return null;
    const key = `${job.transformed_file_name || ''}|${job.source_file_name || ''}`;
    const cached = cache.get(job.job_id);
    if (cached && cached.key === key) return cached.preview;

    let preview = null;
    try {
        const artifactPath = findJobArtifactPath(job);
        if (artifactPath) {
            preview = buildPreviewFromArtifact(fs.readFileSync(artifactPath), artifactPath);
        }
    } catch (error) {
        log.warn(`Preview generation failed for job ${job.job_id}: ${error.message}`);
    }

    cache.set(job.job_id, { key, preview });
    if (cache.size > 200) {
        cache.delete(cache.keys().next().value);
    }
    return preview;
}

export function clearPreviewCache() {
    cache.clear();
}

export default { getJobPreview, buildPreviewFromArtifact, parseGcodeSegments, renderSegmentsToSvg, clearPreviewCache };
