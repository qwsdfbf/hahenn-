// ============================================================
//  Triangle meshes for obstacles and props (local space, meters)
// ============================================================
class MeshBuilder {
  constructor() { this.v = []; this.i = []; }
  vert(p, n) { this.v.push(p[0], p[1], p[2], n[0], n[1], n[2]); return this.v.length / 6 - 1; }
  // triangle wound counter-clockwise when seen from the side its vertex normals face
  tri(a, b, c) {
    const V = this.v;
    const pa = [V[a * 6], V[a * 6 + 1], V[a * 6 + 2]], pb = [V[b * 6], V[b * 6 + 1], V[b * 6 + 2]], pc = [V[c * 6], V[c * 6 + 1], V[c * 6 + 2]];
    const cr = v3.cross(v3.sub(pb, pa), v3.sub(pc, pa));
    const n = [V[a * 6 + 3] + V[b * 6 + 3] + V[c * 6 + 3], V[a * 6 + 4] + V[b * 6 + 4] + V[c * 6 + 4], V[a * 6 + 5] + V[b * 6 + 5] + V[c * 6 + 5]];
    if (v3.dot(cr, n) >= 0) this.i.push(a, b, c); else this.i.push(a, c, b);
  }
  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); }
  grid(rows, cols, at) {
    // at(i, j) -> [pos, nrm]; connects a rows x cols lattice
    const base = this.v.length / 6;
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) { const [p, n] = at(i, j); this.vert(p, n); }
    for (let i = 0; i < rows - 1; i++) for (let j = 0; j < cols - 1; j++) {
      const a = base + i * cols + j;
      this.quad(a, a + 1, a + cols + 1, a + cols);
    }
  }
  transformed(R, t) {
    const out = new MeshBuilder();
    out.i = this.i.slice();
    for (let k = 0; k < this.v.length; k += 6) {
      const p = v3.add(m3.apply(R, [this.v[k], this.v[k + 1], this.v[k + 2]]), t);
      const n = m3.apply(R, [this.v[k + 3], this.v[k + 4], this.v[k + 5]]);
      out.v.push(p[0], p[1], p[2], n[0], n[1], n[2]);
    }
    return out;
  }
  merge(o) {
    const base = this.v.length / 6;
    for (const x of o.v) this.v.push(x);
    for (const x of o.i) this.i.push(x + base);
    return this;
  }
  build() { return { verts: new Float32Array(this.v), idx: new Uint32Array(this.i) }; }
}

function meshRoundBox(hx, hy, hz, r) {
  r = Math.max(0, Math.min(r, hx, hy, hz));
  const ticks = (h) => {
    const t = [];
    const steps = r > 0 ? 3 : 0;
    for (let k = steps; k >= 1; k--) t.push(-h + r - r * Math.tan((k / steps) * Math.PI / 4));
    t.push(-h + r, h - r);
    for (let k = 1; k <= steps; k++) t.push(h - r + r * Math.tan((k / steps) * Math.PI / 4));
    return t;
  };
  const H = [hx, hy, hz];
  const mb = new MeshBuilder();
  for (let axis = 0; axis < 3; axis++) for (const sgn of [-1, 1]) {
    const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
    const t1 = ticks(H[a1]), t2 = ticks(H[a2]);
    mb.grid(t1.length, t2.length, (i, j) => {
      const p = [0, 0, 0];
      p[axis] = sgn * H[axis]; p[a1] = t1[i]; p[a2] = t2[j];
      const inner = p.map((x, k) => clamp(x, -(H[k] - r), H[k] - r));
      let n = v3.sub(p, inner);
      if (v3.len(n) < 1e-9) { n = [0, 0, 0]; n[axis] = sgn; }
      n = v3.norm(n);
      return [r > 0 ? v3.add(inner, v3.mul(n, r)) : p, n];
    });
  }
  return mb;
}

function meshSphere(r, seg = 40) {
  const mb = new MeshBuilder();
  const rows = seg / 2 + 1, cols = seg + 1;
  mb.grid(rows, cols, (i, j) => {
    const th = (i / (rows - 1)) * Math.PI, ph = (j / (cols - 1)) * Math.PI * 2;
    const n = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
    return [v3.mul(n, r), n];
  });
  return mb;
}

