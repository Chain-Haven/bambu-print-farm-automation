// public/js/slicer.js — In-browser model viewer + plate editor for the 3DFLOW slicer.
//
// SLICER_FEATURES_DIRECTIVE §2: full manipulation — multi-object plate, move
// (drag + numeric), free rotation on all axes (numeric + 90° quick buttons),
// per-axis/uniform scale, place-picked-face-on-bed, drop-to-bed, reset, and a
// user-invoked auto-arrange. NO slicing happens here — geometry is exported
// (transforms baked, printer coordinates) and sliced by the real engine with
// --arrange 0 so the plate is printed exactly as shown.
//
// Coordinates: printer is Z-up with bed origin at FRONT-LEFT; the viewer is
// Y-up with the plate centered at the origin. Mapping (used consistently in
// load, UI readouts, and export):
//   printer X = viewer x + bed.x/2
//   printer Y = -viewer z + bed.y/2
//   printer Z = viewer y

import * as THREE from 'three';

const BED = {
    P1S: { x: 256, y: 256, z: 256 }, X1: { x: 256, y: 256, z: 256 },
    A1: { x: 256, y: 256, z: 256 }, A1_MINI: { x: 180, y: 180, z: 180 },
    // 2026 lineup (matches src/models/PrinterModels.js registry beds)
    P2S: { x: 256, y: 256, z: 256 }, X2D: { x: 256, y: 256, z: 260 },
    H2D: { x: 325, y: 320, z: 325 }, A2L: { x: 330, y: 320, z: 325 },
};

const BODY_COLOR = 0x6ea8ff, SELECT_EMISSIVE = 0x1a3a7a, OUT_COLOR = 0xdd5555;
// Objects carry a PRINT COLOR (hex). Logical filament slots are derived from
// the set of distinct colors on the plate (order of first use); the physical
// AMS tray is resolved from the color at print time.
const DEFAULT_COLOR = '#e8e8e8';

let ctx = null;
let nextId = 1;

