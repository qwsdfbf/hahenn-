// ============================================================
//  WGSL: scene rendering (sky, solids, glass)
// ============================================================
const WGSL_FRAME = /* wgsl */`
struct Frame {
  vp: mat4x4f, invVp: mat4x4f, view: mat4x4f, proj: mat4x4f, shadowVp: mat4x4f,
  eye: vec4f,       // camera position, pixel angle
  sunDir: vec4f,    // direction to the sun, sun disc radiance
  sunColor: vec4f,  // irradiance, exposure
  skyIrr: vec4f,    // sky irradiance on an upward surface, time
  screen: vec4f,    // width, height, 1/width, 1/height
  proj2: vec4f,     // P00, P11, near, far
  tank: vec4f,      // half width, height, half depth, glass thickness
  water: vec4f,     // absorption rgb, particle radius
  camRight: vec4f, camUp: vec4f, camBack: vec4f,
  misc: vec4f,      // focal length in px, whitewater on, unused, unused
  wmap: vec4f,      // top-view water map: x min, z min, width, depth
  wmap2: vec4f,     // sunlight direction after refraction by flat water, unused
};
const PI: f32 = 3.14159265;
fn fresnelW(c: f32) -> f32 { let x = clamp(1.0 - c, 0.0, 1.0); return 0.0204 + 0.9796 * x * x * x * x * x; }
fn linDepth(d: f32) -> f32 { let n = F.proj2.z; let f = F.proj2.w; return n * f / (d * (n - f) + f); }
fn hash12(p: vec2f) -> f32 { var p3 = fract(vec3f(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2f(1.0, 0.0)), u.x), mix(hash12(i + vec2f(0.0, 1.0)), hash12(i + vec2f(1.0, 1.0)), u.x), u.y);
}
fn fbm(p0: vec2f) -> f32 { var p = p0; var s = 0.0; var a = 0.5; for (var i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + vec2f(1.7, 9.2); a *= 0.5; } return s; }
fn ggxSpec(n: vec3f, v: vec3f, l: vec3f, a: f32, f0: vec3f) -> vec3f {
  let nl = dot(n, l);
  if (nl <= 0.0) { return vec3f(0.0); }
  let h = normalize(l + v);
  let nv = max(dot(n, v), 1e-3); let nh = max(dot(n, h), 0.0); let vh = max(dot(v, h), 0.0);
  let a2 = a * a;
  let dd = nh * nh * (a2 - 1.0) + 1.0;
  let D = a2 / (PI * dd * dd);
  let k = a * 0.5;
  let Gs = (nl / (nl * (1.0 - k) + k)) * (nv / (nv * (1.0 - k) + k));
  let Fr = f0 + (vec3f(1.0) - f0) * pow(1.0 - vh, 5.0);
  return Fr * (D * Gs / (4.0 * nv));
}
`;

