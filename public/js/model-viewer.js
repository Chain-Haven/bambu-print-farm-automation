// public/js/model-viewer.js — self-contained interactive 3D preview.
//
// Renders STL (binary + ASCII) and OBJ meshes with plain WebGL — no
// three.js, no CDN, works offline. Orbit with drag, zoom with wheel/pinch,
// auto-fit + gentle idle spin until the first interaction. Exposed as
// window.PKXModelViewer = { parseSTL, parseOBJ, createModelViewer }.
(function modelViewerModule() {
  'use strict';

  // ------------------------------------------------------------- mesh parsing

  function parseBinarySTL(buffer) {
    const view = new DataView(buffer);
    if (buffer.byteLength < 84) return null;
    const triangleCount = view.getUint32(80, true);
    if (triangleCount === 0 || buffer.byteLength < 84 + triangleCount * 50) return null;
    const positions = new Float32Array(triangleCount * 9);
    let offset = 84;
    for (let t = 0; t < triangleCount; t += 1) {
      offset += 12; // facet normal (recomputed below for consistency)
      for (let v = 0; v < 9; v += 1) {
        positions[t * 9 + v] = view.getFloat32(offset, true);
        offset += 4;
      }
      offset += 2; // attribute byte count
    }
    return positions;
  }

  function parseAsciiSTL(text) {
    const values = [];
    const pattern = /vertex\s+([-\d.eE+]+)\s+([-\d.eE+]+)\s+([-\d.eE+]+)/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      values.push(Number(match[1]), Number(match[2]), Number(match[3]));
    }
    if (values.length < 9 || (values.length / 3) % 3 !== 0) return null;
    return new Float32Array(values);
  }

  function parseSTL(arrayBuffer) {
    const head = new Uint8Array(arrayBuffer, 0, Math.min(5, arrayBuffer.byteLength));
    const startsWithSolid = String.fromCharCode(...head).toLowerCase() === 'solid';
    if (startsWithSolid) {
      const ascii = parseAsciiSTL(new TextDecoder().decode(arrayBuffer));
      if (ascii) return ascii;
    }
    return parseBinarySTL(arrayBuffer);
  }

  // OBJ: vertices + fan-triangulated faces ("f v", "f v/vt", "f v/vt/vn", negatives).
  function parseOBJ(text) {
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
          triangles.push(refs[0], refs[i], refs[i + 1]);
        }
      }
    }
    if (triangles.length < 3) return null;
    const positions = new Float32Array(triangles.length * 3);
    for (let i = 0; i < triangles.length; i += 1) {
      const vertex = vertices[triangles[i]];
      if (!vertex) return null;
      positions[i * 3] = vertex[0];
      positions[i * 3 + 1] = vertex[1];
      positions[i * 3 + 2] = vertex[2];
    }
    return positions;
  }

  function computeFlatNormals(positions) {
    const normals = new Float32Array(positions.length);
    for (let i = 0; i < positions.length; i += 9) {
      const ax = positions[i], ay = positions[i + 1], az = positions[i + 2];
      const ux = positions[i + 3] - ax, uy = positions[i + 4] - ay, uz = positions[i + 5] - az;
      const vx = positions[i + 6] - ax, vy = positions[i + 7] - ay, vz = positions[i + 8] - az;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const length = Math.hypot(nx, ny, nz) || 1;
      nx /= length; ny /= length; nz /= length;
      for (let v = 0; v < 3; v += 1) {
        normals[i + v * 3] = nx;
        normals[i + v * 3 + 1] = ny;
        normals[i + v * 3 + 2] = nz;
      }
    }
    return normals;
  }

  function meshBounds(positions) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < positions.length; i += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = positions[i + axis];
        if (value < min[axis]) min[axis] = value;
        if (value > max[axis]) max[axis] = value;
      }
    }
    return {
      min,
      max,
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
      center: [(max[0] + min[0]) / 2, (max[1] + min[1]) / 2, (max[2] + min[2]) / 2],
    };
  }

  // ------------------------------------------------------------- tiny mat4

  function mat4Perspective(fovY, aspect, near, far) {
    const f = 1 / Math.tan(fovY / 2);
    const out = new Float32Array(16);
    out[0] = f / aspect; out[5] = f;
    out[10] = (far + near) / (near - far); out[11] = -1;
    out[14] = (2 * far * near) / (near - far);
    return out;
  }

  function mat4LookAt(eye, target, up) {
    const zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
    let zl = Math.hypot(zx, zy, zz) || 1;
    const z = [zx / zl, zy / zl, zz / zl];
    const x = [
      up[1] * z[2] - up[2] * z[1],
      up[2] * z[0] - up[0] * z[2],
      up[0] * z[1] - up[1] * z[0],
    ];
    const xl = Math.hypot(x[0], x[1], x[2]) || 1;
    x[0] /= xl; x[1] /= xl; x[2] /= xl;
    const y = [
      z[1] * x[2] - z[2] * x[1],
      z[2] * x[0] - z[0] * x[2],
      z[0] * x[1] - z[1] * x[0],
    ];
    return new Float32Array([
      x[0], y[0], z[0], 0,
      x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0,
      -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]),
      -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]),
      -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]),
      1,
    ]);
  }

  const VERTEX_SHADER = `
    attribute vec3 aPosition;
    attribute vec3 aNormal;
    uniform mat4 uProjection;
    uniform mat4 uView;
    uniform vec3 uCenter;
    varying vec3 vNormal;
    void main() {
      vNormal = aNormal;
      gl_Position = uProjection * uView * vec4(aPosition - uCenter, 1.0);
    }
  `;

  const FRAGMENT_SHADER = `
    precision mediump float;
    uniform vec3 uColor;
    varying vec3 vNormal;
    void main() {
      vec3 normal = normalize(vNormal);
      float key = max(dot(normal, normalize(vec3(0.5, 0.65, 0.8))), 0.0);
      float fill = max(dot(normal, normalize(vec3(-0.6, -0.2, 0.4))), 0.0);
      float light = 0.28 + key * 0.62 + fill * 0.22;
      gl_FragColor = vec4(uColor * min(light, 1.15), 1.0);
    }
  `;

  function compileProgram(gl) {
    const make = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(`shader: ${gl.getShaderInfoLog(shader)}`);
      }
      return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, make(gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, make(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`program: ${gl.getProgramInfoLog(program)}`);
    }
    return program;
  }

  function hexToRgb(hex) {
    const clean = String(hex || '').replace('#', '');
    const six = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean.slice(0, 6);
    const value = Number.parseInt(six, 16);
    if (!Number.isFinite(value)) return [0.42, 0.75, 0.68];
    return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
  }

  // ------------------------------------------------------------- viewer

  function createModelViewer(canvas) {
    const gl = canvas.getContext('webgl', { antialias: true, alpha: true, preserveDrawingBuffer: false });
    if (!gl) return null;
    const program = compileProgram(gl);
    const attribs = {
      position: gl.getAttribLocation(program, 'aPosition'),
      normal: gl.getAttribLocation(program, 'aNormal'),
    };
    const uniforms = {
      projection: gl.getUniformLocation(program, 'uProjection'),
      view: gl.getUniformLocation(program, 'uView'),
      center: gl.getUniformLocation(program, 'uCenter'),
      color: gl.getUniformLocation(program, 'uColor'),
    };
    const positionBuffer = gl.createBuffer();
    const normalBuffer = gl.createBuffer();

    const state = {
      vertexCount: 0,
      bounds: null,
      theta: Math.PI / 4,   // azimuth
      phi: Math.PI / 3,     // inclination from +Z (model up)
      radius: 100,
      fitRadius: 100,
      color: [0.42, 0.75, 0.68],
      idleSpin: true,
      frame: null,
      lastTime: 0,
    };

    function resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
      const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    }

    function draw(time) {
      state.frame = null;
      if (!state.vertexCount || !state.bounds) return;
      resize();
      if (state.idleSpin) {
        const dt = state.lastTime ? Math.min(time - state.lastTime, 100) : 16;
        state.theta += dt * 0.00035;
        scheduleDraw();
      }
      state.lastTime = time;

      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.enable(gl.DEPTH_TEST);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(program);

      const phi = Math.min(Math.max(state.phi, 0.15), Math.PI - 0.15);
      // Model Z is "up" (print orientation); camera orbits around it.
      const eye = [
        state.radius * Math.sin(phi) * Math.cos(state.theta),
        state.radius * Math.sin(phi) * Math.sin(state.theta),
        state.radius * Math.cos(phi),
      ];
      const aspect = canvas.width / canvas.height;
      const near = Math.max(state.fitRadius / 100, 0.1);
      const projection = mat4Perspective(Math.PI / 5, aspect, near, state.fitRadius * 40);
      const view = mat4LookAt(eye, [0, 0, 0], [0, 0, 1]);

      gl.uniformMatrix4fv(uniforms.projection, false, projection);
      gl.uniformMatrix4fv(uniforms.view, false, view);
      gl.uniform3fv(uniforms.center, state.bounds.center);
      gl.uniform3fv(uniforms.color, state.color);

      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.enableVertexAttribArray(attribs.position);
      gl.vertexAttribPointer(attribs.position, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
      gl.enableVertexAttribArray(attribs.normal);
      gl.vertexAttribPointer(attribs.normal, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, state.vertexCount);
    }

    function scheduleDraw() {
      if (state.frame === null) state.frame = requestAnimationFrame(draw);
    }

    function fitView() {
      if (!state.bounds) return;
      const maxDim = Math.max(...state.bounds.size, 1);
      state.fitRadius = maxDim;
      state.radius = maxDim * 2.1;
      state.theta = Math.PI / 4;
      state.phi = Math.PI / 3;
      scheduleDraw();
    }

    // ----- interaction: drag orbit, wheel zoom, pinch zoom, idle spin stop
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let pinchDistance = 0;

    canvas.addEventListener('pointerdown', (event) => {
      dragging = true;
      state.idleSpin = false;
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      state.theta -= (event.clientX - lastX) * 0.008;
      state.phi -= (event.clientY - lastY) * 0.008;
      lastX = event.clientX;
      lastY = event.clientY;
      scheduleDraw();
    });
    canvas.addEventListener('pointerup', () => { dragging = false; });
    canvas.addEventListener('pointercancel', () => { dragging = false; });
    canvas.addEventListener('wheel', (event) => {
      event.preventDefault();
      state.idleSpin = false;
      state.radius *= Math.exp(event.deltaY * 0.0012);
      state.radius = Math.min(Math.max(state.radius, state.fitRadius * 0.4), state.fitRadius * 12);
      scheduleDraw();
    }, { passive: false });
    canvas.addEventListener('touchstart', (event) => {
      if (event.touches.length === 2) {
        pinchDistance = Math.hypot(
          event.touches[0].clientX - event.touches[1].clientX,
          event.touches[0].clientY - event.touches[1].clientY,
        );
      }
    }, { passive: true });
    canvas.addEventListener('touchmove', (event) => {
      if (event.touches.length === 2 && pinchDistance > 0) {
        event.preventDefault();
        const next = Math.hypot(
          event.touches[0].clientX - event.touches[1].clientX,
          event.touches[0].clientY - event.touches[1].clientY,
        );
        state.radius *= pinchDistance / next;
        state.radius = Math.min(Math.max(state.radius, state.fitRadius * 0.4), state.fitRadius * 12);
        pinchDistance = next;
        state.idleSpin = false;
        scheduleDraw();
      }
    }, { passive: false });
    window.addEventListener('resize', scheduleDraw);

    return {
      loadPositions(positions) {
        const normals = computeFlatNormals(positions);
        gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, normalBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);
        state.vertexCount = positions.length / 3;
        state.bounds = meshBounds(positions);
        state.idleSpin = true;
        state.lastTime = 0;
        fitView();
        return state.bounds;
      },
      setColor(hex) {
        state.color = hexToRgb(hex);
        scheduleDraw();
      },
      resetView() {
        state.idleSpin = true;
        state.lastTime = 0;
        fitView();
      },
      getBounds() {
        return state.bounds;
      },
    };
  }

  window.PKXModelViewer = { parseSTL, parseOBJ, createModelViewer };
})();