export function initSlicer(container, opts = {}) {
    disposeSlicer();
    const model = opts.model || 'P1S';
    const bed = BED[model] || BED.P1S;
    let onScene = opts.onSceneChange || (() => {});

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0e14);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);
    Object.assign(renderer.domElement.style, { display: 'block', width: '100%', height: '100%' });

    scene.add(new THREE.HemisphereLight(0xbcd0ff, 0x202830, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(bed.x, bed.z * 1.5, bed.y);
    scene.add(key);

    // DoubleSide + transparent: the plate is visible (dimly) from underneath so
    // text placed on the bottom of a part can be inspected — opacity drops when
    // the camera goes below the bed (see tick loop).
    const plate = new THREE.Mesh(
        new THREE.PlaneGeometry(bed.x, bed.y),
        new THREE.MeshStandardMaterial({ color: 0x1b2230, roughness: 0.95, side: THREE.DoubleSide, transparent: true, opacity: 0.95 })
    );
    plate.rotation.x = -Math.PI / 2;
    scene.add(plate);
    scene.add(new THREE.GridHelper(Math.max(bed.x, bed.y), Math.max(bed.x, bed.y) / 10, 0x3a4a66, 0x223047));

    // --- FRONT-of-plate indicator (printer Y=0 edge = viewer +Z edge) ---
    // Parts eject toward the front, so operators need this landmark.
    const frontBar = new THREE.Mesh(
        new THREE.BoxGeometry(bed.x, 1, 3),
        new THREE.MeshBasicMaterial({ color: 0x22d3ee })
    );
    frontBar.position.set(0, 0.5, bed.y / 2 + 2);
    scene.add(frontBar);
    const frontLabel = (() => {
        const cvs = document.createElement('canvas');
        cvs.width = 256; cvs.height = 64;
        const c2d = cvs.getContext('2d');
        c2d.font = 'bold 44px sans-serif';
        c2d.textAlign = 'center'; c2d.textBaseline = 'middle';
        c2d.fillStyle = '#22d3ee';
        c2d.fillText('FRONT', 128, 34);
        const tex = new THREE.CanvasTexture(cvs);
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
        sprite.scale.set(48, 12, 1);
        sprite.position.set(0, 3, bed.y / 2 + 16);
        return sprite;
    })();
    scene.add(frontLabel);

    const target = new THREE.Vector3(0, bed.z * 0.15, 0);
    const orbit = { theta: Math.PI * 0.25, phi: Math.PI * 0.32, radius: Math.max(bed.x, bed.y, bed.z) * 1.9 };
    applyCamera(camera, target, orbit);

    const objects = [];        // { id, name, mesh, baseGeo, isText?, textParams?, attachedTo? }
    let selectedId = null;
    let pointerMode = null;    // null | 'placeFace' | 'attachText'

    ctx = {
        container, scene, camera, renderer, bed, model,
        raf: 0, listeners: [], resizeObserver: null,
    };

    const resize = () => {
        const w = container.clientWidth || 1, h = container.clientHeight || 1;
        renderer.setSize(w, h, false);
        camera.aspect = w / h; camera.updateProjectionMatrix();
    };
    resize();
    ctx.resizeObserver = new ResizeObserver(resize);
    ctx.resizeObserver.observe(container);

    // ---------- helpers ----------
    const byId = (id) => objects.find(o => o.id === id) || null;
    const selected = () => byId(selectedId);

    function worldBox(mesh) {
        mesh.updateMatrixWorld(true);
        return new THREE.Box3().setFromObject(mesh);
    }

    function dropToBed(obj) {
        const bb = worldBox(obj.mesh);
        obj.mesh.position.y -= bb.min.y;
    }

    function refreshAppearance() {
        for (const o of objects) {
            const bb = worldBox(o.mesh);
            const out = bb.min.x < -bed.x / 2 - 0.01 || bb.max.x > bed.x / 2 + 0.01 ||
                bb.min.z < -bed.y / 2 - 0.01 || bb.max.z > bed.y / 2 + 0.01 ||
                bb.max.y > bed.z + 0.01 || bb.min.y < -0.5;
            if (out) o.mesh.material.color.setHex(OUT_COLOR);
            else o.mesh.material.color.set(o.color || DEFAULT_COLOR);
            o.mesh.material.emissive.setHex(o.id === selectedId ? SELECT_EMISSIVE : 0x000000);
            o.outOfBed = out;
        }
    }

    // Distinct plate colors in order of first use = logical filament slots 1..N
    function palette() {
        const seen = [];
        for (const o of objects) {
            const c = (o.color || DEFAULT_COLOR).toLowerCase();
            if (!seen.includes(c)) seen.push(c);
        }
        return seen;
    }
    const slotOf = (o) => palette().indexOf((o.color || DEFAULT_COLOR).toLowerCase()) + 1;

    function sceneState() {
        const sel = selected();
        let transform = null;
        if (sel) {
            const bb = worldBox(sel.mesh);
            const size = new THREE.Vector3(); bb.getSize(size);
            const center = new THREE.Vector3(); bb.getCenter(center);
            transform = {
                pos: { // printer coords of the object's center footprint
                    x: +(center.x + bed.x / 2).toFixed(2),
                    y: +(-center.z + bed.y / 2).toFixed(2),
                    z: +bb.min.y.toFixed(2), // lift above bed
                },
                rot: {
                    x: +THREE.MathUtils.radToDeg(sel.mesh.rotation.x).toFixed(1),
                    y: +THREE.MathUtils.radToDeg(sel.mesh.rotation.z).toFixed(1) * -1, // printer Y axis = viewer -Z
                    z: +THREE.MathUtils.radToDeg(sel.mesh.rotation.y).toFixed(1),
                },
                scale: {
                    x: +(sel.mesh.scale.x * 100).toFixed(1),
                    y: +(sel.mesh.scale.z * 100).toFixed(1),
                    z: +(sel.mesh.scale.y * 100).toFixed(1),
                },
                // printer-axis world AABB (X = viewer x, Y = viewer z, Z = viewer y)
                dims: { x: +size.x.toFixed(2), y: +size.z.toFixed(2), z: +size.y.toFixed(2) },
                insert: !!sel.insert,
                isLogo: !!sel.isLogo,
            };
        }
        return {
            objects: objects.map(o => ({ id: o.id, name: o.name, selected: o.id === selectedId, outOfBed: !!o.outOfBed, isText: !!o.isText, color: o.color || DEFAULT_COLOR, slot: slotOf(o) })),
            selected: sel ? { id: sel.id, name: sel.name, isText: !!sel.isText, textParams: sel.textParams || null, color: sel.color || DEFAULT_COLOR, ...transform } : null,
            anyOutOfBed: objects.some(o => o.outOfBed),
            palette: palette(),
            bed: { ...bed },
            count: objects.length,
        };
    }

    function changed() { refreshAppearance(); onScene(sceneState()); }

    // ---------- pointer interaction ----------
    const cv = renderer.domElement;
    const raycaster = new THREE.Raycaster();
    const ndcFromEvent = (e) => {
        const r = cv.getBoundingClientRect();
        return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    };
    const bedPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    let mode = null; // 'orbit' | 'move'
    let moved = 0, lastX = 0, lastY = 0, dragStart = null;

    const onDown = (e) => {
        moved = 0; lastX = e.clientX; lastY = e.clientY;
        raycaster.setFromCamera(ndcFromEvent(e), camera);
        const hits = raycaster.intersectObjects(objects.map(o => o.mesh), false);
        if (hits.length) {
            const obj = objects.find(o => o.mesh === hits[0].object);
            if (pointerMode) { mode = null; return; } // face-pick handled on mouseup
            if (obj.id !== selectedId) { selectedId = obj.id; changed(); }
            const hitOnPlane = new THREE.Vector3();
            raycaster.ray.intersectPlane(bedPlane, hitOnPlane);
            dragStart = { start: hitOnPlane, origPos: obj.mesh.position.clone() };
            mode = 'move';
        } else {
            mode = 'orbit';
        }
    };
    const onMove = (e) => {
        if (!mode) return;
        moved += Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY);
        if (mode === 'orbit') {
            orbit.theta -= (e.clientX - lastX) * 0.01;
            // full range: allow orbiting BELOW the plate to inspect part undersides
            orbit.phi = Math.max(0.05, Math.min(Math.PI - 0.05, orbit.phi - (e.clientY - lastY) * 0.01));
            applyCamera(camera, target, orbit);
        } else if (mode === 'move' && dragStart && selected()) {
            raycaster.setFromCamera(ndcFromEvent(e), camera);
            const p = new THREE.Vector3();
            if (raycaster.ray.intersectPlane(bedPlane, p)) {
                const m = selected().mesh;
                m.position.x = dragStart.origPos.x + (p.x - dragStart.start.x);
                m.position.z = dragStart.origPos.z + (p.z - dragStart.start.z);
                changed();
            }
        }
        lastX = e.clientX; lastY = e.clientY;
    };
    const onUp = (e) => {
        if (pointerMode && moved < 4) {
            raycaster.setFromCamera(ndcFromEvent(e), camera);
            const hits = raycaster.intersectObjects(objects.map(o => o.mesh), false);
            const hit = hits[0];
            if (hit?.face) {
                const obj = objects.find(o => o.mesh === hit.object);
                const nWorld = hit.face.normal.clone()
                    .applyMatrix3(new THREE.Matrix3().getNormalMatrix(obj.mesh.matrixWorld)).normalize();
                if (pointerMode === 'placeFace') {
                    // rotate the clicked object so this face lies on the bed
                    selectedId = obj.id;
                    const q = new THREE.Quaternion().setFromUnitVectors(nWorld, new THREE.Vector3(0, -1, 0));
                    obj.mesh.quaternion.premultiply(q);
                    dropToBed(obj);
                    changed();
                } else if (pointerMode === 'attachText') {
                    // stick the SELECTED text/logo object onto the clicked face:
                    // its thickness axis (local +Y) points along the face normal,
                    // sunk 0.2mm into the surface so booleans/adhesion are solid.
                    const att = selected();
                    if (att && (att.isText || att.isLogo) && obj !== att && !obj.isText && !obj.isLogo) {
                        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), nWorld);
                        att.mesh.quaternion.copy(q);
                        const thick = att.isLogo
                            ? (att.logoParams?.thicknessMm ?? 0.5)
                            : (att.textParams?.thicknessMm ?? 2);
                        att.mesh.position.copy(hit.point).addScaledVector(nWorld, thick / 2 - 0.2);
                        att.attachedTo = obj.id;
                        changed();
                    }
                }
            }
        } else if (mode === 'move' && selected()) {
            changed();
        }
        mode = null; dragStart = null;
    };
    const onWheel = (e) => {
        e.preventDefault();
        orbit.radius = Math.max(40, Math.min(3000, orbit.radius * (1 + Math.sign(e.deltaY) * 0.1)));
        applyCamera(camera, target, orbit);
    };
    cv.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    cv.addEventListener('wheel', onWheel, { passive: false });
    ctx.listeners = [[cv, 'mousedown', onDown], [window, 'mousemove', onMove], [window, 'mouseup', onUp], [cv, 'wheel', onWheel]];

    const tick = () => {
        // fade the plate out as the camera dips below it, so undersides
        // (e.g. bottom-face text) are visible through a ghosted bed
        plate.material.opacity = camera.position.y < 8 ? 0.22 : 0.95;
        renderer.render(scene, camera);
        ctx.raf = requestAnimationFrame(tick);
    };
    tick();

    // ---------- detach / reattach (scene persistence across navigation) ----------
    // Navigating away must NOT lose the plate: detach pauses rendering and
    // pulls the canvas out of the DOM but keeps the whole scene alive;
    // reattach drops the same canvas into the new page instance.
    ctx.detach = () => {
        cancelAnimationFrame(ctx.raf);
        ctx.resizeObserver?.disconnect();
        renderer.domElement.remove();
        ctx.detached = true;
    };
    ctx.reattach = (newContainer, newOnScene) => {
        container = newContainer;
        ctx.container = newContainer;
        if (newOnScene) onScene = newOnScene;
        newContainer.appendChild(renderer.domElement);
        ctx.resizeObserver = new ResizeObserver(resize);
        ctx.resizeObserver.observe(newContainer);
        resize();
        ctx.detached = false;
        tick();
        changed(); // push current scene state into the fresh page UI
    };

    // Remove every object from the plate (used by "New model").
    ctx.clearAll = () => {
        for (const o of [...objects]) {
            scene.remove(o.mesh);
            o.mesh.geometry.dispose();
            o.mesh.material.dispose();
        }
        objects.length = 0;
        selectedId = null;
        changed();
    };

    // ---------- public API ----------
    ctx.addModel = (arrayBuffer, name) => {
        const ext = (name.split('.').pop() || '').toLowerCase();
        if (ext !== 'stl') throw new Error(`Viewer currently loads STL; "${ext}" support comes with the engine path.`);
        const geometry = parseSTL(arrayBuffer);
        geometry.rotateX(-Math.PI / 2); // STL Z-up -> viewer Y-up
        geometry.computeVertexNormals();
        geometry.computeBoundingBox();
        const c = new THREE.Vector3(); geometry.boundingBox.getCenter(c);
        geometry.translate(-c.x, -c.y, -c.z); // center at origin (rotation pivot = center)

        const mesh = new THREE.Mesh(geometry,
            new THREE.MeshStandardMaterial({ color: BODY_COLOR, roughness: 0.55, metalness: 0.05 }));
        const obj = { id: nextId++, name, mesh, baseGeo: geometry.clone() };
        scene.add(mesh);
        objects.push(obj);
        dropToBed(obj);
        // naive free-spot placement: offset each new object to the right
        if (objects.length > 1) {
            const bb = worldBox(mesh); const w = bb.max.x - bb.min.x;
            mesh.position.x = Math.min(bed.x / 2 - w / 2, (objects.length - 1) * (w + 8) - bed.x / 4);
        }
        selectedId = obj.id;
        changed();
        return obj.id;
    };

    ctx.select = (id) => { selectedId = byId(id) ? id : null; changed(); };
    ctx.removeSelected = () => {
        const o = selected(); if (!o) return;
        scene.remove(o.mesh); o.mesh.geometry.dispose(); o.mesh.material.dispose();
        objects.splice(objects.indexOf(o), 1);
        selectedId = objects.length ? objects[objects.length - 1].id : null;
        changed();
    };
    ctx.clearAll = () => {
        for (const o of objects) { scene.remove(o.mesh); o.mesh.geometry.dispose(); o.mesh.material.dispose(); }
        objects.length = 0; selectedId = null; changed();
    };

    ctx.setPositionPrinter = (px, py, pz) => {
        const o = selected(); if (!o) return;
        const bb = worldBox(o.mesh);
        const center = new THREE.Vector3(); bb.getCenter(center);
        if (px != null && px !== '') o.mesh.position.x += (px - bed.x / 2) - center.x;
        if (py != null && py !== '') o.mesh.position.z += -(py - bed.y / 2) - center.z;
        if (pz != null && pz !== '') o.mesh.position.y += pz - bb.min.y;
        changed();
    };
    ctx.setRotationDeg = (rx, ry, rz) => {
        const o = selected(); if (!o) return;
        const cur = o.mesh.rotation;
        o.mesh.rotation.set(
            rx != null && rx !== '' ? THREE.MathUtils.degToRad(rx) : cur.x,
            rz != null && rz !== '' ? THREE.MathUtils.degToRad(rz) : cur.y,   // printer Z spin = viewer Y
            ry != null && ry !== '' ? THREE.MathUtils.degToRad(-ry) : cur.z,  // printer Y axis = viewer -Z
        );
        dropToBed(o); changed();
    };
    ctx.setScalePct = (sx, sy, sz) => {
        const o = selected(); if (!o) return;
        const s = o.mesh.scale;
        o.mesh.scale.set(
            sx != null && sx !== '' ? Math.max(1, sx) / 100 : s.x,
            sz != null && sz !== '' ? Math.max(1, sz) / 100 : s.y,  // printer Z = viewer Y
            sy != null && sy !== '' ? Math.max(1, sy) / 100 : s.z,  // printer Y = viewer Z
        );
        dropToBed(o); changed();
    };
    // Set the selected object's ABSOLUTE size in printer-axis mm (like Bambu
    // Studio's Size fields). Ratio-based against the current world AABB, so it
    // is exact for axis-aligned rotations and matches what the scale % implies
    // (printer X = viewer x, printer Y = viewer z, printer Z = viewer y).
    ctx.setSizePrinterMm = ({ x = null, y = null, z = null } = {}, uniform = false) => {
        const o = selected(); if (!o) return;
        const size = new THREE.Vector3(); worldBox(o.mesh).getSize(size);
        const cur = { x: size.x, y: size.z, z: size.y }; // printer axes
        const ratio = {};
        if (x != null && x !== '' && x > 0 && cur.x > 1e-3) ratio.x = x / cur.x;
        if (y != null && y !== '' && y > 0 && cur.y > 1e-3) ratio.y = y / cur.y;
        if (z != null && z !== '' && z > 0 && cur.z > 1e-3) ratio.z = z / cur.z;
        const rs = Object.values(ratio);
        if (!rs.length) return;
        if (uniform) {
            o.mesh.scale.multiplyScalar(rs[0]);
        } else {
            if (ratio.x) o.mesh.scale.x *= ratio.x;
            if (ratio.y) o.mesh.scale.z *= ratio.y; // printer Y = viewer Z
            if (ratio.z) o.mesh.scale.y *= ratio.z; // printer Z = viewer Y
        }
        dropToBed(o); changed();
    };

    // Mark the selected object as an INSERT (logo): when merged with touching
    // objects at slice time it is ordered LAST in its group, so it wins every
    // shared volume and always shows through (needs its own color to be seen).
    ctx.setInsert = (flag) => {
        const o = selected(); if (!o) return;
        o.insert = !!flag;
        changed();
    };

    ctx.rotate90 = (axis) => {
        const o = selected(); if (!o) return;
        if (axis === 'x') o.mesh.rotateX(Math.PI / 2);
        else if (axis === 'y') o.mesh.rotateZ(-Math.PI / 2); // printer Y
        else o.mesh.rotateY(Math.PI / 2);                    // printer Z
        dropToBed(o); changed();
    };
    ctx.dropToBed = () => { const o = selected(); if (o) { dropToBed(o); changed(); } };
    ctx.setColor = (hex) => {
        const o = selected(); if (!o) return;
        if (/^#[0-9a-fA-F]{6}$/.test(hex)) { o.color = hex.toLowerCase(); changed(); }
    };
    ctx.sceneState = sceneState; // read-only snapshot (custom color picker reads selected.color)
    ctx.resetTransform = () => {
        const o = selected(); if (!o) return;
        o.mesh.geometry.dispose();
        o.mesh.geometry = o.baseGeo.clone();
        o.mesh.rotation.set(0, 0, 0);
        o.mesh.scale.set(1, 1, 1);
        o.mesh.position.set(0, 0, 0);
        dropToBed(o); changed();
    };
    ctx.setPointerMode = (m) => {
        pointerMode = (m === 'placeFace' || m === 'attachText') ? m : null;
        cv.style.cursor = pointerMode ? 'crosshair' : '';
    };

    // ---------- 3D text objects (DIRECTIVE §4) ----------
    // Geometry comes from text3d.buildTextGeometry (XY-centered, thickness 0..+Z).
    // We lay it flat: thickness up (+Y), readable from the front.
    ctx.addTextObject = (geometry, params) => {
        const g = geometry.clone();
        g.rotateX(-Math.PI / 2);
        g.computeBoundingBox();
        const c = new THREE.Vector3(); g.boundingBox.getCenter(c);
        g.translate(-c.x, -c.y, -c.z);
        const mesh = new THREE.Mesh(g,
            new THREE.MeshStandardMaterial({ color: BODY_COLOR, roughness: 0.55, metalness: 0.05 }));
        const obj = {
            id: nextId++, name: `“${params.text}”`, mesh, baseGeo: g.clone(),
            isText: true, textParams: { ...params }, attachedTo: null,
        };
        scene.add(mesh);
        objects.push(obj);
        dropToBed(obj);
        // default spot: front-center, where it's visible and near the eject path
        mesh.position.z += bed.y / 4;
        selectedId = obj.id;
        changed();
        return obj.id;
    };

    // ---------- SVG logo objects (0.5mm, single color, always show through) ----------
    // Geometry comes from logo3d.svgToLogoGeometry (XY-centered, thickness 0..+Z).
    // Same lie-flat convention as text; insert=true so it wins merge overlaps.
    ctx.addLogoObject = (geometry, name, thicknessMm = 0.5) => {
        const g = geometry.clone();
        g.rotateX(-Math.PI / 2);
        g.computeBoundingBox();
        const c = new THREE.Vector3(); g.boundingBox.getCenter(c);
        g.translate(-c.x, -c.y, -c.z);
        const mesh = new THREE.Mesh(g,
            new THREE.MeshStandardMaterial({ color: BODY_COLOR, roughness: 0.55, metalness: 0.05 }));
        const obj = {
            id: nextId++, name: `🖼 ${String(name || 'logo').replace(/\.svg$/i, '')}`, mesh, baseGeo: g.clone(),
            isLogo: true, insert: true, logoParams: { thicknessMm }, attachedTo: null,
        };
        scene.add(mesh);
        objects.push(obj);
        dropToBed(obj);
        mesh.position.z += bed.y / 4; // spawn front-center like text
        selectedId = obj.id;
        changed();
        return obj.id;
    };

    // Spin the selected text/logo 90° around its own thickness axis (the face
    // normal once attached) — orientation control for placed logos.
    ctx.spinSelected90 = () => {
        const o = selected();
        if (!o || (!o.isLogo && !o.isText)) return;
        o.mesh.rotateY(Math.PI / 2);
        changed();
    };

    // Invert (mirror) the selected logo — baked into the geometry with the
    // winding fixed (see logo3d.mirrorGeometryX), so exports stay watertight.
    ctx.invertSelectedLogo = (mirrorFn) => {
        const o = selected();
        if (!o?.isLogo || typeof mirrorFn !== 'function') return;
        const g = mirrorFn(o.mesh.geometry);
        if (g !== o.mesh.geometry) { o.mesh.geometry.dispose(); o.mesh.geometry = g; }
        o.baseGeo = g.clone();
        changed();
    };

    // Replace the selected text object's geometry (live text/font/size edits),
    // keeping its position/rotation/scale and attachment.
    ctx.updateSelectedText = (geometry, params) => {
        const o = selected();
        if (!o?.isText) return false;
        const g = geometry.clone();
        g.rotateX(-Math.PI / 2);
        g.computeBoundingBox();
        const c = new THREE.Vector3(); g.boundingBox.getCenter(c);
        g.translate(-c.x, -c.y, -c.z);
        o.mesh.geometry.dispose();
        o.mesh.geometry = g;
        o.baseGeo = g.clone();
        o.textParams = { ...params };
        o.name = `“${params.text}”`;
        changed();
        return true;
    };

    // Emboss (union) / deboss (subtract) the selected text into a model.
    // The REAL boolean runs in three-bvh-csg; the result replaces the target's
    // geometry, and the text object is consumed. Returns {ok, error?}.
    ctx.applyTextBoolean = async (operation) => {
        const txt = selected();
        if (!txt?.isText) return { ok: false, error: 'Select a text object first' };
        // target: the attached model, else the model whose bbox intersects the text
        let target = txt.attachedTo != null ? byId(txt.attachedTo) : null;
        if (!target) {
            const tb = worldBox(txt.mesh);
            target = objects.find(o => !o.isText && worldBox(o.mesh).intersectsBox(tb)) || null;
        }
        if (!target) return { ok: false, error: 'Text must touch (or be attached to) a model' };
        // Different print colors: a CSG merge would absorb the text into the
        // target's filament and lose its color. Un-merged text that touches a
        // model slices as one merged multi-part object automatically (the text
        // part wins the shared volume), so the color shows through — just slice.
        if ((txt.color || DEFAULT_COLOR).toLowerCase() !== (target.color || DEFAULT_COLOR).toLowerCase()) {
            return { ok: false, error: 'Text has a different print color than the model — leave it un-merged; it is merged with the model automatically when slicing and the text color shows through.' };
        }

        const { Evaluator, Brush, SUBTRACTION, ADDITION } = await import('three-bvh-csg');
        // deboss on face-attached text: attach places it proud (top at surface
        // + thickness − 0.2). Shift inward so the top sits 0.2mm ABOVE the
        // surface and the body is inside → clean recess ≈ thickness deep.
        // Manually-placed text is subtracted exactly as the user positioned it.
        if (operation === 'deboss' && txt.attachedTo != null) {
            const w = new THREE.Vector3(0, 1, 0).applyQuaternion(txt.mesh.quaternion);
            txt.mesh.position.addScaledVector(w, -((txt.textParams?.thicknessMm ?? 2) - 0.4));
        }
        txt.mesh.updateMatrixWorld(true);
        target.mesh.updateMatrixWorld(true);
        const gA = target.mesh.geometry.clone().applyMatrix4(target.mesh.matrixWorld);
        const gB = txt.mesh.geometry.clone().applyMatrix4(txt.mesh.matrixWorld);
        const ev = new Evaluator();
        ev.attributes = ['position', 'normal'];
        let result;
        try {
            result = ev.evaluate(new Brush(gA), new Brush(gB), operation === 'deboss' ? SUBTRACTION : ADDITION);
        } catch (err) {
            return { ok: false, error: `Boolean failed (${err.message}) — text left as a separate part` };
        }
        // world-space result -> recentered geometry + identity-ish transform
        const g = result.geometry;
        g.computeBoundingBox();
        const c = new THREE.Vector3(); g.boundingBox.getCenter(c);
        g.translate(-c.x, -c.y, -c.z);
        target.mesh.geometry.dispose();
        target.mesh.geometry = g;
        target.baseGeo = g.clone();
        target.mesh.rotation.set(0, 0, 0);
        target.mesh.scale.set(1, 1, 1);
        target.mesh.position.copy(c);
        // consume the text object
        scene.remove(txt.mesh); txt.mesh.geometry.dispose(); txt.mesh.material.dispose();
        objects.splice(objects.indexOf(txt), 1);
        selectedId = target.id;
        changed();
        return { ok: true };
    };

    ctx.autoArrange = () => {
        // Simple shelf packing, largest footprint first — a USER action, never
        // done at slice time (the engine gets --arrange 0).
        const gap = 8;
        const items = objects.map(o => {
            const bb = worldBox(o.mesh); const s = new THREE.Vector3(); bb.getSize(s);
            return { o, w: s.x + gap, d: s.z + gap };
        }).sort((a, b) => (b.w * b.d) - (a.w * a.d));
        let cursorX = -bed.x / 2 + gap, cursorZ = -bed.y / 2 + gap, rowDepth = 0;
        for (const it of items) {
            if (cursorX + it.w > bed.x / 2) { cursorX = -bed.x / 2 + gap; cursorZ += rowDepth; rowDepth = 0; }
            const bb = worldBox(it.o.mesh);
            const center = new THREE.Vector3(); bb.getCenter(center);
            it.o.mesh.position.x += (cursorX + it.w / 2 - gap / 2) - center.x;
            it.o.mesh.position.z += (cursorZ + it.d / 2 - gap / 2) - center.z;
            cursorX += it.w; rowDepth = Math.max(rowDepth, it.d);
        }
        changed();
    };

    // Export every object with its full transform baked, in printer coordinates
    // (Z-up, front-left origin) — ready for the engine with --arrange 0.
    //
    // Merge groups (Bambu Studio "merge" semantics): ANY objects that touch or
    // overlap — plus text attached to a model — are exported in the SAME group,
    // so the server slices them as one multi-part object. Separate overlapping
    // objects abort the engine outright (exit -101); within one object the
    // later part wins the shared volume, which is what makes differently-
    // colored text show through. Text is therefore ordered AFTER solid models.
    ctx.exportPlacedSTLs = () => {
        // union-find over slightly-expanded world bboxes (near-touching counts)
        const boxes = objects.map(o => worldBox(o.mesh).expandByScalar(0.3));
        const parent = objects.map((_, i) => i);
        const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
        for (let i = 0; i < objects.length; i++) {
            for (let j = i + 1; j < objects.length; j++) {
                if (boxes[i].intersectsBox(boxes[j])) parent[find(i)] = find(j);
            }
        }
        objects.forEach((o, i) => {
            if (o.isText && o.attachedTo != null) {
                const t = objects.findIndex(x => x.id === o.attachedTo);
                if (t >= 0) parent[find(i)] = find(t);
            }
        });
        const groupOf = new Map();
        objects.forEach((o, i) => {
            const root = find(i);
            let min = i;
            for (let j = 0; j < objects.length; j++) if (find(j) === root && j < min) min = j;
            groupOf.set(o.id, min);
        });
        // Ordering guarantee: text AND flagged inserts (logos) sort LAST within
        // their group — the later part wins every shared volume, so they always
        // show through. Two overlapping inserts: the later-added one wins.
        const winsOverlap = (o) => (o.isText || o.insert) ? 1 : 0;
        const ordered = [...objects].sort((a, b) =>
            (groupOf.get(a.id) - groupOf.get(b.id)) ||
            (winsOverlap(a) - winsOverlap(b)) ||
            (objects.indexOf(a) - objects.indexOf(b)));
        return ordered.map(o => {
            const g = o.mesh.geometry.clone();
            o.mesh.updateMatrixWorld(true);
            g.applyMatrix4(o.mesh.matrixWorld);
            g.rotateX(Math.PI / 2);                       // viewer Y-up -> printer Z-up
            g.translate(bed.x / 2, bed.y / 2, 0);         // center origin -> front-left origin
            return { name: o.name.replace(/\.[^.]+$/, '') + '.stl', buffer: geometryToBinarySTL(g), filament: slotOf(o), color: o.color || DEFAULT_COLOR, group: groupOf.get(o.id) };
        });
    };

    // Capture everything needed to reproduce this plate server-side as a saved
    // print job: baked base STLs (+ per-object color/filament) and — when a
    // text object exists — its params, viewer-space world matrix and target so
    // fills can swap the string (DIRECTIVE §7). Works with or without text.
    ctx.getProjectData = (mode = 'deboss') => {
        if (!objects.length) return { error: 'Nothing on the plate' };
        // text placeholder: the selected text object, else the first one
        const sel = selected();
        const txt = sel?.isText ? sel : (objects.find(o => o.isText) || null);
        const base = objects.filter(o => o !== txt);
        if (!base.length) return { error: 'Add the base model to the plate first' };
        let targetIndex = -1;
        if (txt) {
            if (txt.attachedTo != null) targetIndex = base.findIndex(o => o.id === txt.attachedTo);
            if (targetIndex < 0) {
                const tb = worldBox(txt.mesh);
                targetIndex = base.findIndex(o => worldBox(o.mesh).intersectsBox(tb));
            }
            if (targetIndex < 0 && mode !== 'separate') return { error: 'Text must touch (or be attached to) the base model for emboss/deboss' };
            txt.mesh.updateMatrixWorld(true);
        }
        // inserts sort last so saved prints keep the show-through ordering
        const baseOrdered = [...base].sort((a, b) =>
            ((a.insert ? 1 : 0) - (b.insert ? 1 : 0)) || (base.indexOf(a) - base.indexOf(b)));
        // targetIndex must reference the SORTED order the server stores
        if (txt && targetIndex >= 0) targetIndex = baseOrdered.indexOf(base[targetIndex]);
        return {
            baseObjects: baseOrdered.map(o => {
                const g = o.mesh.geometry.clone();
                o.mesh.updateMatrixWorld(true);
                g.applyMatrix4(o.mesh.matrixWorld);
                g.rotateX(Math.PI / 2);
                g.translate(bed.x / 2, bed.y / 2, 0);
                return { name: o.name.replace(/\.[^.]+$/, '') + '.stl', buffer: geometryToBinarySTL(g), color: o.color || DEFAULT_COLOR, filament: slotOf(o), insert: !!o.insert };
            }),
            colors: palette(),
            textDef: txt ? {
                fontId: txt.textParams?.fontId || 'sans',
                sizeMm: txt.textParams?.sizeMm ?? 10,
                thicknessMm: txt.textParams?.thicknessMm ?? 2,
                mode,
                filament: slotOf(txt),
                color: txt.color || DEFAULT_COLOR,
                matrixWorld: [...txt.mesh.matrixWorld.elements],
                targetIndex,
                maxChars: 40,
                colors: palette(),
            } : null,
        };
    };
    // Back-compat alias (older callers): requires text.
    ctx.getTemplateData = (mode = 'deboss') => {
        const d = ctx.getProjectData(mode);
        if (d.error) return d;
        if (!d.textDef) return { error: 'Select a text object first' };
        return d;
    };

    ctx.getState = sceneState;
    ctx.hasObjects = () => objects.length > 0;

    return ctx;
}

