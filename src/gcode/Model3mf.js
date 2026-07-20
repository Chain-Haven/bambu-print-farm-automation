// src/gcode/Model3mf.js — Build a plain (input) 3MF from mesh geometry.
//
// Purpose (SLICER_FEATURES_DIRECTIVE §6): the engine slices files, not our
// Three.js scene. The browser bakes each object's transform into its geometry
// (printer coords, Z-up, bed front-left origin) and sends one STL per object;
// we assemble them into a standard 3MF so OrcaSlicer slices the EXACT layout
// with --arrange 0 — never re-arranging the user's placement.
//
// This builds an *input* model 3MF (geometry to slice) — not to be confused
// with the .gcode.3mf *output* wrapper built by AutomatorZip.buildGcode3mf.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { createLogger } from '../utils/logger.js';

const log = createLogger('Model3mf');

// Ground-truth multi-color project exported from the OrcaSlicer GUI (2 objects,
// 2 filaments). VERIFIED to slice dual-color via CLI, including retargeting to
// another printer with --load-settings. buildBambuProject3mf() regenerates its
// geometry/assignments while keeping the engine-blessed structure and config.
const TEMPLATE_3MF = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'bambu_multicolor_template.3mf');

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

const RELS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

/**
 * Parse a binary STL buffer into {vertices: Float64Array-ish arrays, triangles}.
 * Deduplicates vertices so the 3MF stays compact and manifold-friendly.
 */
export function parseBinarySTL(buf) {
    if (buf.length < 84) throw new Error('STL too small');
    const triCount = buf.readUInt32LE(80);
    if (84 + triCount * 50 !== buf.length) throw new Error('Not a binary STL (size mismatch)');

    const vertices = [];       // flat [x,y,z,...]
    const triangles = [];      // flat [v1,v2,v3,...]
    const index = new Map();   // "x,y,z" -> vertex index

    let o = 84;
    for (let t = 0; t < triCount; t++) {
        o += 12; // skip facet normal
        const tri = [];
        for (let v = 0; v < 3; v++) {
            const x = buf.readFloatLE(o), y = buf.readFloatLE(o + 4), z = buf.readFloatLE(o + 8);
            o += 12;
            const key = `${x},${y},${z}`;
            let idx = index.get(key);
            if (idx === undefined) {
                idx = vertices.length / 3;
                index.set(key, idx);
                vertices.push(x, y, z);
            }
            tri.push(idx);
        }
        triangles.push(tri[0], tri[1], tri[2]);
        o += 2; // attribute byte count
    }
    return { vertices, triangles };
}

const fmt = (n) => {
    // Compact but precise vertex formatting
    const s = n.toFixed(6);
    return s.replace(/\.?0+$/, '') || '0';
};

/**
 * Build a plain 3MF from objects whose geometry is ALREADY in printer
 * coordinates (mm, Z-up, bed front-left origin). Build items use identity
 * transforms so the engine slices the layout exactly as given.
 *
 * `bed` is embedded as Metadata/project_settings.config -> printable_area.
 * Without it, OrcaSlicer's load-time plate check uses a default 200x200 bed
 * and rejects objects beyond it ("partly inside") BEFORE --load-settings
 * applies (verified empirically). Per the CLI's documented priority, 3MF
 * config is the LOWEST — the loaded machine/process presets still override
 * everything else at slice time.
 *
 * Per-object `filament` (1-based extruder index) is written into
 * Metadata/model_settings.config — BambuStudio's native mechanism for
 * per-object filament assignment (multi-material / AMS, DIRECTIVE §5).
 *
 * @param {Array<{name?: string, stl: Buffer, filament?: number}>} objects
 * @param {{x:number, y:number, z:number}} [bed] printer build volume (mm)
 * @returns {Buffer} 3mf zip buffer
 */
// Distinct display colors per filament slot. The engine's 3MF reader assigns
// extruder ids by DISTINCT color, iterating color groups in ascending id order
// (bbs_3mf.cpp: m_group_id_to_color -> color_group_id_to_extruder_id_map), so
// slot k gets extruder k as long as every slot 1..N has its own group+color.
const FILAMENT_SLOT_COLORS = ['#00AE42', '#F25C05', '#2080F0', '#B84CD6', '#F2C500', '#E23A3A', '#26C6DA', '#8D6E63'];

