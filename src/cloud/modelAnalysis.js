// src/cloud/modelAnalysis.js — estimate filament use straight from an upload.
//
// Storefront quotes must not trust client-supplied numbers, so grams are
// derived server-side from the file itself, best source first:
//   1. Sliced files (.gcode / .gcode.3mf): the slicer already knows — parse
//      "filament used [g]" from the gcode header (Bambu Studio / OrcaSlicer /
//      PrusaSlicer all emit a variant) or slice_info metadata.
//   2. STL meshes: exact signed-tetrahedron volume (binary + ASCII), then
//      grams = volume × material density × solidity factor (walls + infill —
//      parts are not printed solid).
//   3. Everything else (OBJ/STEP/unsliced 3MF): a coarse file-size heuristic,
//      reported as such so the UI can say "estimate".
import AdmZip from 'adm-zip';

// g/cm³, standard filament datasheet values.
export const MATERIAL_DENSITY = {
    PLA: 1.24,
    PETG: 1.27,
    ABS: 1.04,
    ASA: 1.07,
    TPU: 1.21,
    NYLON: 1.15,
    PA: 1.15,
    PC: 1.20,
};

// Printed parts are shells + infill, not solid plastic. 0.35 ≈ 2-3 walls with
// ~15% infill on typical part geometry — intentionally a little high so
// quotes err toward covering material, not undercharging.
export const DEFAULT_SOLIDITY = 0.35;
const MIN_GRAMS = 5;
const ASCII_STL_MAX_BYTES = 40 * 1024 * 1024;

function toUpper(value) {
    return String(value || '').trim().toUpperCase();
}

export function materialDensity(material) {
    return MATERIAL_DENSITY[toUpper(material)] || MATERIAL_DENSITY.PLA;
}

// Signed volume of the tetrahedron (origin, a, b, c) summed over every facet.
// Magnitude is exact for closed manifolds regardless of mesh position.
function signedTetraVolume(ax, ay, az, bx, by, bz, cx, cy, cz) {
    return (
        ax * (by * cz - bz * cy)
        - ay * (bx * cz - bz * cx)
        + az * (bx * cy - by * cx)
    ) / 6;
}

function binaryStlVolumeMm3(buffer) {
    if (buffer.length < 84) return null;
    const triangleCount = buffer.readUInt32LE(80);
    if (triangleCount === 0 || buffer.length < 84 + triangleCount * 50) return null;
    let volume = 0;
    let offset = 84;
    for (let i = 0; i < triangleCount; i += 1) {
        // 12 bytes normal, then 3 vertices × 3 floats, then 2-byte attribute.
        const base = offset + 12;
        volume += signedTetraVolume(
            buffer.readFloatLE(base), buffer.readFloatLE(base + 4), buffer.readFloatLE(base + 8),
            buffer.readFloatLE(base + 12), buffer.readFloatLE(base + 16), buffer.readFloatLE(base + 20),
            buffer.readFloatLE(base + 24), buffer.readFloatLE(base + 28), buffer.readFloatLE(base + 32),
        );
        offset += 50;
    }
    return Math.abs(volume);
}

function asciiStlVolumeMm3(buffer) {
    if (buffer.length > ASCII_STL_MAX_BYTES) return null;
    const text = buffer.toString('utf8');
    const vertexPattern = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
    const vertices = [];
    let match;
    while ((match = vertexPattern.exec(text)) !== null) {
        vertices.push([Number(match[1]), Number(match[2]), Number(match[3])]);
    }
    if (vertices.length < 3 || vertices.length % 3 !== 0) return null;
    let volume = 0;
    for (let i = 0; i < vertices.length; i += 3) {
        const [a, b, c] = [vertices[i], vertices[i + 1], vertices[i + 2]];
        volume += signedTetraVolume(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    }
    return Math.abs(volume);
}

// A binary STL is anything that does not start with "solid" — but some binary
// exporters write "solid" in the 80-byte header too, so verify the ASCII path
// actually parses before trusting the prefix.
export function computeStlVolumeCm3(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 15) return null;
    const startsWithSolid = buffer.subarray(0, 5).toString('ascii').toLowerCase() === 'solid';
    if (startsWithSolid) {
        const asciiVolume = asciiStlVolumeMm3(buffer);
        if (asciiVolume !== null && asciiVolume > 0) return asciiVolume / 1000;
    }
    const binaryVolume = binaryStlVolumeMm3(buffer);
    if (binaryVolume !== null && binaryVolume > 0) return binaryVolume / 1000;
    return null;
}

