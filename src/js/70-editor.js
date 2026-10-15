// ============================================================
//  Viewport interaction: camera, picking, gizmos, Blender-style G / R / S
// ============================================================
const overlay = $('overlay');
const octx = overlay.getContext('2d');
let cssW = 1, cssH = 1;
const AXIS_COLORS = ['#e8625f', '#8bd16a', '#5c9cf0'];
const AXES = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const editor = { tool: 'move', hover: null, drag: null, modal: null, pointers: new Map(), pinch: null };

function project(p) {
  const c = m4.transform(view.VP, p);
  return { x: (c[0] * 0.5 + 0.5) * cssW, y: (0.5 - c[1] * 0.5) * cssH, w: c[3], ok: c[3] > cam.near };
}
function rayAt(cx, cy) {
  const nx = (cx / cssW) * 2 - 1, ny = 1 - (cy / cssH) * 2;
  const a = m4.transform(view.invVP, [nx, ny, 0]);
  const b = m4.transform(view.invVP, [nx, ny, 1]);
  const o = [a[0], a[1], a[2]];
  return { o, d: v3.norm(v3.sub([b[0], b[1], b[2]], o)) };
}
function localXY(e) {
  const r = gpuCanvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}
function worldPerPx(p) {
  const depth = Math.max(v3.dot(v3.sub(p, view.eye), view.fwd), cam.near);
  return depth * 2 * Math.tan(cam.fov / 2) / cssH;
}
function raySphere(ray, c, r) {
  const oc = v3.sub(ray.o, c);
  const b = v3.dot(oc, ray.d), q = v3.dot(oc, oc) - r * r, h = b * b - q;
  if (h < 0) return null;
  const s = Math.sqrt(h);
  return [-b - s, -b + s];
}
function rayPlane(ray, p0, n) {
  const den = v3.dot(ray.d, n);
  if (Math.abs(den) < 1e-6) return null;
  const t = v3.dot(v3.sub(p0, ray.o), n) / den;
  return t > 0 ? v3.add(ray.o, v3.mul(ray.d, t)) : null;
}
// parameter s of the point on line (p0 + s * axis) closest to the ray
function rayLineParam(ray, p0, axis) {
  const w0 = v3.sub(p0, ray.o);
  const a = v3.dot(axis, axis), b = v3.dot(axis, ray.d), c = 1, d = v3.dot(axis, w0), e = v3.dot(ray.d, w0);
  const den = a * c - b * b;
  if (Math.abs(den) < 1e-8) return null;
  return (b * e - c * d) / den;
}
function segDist(px, py, a, b) {
  const vx = b.x - a.x, vy = b.y - a.y;
  const t = clamp(((px - a.x) * vx + (py - a.y) * vy) / (vx * vx + vy * vy || 1), 0, 1);
  return Math.hypot(px - a.x - vx * t, py - a.y - vy * t);
}

// ---------- picking ----------
function rayObstacle(ray, o) {
  const R = obstacleRot(o);
  const ts = raySphere(ray, o.pos, boundRadius(o) + 0.003);
  if (!ts || ts[1] < 0) return Infinity;
  let t = Math.max(ts[0], 0);
  for (let i = 0; i < 160 && t < ts[1]; i++) {
    const d = obstacleSdf(o, v3.add(ray.o, v3.mul(ray.d, t)), R);
    if (d < 0.0004) return t;
    t += Math.max(d * 0.9, 0.0003);
  }
  return Infinity;
}
function blockEdges(b) {
  const h = [b.dims.w / 2, b.dims.h / 2, b.dims.d / 2];
  const c = [];
  for (let i = 0; i < 8; i++) c.push([b.pos[0] + (i & 1 ? h[0] : -h[0]), b.pos[1] + (i & 2 ? h[1] : -h[1]), b.pos[2] + (i & 4 ? h[2] : -h[2])]);
  return [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]].map(([a, b2]) => [c[a], c[b2]]);
}
function pickItem(cx, cy) {
  const ray = rayAt(cx, cy);
  let best = null, bt = Infinity;
  for (const it of scene.items) {
    let t = Infinity;
    if (it.kind === 'obstacle') t = rayObstacle(ray, it);
    else if (it.kind === 'source') {
      const s = raySphere(ray, it.pos, it.mode === 'rain' ? 0.02 : 0.02);
      if (s && s[1] > 0) t = Math.max(s[0], 0);
    } else if (it.kind === 'drain') {
      const s = raySphere(ray, it.pos, it.r + 0.006);
      if (s && s[1] > 0) t = Math.max(s[0], 0);
    }
    if (t < bt) { bt = t; best = it; }
  }
  if (!best && settings.guides) {
    for (const it of scene.items) {
      if (it.kind !== 'block') continue;
      for (const [a, b] of blockEdges(it)) {
        const pa = project(a), pb = project(b);
        if (pa.ok && pb.ok && segDist(cx, cy, pa, pb) < 6) return it;
      }
    }
  }
  return best;
}