export function buildPlain3mf(objects, bed = { x: 256, y: 256, z: 256 }) {
    if (!objects?.length) throw new Error('buildPlain3mf: no objects');

    const resourceXml = [];
    const buildXml = [];

    // Multi-material: emit one m:colorgroup per filament slot 1..maxFilament
    // (3MF materials extension); each object references its slot via pid.
    const filaments = objects.map(o => (o.filament && o.filament > 0 ? Math.round(o.filament) : 1));
    const maxFilament = Math.max(...filaments);
    const GROUP_BASE = 1000; // keep group ids clear of object ids
    const colorGroupsXml = [];
    if (maxFilament > 1) {
        for (let k = 1; k <= maxFilament; k++) {
            const color = FILAMENT_SLOT_COLORS[(k - 1) % FILAMENT_SLOT_COLORS.length];
            colorGroupsXml.push(
                `  <m:colorgroup id="${GROUP_BASE + k}">\n   <m:color color="${color}"/>\n  </m:colorgroup>`
            );
        }
    }

    objects.forEach((obj, i) => {
        const id = i + 1;
        const { vertices, triangles } = parseBinarySTL(obj.stl);
        const vparts = [];
        for (let v = 0; v < vertices.length; v += 3) {
            vparts.push(`<vertex x="${fmt(vertices[v])}" y="${fmt(vertices[v + 1])}" z="${fmt(vertices[v + 2])}"/>`);
        }
        const tparts = [];
        for (let t = 0; t < triangles.length; t += 3) {
            tparts.push(`<triangle v1="${triangles[t]}" v2="${triangles[t + 1]}" v3="${triangles[t + 2]}"/>`);
        }
        const pidAttr = maxFilament > 1 ? ` pid="${GROUP_BASE + filaments[i]}" pindex="0"` : '';
        resourceXml.push(
            `  <object id="${id}" type="model"${pidAttr}>\n` +
            `   <mesh>\n    <vertices>${vparts.join('')}</vertices>\n` +
            `    <triangles>${tparts.join('')}</triangles>\n   </mesh>\n  </object>`
        );
        buildXml.push(`  <item objectid="${id}"/>`);
    });

    // TWO FLAVOURS (both verified against the engine):
    //  - single-filament: "plain model" flavour. Application metadata must NOT
    //    look like a slicer (bbs_3mf.cpp only treats files whose Application
    //    starts with "BambuStudio-"/"OrcaSlicer-" as projects); the partial
    //    project_settings.config carries printable_area so the load-time plate
    //    check doesn't clip to the default 200x200 bed.
    //  - multi-material: full "Bambu project" flavour (Application=BambuStudio-…)
    //    so model_settings.config per-object extruder assignments are honoured;
    //    needs the plate/model_instance section. Pass --allow-newer-file when
    //    slicing so engine upgrades don't trip the version equality check.
    const isProject = maxFilament > 1;
    const application = isProject ? 'BambuStudio-01.09.03.50' : 'Antigravity-Slicer';
    const modelXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">
 <metadata name="Application">${application}</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <resources>
${colorGroupsXml.join('\n')}
${resourceXml.join('\n')}
 </resources>
 <build>
${buildXml.join('\n')}
 </build>
</model>`;

    const projectSettings = JSON.stringify({
        printable_area: ['0x0', `${bed.x}x0`, `${bed.x}x${bed.y}`, `0x${bed.y}`],
        printable_height: String(bed.z),
    }, null, 1);

    // Per-object filament assignment (BambuStudio model_settings.config format).
    // The <part> entry is required: with config data present the engine takes the
    // object's volume list from it (a part with only an id references the mesh
    // object of that id); "extruder" metadata binds the object to a filament slot.
    const objectSettings = objects.map((obj, i) => {
        const id = i + 1;
        const name = (obj.name || `object_${id}`).replace(/[<>&"]/g, '');
        const extruder = obj.filament && obj.filament > 0 ? Math.round(obj.filament) : 1;
        return `  <object id="${id}">\n` +
            `    <metadata key="name" value="${name}"/>\n` +
            `    <metadata key="extruder" value="${extruder}"/>\n` +
            `    <part id="${id}" subtype="normal_part">\n` +
            `      <metadata key="name" value="${name}"/>\n` +
            `      <metadata key="extruder" value="${extruder}"/>\n` +
            `    </part>\n` +
            `  </object>`;
    }).join('\n');

    // Plate section: assigns every object instance to plate 1 (obj_inst_map).
    const plateSection = `  <plate>\n` +
        `    <metadata key="plater_id" value="1"/>\n` +
        `    <metadata key="plater_name" value=""/>\n` +
        `    <metadata key="locked" value="false"/>\n` +
        objects.map((_, i) =>
            `    <model_instance>\n` +
            `      <metadata key="object_id" value="${i + 1}"/>\n` +
            `      <metadata key="instance_id" value="0"/>\n` +
            `      <metadata key="identify_id" value="${100 + i}"/>\n` +
            `    </model_instance>`
        ).join('\n') + '\n' +
        `  </plate>`;

    const modelSettings = `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n${objectSettings}\n${isProject ? plateSection + '\n' : ''}</config>`;

    const zip = new AdmZip();
    zip.addFile('[Content_Types].xml', Buffer.from(CONTENT_TYPES_XML, 'utf-8'));
    zip.addFile('_rels/.rels', Buffer.from(RELS_XML, 'utf-8'));
    zip.addFile('3D/3dmodel.model', Buffer.from(modelXml, 'utf-8'));
    if (!isProject) {
        // partial config crashes the project loader; only the plain flavour gets it
        zip.addFile('Metadata/project_settings.config', Buffer.from(projectSettings, 'utf-8'));
    }
    zip.addFile('Metadata/model_settings.config', Buffer.from(modelSettings, 'utf-8'));
    const buf = zip.toBuffer();
    log.info(`Built input 3MF (${isProject ? 'project' : 'plain'}): ${objects.length} object(s), ${buf.length} bytes`);
    return buf;
}

// ============================================================
// MULTI-COLOR: Bambu project 3MF from the engine-blessed template
// ============================================================

const xmlNum = (n) => {
    const s = Number(n).toFixed(7);
    return s.replace(/\.?0+$/, '') || '0';
};

/** Deterministic template-style UUIDs (format matters, values just need uniqueness). */
const pad8 = (k) => String(k).padStart(8, '0').slice(-8);
const uuidObj = (k) => `${pad8(k)}-61cb-4c03-9d28-80fed5dfa1dc`;
const uuidComp = (k) => `${pad8(k)}-b206-40ff-9872-83e8017abed1`;
const uuidMesh = (k) => `${pad8(k)}-81cb-4c03-9d28-80fed5dfa1dc`;
const uuidItem = (k) => `${pad8(k)}-b1ec-4553-aec9-835e5b724bb4`;

/**
 * Build a multi-color Bambu PROJECT 3MF by regenerating the geometry and
 * per-object filament assignments inside the verified GUI-exported template.
 *
 * objects: [{ name, stl: Buffer (printer coords, Z-up, front-left origin), filament: 1-based }]
 *   OR     [{ name, parts: [{ name?, stl, filament }] }] — a MERGED object.
 * colors:  optional hex list per filament slot (cosmetic; physical color = AMS mapping)
 *
 * Multi-part objects are the Bambu Studio "merge" equivalent: parts of ONE
 * object may touch/overlap (e.g. colored text sunk into a model) and the
 * engine resolves the shared volume so later parts show through. Overlapping
 * SEPARATE objects, by contrast, make the CLI abort the plate (exit -101) —
 * verified empirically 2026-07-03.
 *
 * Structure mirrored from the template (all required, verified empirically):
 *  - production-extension: meshes in 3D/Objects/*.model, root 3dmodel.model with components
 *  - model_settings.config: per-object + per-part extruder + <plate> model_instances + <assemble>
 *  - project_settings.config: FULL consistent config; per-filament arrays widened for >2 slots
 */
export function buildBambuProject3mf(objects, colors = [], bed = { x: 256, y: 256, z: 256 }, configOverlay = {}) {
    if (!objects?.length) throw new Error('buildBambuProject3mf: no objects');
    const tpl = new AdmZip(fs.readFileSync(TEMPLATE_3MF));
    const zip = new AdmZip();

    // Normalize: every object = 1..N parts, each part its own mesh + filament.
    const norm = objects.map((o, i) => ({
        name: (o.name || `object_${i + 1}`).replace(/[<>&"]/g, ''),
        parts: (o.parts?.length ? o.parts : [{ name: o.name, stl: o.stl, filament: o.filament }])
            .map((p, j) => ({
                name: (p.name || o.name || `part_${j + 1}`).replace(/[<>&"]/g, ''),
                stl: p.stl,
                filament: Math.max(1, Math.round(p.filament || 1)),
            })),
    }));
    const maxFilament = Math.max(...norm.flatMap(o => o.parts.map(p => p.filament)));

    // --- geometry: center each part mesh locally; the part's offset from the
    // object center rides on the component transform (and the part matrix in
    // model_settings); the object center rides on the build item transform. ---
    let nextId = 0;
    const objMeta = norm.map((obj, i) => {
        const k = i + 1;
        const parsed = obj.parts.map(p => {
            const { vertices, triangles } = parseBinarySTL(p.stl);
            let minX = 1e30, minY = 1e30, minZ = 1e30, maxX = -1e30, maxY = -1e30, maxZ = -1e30;
            for (let v = 0; v < vertices.length; v += 3) {
                if (vertices[v] < minX) minX = vertices[v]; if (vertices[v] > maxX) maxX = vertices[v];
                if (vertices[v + 1] < minY) minY = vertices[v + 1]; if (vertices[v + 1] > maxY) maxY = vertices[v + 1];
                if (vertices[v + 2] < minZ) minZ = vertices[v + 2]; if (vertices[v + 2] > maxZ) maxZ = vertices[v + 2];
            }
            return { ...p, vertices, triangles, min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
        });
        // object center = center of the combined bbox of all parts
        const oMin = [0, 1, 2].map(a => Math.min(...parsed.map(p => p.min[a])));
        const oMax = [0, 1, 2].map(a => Math.max(...parsed.map(p => p.max[a])));
        const c = [0, 1, 2].map(a => (oMin[a] + oMax[a]) / 2);
        // A whole object floating above the bed makes the engine abort the
        // plate with a bare exit -101 — fail with an actionable message instead.
        // (Individual PARTS may float — e.g. text on top of a model.)
        if (oMin[2] > 0.1) {
            throw new Error(`Object "${obj.name}" floats ${oMin[2].toFixed(1)}mm above the bed — ` +
                `drop it to the bed, or attach/touch it to a model so they merge.`);
        }

        const partMeta = parsed.map((p) => {
            const meshId = ++nextId;
            const pc = [0, 1, 2].map(a => (p.min[a] + p.max[a]) / 2); // part center
            const d = [pc[0] - c[0], pc[1] - c[1], pc[2] - c[2]];      // offset from object center
            const vparts = [];
            for (let v = 0; v < p.vertices.length; v += 3) {
                vparts.push(`<vertex x="${xmlNum(p.vertices[v] - pc[0])}" y="${xmlNum(p.vertices[v + 1] - pc[1])}" z="${xmlNum(p.vertices[v + 2] - pc[2])}"/>`);
            }
            const tparts = [];
            for (let t = 0; t < p.triangles.length; t += 3) {
                tparts.push(`<triangle v1="${p.triangles[t]}" v2="${p.triangles[t + 1]}" v3="${p.triangles[t + 2]}"/>`);
            }
            const meshXml =
                `  <object id="${meshId}" p:UUID="${uuidMesh(meshId)}" type="model">\n` +
                `   <mesh>\n` +
                `    <vertices>${vparts.join('')}</vertices>\n` +
                `    <triangles>${tparts.join('')}</triangles>\n` +
                `   </mesh>\n  </object>`;
            return { meshId, name: p.name, filament: p.filament, offset: d, meshXml };
        });

        const rootId = ++nextId;
        const file = `3D/Objects/object_${k}.model`;
        // sub-model file (all part meshes in local/centered coords)
        const subXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <resources>
${partMeta.map(p => p.meshXml).join('\n')}
 </resources>
 <build/>
</model>`;
        zip.addFile(file, Buffer.from(subXml, 'utf-8'));
        return { k, rootId, file, name: obj.name, center: c, parts: partMeta };
    });

    // --- root 3dmodel.model: components + positioned build items ---
    const resXml = objMeta.map(o =>
        `  <object id="${o.rootId}" p:UUID="${uuidObj(o.rootId)}" type="model">\n` +
        `   <components>\n` +
        o.parts.map(p =>
            `    <component p:path="/${o.file}" objectid="${p.meshId}" p:UUID="${uuidComp(p.meshId)}" transform="1 0 0 0 1 0 0 0 1 ${xmlNum(p.offset[0])} ${xmlNum(p.offset[1])} ${xmlNum(p.offset[2])}"/>`
        ).join('\n') + '\n' +
        `   </components>\n  </object>`
    ).join('\n');
    const buildXml = objMeta.map(o =>
        `  <item objectid="${o.rootId}" p:UUID="${uuidItem(o.rootId)}" transform="1 0 0 0 1 0 0 0 1 ${xmlNum(o.center[0])} ${xmlNum(o.center[1])} ${xmlNum(o.center[2])}" printable="1"/>`
    ).join('\n');
    const rootXml = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <metadata name="Application">BambuStudio-02.06.00.51</metadata>
 <metadata name="OrcaSlicer">2.4.1</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <resources>
