// ============================================================
//  Viewport interaction: camera, picking, gizmos, Blender-style G / R / S
// ============================================================
const overlay = $('overlay');
const octx = overlay.getContext('2d');
let cssW = 1, cssH = 1;
const AXIS_COLORS = ['#ef7471', '#93d673', '#6fa8f2'];
const editor = { tool: 'move', hover: null, drag: null, modal: null, pointers: new Map(), pinch: null, panMode: false, touch: false, readout: null };

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
// pixel tolerances: fingers cover far more than a mouse pointer
function tolPx() { return editor.touch ? 22 : 9; }
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
function rayBox(ray, lo, hi) {
  let t0 = 0, t1 = Infinity;
  for (let i = 0; i < 3; i++) {
    const inv = 1 / (ray.d[i] || 1e-12);
    let a = (lo[i] - ray.o[i]) * inv, b = (hi[i] - ray.o[i]) * inv;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    if (t0 > t1) return Infinity;
  }
  return t0;
}
// parameter s of the point on line (p0 + s * axis) closest to the ray
function rayLineParam(ray, p0, axis) {
  const w0 = v3.sub(p0, ray.o);
  const a = v3.dot(axis, axis), b = v3.dot(axis, ray.d), c = 1, d = v3.dot(axis, w0), e = v3.dot(ray.d, w0);
  const den = a * c - b * b;
  if (Math.abs(den) < 1e-8) return null;
  return (b * e - c * d) / den;
}
// closest approach between the ray and the segment a-b: { dist, t (along the ray) }
function raySegment(ray, a, b) {
  const u = v3.sub(b, a), len = v3.len(u);
  if (len < 1e-9) { const t = Math.max(v3.dot(v3.sub(a, ray.o), ray.d), 0); return { dist: v3.len(v3.sub(v3.add(ray.o, v3.mul(ray.d, t)), a)), t }; }
  const ax = v3.mul(u, 1 / len);
  let s = rayLineParam(ray, a, ax);
  s = clamp(s === null ? 0 : s, 0, len);
  const p = v3.add(a, v3.mul(ax, s));
  const t = Math.max(v3.dot(v3.sub(p, ray.o), ray.d), 0);
  return { dist: v3.len(v3.sub(v3.add(ray.o, v3.mul(ray.d, t)), p)), t };
}
function segDist(px, py, a, b) {
  const vx = b.x - a.x, vy = b.y - a.y;
  const t = clamp(((px - a.x) * vx + (py - a.y) * vy) / (vx * vx + vy * vy || 1), 0, 1);
  return Math.hypot(px - a.x - vx * t, py - a.y - vy * t);
}

// ---------- picking ----------
// Every candidate gets a screen distance in pixels (0 = the pointer is on it) and a depth. Direct hits win by depth;
// near misses within the touch/mouse tolerance count when nothing is hit directly.
function rayObstacle(ray, o) {
  const R = obstacleRot(o);
  const ts = raySphere(ray, o.pos, boundRadius(o) + 0.01);
  if (!ts || ts[1] < 0) return null;
  let t = Math.max(ts[0], 0), bestPx = Infinity, bestT = t;
  for (let i = 0; i < 200 && t < ts[1]; i++) {
    const p = v3.add(ray.o, v3.mul(ray.d, t));
    const d = obstacleSdf(o, p, R);
    if (d < 0.0004) return { px: 0, t };
    const px = d / worldPerPx(p);
    if (px < bestPx) { bestPx = px; bestT = t; }
    t += Math.max(d * 0.9, 0.0003);
  }
  return { px: bestPx, t: bestT };
}
function sourceBody(it) {
  const dir = sourceDir(it);
  return { a: it.pos, b: v3.sub(it.pos, v3.mul(dir, 0.05)), r: sourceOutlet(it) / 2 + 0.006 };
}
function blockBounds(b) {
  const h = [b.dims.w / 2, b.dims.h / 2, b.dims.d / 2];
  return [b.pos.map((x, i) => x - h[i]), b.pos.map((x, i) => x + h[i])];
}
function boxEdges(lo, hi) {
  const c = [];
  for (let i = 0; i < 8; i++) c.push([i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]]);
  return [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]].map(([a, b2]) => [c[a], c[b2]]);
}
function blockEdges(b) { const [lo, hi] = blockBounds(b); return boxEdges(lo, hi); }
function tankEdges() { const t = scene.tank; return boxEdges([-t.w / 2, 0, -t.d / 2], [t.w / 2, t.h, t.d / 2]); }
function edgesPx(cx, cy, edges) {
  let best = Infinity;
  for (const [a, b] of edges) { const pa = project(a), pb = project(b); if (pa.ok && pb.ok) best = Math.min(best, segDist(cx, cy, pa, pb)); }
  return best;
}
// { it, exact }: exact when the pointer is on the item itself, otherwise within the tolerance of it. Water blocks and
// the tank are regions the view looks through, so they are picked by their frames only.
function pickAt(cx, cy) {
  const ray = rayAt(cx, cy);
  const tol = tolPx();
  let hit = null, near = null;
  const consider = (it, px, t) => {
    if (px <= 0) { if (!hit || t < hit.t) hit = { it, t }; }
    else if (px < tol && (!near || px < near.px)) near = { it, px };
  };
  for (const it of scene.items) {
    if (it.kind === 'obstacle') {
      const r = rayObstacle(ray, it);
      if (r) consider(it, r.px, r.t);
    } else if (it.kind === 'source') {
      if (it.mode === 'rain') {
        const s = it.rainSize / 2;
        const cs = [[-s, -s], [s, -s], [s, s], [-s, s]].map(([x, z]) => [it.pos[0] + x, it.pos[1], it.pos[2] + z]);
        const px = Math.min(edgesPx(cx, cy, cs.map((c, i) => [c, cs[(i + 1) % 4]])), Math.hypot(cx - project(it.pos).x, cy - project(it.pos).y));
        consider(it, px > 4 ? px : 0, v3.len(v3.sub(it.pos, ray.o)));
      } else {
        const b = sourceBody(it);
        const r = raySegment(ray, b.a, b.b);
        const p = v3.add(ray.o, v3.mul(ray.d, r.t));
        consider(it, Math.max(0, (r.dist - b.r) / worldPerPx(p)), r.t);
      }
    } else if (it.kind === 'drain') {
      const R = m3.euler(it.rot[0], it.rot[1], it.rot[2]);
      const n = [R[1], R[4], R[7]];
      const p = rayPlane(ray, it.pos, n);
      if (p) {
        const d = v3.len(v3.sub(p, it.pos)) - it.r - 0.004;
        consider(it, Math.max(0, d / worldPerPx(p)), v3.len(v3.sub(p, ray.o)));
      }
    }
  }
  if (hit) return { it: hit.it, exact: true };
  if (near) return { it: near.it, exact: false };
  let frame = null, fd = tol;
  if (settings.guides) {
    for (const it of scene.items) {
      if (it.kind !== 'block') continue;
      const d = edgesPx(cx, cy, blockEdges(it));
      if (d < fd) { fd = d; frame = it; }
    }
  }
  if (frame) return { it: frame, exact: false };
  if (edgesPx(cx, cy, tankEdges()) < tol) return { it: 'tank', exact: false };
  return { it: null, exact: false };
}
function pickItem(cx, cy) { return pickAt(cx, cy).it; }

