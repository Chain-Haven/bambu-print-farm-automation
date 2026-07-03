// public/js/slicer.js — In-browser model viewer + editor for the 3DFLOW slicer.
//
// Self-contained Three.js viewer (vendored, offline). Features:
//   - STL load (binary + ASCII), rendered on a per-model build plate
//   - orbit / zoom
//   - orientation editing: place-a-picked-face-on-the-bed, rotate 90° about an axis, reset
//   - export the (re-oriented) geometry back to a binary STL so the slice matches the view
//
// Coordinate convention: STL/printer is Z-up; the Three.js viewer is Y-up. We
// rotate -90° about X on load (Z-up -> Y-up) and +90° on export (Y-up -> Z-up),
// so all editing happens in viewer space and the sliced STL is printer-correct.

import * as THREE from 'three';

const BED = {
    P1S: { x: 256, y: 256, z: 256 }, X1: { x: 256, y: 256, z: 256 },
    A1: { x: 256, y: 256, z: 256 }, A1_MINI: { x: 180, y: 180, z: 180 },
    P2S: { x: 256, y: 256, z: 256 }, X2D: { x: 256, y: 256, z: 260 },
    H2D: { x: 325, y: 320, z: 325 }, A2L: { x: 330, y: 320, z: 325 },
};

let ctx = null;

