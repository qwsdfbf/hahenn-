// ============================================================
//  WGSL: FLIP liquid solver on a staggered (MAC) grid with cut-cell solid fractions
// ============================================================
const VSCALE = 262144.0;   // fixed-point scale for atomic momentum / weight sums
const RIPPLE_SCALE = 1e9;  // fixed-point scale for ripple impulses [N·s]

const WGSL_SIM_COMMON = /* wgsl */`
struct Params {
  dims: vec4u,     // nx, ny, nz, node count
  ext: vec4u,      // cell count, particle capacity, object count, frame
  origin: vec4f,   // grid min corner, cell size h
  phys: vec4f,     // dt, gravity, flip ratio, 1/h
  phys2: vec4f,    // particles per cell at rest, drift correction, SOR omega, collision radius
  tank: vec4f,     // rim height, whitewater rate, whitewater capacity, wall friction
  misc: vec4f,     // time, render radius, unused, unused
};
struct Particle { pos: vec4f, vel: vec4f };
struct Obj { r0: vec4f, r1: vec4f, r2: vec4f, pos: vec4f, dims: vec4f, vel: vec4f, angv: vec4f };
@group(0) @binding(0) var<uniform> P: Params;
const VS: f32 = ${VSCALE.toFixed(1)};

fn NX() -> i32 { return i32(P.dims.x); }
fn NY() -> i32 { return i32(P.dims.y); }
fn NZ() -> i32 { return i32(P.dims.z); }
fn nodeIdx(i: i32, j: i32, k: i32) -> u32 { return u32(i + (j + k * (NY() + 1)) * (NX() + 1)); }
fn cellIdx(i: i32, j: i32, k: i32) -> u32 { return u32(i + (j + k * NY()) * NX()); }
fn nodeCoord(n: u32) -> vec3i {
  let sx = P.dims.x + 1u; let sy = P.dims.y + 1u;
  return vec3i(i32(n % sx), i32((n / sx) % sy), i32(n / (sx * sy)));
}
fn cellCoord(c: u32) -> vec3i {
  return vec3i(i32(c % P.dims.x), i32((c / P.dims.x) % P.dims.y), i32(c / (P.dims.x * P.dims.y)));
}
fn gridPos(x: vec3f) -> vec3f { return (x - P.origin.xyz) * P.phys.w; }
fn inGrid(g: vec3f) -> bool { return all(g >= vec3f(0.0)) && all(g < vec3f(P.dims.xyz)); }
fn hashU(a: u32) -> u32 { var x = a; x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u; return x; }
fn rnd(s: ptr<function, u32>) -> f32 { *s = hashU(*s); return f32(*s >> 8u) / 16777216.0; }
`;