const FILAMENT_GRAMS_PATTERNS = [
    // "; total filament used [g] : 42.50" (Bambu) / "; filament used [g] = 40.1,2.4" (Orca/Prusa)
    /total\s+filament\s+used\s*\[g\]\s*[:=]\s*([\d.,\s]+)/i,
    /filament\s+used\s*\[g\]\s*[:=]\s*([\d.,\s]+)/i,
];

function gramsFromGcodeText(text) {
    for (const pattern of FILAMENT_GRAMS_PATTERNS) {
        const match = pattern.exec(text);
        if (!match) continue;
        const total = match[1]
            .split(',')
            .map((part) => Number.parseFloat(part))
            .filter((value) => Number.isFinite(value) && value >= 0)
            .reduce((sum, value) => sum + value, 0);
        if (total > 0) return total;
    }
    return null;
}

// Sliced uploads carry the slicer's own filament accounting. Scan gcode text
// (plain .gcode) or every *.gcode inside a .gcode.3mf; fall back to the
// slice_info metadata's used_g attributes.
export function extractSlicedFilamentGrams({ fileName, buffer }) {
    const lower = String(fileName || '').toLowerCase();
    try {
        if (lower.endsWith('.gcode')) {
            // Header comments live at the top; scan a bounded window.
            return gramsFromGcodeText(buffer.subarray(0, 512 * 1024).toString('utf8'));
        }
        if (lower.endsWith('.gcode.3mf') || lower.endsWith('.3mf')) {
            const zip = new AdmZip(buffer);
            for (const entry of zip.getEntries()) {
                if (!entry.entryName.toLowerCase().endsWith('.gcode')) continue;
                const grams = gramsFromGcodeText(entry.getData().subarray(0, 512 * 1024).toString('utf8'));
                if (grams) return grams;
            }
            const sliceInfo = zip.getEntry('Metadata/slice_info.config');
            if (sliceInfo) {
                const text = sliceInfo.getData().toString('utf8');
                const used = [...text.matchAll(/used_g\s*=\s*"([\d.]+)"/g)]
                    .map((match) => Number.parseFloat(match[1]))
                    .filter((value) => Number.isFinite(value) && value > 0)
                    .reduce((sum, value) => sum + value, 0);
                if (used > 0) return used;
            }
        }
    } catch { /* corrupt/odd container — fall through to other estimators */ }
    return null;
}

/**
 * Per-piece filament estimate for a storefront upload.
 * `scalePercent` is the customer's uniform scale finishing option: volume
 * (and therefore grams) grows with the CUBE of linear scale. Sliced files
 * ignore it — their geometry is already frozen by the slicer.
 * Returns { estimated_grams, estimate_basis, mesh_volume_cm3, scaled }.
 */
export function analyzePrintUpload({
    fileName,
    buffer,
    material = 'PLA',
    solidity = DEFAULT_SOLIDITY,
    scalePercent = 100,
} = {}) {
    const lower = String(fileName || '').toLowerCase();
    const scale = Math.min(Math.max(Number(scalePercent) || 100, 25), 400) / 100;
    const volumeFactor = scale ** 3;

    const slicedGrams = extractSlicedFilamentGrams({ fileName, buffer });
    if (slicedGrams) {
        return {
            estimated_grams: Math.max(MIN_GRAMS, Math.ceil(slicedGrams)),
            estimate_basis: 'slicer_metadata',
            mesh_volume_cm3: null,
            scaled: false,
        };
    }

    if (lower.endsWith('.stl')) {
        const volumeCm3 = computeStlVolumeCm3(buffer);
        if (volumeCm3) {
            const grams = volumeCm3 * volumeFactor * materialDensity(material) * Math.min(Math.max(solidity, 0.05), 1);
            return {
                estimated_grams: Math.max(MIN_GRAMS, Math.ceil(grams)),
                estimate_basis: 'mesh_volume',
                mesh_volume_cm3: Math.round(volumeCm3 * volumeFactor * 100) / 100,
                scaled: scale !== 1,
            };
        }
    }

    // OBJ / STEP / unsliced 3MF without slice metadata: coarse size heuristic,
    // clearly labeled so the UI presents it as an estimate pending review.
    return {
        estimated_grams: Math.max(20, Math.ceil(((buffer?.length || 0) / 50000) * volumeFactor)),
        estimate_basis: 'file_size_heuristic',
        mesh_volume_cm3: null,
        scaled: scale !== 1,
    };
}