// Reattach the live scene when returning to the slicer (same printer model);
// otherwise start fresh. This is what keeps your plate from disappearing when
// you navigate around the site.
export function attachSlicer(container, opts = {}) {
    const model = opts.model || 'P1S';
    if (ctx && ctx.model === model && ctx.reattach) {
        ctx.reattach(container, opts.onSceneChange);
        return ctx;
    }
    return initSlicer(container, opts);
}

/** Pause + pull the canvas out of the DOM, keeping the scene alive. */
export function detachSlicer() {
    if (ctx && !ctx.detached && ctx.detach) ctx.detach();
}

/** Is there a live scene (optionally for a specific printer model)? */
export function hasLiveScene(model = null) {
    return !!ctx && (!model || ctx.model === model) && !!ctx.hasObjects?.();
}

/** Printer model of the live scene, or null. Lets the page sync its model
 *  select to the surviving scene on re-entry (previously the select's DEFAULT
 *  won, silently rebuilding a fresh scene whenever it differed). */
export function liveSceneModel() {
    return ctx ? ctx.model : null;
}

export function disposeSlicer() {
    if (!ctx) return;
    cancelAnimationFrame(ctx.raf);
    ctx.resizeObserver?.disconnect();
    for (const [el, ev, fn] of ctx.listeners) el.removeEventListener(ev, fn);
    ctx.renderer.dispose();
    ctx.renderer.domElement.remove();
    ctx = null;
}