const WGSL_SDF = (binding) => /* wgsl */`
@group(0) @binding(${binding}) var<storage, read> objs: array<Obj>;
fn toLocal(o: Obj, p: vec3f) -> vec3f { let d = p - o.pos.xyz; return vec3f(dot(o.r0.xyz, d), dot(o.r1.xyz, d), dot(o.r2.xyz, d)); }
fn sdRoundBox(p: vec3f, b: vec3f, r: f32) -> f32 {
  let q = abs(p) - b + vec3f(r);
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}
fn sdCyl(p: vec3f, r: f32, hh: f32) -> f32 {
  let d = vec2f(length(p.xz) - r, abs(p.y) - hh);
  return min(max(d.x, d.y), 0.0) + length(max(d, vec2f(0.0)));
}
fn sdCone(p: vec3f, r: f32, hh: f32) -> f32 {
  let q = vec2f(length(p.xz), p.y);
  let k1 = vec2f(0.0, hh);
  let k2 = vec2f(-r, 2.0 * hh);
  let ca = vec2f(q.x - min(q.x, select(0.0, r, q.y < 0.0)), abs(q.y) - hh);
  let cb = q - k1 + k2 * clamp(dot(k1 - q, k2) / dot(k2, k2), 0.0, 1.0);
  let s = select(1.0, -1.0, cb.x < 0.0 && ca.y < 0.0);
  return s * sqrt(min(dot(ca, ca), dot(cb, cb)));
}
fn shapeSdf(o: Obj, p: vec3f) -> f32 {
  let q = toLocal(o, p);
  let d = o.dims;
  let t = u32(o.pos.w + 0.5);
  var r = 1e9;
  switch t {
    case 0u: { r = sdRoundBox(q, d.xyz, d.w); }
    case 1u: { r = length(q) - d.x; }
    case 2u: { r = sdCyl(q, d.x, d.y); }
    case 3u: { r = sdCone(q, d.x, d.y); }
    case 4u: { r = length(vec2f(length(q.xz) - d.x, q.y)) - d.y; }
    case 5u: { r = max(sdCyl(q, d.x, d.y), -sdCyl(q - vec3f(0.0, d.z, 0.0), d.x - d.z, d.y)); }
    case 6u: { r = max(sdRoundBox(q, d.xyz, 0.002), -sdRoundBox(q - vec3f(0.0, d.w, 0.0), d.xyz - vec3f(d.w, 0.0, d.w), 0.001)); }
    case 7u: { r = max(max(abs(length(q.yz) - d.y) - 0.5 * d.z, q.y), abs(q.x) - d.x); }
    default: { }
  }
  return r;
}
fn sceneSdf(p: vec3f) -> f32 {
  var best = 1e9;
  for (var i = 0u; i < P.ext.z; i++) {
    let o = objs[i];
    if (o.angv.w != 1.0) { continue; }
    if (length(p - o.pos.xyz) - o.vel.w > best) { continue; }
    best = min(best, shapeSdf(o, p));
  }
  return best;
}
fn sceneNormal(p: vec3f) -> vec3f {
  let e = 0.0006;
  let n = vec3f(sceneSdf(p + vec3f(e, 0.0, 0.0)) - sceneSdf(p - vec3f(e, 0.0, 0.0)),
                sceneSdf(p + vec3f(0.0, e, 0.0)) - sceneSdf(p - vec3f(0.0, e, 0.0)),
                sceneSdf(p + vec3f(0.0, 0.0, e)) - sceneSdf(p - vec3f(0.0, 0.0, e)));
  let l = length(n);
  return select(vec3f(0.0, 1.0, 0.0), n / l, l > 1e-9);
}
fn solidVelAt(p: vec3f) -> vec3f {
  var best = 1e9; var v = vec3f(0.0);
  for (var i = 0u; i < P.ext.z; i++) {
    let o = objs[i];
    if (o.angv.w != 1.0) { continue; }
    if (length(p - o.pos.xyz) - o.vel.w > best) { continue; }
    let d = shapeSdf(o, p);
    if (d < best) { best = d; v = o.vel.xyz + cross(o.angv.xyz, p - o.pos.xyz); }
  }
  return v;
}
fn inDrain(p: vec3f) -> bool {
  for (var i = 0u; i < P.ext.z; i++) {
    let o = objs[i];
    if (o.angv.w != 2.0) { continue; }
    if (sdCyl(toLocal(o, p), o.dims.x, o.dims.y) < 0.0) { return true; }
  }
  return false;
}
`;

