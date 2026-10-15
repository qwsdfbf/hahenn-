// ============================================================
//  WGSL: particle kernels (grid-to-particle, emission, compaction, whitewater, counters)
// ============================================================
const WGSL_COUNTERS = /* wgsl */`
struct Counters { count: atomic<u32>, newCount: atomic<u32>, wwCount: atomic<u32>, wwNew: atomic<u32>, vmax: atomic<u32>, impacts: atomic<u32>, pad0: u32, pad1: u32 };
`;
// grid -> particle: only faces that received particle weight this step take part, so air faces never leak in
const WGSL_TRANSFER = /* wgsl */`
fn transfer1(q: vec3f, comp: u32, vp: f32) -> vec3f {
  let b = vec3i(floor(q));
  let f = q - vec3f(b);
  var sn = 0.0; var so = 0.0; var sw = 0.0;
  let bit = 1u << comp;
  for (var dz = 0; dz < 2; dz++) {
    let k = b.z + dz;
    if (k < 0 || k > NZ()) { continue; }
    let wz = select(1.0 - f.z, f.z, dz == 1);
    for (var dy = 0; dy < 2; dy++) {
      let j = b.y + dy;
      if (j < 0 || j > NY()) { continue; }
      let wy = select(1.0 - f.y, f.y, dy == 1);
      for (var dx = 0; dx < 2; dx++) {
        let i = b.x + dx;
        if (i < 0 || i > NX()) { continue; }
        let n = nodeIdx(i, j, k);
        if ((u32(velOld[n].w) & bit) == 0u) { continue; }
        let w = select(1.0 - f.x, f.x, dx == 1) * wy * wz;
        sn += w * vel[n][comp];
        so += w * velOld[n][comp];
        sw += w;
      }
    }
  }
  if (sw < 1e-6) { return vec3f(vp, vp, 0.0); }
  return vec3f(sn / sw, vp + (sn - so) / sw, 1.0);
}
`;
const WGSL_SAMPLE = /* wgsl */`
fn sample1(q: vec3f, comp: u32) -> f32 {
  let b = vec3i(floor(q));
  let f = q - vec3f(b);
  var s = 0.0;
  for (var dz = 0; dz < 2; dz++) {
    let k = clamp(b.z + dz, 0, NZ());
    let wz = select(1.0 - f.z, f.z, dz == 1);
    for (var dy = 0; dy < 2; dy++) {
      let j = clamp(b.y + dy, 0, NY());
      let wy = select(1.0 - f.y, f.y, dy == 1);
      for (var dx = 0; dx < 2; dx++) {
        let i = clamp(b.x + dx, 0, NX());
        s += select(1.0 - f.x, f.x, dx == 1) * wy * wz * vel[nodeIdx(i, j, k)][comp];
      }
    }
  }
  return s;
}
fn velNew(g: vec3f) -> vec3f {
  return vec3f(sample1(g - vec3f(0.0, 0.5, 0.5), 0u), sample1(g - vec3f(0.5, 0.0, 0.5), 1u), sample1(g - vec3f(0.5, 0.5, 0.0), 2u));
}
`;
const WGSL_TANK = /* wgsl */`
fn fpMin() -> vec2f { return P.origin.xz; }
fn fpMax() -> vec2f { return P.origin.xz + vec2f(f32(P.dims.x), f32(P.dims.z)) * P.origin.w; }
fn inFootprint(x: vec3f) -> bool { return all(x.xz > fpMin()) && all(x.xz < fpMax()); }
// keeps particles inside the glass walls below the rim, and outside them when they come from outside
fn tankClamp(x0: vec3f, x: ptr<function, vec3f>, v: ptr<function, vec3f>, r: f32) {
  let lo = fpMin(); let hi = fpMax();
  let wasIn = inFootprint(x0);
  if (wasIn && (*x).y < P.tank.x) {
    if ((*x).x < lo.x + r) { (*x).x = lo.x + r; (*v).x = max((*v).x, 0.0); }
    if ((*x).x > hi.x - r) { (*x).x = hi.x - r; (*v).x = min((*v).x, 0.0); }
    if ((*x).z < lo.y + r) { (*x).z = lo.y + r; (*v).z = max((*v).z, 0.0); }
    if ((*x).z > hi.y - r) { (*x).z = hi.y - r; (*v).z = min((*v).z, 0.0); }
  }
  if (wasIn && (*x).y < P.origin.y + r) { (*x).y = P.origin.y + r; (*v).y = max((*v).y, 0.0); }
  if (!wasIn && (*x).y < P.tank.x && inFootprint(*x)) {
    *x = vec3f(x0.x, (*x).y, x0.z);
    *v = vec3f(-0.2 * (*v).x, (*v).y, -0.2 * (*v).z);
  }
}
`;