// Revolve profile strips around the y axis. Each strip is an array of [radius, y, normalRadial, normalY].
function meshLathe(strips, seg = 48) {
  const mb = new MeshBuilder();
  for (const strip of strips) {
    mb.grid(strip.length, seg + 1, (i, j) => {
      const [r, y, nr, ny] = strip[i];
      const a = (j / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      const n = v3.norm([nr * c, ny, nr * s]);
      return [[r * c, y, r * s], n];
    });
  }
  return mb;
}
// quarter/half arcs used by profiles: centre (cx, cy), radius b, angles in radians
function arc(cx, cy, b, a0, a1, steps) {
  const out = [];
  for (let k = 0; k <= steps; k++) {
    const a = a0 + (a1 - a0) * (k / steps);
    out.push([cx + b * Math.cos(a), cy + b * Math.sin(a), Math.cos(a), Math.sin(a)]);
  }
  return out;
}
function meshCylinder(r, hh) {
  const b = Math.min(0.002, r / 4, hh / 4);
  const strip = [[0, -hh, 0, -1], ...arc(r - b, -hh + b, b, -Math.PI / 2, 0, 3), ...arc(r - b, hh - b, b, 0, Math.PI / 2, 3), [0, hh, 0, 1]];
  return meshLathe([strip]);
}
function meshCone(r, hh) {
  const len = Math.hypot(r, 2 * hh);
  const nr = (2 * hh) / len, ny = r / len;
  const side = [];
  for (let k = 0; k <= 8; k++) { const t = k / 8; side.push([r * (1 - t), -hh + 2 * hh * t, nr, ny]); }
  return meshLathe([[[0, -hh, 0, -1], [r, -hh, 0, -1]], side]);
}
function meshTorus(R, r) {
  return meshLathe([arc(R, 0, r, -Math.PI, Math.PI, 28)], 56);
}
function meshCup(r, hh, t) {
  const lip = t / 2;
  const outer = [[0, -hh, 0, -1], ...arc(r - 0.002, -hh + 0.002, 0.002, -Math.PI / 2, 0, 3), [r, hh - lip, 1, 0], ...arc(r - lip, hh - lip, lip, 0, Math.PI, 8), [r - t, hh - lip, -1, 0], [r - t, -hh + t, -1, 0]];
  const inner = [[r - t, -hh + t, 0, 1], [0, -hh + t, 0, 1]];
  return meshLathe([outer, inner]);
}
function meshContainer(hx, hy, hz, t) {
  const mb = new MeshBuilder();
  const part = (sx, sy, sz, cx, cy, cz) => mb.merge(meshRoundBox(sx, sy, sz, Math.min(0.0015, sx, sy, sz)).transformed([1, 0, 0, 0, 1, 0, 0, 0, 1], [cx, cy, cz]));
  part(hx, t / 2, hz, 0, -hy + t / 2, 0);
  part(t / 2, hy, hz, -hx + t / 2, 0, 0);
  part(t / 2, hy, hz, hx - t / 2, 0, 0);
  part(hx - t, hy, t / 2, 0, 0, -hz + t / 2);
  part(hx - t, hy, t / 2, 0, 0, hz - t / 2);
  return mb;
}
function meshGutter(hl, R, t) {
  const mb = new MeshBuilder();
  const seg = 28;
  const ro = R + t / 2, ri = R - t / 2;
  // outer and inner shells (lower half), extruded along x
  for (const [rad, sgn] of [[ro, 1], [ri, -1]]) {
    mb.grid(seg + 1, 2, (i, j) => {
      const ph = (i / seg) * Math.PI;
      const dirYZ = [-Math.sin(ph), Math.cos(ph)];
      return [[j ? hl : -hl, dirYZ[0] * rad, dirYZ[1] * rad], [0, dirYZ[0] * sgn, dirYZ[1] * sgn]];
    });
  }
  // flat top edges
  for (const zs of [1, -1]) {
    const a = mb.vert([-hl, 0, zs * ri], [0, 1, 0]), b = mb.vert([hl, 0, zs * ri], [0, 1, 0]);
    const c = mb.vert([hl, 0, zs * ro], [0, 1, 0]), d = mb.vert([-hl, 0, zs * ro], [0, 1, 0]);
    mb.quad(a, b, c, d);
  }
  // end caps
  for (const xs of [1, -1]) {
    const n = [xs, 0, 0];
    const base = mb.v.length / 6;
    for (let i = 0; i <= seg; i++) {
      const ph = (i / seg) * Math.PI;
      const y = -Math.sin(ph), z = Math.cos(ph);
      mb.vert([xs * hl, y * ro, z * ro], n);
      mb.vert([xs * hl, y * ri, z * ri], n);
    }
    for (let i = 0; i < seg; i++) mb.quad(base + i * 2, base + i * 2 + 2, base + i * 2 + 3, base + i * 2 + 1);
  }
  return mb;
}
// a tap: a short spout with the outlet at the origin (local -Y is the water's direction) under a wider body
function meshNozzle(d) {
  const ri = Math.max(d / 2, 0.002), ro = ri + 0.0025, rb = ri + 0.009, l1 = 0.022, len = 0.05;
  return meshLathe([
    [[ri, 0, 0, -1], [ro, 0, 0, -1]],
    [[ro, 0, 1, 0], [ro, l1, 1, 0]],
    [[ro, l1, 0, -1], [rb, l1, 0, -1]],
    [[rb, l1, 1, 0], [rb, len, 1, 0]],
    [[rb, len, 0, 1], [0, len, 0, 1]],
    [[ri, 0, -1, 0], [ri, l1 * 0.8, -1, 0]],
  ], 32);
}
function meshDrainRing(r) {
  const rw = 0.004;
  return meshLathe([[[r - rw, 0.0015, 0, 1], [r + rw, 0.0015, 0, 1]], [[r + rw, 0.0015, 1, 0.2], [r + rw, 0.0002, 1, 0]], [[r - rw, 0.0002, -1, 0], [r - rw, 0.0015, -1, 0.2]]], 40);
}
function meshDisc(r, y) {
  return meshLathe([[[0, y, 0, 1], [r, y, 0, 1]]], 40);
}
function meshBlockBox() { return meshRoundBox(0.5, 0.5, 0.5, 0); }

function meshForObstacle(o) {
  const [t, a, b, c, e] = shapeParams(o);
  switch (t) {
    case 0: return meshRoundBox(a, b, c, e);
    case 1: return meshSphere(a);
    case 2: return meshCylinder(a, b);
    case 3: return meshCone(a, b);
    case 4: return meshTorus(a, b);
    case 5: return meshCup(a, b, c);
    case 6: return meshContainer(a, b, c, e);
    case 7: return meshGutter(a, b, c);
  }
  return meshRoundBox(0.05, 0.05, 0.05, 0);
}