// open fraction of every staggered face + solid velocity at faces (run when obstacles change or move)
const WGSL_GEOM = WGSL_SIM_COMMON + WGSL_SDF(1) + /* wgsl */`
@group(0) @binding(2) var<storage, read_write> frac: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> svel: array<vec4f>;
fn faceOpen(c: vec3f, axis: u32) -> f32 {
  let a = 0.5 * P.origin.w;
  var o1 = vec3f(0.0); var o2 = vec3f(0.0);
  if (axis == 0u) { o1 = vec3f(0.0, a, 0.0); o2 = vec3f(0.0, 0.0, a); }
  else if (axis == 1u) { o1 = vec3f(a, 0.0, 0.0); o2 = vec3f(0.0, 0.0, a); }
  else { o1 = vec3f(a, 0.0, 0.0); o2 = vec3f(0.0, a, 0.0); }
  let s0 = sceneSdf(c - o1 - o2); let s1 = sceneSdf(c + o1 - o2);
  let s2 = sceneSdf(c + o1 + o2); let s3 = sceneSdf(c - o1 + o2);
  let sc = sceneSdf(c);
  let pos = max(s0, 0.0) + max(s1, 0.0) + max(s2, 0.0) + max(s3, 0.0) + 2.0 * max(sc, 0.0);
  let tot = abs(s0) + abs(s1) + abs(s2) + abs(s3) + 2.0 * abs(sc);
  if (tot < 1e-12) { return 1.0; }
  return clamp(pos / tot, 0.0, 1.0);
}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let n = gid.x;
  if (n >= P.dims.w) { return; }
  let c = nodeCoord(n);
  let h = P.origin.w;
  let o = P.origin.xyz;
  var fr = vec4f(0.0);
  var sv = vec4f(0.0);
  if (c.y < NY() && c.z < NZ() && c.x > 0 && c.x < NX()) {
    let p = o + h * vec3f(f32(c.x), f32(c.y) + 0.5, f32(c.z) + 0.5);
    fr.x = faceOpen(p, 0u); sv.x = solidVelAt(p).x;
  }
  if (c.x < NX() && c.z < NZ() && c.y > 0) {
    if (c.y >= NY()) { fr.y = 1.0; }
    else { let p = o + h * vec3f(f32(c.x) + 0.5, f32(c.y), f32(c.z) + 0.5); fr.y = faceOpen(p, 1u); sv.y = solidVelAt(p).y; }
  }
  if (c.x < NX() && c.y < NY() && c.z > 0 && c.z < NZ()) {
    let p = o + h * vec3f(f32(c.x) + 0.5, f32(c.y) + 0.5, f32(c.z));
    fr.z = faceOpen(p, 2u); sv.z = solidVelAt(p).z;
  }
  frac[n] = fr;
  svel[n] = sv;
}`;

const WGSL_P2G = WGSL_SIM_COMMON + /* wgsl */`
@group(0) @binding(1) var<storage, read> parts: array<Particle>;
@group(0) @binding(2) var<storage, read> cnt: array<u32>;
@group(0) @binding(3) var<storage, read_write> acc: array<atomic<i32>>;
@group(0) @binding(4) var<storage, read_write> cellCount: array<atomic<u32>>;
fn splat(q: vec3f, val: f32, comp: u32) {
  let b = vec3i(floor(q));
  let f = q - vec3f(b);
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
        let w = select(1.0 - f.x, f.x, dx == 1) * wy * wz;
        if (w <= 0.0) { continue; }
        let n = nodeIdx(i, j, k) * 6u + comp * 2u;
        atomicAdd(&acc[n], i32(round(w * val * VS)));
        atomicAdd(&acc[n + 1u], i32(round(w * VS)));
      }
    }
  }
}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let id = gid.x;
  if (id >= cnt[0]) { return; }
  let p = parts[id];
  if (p.pos.w < 0.5) { return; }
  let g = gridPos(p.pos.xyz);
  if (!inGrid(g)) { return; }
  let c = vec3i(g);
  atomicAdd(&cellCount[cellIdx(c.x, c.y, c.z)], 1u);
  let v = clamp(p.vel.xyz, vec3f(-30.0), vec3f(30.0));
  splat(g - vec3f(0.0, 0.5, 0.5), v.x, 0u);
  splat(g - vec3f(0.5, 0.0, 0.5), v.y, 1u);
  splat(g - vec3f(0.5, 0.5, 0.0), v.z, 2u);
}`;