const WGSL_G2P = WGSL_SIM_COMMON + WGSL_COUNTERS + /* wgsl */`
@group(0) @binding(1) var<storage, read_write> parts: array<Particle>;
@group(0) @binding(2) var<storage, read_write> C: Counters;
@group(0) @binding(3) var<storage, read> vel: array<vec4f>;
@group(0) @binding(4) var<storage, read> velOld: array<vec4f>;
@group(0) @binding(6) var<storage, read> cellCount: array<u32>;
@group(0) @binding(7) var<storage, read_write> ww: array<Particle>;
@group(0) @binding(8) var<storage, read_write> rsrc: array<atomic<i32>>;
` + WGSL_SDF(5) + WGSL_TRANSFER + WGSL_TANK + /* wgsl */`
// particles in a cell; above the grid is open air, beyond the side walls and floor is solid
fn countAt(c: vec3i) -> u32 {
  if (c.y >= NY() || any(c < vec3i(0)) || c.x >= NX() || c.z >= NZ()) { return 0u; }
  return cellCount[cellIdx(c.x, c.y, c.z)];
}
fn airAt(c: vec3i) -> bool {
  if (c.y >= NY()) { return true; }
  if (any(c < vec3i(0)) || c.x >= NX() || c.z >= NZ()) { return false; }
  return cellCount[cellIdx(c.x, c.y, c.z)] == 0u;
}
fn nearAir(c: vec3i) -> bool {
  for (var d = 0; d < 6; d++) {
    var o = vec3i(0);
    o[d / 2] = select(-1, 1, (d & 1) == 1);
    if (airAt(c + o)) { return true; }
  }
  return false;
}
fn depositRipple(xz: vec2f, impulse: f32, R: u32) {
  let uv = (xz - fpMin()) / (fpMax() - fpMin());
  let ij = vec2u(clamp(round(uv * f32(R)), vec2f(0.0), vec2f(f32(R))));
  atomicAdd(&rsrc[ij.y * (R + 1u) + ij.x], i32(clamp(impulse, 0.0, 2e-3) * ${RIPPLE_SCALE.toExponential()}));
}
// splash of a drop of mass m hitting the surface at speed U, centred at x on the surface: a ring of droplets thrown
// up and out (the crown) and a few rising straight up from the centre (the jet that follows the crater collapse).
// The number of droplets follows the mass, so a drop gives the same splash whatever the particle size.
fn splashCrown(x: vec3f, U: f32, m: f32, id: u32) {
  if (P.tank.y <= 0.0 || U < 0.8) { return; }
  var s = hashU(id * 2654435761u + P.ext.w * 97u + 3u);
  let share = m / 1.13e-4;
  let n = u32(clamp(round((6.0 + 6.0 * (U - 0.8)) * share), 2.0, 24.0));
  let nj = u32(clamp(round(2.0 * share), 1.0, 3.0));
  let base = atomicAdd(&C.wwCount, n + nj);
  let cap = u32(P.tank.z);
  let r0 = 0.35 * P.origin.w;
  let ph0 = rnd(&s) * 6.2831853;
  for (var i = 0u; i < n; i++) {
    let k = base + i;
    if (k >= cap) { return; }
    let ph = ph0 + 6.2831853 * (f32(i) + 0.3 * rnd(&s)) / f32(n);
    let el = 0.9 + 0.45 * rnd(&s);
    let sp = U * (0.15 + 0.2 * rnd(&s));
    let d = vec3f(cos(ph), 0.0, sin(ph));
    ww[k] = Particle(vec4f(x + d * r0, 0.5 + 0.4 * rnd(&s)), vec4f(d * cos(el) * sp + vec3f(0.0, sin(el) * sp, 0.0), 0.0));
  }
  for (var j = 0u; j < nj; j++) {
    let k = base + n + j;
    if (k >= cap) { return; }
    let sp = U * (0.22 + 0.04 * f32(j)) * (0.9 + 0.2 * rnd(&s));
    ww[k] = Particle(vec4f(x + vec3f(0.0, 0.001 * f32(j), 0.0), 0.7), vec4f((rnd(&s) - 0.5) * 0.05, sp, (rnd(&s) - 0.5) * 0.05, 0.0));
  }
}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let id = gid.x;
  if (id >= atomicLoad(&C.count)) { return; }
  let p = parts[id];
  if (p.pos.w < 0.5) { return; }
  let dt = P.phys.x;
  let h = P.origin.w;
  let x0 = p.pos.xyz;
  var v = p.vel.xyz;
  let g = gridPos(x0);
  let ing = inGrid(g);
  if (ing) {
    let tx = transfer1(g - vec3f(0.0, 0.5, 0.5), 0u, v.x);
    let ty = transfer1(g - vec3f(0.5, 0.0, 0.5), 1u, v.y);
    let tz = transfer1(g - vec3f(0.5, 0.5, 0.0), 2u, v.z);
    v = mix(vec3f(tx.x, ty.x, tz.x), vec3f(tx.y, ty.y, tz.y), P.phys.z);
  } else {
    v.y -= P.phys.y * dt;
  }
  var x = x0 + v * dt;
  let rc = P.phys2.w;
  let d = sceneSdf(x);
  if (d < rc) {
    let nrm = sceneNormal(x);
    x += nrm * (rc - d);
    let vs = solidVelAt(x);
    let rel = v - vs;
    let vn = dot(rel, nrm);
    if (vn < 0.0) { v = vs + (rel - nrm * vn) * (1.0 - P.tank.w); }
  }
  tankClamp(x0, &x, &v, rc);
  var alive = 1.0;
  if (inDrain(x)) { alive = 0.0; }
  if (!inFootprint(x) && x.y < 0.002) { alive = 0.0; }
  if (any(abs(x.xz) > vec2f(20.0)) || x.y < -1.0 || x.y > 30.0) { alive = 0.0; }
  // A drop smaller than a cell that falls out of open air into resolved liquid cannot be stopped by the grid: the
  // cells it enters are dominated by the liquid's own particles, so FLIP would carry it straight through the pool.
  // It merges with the liquid instead. The momentum it brings becomes a pressure impulse on the surface (ripple layer)
  // and a crown splash, and from then on it moves with the liquid around it.
  // vel.w marks a particle that has been flying free since it last belonged to liquid: alone in its neighbourhood with
  // nothing following it from above. Particles inside a falling stream never get the mark, so a stream pours into
  // the pool through the grid while its leading drop and the drops it breaks into still splash.
  // Drops and rain are emitted with the mark; above the grid nothing can be checked, so the mark is kept as it is.
  let c0 = vec3i(g);
  var airborne = p.vel.w;
  if (ing) {
    let n0 = countAt(c0);
    if (n0 >= 4u) { airborne = 0.0; }
    else if (n0 <= 2u && c0.y + 2 < NY() && countAt(c0 + vec3i(0, 1, 0)) == 0u && countAt(c0 + vec3i(0, 2, 0)) == 0u) {
      var around = 0u;
      for (var dz = -1; dz <= 1; dz++) {
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) { around += countAt(c0 + vec3i(dx, dy, dz)); }
        }
      }
      if (around <= 4u) { airborne = 1.0; }
    }
  }
  let g1 = gridPos(x);
  let c1 = vec3i(g1);
  if (airborne > 0.5 && p.vel.y < -0.3 && inGrid(g1)) {
    let others = countAt(c1) - select(0u, 1u, all(c1 == c0));
    if (others >= 3u) {
      let vl = vec3f(transfer1(g1 - vec3f(0.0, 0.5, 0.5), 0u, v.x).x,
                     transfer1(g1 - vec3f(0.5, 0.0, 0.5), 1u, v.y).x,
                     transfer1(g1 - vec3f(0.5, 0.5, 0.0), 2u, v.z).x);
      let dv = vl.y - p.vel.y;
      if (dv > 0.3) {
        v = vl;
        airborne = 0.0;
        atomicAdd(&C.impacts, 1u);
        let m = 998.0 * pow(0.5 * h, 3.0);
        let R = u32(P.misc.z);
        if (R > 0u) { depositRipple(x.xz, 2.0 * m * min(dv, 8.0), R); }
        // the liquid fills the bottom of the cell it lands in in proportion to the particles there
        let level = P.origin.y + (f32(c1.y) + min(f32(countAt(c1)) / P.phys2.x, 1.0)) * h;
        splashCrown(vec3f(x.x, level + 0.25 * h, x.z), -p.vel.y, m, id);
      }
    }
  }
  if (ing) { atomicMax(&C.vmax, bitcast<u32>(min(length(v), 60.0))); }
  if (ing && P.tank.y > 0.0) {
    let sp = length(v);
    if (sp > 0.75) {
      if (nearAir(c0)) {
        var s = hashU(id * 9781u + P.ext.w * 6271u + 17u);
        let e = clamp((sp - 0.75) / 1.6, 0.0, 1.0);
        if (rnd(&s) < P.tank.y * e * e * dt) {
          let k = atomicAdd(&C.wwCount, 1u);
          if (k < u32(P.tank.z)) {
            let j = vec3f(rnd(&s), rnd(&s), rnd(&s)) - vec3f(0.5);
            ww[k] = Particle(vec4f(x + j * h * 0.6, 1.0 + 2.5 * rnd(&s)), vec4f(v * (0.8 + 0.35 * rnd(&s)) + j * 0.35, 0.0));
          }
        }
      }
    }
  }
  parts[id] = Particle(vec4f(x, alive), vec4f(v, airborne));
}`;

