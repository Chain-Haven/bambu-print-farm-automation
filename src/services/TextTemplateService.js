// src/services/TextTemplateService.js — Customer-text automation (DIRECTIVE §7).
//
// A template = base model(s) (baked STLs, printer coords) + a text placeholder
// (font/size/thickness/mode/filament/placement matrix) — everything except the
// string. fill() regenerates ONLY the text geometry with the customer's string
// using the same shared builder the browser uses (public/js/text3d.js, which
// resolves 'three'/'opentype.js' from node_modules here), merges it with the
// base exactly like the browser would (same coordinate pipeline), slices via
// the REAL engine (SliceService), and can hand the result straight to
// JobOrchestrator.submit() for the existing loop/eject/print pipeline.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { Evaluator, Brush, SUBTRACTION, ADDITION } from 'three-bvh-csg';
import { dbRun, dbGet, dbAll } from '../db/database.js';
import { parseFont, buildTextGeometry } from '../../public/js/text3d.js';
import { parseBinarySTL } from '../gcode/Model3mf.js';
import { SliceService } from './SliceService.js';
import { createLogger } from '../utils/logger.js';
import { getUploadRoot } from '../utils/uploadPaths.js';

const log = createLogger('TextTemplate');

const TEMPLATES_DIR = path.join(getUploadRoot(), 'templates');
const FONT_FILES = {
    'sans': 'DejaVuSans.ttf',
    'sans-bold': 'DejaVuSans-Bold.ttf',
    'serif': 'DejaVuSerif.ttf',
    'script': 'GreatVibes-Regular.ttf',
};
// Module-relative (not CWD-relative) so the app works no matter where it's
// launched from on another machine.
const FONTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'vendor', 'fonts');

