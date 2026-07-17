// public/js/preview3d.js — lightweight orbit/pan 3D viewer for saved prints.
// Renders baked STLs (printer coordinates) plus a live text mesh, with the
// same coordinate convention as the slicer (viewer Y-up, plate at y=0,
// printer front-left origin -> viewer center origin).
import * as THREE from 'three';
import { parseSTL } from './slicer.js';

export function createPreview(container, { bed = { x: 256, y: 256, z: 256 } } = {}) {
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

    const plate = new THREE.Mesh(
        new THREE.PlaneGeometry(bed.x, bed.y),
        new THREE.MeshStandardMaterial({ color: 0x1b2230, roughness: 0.95, side: THREE.DoubleSide, transparent: true, opacity: 0.95 })
    );
    plate.rotation.x = -Math.PI / 2;
    scene.add(plate);
    scene.add(new THREE.GridHelper(Math.max(bed.x, bed.y), Math.max(bed.x, bed.y) / 10, 0x3a4a66, 0x223047));

    const content = new THREE.Group();
    scene.add(content);

    const target = new THREE.Vector3(0, bed.z * 0.1, 0);
    const orbit = { theta: Math.PI * 0.25, phi: Math.PI * 0.32, radius: Math.max(bed.x, bed.y) * 1.4 };
    const applyCam = () => {
        camera.position.set(
            target.x + orbit.radius * Math.sin(orbit.phi) * Math.sin(orbit.theta),
            target.y + orbit.radius * Math.cos(orbit.phi),
            target.z + orbit.radius * Math.sin(orbit.phi) * Math.cos(orbit.theta)
        );
        camera.lookAt(target);
    };
    applyCam();

    const resize = () => {
        const w = container.clientWidth || 600, h = container.clientHeight || 420;
        renderer.setSize(w, h, false);
        camera.aspect = w / h; camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    // ----- controls: left-drag rotate, right/shift-drag pan, wheel zoom -----
    const cv = renderer.domElement;
    let drag = null;
    const onDown = (e) => {
        drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
        e.preventDefault();
    };
    const onMove = (e) => {
        if (!drag) return;
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        drag.x = e.clientX; drag.y = e.clientY;
        if (drag.pan) {
            // pan in the camera's screen plane
            const scale = orbit.radius * 0.0016;
            const right = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 0).multiplyScalar(-dx * scale);
            const up = new THREE.Vector3().setFromMatrixColumn(camera.matrix, 1).multiplyScalar(dy * scale);
            target.add(right).add(up);
        } else {
            orbit.theta -= dx * 0.006;
            orbit.phi = Math.min(Math.PI - 0.05, Math.max(0.05, orbit.phi - dy * 0.006));
        }
        applyCam();
    };
    const onUp = () => { drag = null; };
    const onWheel = (e) => {
        e.preventDefault();
        orbit.radius = Math.min(2500, Math.max(20, orbit.radius * (e.deltaY > 0 ? 1.12 : 0.89)));
        applyCam();
    };
    const onCtx = (e) => e.preventDefault();
    cv.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('contextmenu', onCtx);

    let raf = 0;
    const tick = () => {
        plate.material.opacity = camera.position.y < 8 ? 0.22 : 0.95;
        renderer.render(scene, camera);
        raf = requestAnimationFrame(tick);
    };
    tick();

    // printer coords (front-left origin, Z-up) -> viewer coords
    const printerToViewer = (g) => {
        g.translate(-bed.x / 2, -bed.y / 2, 0);
        g.rotateX(-Math.PI / 2);
        return g;
    };

    const api = {
        /** Add a baked STL (printer coordinates). Returns the mesh. */
        addSTL(arrayBuffer, colorHex = '#e8e8e8') {
            const g = printerToViewer(parseSTL(arrayBuffer));
            g.computeVertexNormals(); // parseSTL leaves normals empty → black mesh
            const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.55, metalness: 0.05 }));
            content.add(mesh);
            return mesh;
        },
        /** Add/replace the live text mesh (geometry already in VIEWER coords). */
        setTextMesh(geometry, colorHex = '#e8e8e8') {
            if (api._textMesh) {
                content.remove(api._textMesh);
                api._textMesh.geometry.dispose();
                api._textMesh.material.dispose();
                api._textMesh = null;
            }
            if (!geometry) return null;
            const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: colorHex, roughness: 0.5, metalness: 0.05 }));
            content.add(mesh);
            api._textMesh = mesh;
            return mesh;
        },
        /** Frame the content in view. */
        fit() {
            const box = new THREE.Box3().setFromObject(content);
            if (box.isEmpty()) return;
            const c = new THREE.Vector3(); box.getCenter(c);
            const s = new THREE.Vector3(); box.getSize(s);
            target.copy(c);
            orbit.radius = Math.min(1200, Math.max(90, Math.max(s.x, s.y, s.z) * 3));
            applyCam();
        },
        dispose() {
            cancelAnimationFrame(raf);
            ro.disconnect();
            cv.removeEventListener('mousedown', onDown);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            cv.removeEventListener('wheel', onWheel);
            cv.removeEventListener('contextmenu', onCtx);
            renderer.dispose();
            renderer.domElement.remove();
        },
        THREE,
    };
    return api;
}

export default { createPreview };