// Emitters: 0 = disc outlet (stream/shower), 1 = sphere (drop/burst), 2 = jittered lattice (water block), 3 = rain area
const WGSL_EMIT = WGSL_SIM_COMMON + WGSL_COUNTERS + /* wgsl */`
struct Emit { a: vec4f, b: vec4f, c: vec4f, d: vec4f, info: vec4u };
@group(0) @binding(1) var<storage, read_write> parts: array<Particle>;
@group(0) @binding(2) var<storage, read_write> C: Counters;
@group(0) @binding(3) var<storage, read> E: array<Emit>;
@group(0) @binding(4) var<uniform> EI: vec4u;
@group(0) @binding(6) var<storage, read> cellCount: array<u32>;
` + WGSL_SDF(5) + /* wgsl */`
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let t = gid.x;
  if (t >= EI.y) { return; }
  var e = 0u;
  for (var i = 0u; i < EI.x; i++) { if (t >= E[i].info.x) { e = i; } }
  let em = E[e];
  let local = t - em.info.x;
  let idx = atomicLoad(&C.count) + t;
  if (idx >= P.ext.y) { return; }
  var s = hashU(t * 747796405u + em.info.z * 2891336453u + 1u);
  var pos = vec3f(0.0);
  var vel = vec3f(0.0);
  var mark = 0.0;
  let shape = em.info.w;
  if (shape == 0u) {
    let rr = em.a.w * sqrt(rnd(&s));
    let th = 6.2831853 * rnd(&s);
    let u = em.c.xyz; let w = em.d.xyz; let dir = em.b.xyz;
    pos = em.a.xyz + (u * cos(th) + w * sin(th)) * rr + dir * (rnd(&s) * em.d.w);
    var dv = dir;
    if (em.c.w > 0.0) {
      let ca = 1.0 - rnd(&s) * (1.0 - cos(em.c.w));
      let sa = sqrt(max(1.0 - ca * ca, 0.0));
      let ph = 6.2831853 * rnd(&s);
      dv = dir * ca + (u * cos(ph) + w * sin(ph)) * sa;
    }
    vel = dv * em.b.w + (vec3f(rnd(&s), rnd(&s), rnd(&s)) - vec3f(0.5)) * (0.02 * em.b.w);
  } else if (shape == 1u) {
    var dd = vec3f(rnd(&s), rnd(&s), rnd(&s)) * 2.0 - vec3f(1.0);
    dd = normalize(dd + vec3f(1e-4));
    pos = em.a.xyz + dd * em.a.w * pow(rnd(&s), 0.3333);
    vel = em.b.xyz;
    mark = em.b.w;
  } else if (shape == 2u) {
    let nx = u32(em.b.x); let ny = u32(em.b.y);
    let i = local % nx; let j = (local / nx) % ny; let k = local / (nx * ny);
    let jit = (vec3f(rnd(&s), rnd(&s), rnd(&s)) - vec3f(0.5)) * 0.3;
    pos = em.a.xyz + (vec3f(f32(i), f32(j), f32(k)) + vec3f(0.5) + jit) * em.a.w;
    vel = em.c.xyz;
    // pouring into the running simulation: leave cells that are already at least half full of water alone
    let g = gridPos(pos);
    if (em.b.w > 0.5 && inGrid(g)) {
      let c = vec3i(g);
      if (f32(cellCount[cellIdx(c.x, c.y, c.z)]) >= 0.5 * P.phys2.x) { parts[idx] = Particle(vec4f(pos, 0.0), vec4f(0.0)); return; }
    }
  } else {
    pos = em.a.xyz + vec3f((rnd(&s) * 2.0 - 1.0) * em.a.w, -rnd(&s) * em.d.w, (rnd(&s) * 2.0 - 1.0) * em.a.w);
    vel = em.b.xyz;
    mark = 1.0;
  }
  var alive = 1.0;
  if (sceneSdf(pos) < 0.0) { alive = 0.0; }
  parts[idx] = Particle(vec4f(pos, alive), vec4f(vel, mark));
}`;