const WGSL_SKYBAKE = /* wgsl */`
@group(0) @binding(0) var outTex: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(1) var<uniform> S: vec4f;
fn hash12(p: vec2f) -> f32 { var p3 = fract(vec3f(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2f(1.0, 0.0)), u.x), mix(hash12(i + vec2f(0.0, 1.0)), hash12(i + vec2f(1.0, 1.0)), u.x), u.y);
}
fn fbm(p0: vec2f) -> f32 { var p = p0; var s = 0.0; var a = 0.5; for (var i = 0; i < 6; i++) { s += a * vnoise(p); p = p * 2.07 + vec2f(3.1, 1.3); a *= 0.5; } return s; }
fn faceDir(face: u32, st: vec2f) -> vec3f {
  let u = st.x * 2.0 - 1.0; let v = st.y * 2.0 - 1.0;
  switch face {
    case 0u: { return vec3f(1.0, -v, -u); }
    case 1u: { return vec3f(-1.0, -v, u); }
    case 2u: { return vec3f(u, 1.0, v); }
    case 3u: { return vec3f(u, -1.0, -v); }
    case 4u: { return vec3f(u, -v, 1.0); }
    default: { return vec3f(-u, -v, -1.0); }
  }
}
@compute @workgroup_size(8, 8, 1) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let size = u32(S.w);
  if (gid.x >= size || gid.y >= size) { return; }
  let d = normalize(faceDir(gid.z, (vec2f(gid.xy) + 0.5) / f32(size)));
  let sun = S.xyz;
  let mu = dot(d, sun);
  let h = max(d.y, 0.0);
  let zenith = vec3f(0.07, 0.18, 0.48);
  let horizon = vec3f(0.48, 0.60, 0.74);
  var c = mix(horizon, zenith, pow(h, 0.42));
  c *= 1.0 + 0.3 * mu * mu;
  c += vec3f(1.0, 0.86, 0.68) * (0.1 * pow(max(mu, 0.0), 5.0) + 0.5 * pow(max(mu, 0.0), 90.0));
  if (d.y > 0.0) {
    let p = d.xz / (d.y + 0.06) * 0.9;
    let n = fbm(p * 1.1 + vec2f(4.0, 7.0));
    let cov = smoothstep(0.5, 0.78, n) * smoothstep(0.0, 0.1, d.y);
    let sh = fbm(p * 1.1 + vec2f(4.0, 7.0) + sun.xz * 0.15);
    let lit = clamp(0.62 + 1.6 * (n - sh) + 0.35 * max(mu, 0.0), 0.35, 1.25);
    c = mix(c, vec3f(1.0, 0.98, 0.95) * 1.15 * lit, cov * 0.92);
  } else {
    let ground = vec3f(0.26, 0.25, 0.23);
    c = mix(horizon * 0.85, ground, smoothstep(0.0, -0.12, d.y));
  }
  textureStore(outTex, vec2i(gid.xy), i32(gid.z), vec4f(c, 1.0));
}`;

const WGSL_MIP = /* wgsl */`
@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var dst: texture_storage_2d_array<rgba16float, write>;
@compute @workgroup_size(8, 8, 1) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let size = textureDimensions(dst).x;
  if (gid.x >= size || gid.y >= size) { return; }
  let p = vec2i(gid.xy) * 2;
  let f = i32(gid.z);
  let c = textureLoad(src, p, f, 0) + textureLoad(src, p + vec2i(1, 0), f, 0) + textureLoad(src, p + vec2i(0, 1), f, 0) + textureLoad(src, p + vec2i(1, 1), f, 0);
  textureStore(dst, vec2i(gid.xy), f, c * 0.25);
}`;

const WGSL_SCENE_BINDINGS = /* wgsl */`
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var skyTex: texture_cube<f32>;
@group(0) @binding(3) var shadowMap: texture_depth_2d;
@group(0) @binding(4) var shadowSamp: sampler_comparison;
@group(0) @binding(5) var topH: texture_2d<f32>;
@group(0) @binding(6) var causticTex: texture_2d<f32>;
fn waterTop(xz: vec2f) -> f32 {
  let uv = (xz - F.wmap.xy) / F.wmap.zw;
  if (any(uv < vec2f(0.0)) || any(uv >= vec2f(1.0))) { return -1.0; }
  let dims = vec2f(textureDimensions(topH));
  return textureLoad(topH, vec2i(uv * dims), 0).r;
}
// sunlight factor and colour change for a point that may lie under the water surface
fn underwaterSun(wp: vec3f) -> vec3f {
  let h = waterTop(wp.xz);
  if (h < 0.0 || wp.y > h - 0.0005) { return vec3f(1.0); }
  let uv = (wp.xz - F.wmap.xy) / F.wmap.zw;
  let c = textureSampleLevel(causticTex, samp, uv, 0.0).r;
  let path = (h - wp.y) / max(-F.wmap2.y, 0.2);
  return c * exp(-F.water.rgb * path);
}
fn underwaterAmb(wp: vec3f) -> vec3f {
  let h = waterTop(wp.xz);
  if (h < 0.0 || wp.y > h) { return vec3f(1.0); }
  return 0.9 * exp(-F.water.rgb * (h - wp.y) * 1.5);
}
fn shadowAt(wp: vec3f, n: vec3f) -> f32 {
  let p = F.shadowVp * vec4f(wp + n * 0.0015, 1.0);
  let uv = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0)) || p.z > 1.0) { return 1.0; }
  let texel = 1.0 / f32(textureDimensions(shadowMap).x);
  var s = 0.0;
  for (var i = -1; i <= 1; i++) {
    for (var j = -1; j <= 1; j++) {
      s += textureSampleCompareLevel(shadowMap, shadowSamp, uv + vec2f(f32(i), f32(j)) * texel * 1.3, p.z - 0.0008);
    }
  }
  return s / 9.0;
}
fn skyL(d: vec3f, lod: f32) -> vec3f { return textureSampleLevel(skyTex, samp, d, lod).rgb; }
fn ambientIrr(n: vec3f) -> vec3f {
  let ground = vec3f(0.30, 0.29, 0.27) * (F.sunColor.rgb * F.sunDir.y + F.skyIrr.rgb) / PI;
  return mix(ground, F.skyIrr.rgb, clamp(n.y * 0.5 + 0.5, 0.0, 1.0));
}
`;