// ---------- gizmo handles ----------
function itemRot(it) {
  if (it.kind === 'obstacle') return obstacleRot(it);
  if (it.kind === 'drain') return m3.euler(it.rot[0], it.rot[1], it.rot[2]);
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}
function gizmoHandles(it) {
  const c = it.pos;
  const pc = project(c);
  if (!pc.ok) return [];
  const L = 78 * worldPerPx(c);
  const out = [];
  if (editor.tool === 'move') {
    AXES.forEach((ax, i) => out.push({ type: 'axis', i, axis: ax, a: pc, b: project(v3.add(c, v3.mul(ax, L))) }));
    out.push({ type: 'free', a: pc, r: 9 });
  } else if (editor.tool === 'rotate') {
    if (it.kind === 'source') {
      out.push({ type: 'aim', a: pc, b: project(v3.add(c, v3.mul(sourceDir(it), L))), L });
    } else if (it.kind === 'obstacle' || it.kind === 'drain') {
      AXES.forEach((ax, i) => {
        const [u, w] = basisOf(ax);
        const pts = [];
        for (let k = 0; k <= 48; k++) {
          const a = (k / 48) * Math.PI * 2;
          pts.push(project(v3.add(c, v3.add(v3.mul(u, Math.cos(a) * L * 0.8), v3.mul(w, Math.sin(a) * L * 0.8)))));
        }
        out.push({ type: 'ring', i, axis: ax, pts });
      });
    }
  } else if (editor.tool === 'scale') {
    const R = itemRot(it);
    const map = scaleMap(it);
    if (map) {
      [0, 1, 2].forEach((i) => {
        if (!map[i].length) return;
        const ax = [R[i], R[3 + i], R[6 + i]];
        out.push({ type: 'scale', i, axis: ax, a: pc, b: project(v3.add(c, v3.mul(ax, L))) });
      });
      out.push({ type: 'uscale', a: pc, r: 10 });
    }
  }
  return out;
}
// which dimension keys follow each local axis when scaling
function scaleMap(it) {
  if (it.kind === 'block') return [['w'], ['h'], ['d']];
  if (it.kind === 'drain') return [['r'], [], ['r']];
  if (it.kind !== 'obstacle') return null;
  switch (it.shape) {
    case 'box': case 'container': return [['w'], ['h'], ['d']];
    case 'plate': return [['w'], ['t'], ['d']];
    case 'sphere': return [['r'], ['r'], ['r']];
    case 'cylinder': case 'cone': case 'cup': return [['r'], ['h'], ['r']];
    case 'torus': return [['R'], ['r'], ['R']];
    case 'gutter': return [['len'], ['r'], ['r']];
  }
  return null;
}
function hitHandle(cx, cy) {
  const it = selected();
  if (!it) return null;
  let best = null, bd = 9;
  for (const h of gizmoHandles(it)) {
    let d = Infinity;
    if (h.type === 'axis' || h.type === 'scale') d = Math.min(segDist(cx, cy, h.a, h.b), Math.hypot(cx - h.b.x, cy - h.b.y) - 4);
    else if (h.type === 'free' || h.type === 'uscale') d = Math.hypot(cx - h.a.x, cy - h.a.y) - h.r + 3;
    else if (h.type === 'aim') d = Math.hypot(cx - h.b.x, cy - h.b.y) - 6;
    else if (h.type === 'ring') { for (let k = 0; k < h.pts.length - 1; k++) if (h.pts[k].ok && h.pts[k + 1].ok) d = Math.min(d, segDist(cx, cy, h.pts[k], h.pts[k + 1])); }
    if (d < bd) { bd = d; best = h; }
  }
  return best;
}