const WGSL_COMPACT = WGSL_SIM_COMMON + WGSL_COUNTERS + /* wgsl */`
@group(0) @binding(1) var<storage, read> src: array<Particle>;
@group(0) @binding(2) var<storage, read_write> dst: array<Particle>;
@group(0) @binding(3) var<storage, read_write> C: Counters;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let id = gid.x;
  if (id >= min(atomicLoad(&C.count), P.ext.y)) { return; }
  let p = src[id];
  if (p.pos.w < 0.5) { return; }
  let j = atomicAdd(&C.newCount, 1u);
  dst[j] = p;
}`;

// mode 0: refresh dispatch/draw arguments; 1: finish compaction; 2: commit U.y emitted particles;
// 3: finish whitewater compaction; 4: clear everything
const WGSL_COUNT = WGSL_SIM_COMMON + WGSL_COUNTERS + /* wgsl */`
@group(0) @binding(1) var<storage, read_write> C: Counters;
@group(0) @binding(2) var<storage, read_write> args: array<u32>;
@group(0) @binding(3) var<uniform> U: vec4u;
@compute @workgroup_size(1) fn main() {
  let cap = P.ext.y;
  let wcap = u32(P.tank.z);
  if (U.x == 1u) { atomicStore(&C.count, atomicLoad(&C.newCount)); atomicStore(&C.newCount, 0u); }
  if (U.x == 2u) { atomicStore(&C.count, min(atomicLoad(&C.count) + U.y, cap)); }
  if (U.x == 3u) { atomicStore(&C.wwCount, min(atomicLoad(&C.wwNew), wcap)); atomicStore(&C.wwNew, 0u); }
  if (U.x == 4u) { atomicStore(&C.count, 0u); atomicStore(&C.newCount, 0u); atomicStore(&C.wwCount, 0u); atomicStore(&C.wwNew, 0u); atomicStore(&C.impacts, 0u); }
  let n = min(atomicLoad(&C.count), cap);
  let w = min(atomicLoad(&C.wwCount), wcap);
  args[0] = (n + 255u) / 256u; args[1] = 1u; args[2] = 1u;
  args[3] = (w + 255u) / 256u; args[4] = 1u; args[5] = 1u;
  args[6] = 6u; args[7] = n; args[8] = 0u; args[9] = 0u;
  args[10] = 6u; args[11] = w; args[12] = 0u; args[13] = 0u;
}`;