const fontCache = new Map();
function loadFontById(fontId) {
    const file = FONT_FILES[fontId] || FONT_FILES.sans;
    if (!fontCache.has(file)) {
        const buf = fs.readFileSync(path.join(FONTS_DIR, file));
        fontCache.set(file, parseFont(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
    }
    return fontCache.get(file);
}

function geomFromSTLBuffer(buf) {
    const { vertices, triangles } = parseBinarySTL(buf);
    const pos = [];
    for (let t = 0; t < triangles.length; t++) {
        const i = triangles[t] * 3;
        pos.push(vertices[i], vertices[i + 1], vertices[i + 2]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
}

function geometryToBinarySTL(geom) {
    const pos = geom.attributes.position.array;
    const triCount = Math.floor(pos.length / 9);
    const buf = Buffer.alloc(84 + triCount * 50);
    buf.writeUInt32LE(triCount, 80);
    let o = 84;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
    for (let i = 0; i < triCount; i++) {
        const k = i * 9;
        a.set(pos[k], pos[k + 1], pos[k + 2]);
        b.set(pos[k + 3], pos[k + 4], pos[k + 5]);
        c.set(pos[k + 6], pos[k + 7], pos[k + 8]);
        n.crossVectors(b.clone().sub(a), c.clone().sub(a)).normalize();
        buf.writeFloatLE(n.x, o); buf.writeFloatLE(n.y, o + 4); buf.writeFloatLE(n.z, o + 8); o += 12;
        for (const v of [a, b, c]) { buf.writeFloatLE(v.x, o); buf.writeFloatLE(v.y, o + 4); buf.writeFloatLE(v.z, o + 8); o += 12; }
        o += 2;
    }
    return buf;
}

const parseJson = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

export const TextTemplateService = {
    /**
     * Save a template. baseFiles are baked STL buffers in printer coordinates
     * (from the browser's exportPlacedSTLs). textDef.matrixWorld is the text
     * mesh's VIEWER-space world matrix (16 numbers, column-major) — fill()
     * replays the browser pipeline exactly.
     */
    create({ name, printer_model = 'P1S', profile_id = null, baseFiles, textDef = null, settings = {} }) {
        if (!name?.trim()) throw new Error('Template name required');
        if (!baseFiles?.length) throw new Error('At least one base model required');
        // Textless saved prints are allowed (mode 'none') — the "print job"
        // still gets preview + settings + queue, just no text field.
        if (textDef?.fontId) {
            if (!textDef.matrixWorld || textDef.matrixWorld.length !== 16) {
                throw new Error('Invalid text placeholder definition');
            }
        } else {
            textDef = { ...(textDef || {}), mode: 'none' };
        }
        fs.mkdirSync(TEMPLATES_DIR, { recursive: true });

        const template_id = crypto.randomUUID();
        const fileDefs = baseFiles.map((f, i) => {
            const file = `${template_id}_base${i}.stl`;
            fs.writeFileSync(path.join(TEMPLATES_DIR, file), f.buffer);
            // color/filament/insert ride along so fills stay multi-color-correct
            // (inserts were sorted last at save time — order must be preserved)
            return { file, name: f.name || `base_${i}`, color: f.color || null, filament: f.filament || 1, insert: !!f.insert };
        });

        dbRun(
            `INSERT INTO text_templates (template_id, name, printer_model, profile_id, base_files, text_def, settings)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [template_id, name.trim(), printer_model, profile_id,
                JSON.stringify(fileDefs), JSON.stringify(textDef), JSON.stringify(settings)]
        );
        log.info(`Template created: ${name} [${template_id}] (${fileDefs.length} base file(s), mode=${textDef.mode})`);
        return this.get(template_id);
    },

    /** Update name / settings / printer model / text params (not placement). */
    update(id, { name, settings, printer_model, text_def } = {}) {
        const t = this.get(id);
        if (!t) return null;
        const mergedTextDef = text_def ? { ...t.text_def, ...text_def, matrixWorld: t.text_def.matrixWorld } : t.text_def;
        dbRun(
            `UPDATE text_templates SET name = ?, printer_model = ?, text_def = ?, settings = ?, updated_at = datetime('now')
             WHERE template_id = ?`,
            [
                name !== undefined && String(name).trim() ? String(name).trim() : t.name,
                printer_model || t.printer_model,
                JSON.stringify(mergedTextDef),
                JSON.stringify(settings !== undefined ? settings : t.settings),
                id,
            ]
        );
        return this.get(id);
    },

    list() {
        return dbAll('SELECT * FROM text_templates ORDER BY name ASC').map(r => ({
            ...r, base_files: parseJson(r.base_files, []), text_def: parseJson(r.text_def, {}), settings: parseJson(r.settings, {}),
        }));
    },

    get(id) {
        const r = dbGet('SELECT * FROM text_templates WHERE template_id = ?', [id]);
        if (!r) return null;
        return { ...r, base_files: parseJson(r.base_files, []), text_def: parseJson(r.text_def, {}), settings: parseJson(r.settings, {}) };
    },

    /** Absolute path of a stored base STL (for preview serving). */
    filePath(id, index) {
        const t = this.get(id);
        const f = t?.base_files?.[index];
        return f ? path.join(TEMPLATES_DIR, f.file) : null;
    },

    remove(id) {
        const t = this.get(id);
        if (!t) return false;
        for (const f of t.base_files) {
            try { fs.rmSync(path.join(TEMPLATES_DIR, f.file)); } catch { /* best effort */ }
        }
        dbRun('DELETE FROM text_templates WHERE template_id = ?', [id]);
        return true;
    },

    /** Validate a customer string against the template's font/limits. */
    validateText(template, text) {
        const maxChars = template.text_def.maxChars || 40;
        if (!text || !text.trim()) return 'Text is empty';
        if (text.length > maxChars) return `Text too long (max ${maxChars} characters)`;
        const font = loadFontById(template.text_def.fontId);
        for (const ch of text) {
            if (ch === ' ') continue;
            if (font.charToGlyphIndex(ch) === 0) return `Character "${ch}" is not available in this font`;
        }
        return null;
    },

    /**
     * Fill the template with a customer string and slice it with the real
     * engine. Returns { ok, gcode3mf, outputName, report } or { ok:false, error }.
     */
    async fill(id, { text } = {}) {
        const template = this.get(id);
        if (!template) return { ok: false, code: 'not_found', error: 'Template not found' };

        const td = template.text_def || {};
        const hasText = !!td.fontId && td.mode !== 'none';
        let geo = null;

        if (hasText) {
            const invalid = this.validateText(template, text);
            if (invalid) return { ok: false, code: 'invalid_text', error: invalid };
            const font = loadFontById(td.fontId);

            // 1. Regenerate the text solid — IDENTICAL pipeline to the browser:
            //    buildTextGeometry (XY-centered, z 0..thickness) -> rotateX(-90°)
            //    -> center bbox -> saved viewer-space matrixWorld
            //    -> viewer->printer bake: rotateX(+90°) + bed offset.
            geo = buildTextGeometry(font, { text: text.trim(), sizeMm: td.sizeMm, thicknessMm: td.thicknessMm });
            if (!geo) return { ok: false, code: 'no_glyphs', error: 'Text produced no printable glyphs' };
            geo.rotateX(-Math.PI / 2);
            geo.computeBoundingBox();
            const c = new THREE.Vector3(); geo.boundingBox.getCenter(c);
            geo.translate(-c.x, -c.y, -c.z);

            const m = new THREE.Matrix4().fromArray(td.matrixWorld);
            // deboss templates were saved as-placed (proud on the surface): shift
            // inward along the text's thickness axis, same as the browser boolean
            if (td.mode === 'deboss') {
                const q = new THREE.Quaternion(); m.decompose(new THREE.Vector3(), q, new THREE.Vector3());
                const w = new THREE.Vector3(0, 1, 0).applyQuaternion(q).multiplyScalar(-(td.thicknessMm - 0.4));
                m.premultiply(new THREE.Matrix4().makeTranslation(w.x, w.y, w.z));
            }
            geo.applyMatrix4(m);
            const bed = template.printer_model === 'A1_MINI' ? { x: 180, y: 180 } : { x: 256, y: 256 };
            geo.rotateX(Math.PI / 2);
            geo.translate(bed.x / 2, bed.y / 2, 0);
        }

        // 2. Load base STLs (already printer coords); saved color/filament per
        //    base keeps multi-color prints correct on refill.
        const baseBuffers = template.base_files.map(f => fs.readFileSync(path.join(TEMPLATES_DIR, f.file)));
        const modelBuffers = [];
        const filaments = [];
        const baseFil = (i) => Math.max(1, Math.round(template.base_files[i].filament || 1));

        // Overlapping bases (e.g. a logo insert saved seated in the model) must
        // slice as parts of ONE object — same rule as the browser's
        // exportPlacedSTLs (separate overlapping objects abort the CLI). Group
        // by AABB overlap (0.3mm tolerance); saved order is preserved, and
        // inserts were stored LAST so they win their shared volumes.
        const bboxes = baseBuffers.map(b => {
            const { vertices } = parseBinarySTL(b);
            const mn = [1e30, 1e30, 1e30], mx = [-1e30, -1e30, -1e30];
            for (let v = 0; v < vertices.length; v += 3) {
                for (let a = 0; a < 3; a++) {
                    const val = vertices[v + a];
                    if (val < mn[a]) mn[a] = val;
                    if (val > mx[a]) mx[a] = val;
                }
            }
            return { mn, mx };
        });
        const parent = baseBuffers.map((_, i) => i);
        const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
        const boxesTouch = (A, B) => [0, 1, 2].every(a => A.mn[a] - 0.3 <= B.mx[a] && B.mn[a] - 0.3 <= A.mx[a]);
        for (let i = 0; i < bboxes.length; i++) {
            for (let j = i + 1; j < bboxes.length; j++) {
                if (boxesTouch(bboxes[i], bboxes[j])) parent[find(i)] = find(j);
            }
        }
        const baseGroups = baseBuffers.map((_, i) => find(i));
        const anyBaseMerge = new Set(baseGroups).size < baseGroups.length;

        let groups = null;
        if (!hasText) {
            baseBuffers.forEach((b, i) => { modelBuffers.push({ name: template.base_files[i].name, buffer: b }); filaments.push(baseFil(i)); });
            if (anyBaseMerge) groups = baseGroups;
        } else if (td.mode === 'separate') {
            baseBuffers.forEach((b, i) => { modelBuffers.push({ name: template.base_files[i].name, buffer: b }); filaments.push(baseFil(i)); });
            modelBuffers.push({ name: 'text.stl', buffer: geometryToBinarySTL(geo) });
            filaments.push(td.filament || 2);
            // Merge the text with its target base (BBS "merge" semantics): as a
            // separate object, touching/overlapping text aborts the engine; as
            // the LAST part of the target's object it wins the shared volume
            // and shows through. Text with no target keeps its own group.
            groups = [...baseGroups];
            groups.push(td.targetIndex != null && td.targetIndex >= 0 ? baseGroups[td.targetIndex] : baseBuffers.length);
        } else {
            // emboss/deboss: REAL CSG into the target base object (in printer space)
            const targetIndex = Math.max(0, td.targetIndex ?? 0);
            const ev = new Evaluator();
            ev.attributes = ['position', 'normal'];
            geo.computeVertexNormals();
            const targetGeom = geomFromSTLBuffer(baseBuffers[targetIndex]);
            let result;
            try {
                result = ev.evaluate(new Brush(targetGeom), new Brush(geo), td.mode === 'deboss' ? SUBTRACTION : ADDITION);
            } catch (err) {
                return { ok: false, code: 'boolean_failed', error: `Text boolean failed: ${err.message}` };
            }
            baseBuffers.forEach((b, i) => {
                modelBuffers.push({
                    name: template.base_files[i].name,
                    buffer: i === targetIndex ? geometryToBinarySTL(result.geometry) : b,
                });
                filaments.push(baseFil(i));
            });
            if (anyBaseMerge) groups = baseGroups;
        }

        // 3. Slice with the REAL engine — never generated here (DIRECTIVE §0).
        const safe = hasText ? text.trim().replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 24) : 'print';
        const res = await SliceService.slice({
            modelBuffers,
            modelName: `${template.name}_${safe}.3mf`,
            profile: null,
            options: {
                printer_model: template.printer_model,
                settings: template.settings,
                filaments,
                material: td.material || 'PLA',
                ...(td.colors?.length ? { colors: td.colors } : {}),
                ...(groups ? { groups } : {}),
            },
        });
        if (!res.ok) return res;
        return { ...res, outputName: `${template.name}_${safe}.gcode.3mf` };
    },
};

export default TextTemplateService;