// momentum -> velocity, keep a copy for the FLIP update, classify cells
const WGSL_NORMALIZE = WGSL_SIM_COMMON + /* wgsl */`
@group(0) @binding(1) var<storage, read> acc: array<i32>;
@group(0) @binding(2) var<storage, read_write> vel: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> velOld: array<vec4f>;
@group(0) @binding(4) var<storage, read> cellCount: array<u32>;
@group(0) @binding(5) var<storage, read_write> cellType: array<u32>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let n = gid.x;
  if (n < P.dims.w) {
    var v = vec4f(0.0);
    var m = 0u;
    for (var c = 0u; c < 3u; c++) {
      let wt = f32(acc[n * 6u + c * 2u + 1u]);
      if (wt > 1.0) { v[c] = f32(acc[n * 6u + c * 2u]) / wt; m |= 1u << c; }
    }
    vel[n] = v;
    velOld[n] = vec4f(v.xyz, f32(m));
  }
  if (n < P.ext.x) { cellType[n] = select(0u, 1u, cellCount[n] > 0u); }
}`;

const WGSL_FORCES = WGSL_SIM_COMMON + /* wgsl */`
@group(0) @binding(1) var<storage, read_write> vel: array<vec4f>;
@group(0) @binding(2) var<storage, read> frac: array<vec4f>;
@group(0) @binding(3) var<storage, read> svel: array<vec4f>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let n = gid.x;
  if (n >= P.dims.w) { return; }
  var v = vel[n];
  v.y -= P.phys.y * P.phys.x;
  let f = frac[n]; let s = svel[n];
  if (f.x <= 0.0) { v.x = s.x; }
  if (f.y <= 0.0) { v.y = s.y; }
  if (f.z <= 0.0) { v.z = s.z; }
  vel[n] = v;
}`;

const WGSL_DIVERGENCE = WGSL_SIM_COMMON + /* wgsl */`
@group(0) @binding(1) var<storage, read> vel: array<vec4f>;
@group(0) @binding(2) var<storage, read> frac: array<vec4f>;
@group(0) @binding(3) var<storage, read> svel: array<vec4f>;
@group(0) @binding(4) var<storage, read> cellType: array<u32>;
@group(0) @binding(5) var<storage, read> cellCount: array<u32>;
@group(0) @binding(6) var<storage, read_write> divg: array<f32>;
fn flux(f: f32, v: f32, s: f32) -> f32 { return f * v + (1.0 - f) * s; }
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let c = gid.x;
  if (c >= P.ext.x) { return; }
  if (cellType[c] != 1u) { divg[c] = 0.0; return; }
  let q = cellCoord(c);
  let n0 = nodeIdx(q.x, q.y, q.z);
  let nx = nodeIdx(q.x + 1, q.y, q.z);
  let ny = nodeIdx(q.x, q.y + 1, q.z);
  let nz = nodeIdx(q.x, q.y, q.z + 1);
  let f0 = frac[n0]; let v0 = vel[n0]; let s0 = svel[n0];
  var d = flux(frac[nx].x, vel[nx].x, svel[nx].x) - flux(f0.x, v0.x, s0.x);
  d += flux(frac[ny].y, vel[ny].y, svel[ny].y) - flux(f0.y, v0.y, s0.y);
  d += flux(frac[nz].z, vel[nz].z, svel[nz].z) - flux(f0.z, v0.z, s0.z);
  d *= P.phys.w;
  let crowd = f32(cellCount[c]) / P.phys2.x - 1.0;
  divg[c] = d - P.phys2.y * max(crowd, 0.0);
}`;