// ---------- applying edits ----------
const DIM_MIN = { w: 0.01, h: 0.005, d: 0.01, t: 0.004, r: 0.004, R: 0.01, len: 0.04 };
function setDims(it, base, keys, ratio) {
  const target = it.kind === 'drain' ? it : it.dims;
  const src = it.kind === 'drain' ? base : base.dims;
  for (const k of new Set(keys)) {
    const lim = DIM_LIMITS[k] || [0.004, 2];
    target[k] = clamp(src[k] * ratio, Math.max(lim[0], DIM_MIN[k] || 0.004), lim[1]);
  }
}
function setItemRotation(it, R) {
  if (it.kind === 'obstacle' || it.kind === 'drain') it.rot = m3.toEuler(R).map((x) => Math.round(x * 100) / 100);
}
function clampPos(p) {
  return [clamp(p[0], -3, 3), clamp(p[1], -0.05, 3), clamp(p[2], -3, 3)];
}

function beginGizmoDrag(h, cx, cy) {
  const it = selected();
  const ray = rayAt(cx, cy);
  const d = { kind: 'gizmo', h, item: it, start: cloneScene(it), cx, cy, moved: false };
  if (h.type === 'axis' || h.type === 'scale') d.s0 = rayLineParam(ray, it.pos, h.axis);
  if (h.type === 'free') d.hit0 = rayPlane(ray, it.pos, [0, 1, 0]);
  if (h.type === 'ring') {
    d.R0 = itemRot(it);
    const hp = rayPlane(ray, it.pos, h.axis);
    d.ang0 = hp ? ringAngle(hp, it.pos, h.axis) : null;
    d.scr0 = Math.atan2(cy - project(it.pos).y, cx - project(it.pos).x);
  }
  if (h.type === 'uscale') { const pc = project(it.pos); d.r0 = Math.max(Math.hypot(cx - pc.x, cy - pc.y), 8); }
  editor.drag = d;
}
function ringAngle(p, c, axis) {
  const [u, w] = basisOf(axis);
  const q = v3.sub(p, c);
  return Math.atan2(v3.dot(q, w), v3.dot(q, u));
}
function updateGizmoDrag(cx, cy, shift) {
  const d = editor.drag, it = d.item, h = d.h;
  const ray = rayAt(cx, cy);
  d.moved = d.moved || Math.hypot(cx - d.cx, cy - d.cy) > 2;
  if (h.type === 'axis') {
    const s = rayLineParam(ray, d.start.pos, h.axis);
    if (s !== null && d.s0 !== null) it.pos = clampPos(v3.add(d.start.pos, v3.mul(h.axis, snap(s - d.s0, shift))));
  } else if (h.type === 'free') {
    const hit = rayPlane(ray, d.start.pos, [0, 1, 0]);
    if (hit && d.hit0) {
      const delta = v3.sub(hit, d.hit0);
      it.pos = clampPos([d.start.pos[0] + snap(delta[0], shift), d.start.pos[1], d.start.pos[2] + snap(delta[2], shift)]);
    }
  } else if (h.type === 'ring') {
    const hp = rayPlane(ray, d.start.pos, h.axis);
    let da;
    if (hp && d.ang0 !== null && Math.abs(v3.dot(ray.d, h.axis)) > 0.15) da = ringAngle(hp, d.start.pos, h.axis) - d.ang0;
    else da = -(Math.atan2(cy - project(d.start.pos).y, cx - project(d.start.pos).x) - d.scr0) * Math.sign(v3.dot(h.axis, view.fwd) || 1);
    if (shift) da = Math.round(da / (15 * DEG)) * 15 * DEG;
    setItemRotation(it, m3.mul(m3.axisAngle(h.axis, da), d.R0));
  } else if (h.type === 'aim') {
    const ts = raySphere(ray, d.start.pos, h.L);
    let dir;
    if (ts && ts[0] > 0) dir = v3.norm(v3.sub(v3.add(ray.o, v3.mul(ray.d, ts[0])), d.start.pos));
    else { const hp = rayPlane(ray, d.start.pos, view.fwd.map((x) => -x)); if (hp) dir = v3.norm(v3.sub(hp, d.start.pos)); }
    if (dir) {
      let pitch = Math.asin(clamp(dir[1], -1, 1)) / DEG, yaw = Math.atan2(dir[0], dir[2]) / DEG;
      if (shift) { pitch = Math.round(pitch / 15) * 15; yaw = Math.round(yaw / 15) * 15; }
      it.pitch = Math.round(pitch * 10) / 10; it.yaw = Math.round(((yaw % 360) + 360) % 360 * 10) / 10;
    }
  } else if (h.type === 'scale') {
    const s = rayLineParam(ray, d.start.pos, h.axis);
    if (s !== null && d.s0 && Math.abs(d.s0) > 1e-6) {
      let ratio = Math.max(0.05, s / d.s0);
      if (shift) ratio = Math.round(ratio * 10) / 10 || 0.1;
      setDims(it, d.start, scaleMap(it)[h.i], ratio);
    }
  } else if (h.type === 'uscale') {
    const pc = project(d.start.pos);
    let ratio = Math.max(0.05, Math.hypot(cx - pc.x, cy - pc.y) / d.r0);
    if (shift) ratio = Math.round(ratio * 10) / 10 || 0.1;
    const map = scaleMap(it);
    setDims(it, d.start, [...map[0], ...map[1], ...map[2]], ratio);
  }
  sceneChanged(false);
}
function snap(v, on) { return on ? Math.round(v / 0.01) * 0.01 : v; }