// ---- geometry helpers ----

function applyCamera(camera, target, orbit) {
    const { theta, phi, radius } = orbit;
    camera.position.set(
        target.x + radius * Math.sin(phi) * Math.sin(theta),
        target.y + radius * Math.cos(phi),
        target.z + radius * Math.sin(phi) * Math.cos(theta)
    );
    camera.lookAt(target);
}

export function parseSTL(buffer) {
    const view = new DataView(buffer);
    const isBinary = buffer.byteLength >= 84 && (84 + view.getUint32(80, true) * 50 === buffer.byteLength);
    const geometry = new THREE.BufferGeometry();
    const positions = [];
    if (isBinary) {
        const triangles = view.getUint32(80, true);
        let offset = 84;
        for (let i = 0; i < triangles; i++) {
            offset += 12;
            for (let v = 0; v < 3; v++) {
                positions.push(view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true));
                offset += 12;
            }
            offset += 2;
        }
    } else {
        const text = new TextDecoder().decode(buffer);
        const re = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
        let m;
        while ((m = re.exec(text)) !== null) positions.push(+m[1], +m[2], +m[3]);
    }
    if (positions.length === 0) throw new Error('STL parse produced no triangles');
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return geometry;
}

// Binary STL with computed facet normals (zero-normal STLs get rejected by the engine).
function geometryToBinarySTL(geom) {
    const pos = geom.attributes.position.array;
    const triCount = Math.floor(pos.length / 9);
    const buf = new ArrayBuffer(84 + triCount * 50);
    const dv = new DataView(buf);
    dv.setUint32(80, triCount, true);
    let o = 84;
    const ax = new THREE.Vector3(), bx = new THREE.Vector3(), cx = new THREE.Vector3(), n = new THREE.Vector3();
    for (let i = 0; i < triCount; i++) {
        const k = i * 9;
        ax.set(pos[k], pos[k + 1], pos[k + 2]);
        bx.set(pos[k + 3], pos[k + 4], pos[k + 5]);
        cx.set(pos[k + 6], pos[k + 7], pos[k + 8]);
        n.crossVectors(bx.clone().sub(ax), cx.clone().sub(ax)).normalize();
        dv.setFloat32(o, n.x, true); dv.setFloat32(o + 4, n.y, true); dv.setFloat32(o + 8, n.z, true); o += 12;
        for (const v of [ax, bx, cx]) { dv.setFloat32(o, v.x, true); dv.setFloat32(o + 4, v.y, true); dv.setFloat32(o + 8, v.z, true); o += 12; }
        o += 2;
    }
    return buf;
}

export { BED };