export function initSlicer(container, opts = {}) {
    disposeSlicer();
    const model = opts.model || 'P1S';
    const bed = BED[model] || BED.P1S;
    const onModelChange = opts.onModelChange || (() => {});

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

    // Build plate (XZ plane, +Y up)
    const plateGroup = new THREE.Group();
    const plate = new THREE.Mesh(
        new THREE.PlaneGeometry(bed.x, bed.y),
        new THREE.MeshStandardMaterial({ color: 0x1b2230, roughness: 0.95 })
    );
    plate.rotation.x = -Math.PI / 2;
    plateGroup.add(plate);
    plateGroup.add(new THREE.GridHelper(Math.max(bed.x, bed.y), Math.max(bed.x, bed.y) / 10, 0x3a4a66, 0x223047));
    scene.add(plateGroup);

    const target = new THREE.Vector3(0, bed.z * 0.18, 0);
    const orbit = { theta: Math.PI * 0.25, phi: Math.PI * 0.32, radius: Math.max(bed.x, bed.y, bed.z) * 1.9 };
    applyCamera(camera, target, orbit);

    let modelMesh = null;     // current displayed mesh (geometry baked, mesh at origin)
    let baseGeometry = null;  // pristine viewer-space geometry for reset
    let placeFaceMode = false;

    ctx = {
        container, scene, camera, renderer, bed, model, target, orbit,
        raf: 0, listeners: [], resizeObserver: null,
        get hasModel() { return !!modelMesh; },
    };

    const resize = () => {
        const w = container.clientWidth || 1, h = container.clientHeight || 1;
        renderer.setSize(w, h, false);
        camera.aspect = w / h; camera.updateProjectionMatrix();
    };
    resize();
    ctx.resizeObserver = new ResizeObserver(resize);
    ctx.resizeObserver.observe(container);

    // --- Pointer: orbit on drag, face-pick on click (when in place-face mode) ---
    let dragging = false, moved = 0, lastX = 0, lastY = 0, downX = 0, downY = 0;
    const cv = renderer.domElement;
    const raycaster = new THREE.Raycaster();
    const onDown = (e) => { dragging = true; moved = 0; lastX = downX = e.clientX; lastY = downY = e.clientY; };
    const onMove = (e) => {
        if (!dragging) return;
        moved += Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY);
        orbit.theta -= (e.clientX - lastX) * 0.01;
        orbit.phi = Math.max(0.05, Math.min(Math.PI / 2 - 0.02, orbit.phi - (e.clientY - lastY) * 0.01));
        lastX = e.clientX; lastY = e.clientY;
        applyCamera(camera, target, orbit);
    };
    const onUp = (e) => {
        dragging = false;
        if (moved < 4 && placeFaceMode && modelMesh) tryPickFace(e);
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

    function tryPickFace(e) {
        const rect = cv.getBoundingClientRect();
        const ndc = new THREE.Vector2(
            ((e.clientX - rect.left) / rect.width) * 2 - 1,
            -((e.clientY - rect.top) / rect.height) * 2 + 1
        );
        raycaster.setFromCamera(ndc, camera);
        const hit = raycaster.intersectObject(modelMesh, false)[0];
        if (!hit || !hit.face) return;
        // Rotate the picked face's normal to point straight down (-Y), so it lies on the bed.
        const n = hit.face.normal.clone().normalize();
        const q = new THREE.Quaternion().setFromUnitVectors(n, new THREE.Vector3(0, -1, 0));
        modelMesh.geometry.applyQuaternion(q);
        reseat(modelMesh.geometry);
    }

    const tick = () => { renderer.render(scene, camera); ctx.raf = requestAnimationFrame(tick); };
    tick();

    // Center the geometry on the plate in X/Z and rest it on the bed (min Y = 0).
    function reseat(geometry) {
        geometry.computeVertexNormals();
        geometry.computeBoundingBox();
        const bb = geometry.boundingBox;
        const c = new THREE.Vector3(); bb.getCenter(c);
        geometry.translate(-c.x, -bb.min.y, -c.z);
        geometry.computeBoundingBox();
        const size = new THREE.Vector3(); geometry.boundingBox.getSize(size);
        if (!modelMesh) {
            modelMesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x6ea8ff, roughness: 0.55, metalness: 0.05 }));
            scene.add(modelMesh);
        } else {
            modelMesh.geometry = geometry;
        }
        const meta = {
            dims: { x: +size.x.toFixed(1), y: +size.z.toFixed(1), z: +size.y.toFixed(1) }, // viewer Y-up -> printer Z-up
            triangles: geometry.attributes.position.count / 3,
            fitsBed: size.x <= bed.x && size.z <= bed.y && size.y <= bed.z,
            bed: { x: bed.x, y: bed.y, z: bed.z },
        };
        onModelChange(meta);
        return meta;
    }

    // --- Public API ---
    ctx.loadModel = (arrayBuffer, name) => {
        const ext = (name.split('.').pop() || '').toLowerCase();
        if (ext !== 'stl') throw new Error(`Viewer currently loads STL; "${ext}" support comes with the engine path.`);
        const geometry = parseSTL(arrayBuffer);
        geometry.rotateX(-Math.PI / 2); // STL Z-up -> viewer Y-up
        baseGeometry = geometry.clone();
        return reseat(geometry);
    };
    ctx.setPlaceFaceMode = (on) => { placeFaceMode = !!on; cv.style.cursor = on ? 'crosshair' : ''; };
    ctx.rotate90 = (axis) => {
        if (!modelMesh) return;
        const g = modelMesh.geometry;
        if (axis === 'x') g.rotateX(Math.PI / 2);
        else if (axis === 'y') g.rotateY(Math.PI / 2);
        else g.rotateZ(Math.PI / 2);
        reseat(g);
    };
    ctx.resetOrientation = () => { if (baseGeometry) reseat(baseGeometry.clone()); };
    ctx.exportSTL = () => {
        if (!modelMesh) return null;
        const g = modelMesh.geometry.clone();
        g.rotateX(Math.PI / 2); // viewer Y-up -> STL/printer Z-up
        return geometryToBinarySTL(g);
    };

    return ctx;
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

// ---- helpers ----

function applyCamera(camera, target, orbit) {
    const { theta, phi, radius } = orbit;
    camera.position.set(
        target.x + radius * Math.sin(phi) * Math.sin(theta),
        target.y + radius * Math.cos(phi),
        target.z + radius * Math.sin(phi) * Math.cos(theta)
    );
    camera.lookAt(target);
}

function parseSTL(buffer) {
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

// Write a BufferGeometry to a binary STL with computed facet normals (so the
// slicer's loader is happy — zero-normal STLs can be rejected).
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