// ---------- modal transforms (G / R / S) ----------
function startModal(type, cx, cy) {
  const it = selected();
  if (!it || editor.drag) return;
  if (type === 'rotate' && !(it.kind === 'obstacle' || it.kind === 'drain' || it.kind === 'source')) return;
  if (type === 'scale' && !scaleMap(it)) return;
  const ray = rayAt(cx, cy);
  const m = { type, item: it, start: cloneScene(it), axis: -1, cx, cy };
  m.plane0 = rayPlane(ray, it.pos, view.fwd);
  const pc = project(it.pos);
  m.ang0 = Math.atan2(cy - pc.y, cx - pc.x);
  m.r0 = Math.max(Math.hypot(cx - pc.x, cy - pc.y), 10);
  m.R0 = itemRot(it);
  editor.modal = m;
  updateHint();
}
function updateModal(cx, cy, shift) {
  const m = editor.modal, it = m.item;
  const ray = rayAt(cx, cy);
  const pc = project(m.start.pos);
  if (m.type === 'move') {
    if (m.axis >= 0) {
      const s0 = rayLineParam(rayAt(m.cx, m.cy), m.start.pos, AXES[m.axis]);
      const s = rayLineParam(ray, m.start.pos, AXES[m.axis]);
      if (s !== null && s0 !== null) it.pos = clampPos(v3.add(m.start.pos, v3.mul(AXES[m.axis], snap(s - s0, shift))));
    } else {
      const hit = rayPlane(ray, m.start.pos, view.fwd);
      if (hit && m.plane0) { const dl = v3.sub(hit, m.plane0); it.pos = clampPos(v3.add(m.start.pos, dl.map((x) => snap(x, shift)))); }
    }
  } else if (m.type === 'rotate') {
    let da = Math.atan2(cy - pc.y, cx - pc.x) - m.ang0;
    if (shift) da = Math.round(da / (15 * DEG)) * 15 * DEG;
    if (it.kind === 'source') {
      const axis = m.axis >= 0 ? AXES[m.axis] : view.fwd.map((x) => -x);
      const R = m3.axisAngle(axis, -da);
      const dir = m3.apply(R, sourceDir(m.start));
      it.pitch = Math.round(Math.asin(clamp(dir[1], -1, 1)) / DEG * 10) / 10;
      it.yaw = Math.round((((Math.atan2(dir[0], dir[2]) / DEG) % 360) + 360) % 360 * 10) / 10;
    } else {
      const axis = m.axis >= 0 ? AXES[m.axis] : view.fwd.map((x) => -x);
      const sgn = m.axis >= 0 ? -Math.sign(v3.dot(axis, view.fwd) || -1) : 1;
      setItemRotation(it, m3.mul(m3.axisAngle(axis, -da * sgn), m.R0));
    }
  } else if (m.type === 'scale') {
    let ratio = Math.max(0.05, Math.hypot(cx - pc.x, cy - pc.y) / m.r0);
    if (shift) ratio = Math.round(ratio * 10) / 10 || 0.1;
    const map = scaleMap(it);
    const keys = m.axis >= 0 ? map[m.axis] : [...map[0], ...map[1], ...map[2]];
    setDims(it, m.start, keys, ratio);
  }
  m.lastX = cx; m.lastY = cy;
  sceneChanged(false);
}
function endModal(commit) {
  const m = editor.modal;
  if (!m) return;
  if (!commit) { Object.assign(m.item, cloneScene(m.start)); sceneChanged(false); }
  else pushUndo();
  editor.modal = null;
  updateHint();
  refreshPanels();
}