// ---------- what each tool can do with each item ----------
function canRotate(it) {
  if (!it || it === 'tank') return false;
  if (it.kind === 'obstacle') return it.shape !== 'sphere';
  return it.kind === 'drain' || it.kind === 'source';
}
function canScale(it) { return !!(it && it !== 'tank' && scaleMap(it)); }
function toolNote(tool, it) {
  if (!it) return null;
  if (tool === 'rotate' && !canRotate(it)) return it.kind === 'block' ? '水の塊は回転できません' : it.kind === 'obstacle' ? '球は回しても形が変わりません' : null;
  if (tool === 'scale' && !canScale(it)) return it.kind === 'source' ? '水源の太さは「流量」と「勢い」で決まります' : null;
  return null;
}
// rotation axes that change the shape (round shapes ignore their own axis)
function rotationAxes(it) {
  if (it.kind === 'drain') return [0, 2];
  if (it.kind !== 'obstacle') return [];
  switch (it.shape) {
    case 'sphere': return [];
    case 'cylinder': case 'cone': case 'cup': case 'torus': return [0, 2];
  }
  return [0, 1, 2];
}

// ---------- gizmo handles ----------
function itemRot(it) {
  if (it.kind === 'obstacle') return obstacleRot(it);
  if (it.kind === 'drain') return m3.euler(it.rot[0], it.rot[1], it.rot[2]);
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}
// screen area where a handle can be grabbed: inside the view and clear of the navigation buttons
function handleSpace() {
  const vr = $('view').getBoundingClientRect(), nr = document.querySelector('.navpad').getBoundingClientRect();
  return { w: cssW, h: cssH, nav: { l: nr.left - vr.left - 8, r: nr.right - vr.left + 8, t: nr.top - vr.top - 8, b: nr.bottom - vr.top + 8 } };
}
function grabbable(p, sp) {
  if (!p.ok || p.x < 12 || p.y < 12 || p.x > sp.w - 12 || p.y > sp.h - 12) return false;
  return !(p.x > sp.nav.l && p.x < sp.nav.r && p.y > sp.nav.t && p.y < sp.nav.b);
}
// an arrow whose end would be hidden (off the view or under the navigation buttons) is drawn the other way round
function arrowEnd(c, ax, L, sp) {
  const b = project(v3.add(c, v3.mul(ax, L)));
  if (grabbable(b, sp)) return { axis: ax, b };
  const nax = v3.mul(ax, -1), nb = project(v3.add(c, v3.mul(nax, L)));
  return grabbable(nb, sp) ? { axis: nax, b: nb } : { axis: ax, b };
}
function gizmoHandles(it) {
  const c = it.pos;
  const pc = project(c);
  if (!pc.ok) return [];
  const L = (editor.touch ? 96 : 80) * worldPerPx(c);
  const knob = editor.touch ? 11 : 7;
  const sp = handleSpace();
  const out = [];
  if (editor.tool === 'move') {
    [0, 1, 2].forEach((i) => { const e = arrowEnd(c, uiAxisDir(i), L, sp); out.push({ type: 'axis', i, ci: i, axis: e.axis, a: pc, b: e.b, knob }); });
    if (it.kind !== 'block') out.push({ type: 'free', a: pc, r: editor.touch ? 14 : 9 });
  } else if (editor.tool === 'rotate' && canRotate(it)) {
    if (it.kind === 'source') {
      out.push({ type: 'aim', a: pc, b: project(v3.add(c, v3.mul(sourceDir(it), L))), L, knob: knob + 1 });
    } else {
      const R = itemRot(it);
      for (const i of rotationAxes(it)) {
        const ax = [R[i], R[3 + i], R[6 + i]];
        const [u, w] = basisOf(ax);
        const pts = [];
        for (let k = 0; k <= 64; k++) {
          const a = (k / 64) * Math.PI * 2;
          pts.push(project(v3.add(c, v3.add(v3.mul(u, Math.cos(a) * L * 0.8), v3.mul(w, Math.sin(a) * L * 0.8)))));
        }
        out.push({ type: 'ring', i, ci: UI_OF_LOCAL[i], axis: ax, pts });
      }
    }
  } else if (editor.tool === 'scale' && canScale(it)) {
    const R = itemRot(it);
    const map = scaleMap(it);
    [0, 1, 2].forEach((i) => {
      if (!map[i].length) return;
      const e = arrowEnd(c, [R[i], R[3 + i], R[6 + i]], L, sp);
      out.push({ type: 'scale', i, ci: UI_OF_LOCAL[i], axis: e.axis, a: pc, b: e.b, knob });
    });
    out.push({ type: 'uscale', a: pc, r: editor.touch ? 14 : 10 });
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
// the handle under the pointer; `firm` when the pointer is on a knob, a ring or the centre (rather than on the
// shaft of an arrow, which gives way to the item's own body)
function hitHandle(cx, cy) {
  const it = selected();
  if (!it) return null;
  const tol = tolPx();
  let best = null, bd = tol, firm = false;
  for (const h of gizmoHandles(it)) {
    let d = Infinity, f = true;
    if (h.type === 'axis' || h.type === 'scale') {
      const dk = Math.hypot(cx - h.b.x, cy - h.b.y) - h.knob;
      // the inner part of an arrow belongs to the centre handle
      const ds = segDist(cx, cy, { x: lerp(h.a.x, h.b.x, 0.35), y: lerp(h.a.y, h.b.y, 0.35) }, h.b);
      d = Math.min(dk, ds);
      f = dk <= 3;
    } else if (h.type === 'free' || h.type === 'uscale') d = Math.hypot(cx - h.a.x, cy - h.a.y) - h.r;
    else if (h.type === 'aim') d = Math.min(Math.hypot(cx - h.b.x, cy - h.b.y) - h.knob, segDist(cx, cy, h.a, h.b) + 2);
    else if (h.type === 'ring') { for (let k = 0; k < h.pts.length - 1; k++) if (h.pts[k].ok && h.pts[k + 1].ok) d = Math.min(d, segDist(cx, cy, h.pts[k], h.pts[k + 1])); }
    if (d < bd) { bd = d; best = h; firm = f; }
  }
  return best ? { h: best, firm } : null;
}

// ---------- applying edits ----------
const DIM_MIN = { w: 0.01, h: 0.005, d: 0.01, t: 0.004, r: 0.004, R: 0.01, len: 0.04 };
function setDims(it, base, keys, ratio) {
  const target = it.kind === 'drain' ? it : it.dims;
  const src = it.kind === 'drain' ? base : base.dims;
  for (const k of new Set(keys)) {
    const lim = it.kind === 'drain' ? DRAIN_LIMITS : DIM_LIMITS[k] || [0.004, 2];
    target[k] = clamp(src[k] * ratio, Math.max(lim[0], DIM_MIN[k] || 0.004), lim[1]);
  }
}
function setItemRotation(it, R) {
  if (it.kind === 'obstacle' || it.kind === 'drain') it.rot = m3.toEuler(R).map((x) => Math.round(x * 100) / 100);
}
function setPos(it, p) { it.pos = clampItemPos(it, p); }

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
    if (s !== null && d.s0 !== null) setPos(it, v3.add(d.start.pos, v3.mul(h.axis, snap(s - d.s0, shift))));
  } else if (h.type === 'free') {
    const hit = rayPlane(ray, d.start.pos, [0, 1, 0]);
    if (hit && d.hit0) {
      const delta = v3.sub(hit, d.hit0);
      setPos(it, [d.start.pos[0] + snap(delta[0], shift), d.start.pos[1], d.start.pos[2] + snap(delta[2], shift)]);
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
    if (dir) setAim(it, dir, shift);
  } else if (h.type === 'scale') {
    const s = rayLineParam(ray, d.start.pos, h.axis);
    if (s !== null && d.s0 && Math.abs(d.s0) > 1e-6) {
      let ratio = Math.max(0.05, s / d.s0);
      if (shift) ratio = Math.round(ratio * 10) / 10 || 0.1;
      setDims(it, d.start, scaleMap(it)[h.i], ratio);
      afterScale(it, d.start, ratio, cx, cy);
    }
  } else if (h.type === 'uscale') {
    const ratio = dragRatio(d.start.pos, d.r0, cx, cy, shift);
    const map = scaleMap(it);
    setDims(it, d.start, [...map[0], ...map[1], ...map[2]], ratio);
    afterScale(it, d.start, ratio, cx, cy);
  }
  sceneChanged(false);
}
// uniform scaling by dragging: 120 px away from the centre doubles the size, 120 px towards it halves it
function dragRatio(c, r0, cx, cy, shift) {
  const pc = project(c);
  let ratio = Math.pow(2, (Math.hypot(cx - pc.x, cy - pc.y) - r0) / 120);
  if (shift) ratio = Math.round(ratio * 10) / 10 || 0.1;
  return clamp(ratio, 0.05, 20);
}
// items standing on the floor keep standing on it while they grow or shrink, and the factor is shown at the pointer
function afterScale(it, start, ratio, cx, cy) {
  if (it.kind === 'obstacle') {
    const b0 = obstacleBottom(start);
    if (Math.abs(b0) < 0.004) it.pos[1] += b0 - obstacleBottom(it);
  } else if (it.kind === 'block' && Math.abs(start.pos[1] - start.dims.h / 2) < 0.004) it.pos[1] = it.dims.h / 2 + 0.001;
  editor.readout = { x: cx, y: cy, text: `×${ratio.toFixed(2)}` };
}
// the item's own axis that lies closest to an editor axis (used when S is locked to X, Y or Z)
function localOfUI(it, ui) {
  const R = itemRot(it), w = uiAxisDir(ui);
  let best = 0, bd = -1;
  for (let k = 0; k < 3; k++) { const d = Math.abs(R[k] * w[0] + R[3 + k] * w[1] + R[6 + k] * w[2]); if (d > bd) { bd = d; best = k; } }
  return best;
}
function setAim(it, dir, shift) {
  let pitch = Math.asin(clamp(dir[1], -1, 1)) / DEG, yaw = Math.atan2(dir[0], dir[2]) / DEG;
  if (shift) { pitch = Math.round(pitch / 15) * 15; yaw = Math.round(yaw / 15) * 15; }
  it.pitch = Math.round(pitch * 10) / 10;
  it.yaw = Math.round(((yaw % 360) + 360) % 360 * 10) / 10;
}
function snap(v, on) { return on ? Math.round(v / 0.01) * 0.01 : v; }

// dragging the selected item itself does what the active tool does
function beginBodyDrag(it, cx, cy) {
  const ray = rayAt(cx, cy);
  const pc = project(it.pos);
  editor.drag = {
    kind: 'body', item: it, start: cloneScene(it), x: cx, y: cy, moved: false,
    hit0: rayPlane(ray, it.pos, [0, 1, 0]), ang0: Math.atan2(cy - pc.y, cx - pc.x), r0: Math.max(Math.hypot(cx - pc.x, cy - pc.y), 12), R0: itemRot(it),
  };
}
function updateBodyDrag(cx, cy, shift) {
  const d = editor.drag, it = d.item;
  const ray = rayAt(cx, cy);
  const pc = project(d.start.pos);
  if (editor.tool === 'move') {
    if (shift) {
      const n = v3.norm([view.fwd[0], 0, view.fwd[2]]);
      const hit = rayPlane(ray, d.start.pos, n);
      if (!d.vhit0) d.vhit0 = hit;
      if (hit && d.vhit0) setPos(it, [d.start.pos[0], d.start.pos[1] + (hit[1] - d.vhit0[1]), d.start.pos[2]]);
    } else {
      d.vhit0 = null;
      const hit = rayPlane(ray, d.start.pos, [0, 1, 0]);
      if (hit && d.hit0) setPos(it, [d.start.pos[0] + hit[0] - d.hit0[0], d.start.pos[1], d.start.pos[2] + hit[2] - d.hit0[2]]);
    }
  } else if (editor.tool === 'rotate') {
    // turn about the vertical axis, following the pointer around the item's centre
    let da = -(Math.atan2(cy - pc.y, cx - pc.x) - d.ang0) * Math.sign(-view.fwd[1] || 1);
    if (shift) da = Math.round(da / (15 * DEG)) * 15 * DEG;
    const Ry = m3.axisAngle([0, 1, 0], da);
    if (it.kind === 'source') setAim(it, m3.apply(Ry, sourceDir(d.start)), false);
    else setItemRotation(it, m3.mul(Ry, d.R0));
  } else if (editor.tool === 'scale') {
    const ratio = dragRatio(d.start.pos, d.r0, cx, cy, shift);
    const map = scaleMap(it);
    setDims(it, d.start, [...map[0], ...map[1], ...map[2]], ratio);
    afterScale(it, d.start, ratio, cx, cy);
  }
  sceneChanged(false);
}
function bodyDragAllowed(it) {
  if (!it || it === 'tank' || it.kind === 'block') return false;
  if (editor.tool === 'rotate') return canRotate(it);
  if (editor.tool === 'scale') return canScale(it);
  return true;
}

// ---------- modal transforms (G / R / S) ----------
function startModal(type, cx, cy) {
  const it = selected();
  if (!it || editor.drag) return;
  if (type === 'rotate' && !canRotate(it)) { toast(toolNote('rotate', it) || 'この項目は回転できません', 2000); return; }
  if (type === 'scale' && !canScale(it)) { toast(toolNote('scale', it) || 'この項目は大きさを変えられません', 2000); return; }
  const ray = rayAt(cx, cy);
  const m = { type, item: it, start: cloneScene(it), axis: -1, cx, cy };
  m.plane0 = rayPlane(ray, it.pos, [0, 1, 0]);
  const pc = project(it.pos);
  m.ang0 = Math.atan2(cy - pc.y, cx - pc.x);
  m.r0 = Math.max(Math.hypot(cx - pc.x, cy - pc.y), 50);
  m.R0 = itemRot(it);
  editor.modal = m;
  updateHint();
}
function updateModal(cx, cy, shift) {
  const m = editor.modal, it = m.item;
  const ray = rayAt(cx, cy);
  const pc = project(m.start.pos);
  if (m.typed) return;
  if (m.type === 'move') {
    if (m.axis >= 0) {
      const ax = uiAxisDir(m.axis);
      const s0 = rayLineParam(rayAt(m.cx, m.cy), m.start.pos, ax);
      const s = rayLineParam(ray, m.start.pos, ax);
      if (s !== null && s0 !== null) setPos(it, v3.add(m.start.pos, v3.mul(ax, snap(s - s0, shift))));
    } else {
      // without an axis the item slides over the floor plane through it (Z moves it up and down)
      const hit = rayPlane(ray, m.start.pos, [0, 1, 0]);
      if (hit && m.plane0) setPos(it, [m.start.pos[0] + snap(hit[0] - m.plane0[0], shift), m.start.pos[1], m.start.pos[2] + snap(hit[2] - m.plane0[2], shift)]);
    }
  } else if (m.type === 'rotate') {
    let da = Math.atan2(cy - pc.y, cx - pc.x) - m.ang0;
    if (shift) da = Math.round(da / (15 * DEG)) * 15 * DEG;
    const axis = m.axis >= 0 ? uiAxisDir(m.axis) : view.fwd.map((x) => -x);
    if (it.kind === 'source') {
      setAim(it, m3.apply(m3.axisAngle(axis, -da), sourceDir(m.start)), false);
    } else {
      const sgn = m.axis >= 0 ? -Math.sign(v3.dot(axis, view.fwd) || -1) : 1;
      setItemRotation(it, m3.mul(m3.axisAngle(axis, -da * sgn), m.R0));
    }
  } else if (m.type === 'scale') {
    let ratio = clamp(Math.hypot(cx - pc.x, cy - pc.y) / m.r0, 0.05, 20);
    if (shift) ratio = Math.round(ratio * 10) / 10 || 0.1;
    const map = scaleMap(it);
    const keys = m.axis >= 0 ? map[localOfUI(it, m.axis)] : [...map[0], ...map[1], ...map[2]];
    setDims(it, m.start, keys, ratio);
    afterScale(it, m.start, ratio, cx, cy);
  }
  m.lastX = cx; m.lastY = cy;
  sceneChanged(false);
}
function endModal(commit) {
  const m = editor.modal;
  if (!m) return;
  editor.readout = null;
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
// the tank and everything in the scene (sources usually hang above the rim)
function frameAll() {
  const t = scene.tank;
  const lo = [-t.w / 2, 0, -t.d / 2], hi = [t.w / 2, t.h, t.d / 2];
  for (const it of scene.items) {
    const r = it.kind === 'obstacle' ? boundRadius(it) : it.kind === 'source' ? 0.05 : it.kind === 'block' ? 0 : it.r;
    const top = it.kind === 'source' ? it.pos[1] + 0.05 : it.pos[1] + r;
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], it.pos[k] - r); hi[k] = Math.max(hi[k], k === 1 ? top : it.pos[k] + r); }
  }
  const size = Math.max(hi[0] - lo[0], hi[2] - lo[2], hi[1] - lo[1]);
  const r = size * 0.85 + 0.12;
  // fit the narrower of the two view angles so everything stays in frame on tall screens too
  const aspect = cssW > 1 && cssH > 1 ? cssW / cssH : 1.6;
  const half = Math.min(cam.fov / 2, Math.atan(Math.tan(cam.fov / 2) * aspect));
  return { target: [(lo[0] + hi[0]) / 2, lo[1] + (hi[1] - lo[1]) * 0.4, (lo[2] + hi[2]) / 2], dist: (r / Math.tan(half)) * 0.62 };
}
function viewHome() { animateCamera({ ...frameAll(), ...VIEW_PRESETS.home }); }
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
// Press on empty space or on an item that is not selected: dragging moves the camera, a click selects.
// Press on the selected item: dragging applies the active tool to it.
gpuCanvas.addEventListener('contextmenu', (e) => e.preventDefault());
gpuCanvas.addEventListener('pointerdown', (e) => {
  gpuCanvas.focus({ preventScroll: true });
  closeMenus();
  editor.touch = e.pointerType !== 'mouse';
  const [cx, cy] = localXY(e);
  editor.pointers.set(e.pointerId, { x: cx, y: cy });
  gpuCanvas.setPointerCapture(e.pointerId);
  if (editor.modal) {
    if (e.button === 0) endModal(true); else endModal(false);
    return;
  }
  if (editor.pointers.size === 2) {
    const [a, b] = [...editor.pointers.values()];
    const d = editor.drag;
    if (d && (d.kind === 'gizmo' || d.kind === 'body') && d.moved) { Object.assign(d.item, cloneScene(d.start)); sceneChanged(false); }
    editor.drag = null;
    editor.pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, dist: cam.dist };
    return;
  }
  if (editor.pointers.size > 2) return;
  camAnim = null;
  if (e.button === 1 || e.button === 2 || (e.button === 0 && e.altKey)) {
    editor.drag = { kind: e.shiftKey || e.button === 1 && e.ctrlKey ? 'pan' : 'orbit', x: cx, y: cy };
    return;
  }
  if (e.button !== 0) return;
  // knobs, rings and the centre first; then the selected item's own body; then the shafts of the arrows
  const h = hitHandle(cx, cy);
  const pk = pickAt(cx, cy);
  const sel = selected();
  const onBody = pk.it && pk.it === sel && bodyDragAllowed(sel);
  if (h && h.firm) { beginGizmoDrag(h.h, cx, cy); return; }
  if (onBody && pk.exact) { beginBodyDrag(sel, cx, cy); return; }
  if (h) { beginGizmoDrag(h.h, cx, cy); return; }
  if (onBody) { beginBodyDrag(sel, cx, cy); return; }
  editor.drag = { kind: e.shiftKey || editor.panMode ? 'pan' : 'orbit', x: cx, y: cy, sx: cx, sy: cy, click: true, moved: false, pick: pk.it };
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
    pan(mx - editor.pinch.mx, my - editor.pinch.my);
    editor.pinch.mx = mx; editor.pinch.my = my;
    limitCamera();
    return;
  }
  const d = editor.drag;
  if (!d) {
    if (e.pointerType === 'mouse') {
      editor.touch = false;
      const hh = hitHandle(cx, cy);
      const pk = pickAt(cx, cy);
      const sel = selected();
      const onBody = pk.it && pk.it === sel && bodyDragAllowed(sel);
      const h = hh && (hh.firm || !(onBody && pk.exact)) ? hh.h : null;
      editor.hover = h;
      gpuCanvas.style.cursor = h ? 'pointer' : onBody ? 'move' : pk.it ? 'pointer' : 'default';
    }
    return;
  }
  if (d.kind === 'gizmo') { updateGizmoDrag(cx, cy, e.shiftKey); return; }
  if (d.kind === 'orbit' || d.kind === 'pan') {
    if (d.click && !d.moved && Math.hypot(cx - d.sx, cy - d.sy) < (editor.touch ? 8 : 3)) return;
    d.moved = true;
    const dx = cx - d.x, dy = cy - d.y;
    if (d.kind === 'orbit') orbit(dx, dy); else pan(dx, dy);
    d.x = cx; d.y = cy;
    return;
  }
  if (d.kind === 'body') {
    if (!d.moved && Math.hypot(cx - d.x, cy - d.y) < (editor.touch ? 8 : 4)) return;
    d.moved = true;
    updateBodyDrag(cx, cy, e.shiftKey);
  }
});
function endPointer(e) {
  editor.pointers.delete(e.pointerId);
  if (editor.pinch) { if (editor.pointers.size === 0) editor.pinch = null; return; }
  const d = editor.drag;
  if (!d) return;
  editor.drag = null;
  editor.readout = null;
  if (d.kind === 'gizmo' || d.kind === 'body') {
    if (d.moved) { pushUndo(); refreshPanels(); }
  } else if (d.click && !d.moved && e.type === 'pointerup') {
    const id = d.pick === 'tank' ? 'tank' : d.pick ? d.pick.id : null;
    if (id !== selectedId) select(id, { reveal: true });
  }
}
gpuCanvas.addEventListener('pointerup', endPointer);
gpuCanvas.addEventListener('pointercancel', endPointer);
gpuCanvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  camAnim = null;
  // trackpads send pinch as ctrl+wheel; two-finger scrolling pans when it is mostly sideways
  if (!e.ctrlKey && e.deltaMode === 0 && Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.2) { pan(-e.deltaX, 0); return; }
  const k = Math.exp(clamp(e.deltaY, -240, 240) * (e.deltaMode === 1 ? 0.04 : e.ctrlKey ? 0.01 : 0.0013));
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
    const move = (ev) => { if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 3) moved = true; if (moved) fn(ev.clientX - lx, ev.clientY - ly); lx = ev.clientX; ly = ev.clientY; };
    const up = (ev) => {
      el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up);
      if (!moved && ev.type === 'pointerup') navClick(ev);
    };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  });
}
navDrag($('navball'), (dx, dy) => orbit(dx * 1.2, dy * 1.2));
$('nav-in').addEventListener('click', () => { camAnim = null; animateCamera({ dist: clamp(cam.dist / 1.35, 0.06, 8) }); });
$('nav-out').addEventListener('click', () => { camAnim = null; animateCamera({ dist: clamp(cam.dist * 1.35, 0.06, 8) }); });
$('nav-home').addEventListener('click', viewHome);
function setPanMode(on) {
  editor.panMode = on;
  $('nav-pan').setAttribute('aria-pressed', String(on));
  updateHint();
}
$('nav-pan').addEventListener('click', () => setPanMode(!editor.panMode));
function navBallAxes() {
  const el = $('navball');
  const vr = $('view').getBoundingClientRect(), r = el.getBoundingClientRect();
  const cx = r.left - vr.left + r.width / 2, cy = r.top - vr.top + r.height / 2, R = r.width * 0.36;
  return [0, 1, 2].flatMap((i) => [1, -1].map((s) => {
    const a = v3.mul(uiAxisDir(i), s);
    return { i, s, x: cx + v3.dot(a, view.right) * R, y: cy - v3.dot(a, view.up) * R, z: v3.dot(a, view.fwd.map((q) => -q)) };
  }));
}
function navClick(ev) {
  const vr = $('view').getBoundingClientRect();
  const x = ev.clientX - vr.left, y = ev.clientY - vr.top;
  let best = null, bd = ev.pointerType === 'mouse' ? 13 : 20;
  for (const a of navBallAxes()) { const d = Math.hypot(a.x - x, a.y - y); if (d < bd) { bd = d; best = a; } }
  if (!best) return;
  const dir = v3.mul(uiAxisDir(best.i), best.s);
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
// where water from a source goes: the free-fall path from the outlet until it meets an obstacle or the floor, and a
// ring where it lands
function waterPath(src) {
  const dir = sourceDir(src);
  let p = v3.add(src.pos, v3.mul(dir, 0.002));
  let v = v3.mul(dir, src.mode === 'drops' ? src.speed : Math.max(src.speed, 0.05));
  const pts = [p];
  const obs = scene.items.filter((it) => it.kind === 'obstacle');
  const solidAt = (q) => q[1] <= 0 || obs.some((o) => v3.len(v3.sub(q, o.pos)) < boundRadius(o) + 0.01 && obstacleSdf(o, q) < 0);
  const dt = 0.004;
  for (let i = 0; i < 400; i++) {
    const q = [p[0] + v[0] * dt, p[1] + v[1] * dt - 0.5 * G * dt * dt, p[2] + v[2] * dt];
    v = [v[0], v[1] - G * dt, v[2]];
    if (solidAt(q)) {
      // the landing point between p and q
      let a = 0, b = 1;
      for (let k = 0; k < 12; k++) { const m = (a + b) / 2; if (solidAt(v3.add(p, v3.mul(v3.sub(q, p), m)))) b = m; else a = m; }
      const hit = v3.add(p, v3.mul(v3.sub(q, p), a));
      pts.push(hit);
      return { pts, hit };
    }
    pts.push(q);
    p = q;
    if (Math.abs(p[0]) > 3 || Math.abs(p[2]) > 3) break;
  }
  return { pts, hit: null };
}
function drawWaterPath(src) {
  const { pts, hit } = waterPath(src);
  octx.setLineDash([5, 5]);
  octx.strokeStyle = 'rgba(110,190,240,0.85)'; octx.lineWidth = 1.4;
  octx.beginPath();
  let started = false;
  for (const q of pts) { const s = project(q); if (!s.ok) { started = false; continue; } if (started) octx.lineTo(s.x, s.y); else { octx.moveTo(s.x, s.y); started = true; } }
  octx.stroke();
  octx.setLineDash([]);
  if (hit) {
    const r = Math.max(sourceOutlet(src) / 2, 0.012);
    octx.beginPath();
    for (let k = 0; k <= 32; k++) { const a = (k / 32) * Math.PI * 2; const s = project([hit[0] + Math.cos(a) * r, hit[1] + 0.001, hit[2] + Math.sin(a) * r]); if (k) octx.lineTo(s.x, s.y); else octx.moveTo(s.x, s.y); }
    octx.strokeStyle = 'rgba(110,190,240,0.95)'; octx.lineWidth = 1.6; octx.stroke();
  }
}
function drawEdges(edges, style, width, dash) {
  octx.setLineDash(dash || []);
  octx.strokeStyle = style; octx.lineWidth = width;
  octx.beginPath();
  for (const [a, b] of edges) { const pa = project(a), pb = project(b); if (pa.ok && pb.ok) { octx.moveTo(pa.x, pa.y); octx.lineTo(pb.x, pb.y); } }
  octx.stroke();
  octx.setLineDash([]);
}
function drawOverlay() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (overlay.width !== Math.round(cssW * dpr) || overlay.height !== Math.round(cssH * dpr)) { overlay.width = Math.round(cssW * dpr); overlay.height = Math.round(cssH * dpr); }
  octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  octx.clearRect(0, 0, cssW, cssH);
  octx.lineCap = 'round'; octx.lineJoin = 'round';
  if (selectedId === 'tank') drawEdges(tankEdges(), 'rgba(255,170,60,0.95)', 2);
  if (settings.guides) {
    for (const it of scene.items) {
      const sel = it.id === selectedId;
      if (it.kind === 'block') {
        drawEdges(blockEdges(it), sel ? 'rgba(255,170,60,0.95)' : 'rgba(110,190,240,0.75)', sel ? 1.6 : 1.2, sel ? [] : [5, 4]);
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
        if (sel && it.mode !== 'rain') drawWaterPath(it);
        const L = 30 * worldPerPx(it.pos);
        const tip = project(v3.add(it.pos, v3.mul(sourceDir(it), L)));
        if (!(sel && editor.tool === 'rotate')) drawArrow(p, tip, it.enabled ? 'rgba(110,190,240,0.75)' : 'rgba(160,170,175,0.6)', 1.4, it.mode !== 'rain');
        octx.fillStyle = it.enabled ? '#6ebef0' : '#8e989d';
        octx.beginPath(); octx.arc(p.x, p.y, 3, 0, Math.PI * 2); octx.fill();
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
        const col = AXIS_COLORS[h.ci];
        drawArrow(h.a, h.b, col, hot ? 3.4 : 2.4, false);
        octx.fillStyle = col;
        octx.beginPath();
        if (h.type === 'scale') octx.rect(h.b.x - h.knob, h.b.y - h.knob, h.knob * 2, h.knob * 2);
        else octx.arc(h.b.x, h.b.y, hot ? h.knob + 1.5 : h.knob, 0, Math.PI * 2);
        octx.fill();
        octx.strokeStyle = 'rgba(16,19,22,0.85)'; octx.lineWidth = 1.2; octx.stroke();
      } else if (h.type === 'free' || h.type === 'uscale') {
        octx.strokeStyle = 'rgba(255,255,255,0.92)'; octx.lineWidth = hot ? 2.6 : 1.8;
        octx.beginPath();
        if (h.type === 'free') octx.arc(h.a.x, h.a.y, h.r, 0, Math.PI * 2); else octx.rect(h.a.x - h.r, h.a.y - h.r, h.r * 2, h.r * 2);
        octx.stroke();
      } else if (h.type === 'ring') {
        octx.strokeStyle = AXIS_COLORS[h.ci]; octx.lineWidth = hot ? 3.6 : 2.4;
        octx.beginPath();
        let started = false;
        for (const q of h.pts) { if (!q.ok) { started = false; continue; } if (started) octx.lineTo(q.x, q.y); else { octx.moveTo(q.x, q.y); started = true; } }
        octx.stroke();
      } else if (h.type === 'aim') {
        drawArrow(h.a, h.b, '#f2a43a', hot ? 3 : 2.2, false);
        octx.fillStyle = '#f2a43a'; octx.beginPath(); octx.arc(h.b.x, h.b.y, hot ? h.knob + 1.5 : h.knob, 0, Math.PI * 2); octx.fill();
      }
    }
  }
  if (editor.modal && editor.modal.axis >= 0) {
    const m = editor.modal;
    const c = m.start.pos, ax = uiAxisDir(m.axis), L = 4;
    const a = project(v3.sub(c, v3.mul(ax, L))), b = project(v3.add(c, v3.mul(ax, L)));
    if (a.ok && b.ok) drawArrow(a, b, AXIS_COLORS[m.axis], 1.4, false);
  }
  if (editor.readout) {
    const r = editor.readout;
    octx.font = '600 13px "IBM Plex Mono", monospace'; octx.textAlign = 'left'; octx.textBaseline = 'middle';
    const w = octx.measureText(r.text).width + 12;
    const x = Math.min(r.x + 18, cssW - w - 4), y = Math.max(r.y - 18, 14);
    octx.fillStyle = 'rgba(16,19,22,0.85)'; octx.fillRect(x, y - 11, w, 22);
    octx.fillStyle = '#ffd9a3'; octx.fillText(r.text, x + 6, y + 0.5);
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
    octx.beginPath(); octx.arc(a.x, a.y, a.s > 0 ? 8.5 : 6.5, 0, Math.PI * 2); octx.fill(); if (a.s < 0) octx.stroke();
    if (a.s > 0) { octx.fillStyle = '#16191c'; octx.font = '600 11px "IBM Plex Mono", monospace'; octx.textAlign = 'center'; octx.textBaseline = 'middle'; octx.fillText('XYZ'[a.i], a.x, a.y + 0.5); }
  }
}