${resXml}
 </resources>
 <build p:UUID="2c7c17d8-22b5-4d84-8835-1976022ea369">
${buildXml}
 </build>
</model>`;
    zip.addFile('3D/3dmodel.model', Buffer.from(rootXml, 'utf-8'));
    zip.addFile('3D/_rels/3dmodel.model.rels', Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n` +
        objMeta.map((o, i) => ` <Relationship Target="/${o.file}" Id="rel-${i + 1}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>`).join('\n') +
        `\n</Relationships>`, 'utf-8'));

    // --- model_settings.config: extruder assignments + plate instances + assemble ---
    // Per-PART extruder is what makes a merged object multi-color (BBS merge
    // semantics); the object-level extruder is the default for its parts.
    const objSettings = objMeta.map(o =>
        `  <object id="${o.rootId}">\n` +
        `    <metadata key="name" value="${o.name}"/>\n` +
        `    <metadata key="extruder" value="${o.parts[0].filament}"/>\n` +
        o.parts.map(p =>
            `    <part id="${p.meshId}" subtype="normal_part">\n` +
            `      <metadata key="name" value="${p.name}"/>\n` +
            `      <metadata key="matrix" value="1 0 0 ${xmlNum(p.offset[0])} 0 1 0 ${xmlNum(p.offset[1])} 0 0 1 ${xmlNum(p.offset[2])} 0 0 0 1"/>\n` +
            `      <metadata key="extruder" value="${p.filament}"/>\n` +
            `      <mesh_stat edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>\n` +
            `    </part>`
        ).join('\n') + '\n' +
        `  </object>`
    ).join('\n');
    const instances = objMeta.map(o =>
        `    <model_instance>\n` +
        `      <metadata key="object_id" value="${o.rootId}"/>\n` +
        `      <metadata key="instance_id" value="0"/>\n` +
        `      <metadata key="identify_id" value="${60 + 35 * o.k}"/>\n` +
        `    </model_instance>`
    ).join('\n');
    const assemble = objMeta.map(o =>
        `   <assemble_item object_id="${o.rootId}" instance_id="0" transform="1 0 0 0 1 0 0 0 1 ${xmlNum(o.center[0])} ${xmlNum(o.center[1])} ${xmlNum(o.center[2])}" offset="0 0 0" />`
    ).join('\n');
    const modelSettings = `<?xml version="1.0" encoding="UTF-8"?>
<config>
${objSettings}
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value=""/>
    <metadata key="locked" value="false"/>
    <metadata key="filament_map_mode" value="Auto For Flush"/>
${instances}
  </plate>
  <assemble>
${assemble}
  </assemble>
</config>`;
    zip.addFile('Metadata/model_settings.config', Buffer.from(modelSettings, 'utf-8'));

    // --- project_settings.config: template's full config, widened for >2 slots ---
    const cfg = JSON.parse(tpl.readAsText('Metadata/project_settings.config'));
    if (maxFilament > 2) {
        for (const [k, v] of Object.entries(cfg)) {
            // per-filament arrays in the template are exactly width 2
            if (Array.isArray(v) && v.length === 2 && (k.startsWith('filament') || k.startsWith('nozzle_temperature') || ['fan_min_speed', 'fan_max_speed', 'slow_down_layer_time', 'slow_down_min_speed', 'hot_plate_temp', 'hot_plate_temp_initial_layer', 'cool_plate_temp', 'cool_plate_temp_initial_layer', 'eng_plate_temp', 'eng_plate_temp_initial_layer', 'textured_plate_temp', 'textured_plate_temp_initial_layer'].includes(k))) {
                while (cfg[k].length < maxFilament) cfg[k].push(v[v.length - 1]);
            }
        }
        // Pair-wise flush tables are 2×2 in the template; the engine hard-fails
        // ("Flush volumes matrix do not match to the correct size!") unless
        // they are exactly N×N (matrix) / 2·N (vector) for N filaments.
        const offDiag = String(Math.max(440, ...(cfg.flush_volumes_matrix || []).map(Number).filter(n => n > 0)));
        const mat = [];
        for (let i = 0; i < maxFilament; i++) {
            for (let j = 0; j < maxFilament; j++) mat.push(i === j ? '0' : offDiag);
        }
        cfg.flush_volumes_matrix = mat;
        const vec = (cfg.flush_volumes_vector || ['140', '140']).slice(0, 2 * maxFilament);
        while (vec.length < 2 * maxFilament) vec.push(vec[vec.length - 1]);
        cfg.flush_volumes_vector = vec;
    }
    // PLACEMENT (2026-07-03, verified empirically): loading machine/process
    // presets via --load-settings over a project 3MF makes the CLI invalidate
    // the plate and re-center ALL content (objects + wipe tower) on the bed —
    // user placement is lost. Loading only filaments keeps placement. So the
    // caller resolves machine/process preset values itself and bakes them in
    // here; the CLI is then invoked WITHOUT --load-settings.
    Object.assign(cfg, configOverlay);
    if (colors.length) {
        cfg.filament_colour = Array.from({ length: maxFilament }, (_, i) => colors[i] || colors[colors.length - 1] || '#FFFFFF');
    }
    // Pin the wipe tower to the back-left corner so it can't collide with the
    // layout. Bed-aware: a fixed y=220 sits OUTSIDE the A1 Mini's 180mm bed
    // and the engine rejects the whole plate.
    cfg.wipe_tower_x = ['15'];
    cfg.wipe_tower_y = [String(Math.max(20, bed.y - 36))];
    zip.addFile('Metadata/project_settings.config', Buffer.from(JSON.stringify(cfg, null, 1), 'utf-8'));

    // --- everything else straight from the template ---
    for (const e of tpl.getEntries()) {
        const name = e.entryName;
        if (name.startsWith('3D/') || name === 'Metadata/model_settings.config' || name === 'Metadata/project_settings.config') continue;
        zip.addFile(name, tpl.readFile(e));
    }

    const buf = zip.toBuffer();
    log.info(`Built Bambu project 3MF: ${objects.length} object(s), ${maxFilament} filament slot(s), ${buf.length} bytes`);
    return buf;
}

export default { parseBinarySTL, buildPlain3mf, buildBambuProject3mf };
