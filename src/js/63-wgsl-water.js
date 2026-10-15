// ============================================================
//  WGSL: water seen from the sun — top surface height map and floor caustics
// ============================================================
// The height map covers the tank footprint (F.wmap = xmin, zmin, width, depth). Texels without water hold -1.
const WGSL_TOPH = WGSL_FRAME + /* wgsl */`
struct Particle { pos: vec4f, vel: vec4f };
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> parts: array<Particle>;
struct VO { @builtin(position) pos: vec4f, @location(0) d: vec2f, @location(1) @interpolate(flat) cy: f32, @location(2) @interpolate(flat) r: f32 };
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  var o: VO;
  let p = parts[ii];
  if (p.pos.w < 0.5 || p.pos.y > F.tank.y + 0.01) { o.pos = vec4f(3.0, 3.0, 3.0, 1.0); return o; }
  var c = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let r = F.water.w * 1.25;
  let d = c[vi] * r;
  let xz = p.pos.xz + d;
  let uv = (xz - F.wmap.xy) / F.wmap.zw;
  o.pos = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.5, 1.0);
  o.d = d; o.cy = p.pos.y; o.r = r;
  return o;
}
struct FO { @location(0) h: vec4f, @builtin(frag_depth) depth: f32 };
@fragment fn fs(in: VO) -> FO {
  let q = in.r * in.r - dot(in.d, in.d);
  if (q <= 0.0) { discard; }
  let y = in.cy + sqrt(q);
  var o: FO;
  o.h = vec4f(y, 0.0, 0.0, 1.0);
  o.depth = clamp(1.0 - y / (F.tank.y + 1.0), 0.0, 1.0);
  return o;
}`;

const WGSL_TOPBLUR = /* wgsl */`
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var<uniform> D: vec4f;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let p = vec2i(fc.xy);
  let sz = vec2i(textureDimensions(src)) - vec2i(1);
  let h0 = textureLoad(src, p, 0).r;
  if (h0 < 0.0) { return vec4f(-1.0); }
  let dir = vec2i(i32(D.x), i32(D.y));
  var s = 0.0; var w = 0.0;
  for (var i = -6; i <= 6; i++) {
    let h = textureLoad(src, clamp(p + dir * i, vec2i(0), sz), 0).r;
    if (h < 0.0) { continue; }
    let k = exp(-f32(i * i) / 18.0);
    s += h * k; w += k;
  }
  return vec4f(s / w, 0.0, 0.0, 1.0);
}`;

// Each grid vertex of the height map refracts the sun ray; the area change of the projected triangles on the floor
// gives the light concentration (1 = plain sunlight without water).
const WGSL_CAUSTIC = WGSL_FRAME + /* wgsl */`
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var topH: texture_2d<f32>;
@group(0) @binding(2) var ripple: texture_2d<f32>;
struct VO { @builtin(position) pos: vec4f, @location(0) old: vec2f, @location(1) t: f32 };
fn rippleSlope(xz: vec2f) -> vec2f {
  let R = vec2f(textureDimensions(ripple)) - 1.0;
  let q = clamp((xz - F.wmap.xy) / F.wmap.zw * R, vec2f(0.0), R);
  let b = vec2i(min(floor(q), R - 1.0));
  let f = q - vec2f(b);
  let s00 = textureLoad(ripple, b, 0).yz; let s10 = textureLoad(ripple, b + vec2i(1, 0), 0).yz;
  let s01 = textureLoad(ripple, b + vec2i(0, 1), 0).yz; let s11 = textureLoad(ripple, b + vec2i(1, 1), 0).yz;
  return mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);
}
fn hAt(p: vec2i) -> f32 {
  let sz = vec2i(textureDimensions(topH)) - vec2i(1);
  return textureLoad(topH, clamp(p, vec2i(0), sz), 0).r;
}
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VO {
  let dims = vec2i(textureDimensions(topH));
  // two triangles per grid cell
  let cell = i32(vi / 6u);
  let corner = vi % 6u;
  var offs = array<vec2i, 6>(vec2i(0, 0), vec2i(1, 0), vec2i(1, 1), vec2i(0, 0), vec2i(1, 1), vec2i(0, 1));
  let g = vec2i(cell % (dims.x - 1), cell / (dims.x - 1)) + offs[corner];
  let texel = F.wmap.zw / vec2f(dims);
  let xz = F.wmap.xy + (vec2f(g) + 0.5) * texel;
  let h = hAt(g);
  var o: VO;
  o.old = xz;
  var nxz = xz;
  var t = 1.0;
  if (h >= 0.0) {
    var hl = hAt(g - vec2i(1, 0)); if (hl < 0.0) { hl = h; }
    var hr = hAt(g + vec2i(1, 0)); if (hr < 0.0) { hr = h; }
    var hd = hAt(g - vec2i(0, 1)); if (hd < 0.0) { hd = h; }
    var hu = hAt(g + vec2i(0, 1)); if (hu < 0.0) { hu = h; }
    let rs = rippleSlope(xz);
    let n = normalize(vec3f(-(hr - hl) / (2.0 * texel.x) - rs.x, 1.0, -(hu - hd) / (2.0 * texel.y) - rs.y));
    let r = refract(-F.sunDir.xyz, n, 1.0 / 1.333);
    nxz = xz + r.xz * (h / max(-r.y, 0.05));
    t = 1.0 - fresnelW(dot(n, F.sunDir.xyz));
  }
  // shift by the flat-water offset so that calm water maps every texel onto itself
  let r0 = F.wmap2.xyz;
  let flatShift = select(vec2f(0.0), r0.xz * (h / -r0.y), h >= 0.0);
  let uv = (nxz - flatShift - F.wmap.xy) / F.wmap.zw;
  o.pos = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  o.t = t;
  return o;
}
@fragment fn fs(in: VO) -> @location(0) vec4f {
  let dx = dpdx(in.old); let dy = dpdy(in.old);
  let a = abs(dx.x * dy.y - dx.y * dy.x);
  let texel = F.wmap.zw / vec2f(textureDimensions(topH));
  return vec4f(in.t * a / (texel.x * texel.y), 0.0, 0.0, 1.0);
}`;
