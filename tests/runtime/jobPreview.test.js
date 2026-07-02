import AdmZip from 'adm-zip';
import { describe, expect, it } from 'vitest';
import {
    buildPreviewFromArtifact,
    parseGcodeSegments,
    renderSegmentsToSvg,
} from '../../src/services/JobPreview.js';

const SAMPLE_GCODE = [
    '; test part',
    'M83',
    'G28',
    'G1 X0 Y0 Z0.2 F3000',
    'G1 X20 Y0 E1.2',
    'G1 X20 Y20 E1.2',
    'G1 X0 Y20 E1.2',
    'G1 X0 Y0 E1.2',
    'G1 Z0.4',
    'G1 X20 Y0 E1.2',
    'G1 X20 Y20 E1.2',
    '; travel move, no extrusion',
    'G1 X5 Y5',
].join('\n');

// A tiny valid PNG (1x1 transparent pixel).
const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
);

describe('job preview generation', () => {
    it('parses extrusion segments (skipping travels and comments)', () => {
        const segments = parseGcodeSegments(SAMPLE_GCODE);
        expect(segments).toHaveLength(6);
        expect(segments[0]).toEqual([0, 0, 0.2, 20, 0]);
        // second layer segments carry the new Z
        expect(segments[4][2]).toBe(0.4);
    });

    it('renders segments into an isometric SVG data URI', () => {
        const preview = renderSegmentsToSvg(parseGcodeSegments(SAMPLE_GCODE));
        expect(preview).toMatch(/^data:image\/svg\+xml;base64,/);
        const svg = Buffer.from(preview.split(',')[1], 'base64').toString('utf8');
        expect(svg).toContain('<svg');
        expect(svg).toContain('<path');
    });

    it('prefers the slicer plate thumbnail embedded in a .gcode.3mf', () => {
        const zip = new AdmZip();
        zip.addFile('Metadata/plate_1.png', TINY_PNG);
        zip.addFile('Metadata/plate_1.gcode', Buffer.from(SAMPLE_GCODE));
        const preview = buildPreviewFromArtifact(zip.toBuffer(), 'part.gcode.3mf');
        expect(preview).toBe(`data:image/png;base64,${TINY_PNG.toString('base64')}`);
    });

    it('falls back to a toolpath render when the 3mf has no thumbnail', () => {
        const zip = new AdmZip();
        zip.addFile('Metadata/plate_1.gcode', Buffer.from(SAMPLE_GCODE));
        const preview = buildPreviewFromArtifact(zip.toBuffer(), 'part.gcode.3mf');
        expect(preview).toMatch(/^data:image\/svg\+xml;base64,/);
    });

    it('renders plain .gcode buffers directly', () => {
        const preview = buildPreviewFromArtifact(Buffer.from(SAMPLE_GCODE), 'part.gcode');
        expect(preview).toMatch(/^data:image\/svg\+xml;base64,/);
    });

    it('returns null for empty or unrenderable artifacts', () => {
        expect(buildPreviewFromArtifact(Buffer.alloc(0), 'part.gcode')).toBeNull();
        expect(buildPreviewFromArtifact(Buffer.from('no moves here'), 'part.txt')).toBeNull();
    });
});