// red-black Gauss-Seidel with over-relaxation
const WGSL_PRESSURE = WGSL_SIM_COMMON + /* wgsl */`
@group(0) @binding(1) var<storage, read> frac: array<vec4f>;
@group(0) @binding(2) var<storage, read> cellType: array<u32>;
@group(0) @binding(3) var<storage, read> divg: array<f32>;
@group(0) @binding(4) var<storage, read_write> pres: array<f32>;
@group(0) @binding(5) var<uniform> parity: vec4u;
fn nb(c: u32, f: f32, ok: bool, num: ptr<function, f32>, den: ptr<function, f32>) {
  if (f <= 0.0) { return; }
  *den += f;
  if (ok && cellType[c] == 1u) { *num += f * pres[c]; }
}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let c = gid.x;
  if (c >= P.ext.x) { return; }
  let q = cellCoord(c);
  if (u32((q.x + q.y + q.z) & 1) != parity.x) { return; }
  if (cellType[c] != 1u) { pres[c] = 0.0; return; }
  var num = 0.0; var den = 0.0;
  let sx = 1u; let sy = P.dims.x; let sz = P.dims.x * P.dims.y;
  nb(c - select(0u, sx, q.x > 0), frac[nodeIdx(q.x, q.y, q.z)].x, q.x > 0, &num, &den);
  nb(c + sx, frac[nodeIdx(q.x + 1, q.y, q.z)].x, q.x < NX() - 1, &num, &den);
  nb(c - select(0u, sy, q.y > 0), frac[nodeIdx(q.x, q.y, q.z)].y, q.y > 0, &num, &den);
  nb(c + sy, frac[nodeIdx(q.x, q.y + 1, q.z)].y, q.y < NY() - 1, &num, &den);
  nb(c - select(0u, sz, q.z > 0), frac[nodeIdx(q.x, q.y, q.z)].z, q.z > 0, &num, &den);
  nb(c + sz, frac[nodeIdx(q.x, q.y, q.z + 1)].z, q.z < NZ() - 1, &num, &den);
  if (den > 0.0) {
    let h = P.origin.w;
    let pn = (num - h * h * divg[c]) / den;
    pres[c] = mix(pres[c], pn, P.phys2.z);
  }
}`;

const WGSL_PROJECT = WGSL_SIM_COMMON + /* wgsl */`
@group(0) @binding(1) var<storage, read_write> vel: array<vec4f>;
@group(0) @binding(2) var<storage, read> frac: array<vec4f>;
@group(0) @binding(3) var<storage, read> svel: array<vec4f>;
@group(0) @binding(4) var<storage, read> cellType: array<u32>;
@group(0) @binding(5) var<storage, read> pres: array<f32>;
// type and pressure of a cell; outside the side walls and floor counts as solid (2), above the grid as air (0)
fn ctype(i: i32, j: i32, k: i32) -> u32 {
  if (j >= NY()) { return 0u; }
  if (i < 0 || j < 0 || k < 0 || i >= NX() || k >= NZ()) { return 2u; }
  return cellType[cellIdx(i, j, k)];
}
fn cpres(i: i32, j: i32, k: i32) -> f32 {
  if (ctype(i, j, k) != 1u) { return 0.0; }
  return pres[cellIdx(i, j, k)];
}
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let n = gid.x;
  if (n >= P.dims.w) { return; }
  let c = nodeCoord(n);
  var v = vel[n];
  let f = frac[n]; let s = svel[n];
  let ih = P.phys.w;
  if (c.y < NY() && c.z < NZ()) {
    if (f.x <= 0.0) { v.x = s.x; }
    else if (ctype(c.x - 1, c.y, c.z) == 1u || ctype(c.x, c.y, c.z) == 1u) {
      v.x -= (cpres(c.x, c.y, c.z) - cpres(c.x - 1, c.y, c.z)) * ih;
    }
  }
  if (c.x < NX() && c.z < NZ()) {
    if (f.y <= 0.0) { v.y = s.y; }
    else if (ctype(c.x, c.y - 1, c.z) == 1u || ctype(c.x, c.y, c.z) == 1u) {
      v.y -= (cpres(c.x, c.y, c.z) - cpres(c.x, c.y - 1, c.z)) * ih;
    }
  }
  if (c.x < NX() && c.y < NY()) {
    if (f.z <= 0.0) { v.z = s.z; }
    else if (ctype(c.x, c.y, c.z - 1) == 1u || ctype(c.x, c.y, c.z) == 1u) {
      v.z -= (cpres(c.x, c.y, c.z) - cpres(c.x, c.y, c.z - 1)) * ih;
    }
  }
  vel[n] = v;
}`;