const WGSL_SOLID = WGSL_FRAME + WGSL_SCENE_BINDINGS + /* wgsl */`
struct ObjU { model: mat4x4f, color: vec4f, mat: vec4f };
@group(1) @binding(0) var<uniform> O: ObjU;
struct VO { @builtin(position) pos: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) lp: vec3f };
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f) -> VO {
  let w = O.model * vec4f(p, 1.0);
  var o: VO;
  o.pos = F.vp * w;
  o.wp = w.xyz;
  o.n = (O.model * vec4f(n, 0.0)).xyz;
  o.lp = p;
  return o;
}
@vertex fn vsShadow(@location(0) p: vec3f, @location(1) n: vec3f) -> @builtin(position) vec4f {
  return F.shadowVp * O.model * vec4f(p, 1.0);
}
// large stone floor tiles with grout lines
fn floorTiles(p: vec2f, fp: f32) -> vec3f {
  let T = 0.2;
  let g = p / T;
  let cell = floor(g);
  let e = min(fract(g), 1.0 - fract(g)) * T;
  let d = min(e.x, e.y);
  let w = max(fp, 2e-4);
  let grout = (1.0 - smoothstep(0.0025 - w, 0.0025 + w, d)) * (1.0 - smoothstep(0.004, 0.02, fp));
  let h = hash12(cell);
  let n = fbm(p * 7.0 + h * 13.0);
  let fine = mix(0.5, vnoise(p * 120.0 + h * 5.0), 1.0 - smoothstep(0.001, 0.004, fp));
  let base = mix(vec3f(0.46, 0.45, 0.43), vec3f(0.60, 0.59, 0.56), h) * (0.84 + 0.26 * n + 0.08 * (fine - 0.5));
  return mix(base, vec3f(0.24, 0.24, 0.23), grout);
}
@fragment fn fs(in: VO, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  var n = normalize(in.n);
  if (!ff) { n = -n; }
  let Vv = F.eye.xyz - in.wp;
  let dist = length(Vv);
  let V = Vv / dist;
  var alb = O.color.rgb;
  var rough = O.mat.x;
  let metal = O.mat.y;
  let kind = O.mat.z;
  if (kind > 1.5 && kind < 2.5) {
    let fp = F.eye.w * dist / max(abs(dot(n, V)), 0.1);
    alb = floorTiles(in.wp.xz, fp);
  } else if (kind > 0.5 && kind < 1.5) {
    let q = in.lp * 60.0;
    let s = fbm(q.xz + q.y * 1.7) * 0.6 + fbm(q.zy * 2.3) * 0.4;
    alb *= 0.72 + 0.5 * s;
    rough = clamp(rough + 0.1 * (s - 0.5), 0.3, 1.0);
  } else if (kind > 2.5 && kind < 3.5) {
    alb = vec3f(0.015, 0.016, 0.018);
  }
  let a = max(rough * rough, 0.002);
  let f0 = mix(vec3f(0.04), alb, metal);
  let sh = shadowAt(in.wp, n);
  let uw = underwaterSun(in.wp);
  let ua = underwaterAmb(in.wp);
  let L = F.sunDir.xyz;
  let nl = max(dot(n, L), 0.0);
  let spec = ggxSpec(n, V, L, a, f0);
  let kd = (vec3f(1.0) - f0) * (1.0 - metal);
  var col = (kd * alb / PI + spec) * F.sunColor.rgb * nl * sh * uw;
  let nv = max(dot(n, V), 1e-3);
  let Fa = f0 + (max(vec3f(1.0 - rough), f0) - f0) * pow(1.0 - nv, 5.0);
  col += kd * alb * ambientIrr(n) / PI * 0.95 * ua;
  let R = reflect(-V, n);
  col += skyL(R, rough * 7.0) * Fa * mix(0.55, 1.0, sh) * (1.0 - 0.6 * f32(kind > 1.5 && kind < 2.5));
  if (kind > 1.5 && kind < 2.5) { col = mix(col, vec3f(0.42, 0.52, 0.64), 1.0 - exp(-dist * 0.04)); }
  col += O.color.rgb * O.mat.w;
  return vec4f(col, 1.0);
}`;