// ---------- camera ----------
function orbit(dx, dy) {
  cam.az -= dx * 0.0075;
  cam.el = clamp(cam.el + dy * 0.0075, -0.2, 1.5707);
  limitCamera();
}
function pan(dx, dy) {
  const s = worldPerPx(cam.target);
  cam.target = v3.add(cam.target, v3.add(v3.mul(view.right, -dx * s), v3.mul(view.up, dy * s)));
  cam.target[1] = clamp(cam.target[1], 0, 2);
  limitCamera();
}
function zoom(f) {
  cam.dist = clamp(cam.dist * f, 0.06, 8);
  limitCamera();
}
function limitCamera() {
  const minEl = Math.asin(clamp((0.012 - cam.target[1]) / cam.dist, -1, 1));
  cam.el = clamp(cam.el, Math.max(minEl, -1.4), 1.5707);
}
const VIEW_PRESETS = {
  front: { az: 0, el: 0.08 },
  side: { az: Math.PI / 2, el: 0.08 },
  top: { az: 0, el: 1.5707 },
  home: { az: 0.55, el: 0.42 },
};
let camAnim = null;
function animateCamera(to) {
  camAnim = { from: { target: [...cam.target], dist: cam.dist, az: cam.az, el: cam.el }, to, t: 0 };
}
function frameAll() {
  const r = Math.max(scene.tank.w, scene.tank.d, scene.tank.h) * 0.85 + 0.12;
  // fit the narrower of the two view angles so the tank stays in frame on tall screens too
  const aspect = cssW > 1 && cssH > 1 ? cssW / cssH : 1.6;
  const half = Math.min(cam.fov / 2, Math.atan(Math.tan(cam.fov / 2) * aspect));
  return { target: [0, scene.tank.h * 0.35, 0], dist: (r / Math.tan(half)) * 0.62 };
}
function stepCameraAnim(dt) {
  if (!camAnim) return;
  camAnim.t = Math.min(1, camAnim.t + dt / 0.55);
  const k = camAnim.t < 0.5 ? 4 * camAnim.t ** 3 : 1 - Math.pow(-2 * camAnim.t + 2, 3) / 2;
  const f = camAnim.from, to = camAnim.to;
  if (to.target) cam.target = f.target.map((x, i) => lerp(x, to.target[i], k));
  if (to.dist !== undefined) cam.dist = lerp(f.dist, to.dist, k);
  if (to.az !== undefined) {
    let d = to.az - f.az;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    cam.az = f.az + d * k;
  }
  if (to.el !== undefined) cam.el = lerp(f.el, to.el, k);
  if (camAnim.t >= 1) camAnim = null;
}