// whitewater: spray in the air, foam on the surface, bubbles below it
const WGSL_WW = WGSL_SIM_COMMON + WGSL_COUNTERS + /* wgsl */`
@group(0) @binding(1) var<storage, read> src: array<Particle>;
@group(0) @binding(2) var<storage, read_write> dst: array<Particle>;
@group(0) @binding(3) var<storage, read_write> C: Counters;
@group(0) @binding(4) var<storage, read> vel: array<vec4f>;
@group(0) @binding(5) var<storage, read> cellCount: array<u32>;
@group(0) @binding(7) var<uniform> WU: vec4f;
@group(0) @binding(8) var<storage, read_write> rsrc: array<atomic<i32>>;
` + WGSL_SDF(6) + WGSL_SAMPLE + WGSL_TANK + /* wgsl */`
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let id = gid.x;
  if (id >= min(atomicLoad(&C.wwCount), u32(P.tank.z))) { return; }
  let p = src[id];
  var x = p.pos.xyz;
  var v = p.vel.xyz;
  var life = p.pos.w;
  let dt = WU.x;
  let g = gridPos(x);
  // under the surface layer: bubble; in a surface cell below the liquid level (the liquid fills the bottom of the
  // cell in proportion to its particles): foam; anywhere else: spray
  var kind = 0.0;
  if (inGrid(g)) {
    let c = vec3i(g);
    let n = cellCount[cellIdx(c.x, c.y, c.z)];
    if (n > 0u) {
      var up = 0u;
      if (c.y + 1 < NY()) { up = cellCount[cellIdx(c.x, c.y + 1, c.z)]; }
      if (up > 0u) { kind = 2.0; }
      else if (g.y - f32(c.y) < min(f32(n) / P.phys2.x, 1.0)) { kind = 1.0; }
    }
  }
  let R = u32(P.misc.z);
  if (p.vel.w < 0.5 && kind > 0.5 && R > 0u && p.vel.y < -0.3) {
    // spray droplet (about 1 mm) landing on the water
    let uv = (x.xz - fpMin()) / (fpMax() - fpMin());
    let ij = vec2u(clamp(round(uv * f32(R)), vec2f(0.0), vec2f(f32(R))));
    atomicAdd(&rsrc[ij.y * (R + 1u) + ij.x], i32(clamp(4.2e-6 * -p.vel.y, 0.0, 1e-4) * ${RIPPLE_SCALE.toExponential()}));
  }
  if (kind == 0.0) {
    v.y -= P.phys.y * dt;
    v *= 1.0 / (1.0 + 0.6 * dt);
    life -= dt * 0.7;
  } else {
    let vf = velNew(g);
    if (kind == 1.0) { v = vec3f(vf.x, 0.2 * vf.y, vf.z); life -= dt * 0.5; }
    else { v = vf + vec3f(0.0, 0.16, 0.0); life -= dt * 0.3; }
  }
  let x0 = x;
  x += v * dt;
  let d = sceneSdf(x);
  if (d < 0.0) { x -= sceneNormal(x) * d; }
  tankClamp(x0, &x, &v, 0.001);
  let outside = !inFootprint(x) && x.y < 0.001;
  if (life > 0.0 && !outside && x.y > -0.5 && !inDrain(x)) {
    let k = atomicAdd(&C.wwNew, 1u);
    if (k < u32(P.tank.z)) { dst[k] = Particle(vec4f(x, life), vec4f(v, kind)); }
  }
}`;