const WGSL_SKY = WGSL_FRAME + WGSL_SCENE_BINDINGS + /* wgsl */`
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VO;
  o.pos = vec4f(p * 2.0 - 1.0, 1.0, 1.0);
  o.uv = p;
  return o;
}
@fragment fn fs(in: VO) -> @location(0) vec4f {
  let ndc = vec2f(in.uv.x * 2.0 - 1.0, in.uv.y * 2.0 - 1.0);
  let w = F.invVp * vec4f(ndc, 1.0, 1.0);
  let d = normalize(w.xyz / w.w - F.eye.xyz);
  var c = skyL(d, 0.0);
  c += vec3f(1.0, 0.95, 0.88) * F.sunDir.w * smoothstep(0.99998, 0.999989, dot(d, F.sunDir.xyz));
  return vec4f(c, 1.0);
}`;

// thin glass walls of the tank; edge faces show the green tint of the glass body
const WGSL_GLASS = WGSL_FRAME + WGSL_SCENE_BINDINGS + /* wgsl */`
struct VO { @builtin(position) pos: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) edge: f32 };
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f, @location(2) edge: f32) -> VO {
  var o: VO;
  o.pos = F.vp * vec4f(p, 1.0);
  o.wp = p; o.n = n; o.edge = edge;
  return o;
}
@fragment fn fs(in: VO, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  var n = normalize(in.n);
  if (!ff) { n = -n; }
  let V = normalize(F.eye.xyz - in.wp);
  let c = abs(dot(n, V));
  let f0 = 0.04;
  let Fr = f0 + (1.0 - f0) * pow(1.0 - c, 5.0);
  let refl = skyL(reflect(-V, n), 0.0);
  let spec = ggxSpec(n, V, F.sunDir.xyz, 0.02, vec3f(f0)) * F.sunColor.rgb * max(dot(n, F.sunDir.xyz), 0.0);
  if (in.edge > 0.5) {
    let tint = vec3f(0.42, 0.62, 0.55) * (ambientIrr(n) + F.sunColor.rgb * max(dot(n, F.sunDir.xyz), 0.0) * 0.3) * 0.7;
    return vec4f(tint + spec, 0.85);
  }
  let alpha = clamp(Fr + 0.035, 0.0, 1.0);
  return vec4f((refl * Fr + spec + vec3f(0.004, 0.008, 0.007)) / alpha, alpha);
}`;