// ---------- pointer events on the viewport ----------
gpuCanvas.addEventListener('contextmenu', (e) => e.preventDefault());
gpuCanvas.addEventListener('pointerdown', (e) => {
  gpuCanvas.focus({ preventScroll: true });
  closeMenus();
  const [cx, cy] = localXY(e);
  editor.pointers.set(e.pointerId, { x: cx, y: cy });
  gpuCanvas.setPointerCapture(e.pointerId);
  if (editor.modal) {
    if (e.button === 0) endModal(true); else endModal(false);
    return;
  }
  if (editor.pointers.size === 2) {
    const [a, b] = [...editor.pointers.values()];
    editor.drag = null;
    editor.pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, dist: cam.dist };
    return;
  }
  if (editor.pointers.size > 2) return;
  camAnim = null;
  if (e.button === 1 || e.button === 2 || (e.button === 0 && e.altKey)) {
    editor.drag = { kind: e.shiftKey ? 'pan' : 'orbit', x: cx, y: cy };
    return;
  }
  if (e.button !== 0) return;
  const h = hitHandle(cx, cy);
  if (h) { beginGizmoDrag(h, cx, cy); return; }
  const it = pickItem(cx, cy);
  if (it) {
    if (selectedId !== it.id) select(it.id);
    const ray = rayAt(cx, cy);
    editor.drag = { kind: 'body', item: it, start: cloneScene(it), x: cx, y: cy, hit0: rayPlane(ray, it.pos, [0, 1, 0]), moved: false };
    return;
  }
  editor.drag = { kind: e.shiftKey ? 'pan' : 'orbit', x: cx, y: cy, click: true, moved: false };
});
gpuCanvas.addEventListener('pointermove', (e) => {
  const [cx, cy] = localXY(e);
  const prev = editor.pointers.get(e.pointerId);
  if (prev) editor.pointers.set(e.pointerId, { x: cx, y: cy });
  if (editor.modal) { updateModal(cx, cy, e.shiftKey); return; }
  if (editor.pinch && editor.pointers.size >= 2) {
    const [a, b] = [...editor.pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    cam.dist = clamp(editor.pinch.dist * editor.pinch.d0 / Math.max(d, 1), 0.06, 8);
    orbit(mx - editor.pinch.mx, my - editor.pinch.my);
    editor.pinch.mx = mx; editor.pinch.my = my;
    limitCamera();
    return;
  }
  const d = editor.drag;
  if (!d) {
    if (e.pointerType === 'mouse') {
      const h = hitHandle(cx, cy);
      editor.hover = h;
      gpuCanvas.style.cursor = h ? 'pointer' : pickItem(cx, cy) ? 'move' : 'default';
    }
    return;
  }
  if (d.kind === 'gizmo') { updateGizmoDrag(cx, cy, e.shiftKey); return; }
  const dx = cx - d.x, dy = cy - d.y;
  if (d.kind === 'orbit' || d.kind === 'pan') {
    if (Math.abs(dx) + Math.abs(dy) > 0) d.moved = true;
    if (d.kind === 'orbit') orbit(dx, dy); else pan(dx, dy);
    d.x = cx; d.y = cy;
    return;
  }
  if (d.kind === 'body') {
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    d.moved = true;
    const it = d.item;
    const ray = rayAt(cx, cy);
    if (e.shiftKey) {
      const n = v3.norm([view.fwd[0], 0, view.fwd[2]]);
      const hit = rayPlane(ray, d.start.pos, n);
      if (!d.vhit0) d.vhit0 = hit;
      if (hit && d.vhit0) it.pos = clampPos([d.start.pos[0], d.start.pos[1] + (hit[1] - d.vhit0[1]), d.start.pos[2]]);
    } else {
      d.vhit0 = null;
      const hit = rayPlane(ray, d.start.pos, [0, 1, 0]);
      if (hit && d.hit0) it.pos = clampPos([d.start.pos[0] + hit[0] - d.hit0[0], d.start.pos[1], d.start.pos[2] + hit[2] - d.hit0[2]]);
    }
    sceneChanged(false);
  }
});
function endPointer(e) {
  editor.pointers.delete(e.pointerId);
  if (editor.pinch) { if (editor.pointers.size < 2) editor.pinch = null; return; }
  const d = editor.drag;
  if (!d) return;
  editor.drag = null;
  if (d.kind === 'gizmo' || d.kind === 'body') {
    if (d.moved) { pushUndo(); refreshPanels(); }
  } else if (d.click && !d.moved && e.type === 'pointerup') {
    select(null);
  }
}
gpuCanvas.addEventListener('pointerup', endPointer);
gpuCanvas.addEventListener('pointercancel', endPointer);
gpuCanvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  camAnim = null;
  const k = Math.exp(clamp(e.deltaY, -240, 240) * (e.deltaMode === 1 ? 0.04 : 0.0013));
  zoom(k);
}, { passive: false });

// navigation widget
function navDrag(el, fn) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    camAnim = null;
    let lx = e.clientX, ly = e.clientY, moved = false;
    const sx = e.clientX, sy = e.clientY;
    const move = (ev) => { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 2) moved = true; fn(ev.clientX - lx, ev.clientY - ly); lx = ev.clientX; ly = ev.clientY; };
    const up = (ev) => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      if (!moved && el === $('navball')) navClick(ev);
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  });
}
navDrag($('navball'), (dx, dy) => orbit(dx * 1.2, dy * 1.2));
navDrag($('nav-zoom'), (dx, dy) => zoom(Math.exp(dy * 0.008)));
navDrag($('nav-pan'), (dx, dy) => pan(dx, dy));
function navBallAxes() {
  const el = $('navball');
  const vr = $('view').getBoundingClientRect(), r = el.getBoundingClientRect();
  const cx = r.left - vr.left + r.width / 2, cy = r.top - vr.top + r.height / 2, R = r.width * 0.36;
  return AXES.flatMap((ax, i) => [1, -1].map((s) => {
    const a = v3.mul(ax, s);
    return { i, s, x: cx + v3.dot(a, view.right) * R, y: cy - v3.dot(a, view.up) * R, z: v3.dot(a, view.fwd.map((q) => -q)) };
  }));
}
function navClick(ev) {
  const vr = $('view').getBoundingClientRect();
  const x = ev.clientX - vr.left, y = ev.clientY - vr.top;
  let best = null, bd = 12;
  for (const a of navBallAxes()) { const d = Math.hypot(a.x - x, a.y - y); if (d < bd) { bd = d; best = a; } }
  if (!best) return;
  const dir = v3.mul(AXES[best.i], best.s);
  const el = Math.asin(clamp(dir[1], -1, 1));
  animateCamera({ el: Math.abs(el) > 1.5 ? Math.sign(el) * 1.5707 : el, az: Math.abs(el) > 1.5 ? cam.az : Math.atan2(dir[0], dir[2]) });
}

// ---------- overlay drawing ----------
function drawArrow(a, b, color, width, head) {
  octx.strokeStyle = color; octx.fillStyle = color; octx.lineWidth = width;
  octx.beginPath(); octx.moveTo(a.x, a.y); octx.lineTo(b.x, b.y); octx.stroke();
  if (head) {
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    octx.beginPath();
    octx.moveTo(b.x + Math.cos(ang) * 9, b.y + Math.sin(ang) * 9);
    octx.lineTo(b.x + Math.cos(ang + 2.5) * 8, b.y + Math.sin(ang + 2.5) * 8);
    octx.lineTo(b.x + Math.cos(ang - 2.5) * 8, b.y + Math.sin(ang - 2.5) * 8);
    octx.closePath(); octx.fill();
  }
}
function drawOverlay() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (overlay.width !== Math.round(cssW * dpr) || overlay.height !== Math.round(cssH * dpr)) { overlay.width = Math.round(cssW * dpr); overlay.height = Math.round(cssH * dpr); }
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.clearRect(0, 0, cssW, cssH);
  octx.lineCap = 'round'; octx.lineJoin = 'round';
  if (settings.guides) {
    for (const it of scene.items) {
      const sel = it.id === selectedId;
      if (it.kind === 'block') {
        octx.setLineDash(sel ? [] : [5, 4]);
        octx.strokeStyle = sel ? 'rgba(255,170,60,0.95)' : 'rgba(110,190,240,0.75)';
        octx.lineWidth = sel ? 1.6 : 1.2;
        octx.beginPath();
        for (const [a, b] of blockEdges(it)) { const pa = project(a), pb = project(b); if (pa.ok && pb.ok) { octx.moveTo(pa.x, pa.y); octx.lineTo(pb.x, pb.y); } }
        octx.stroke();
        octx.setLineDash([]);
      } else if (it.kind === 'source') {
        const p = project(it.pos);
        if (!p.ok) continue;
        if (it.mode === 'rain') {
          const s = it.rainSize / 2;
          const cs = [[-s, -s], [s, -s], [s, s], [-s, s]].map(([x, z]) => project([it.pos[0] + x, it.pos[1], it.pos[2] + z]));
          octx.setLineDash([4, 4]);
          octx.strokeStyle = sel ? 'rgba(255,170,60,0.95)' : 'rgba(110,190,240,0.8)';
          octx.lineWidth = 1.3;
          octx.beginPath(); cs.forEach((c, i) => (i ? octx.lineTo(c.x, c.y) : octx.moveTo(c.x, c.y))); octx.closePath(); octx.stroke();
          octx.setLineDash([]);
        }
        const L = 46 * worldPerPx(it.pos);
        const tip = project(v3.add(it.pos, v3.mul(sourceDir(it), L)));
        if (it.mode !== 'rain' && editor.tool !== 'rotate' || !sel) drawArrow(p, tip, it.enabled ? 'rgba(110,190,240,0.9)' : 'rgba(160,170,175,0.7)', 1.6, true);
        octx.fillStyle = it.enabled ? '#6ebef0' : '#8e989d';
        octx.beginPath(); octx.arc(p.x, p.y, 3.2, 0, Math.PI * 2); octx.fill();
      } else if (it.kind === 'drain' && sel) {
        const p = project(it.pos);
        if (p.ok) { octx.strokeStyle = 'rgba(255,170,60,0.9)'; octx.lineWidth = 1.4; octx.beginPath(); octx.arc(p.x, p.y, 6, 0, Math.PI * 2); octx.stroke(); }
      }
    }
  }
  const it = selected();
  if (it && !editor.modal) {
    for (const h of gizmoHandles(it)) {
      const hot = editor.drag && editor.drag.h === h || editor.hover && editor.hover.type === h.type && editor.hover.i === h.i;
      if (h.type === 'axis' || h.type === 'scale') {
        const col = AXIS_COLORS[h.i];
        drawArrow(h.a, h.b, col, hot ? 3.2 : 2.2, h.type === 'axis');
        if (h.type === 'scale') { octx.fillStyle = col; octx.fillRect(h.b.x - 5, h.b.y - 5, 10, 10); }
      } else if (h.type === 'free' || h.type === 'uscale') {
        octx.strokeStyle = 'rgba(255,255,255,0.9)'; octx.lineWidth = hot ? 2.4 : 1.6;
        octx.beginPath();
        if (h.type === 'free') octx.arc(h.a.x, h.a.y, h.r, 0, Math.PI * 2); else octx.rect(h.a.x - h.r, h.a.y - h.r, h.r * 2, h.r * 2);
        octx.stroke();
      } else if (h.type === 'ring') {
        octx.strokeStyle = AXIS_COLORS[h.i]; octx.lineWidth = hot ? 3.2 : 2;
        octx.beginPath();
        let started = false;
        for (const q of h.pts) { if (!q.ok) { started = false; continue; } if (started) octx.lineTo(q.x, q.y); else { octx.moveTo(q.x, q.y); started = true; } }
        octx.stroke();
      } else if (h.type === 'aim') {
        drawArrow(h.a, h.b, '#f2a43a', hot ? 3 : 2.2, false);
        octx.fillStyle = '#f2a43a'; octx.beginPath(); octx.arc(h.b.x, h.b.y, hot ? 8 : 6.5, 0, Math.PI * 2); octx.fill();
      }
    }
  }
  if (editor.modal && editor.modal.axis >= 0) {
    const m = editor.modal;
    const c = m.start.pos, ax = AXES[m.axis], L = 4;
    const a = project(v3.sub(c, v3.mul(ax, L))), b = project(v3.add(c, v3.mul(ax, L)));
    if (a.ok && b.ok) drawArrow(a, b, AXIS_COLORS[m.axis], 1.4, false);
  }
  // navigation ball
  const axes = navBallAxes().sort((p, q) => p.z - q.z);
  const nb = $('navball').getBoundingClientRect(), vr = $('view').getBoundingClientRect();
  const ncx = nb.left - vr.left + nb.width / 2, ncy = nb.top - vr.top + nb.height / 2;
  for (const a of axes) {
    const col = AXIS_COLORS[a.i];
    if (a.s > 0) { octx.strokeStyle = col; octx.lineWidth = 2; octx.beginPath(); octx.moveTo(ncx, ncy); octx.lineTo(a.x, a.y); octx.stroke(); }
    octx.fillStyle = a.s > 0 ? col : 'rgba(30,34,38,0.9)';
    octx.strokeStyle = col; octx.lineWidth = 1.5;
    octx.beginPath(); octx.arc(a.x, a.y, a.s > 0 ? 8 : 6, 0, Math.PI * 2); octx.fill(); if (a.s < 0) octx.stroke();
    if (a.s > 0) { octx.fillStyle = '#16191c'; octx.font = '600 10px "IBM Plex Mono", monospace'; octx.textAlign = 'center'; octx.textBaseline = 'middle'; octx.fillText('XYZ'[a.i], a.x, a.y + 0.5); }
  }
}
