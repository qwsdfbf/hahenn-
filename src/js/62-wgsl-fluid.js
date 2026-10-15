// ============================================================
//  WGSL: screen-space liquid surface, whitewater, composite, post
// ============================================================
const WGSL_PARTICLE_VS = /* wgsl */`
struct Particle { pos: vec4f, vel: vec4f };
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> parts: array<Particle>;
@group(0) @binding(2) var sceneDepth: texture_depth_2d;
struct VO {
  @builtin(position) pos: vec4f,
  @location(0) vc: vec3f,
  @location(1) q: vec3f,
  @location(2) @interpolate(flat) r: f32,
  @location(3) @interpolate(flat) kind: f32,
  @location(4) @interpolate(flat) life: f32,
};
fn corner(i: u32) -> vec2f {
  var c = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  return c[i];
}
fn sprite(center: vec3f, r: f32, vi: u32) -> VO {
  var o: VO;
  let c = (F.view * vec4f(center, 1.0)).xyz;
  let k = corner(vi);
  let q = c + vec3f(k * r * 1.45, 0.0);
  o.pos = F.proj * vec4f(q, 1.0);
  o.vc = c; o.q = q; o.r = r;
  return o;
}
`;

const WGSL_PDEPTH = WGSL_FRAME + WGSL_PARTICLE_VS + /* wgsl */`
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  let p = parts[ii];
  if (p.pos.w < 0.5) { var o: VO; o.pos = vec4f(3.0, 3.0, 3.0, 1.0); return o; }
  return sprite(p.pos.xyz, F.water.w, vi);
}
struct FO { @location(0) z: vec4f, @builtin(frag_depth) depth: f32 };
fn hit(in: VO) -> vec3f {
  let d = normalize(in.q);
  let b = dot(d, in.vc);
  let disc = b * b - (dot(in.vc, in.vc) - in.r * in.r);
  if (disc <= 0.0) { return vec3f(-1.0); }
  let t = b - sqrt(disc);
  return vec3f(t, 2.0 * sqrt(disc), 1.0);
}
@fragment fn fsDepth(in: VO) -> FO {
  let h = hit(in);
  if (h.z < 0.0 || h.x <= 0.0) { discard; }
  let pv = normalize(in.q) * h.x;
  let z = -pv.z;
  let zs = linDepth(textureLoad(sceneDepth, vec2i(in.pos.xy), 0));
  if (z > zs) { discard; }
  let clip = F.proj * vec4f(pv, 1.0);
  var o: FO;
  o.z = vec4f(z, 0.0, 0.0, 1.0);
  o.depth = clip.z / clip.w;
  return o;
}
@fragment fn fsThick(in: VO) -> @location(0) vec4f {
  let h = hit(in);
  if (h.z < 0.0 || h.x <= 0.0) { discard; }
  let z = -(normalize(in.q) * h.x).z;
  let zs = linDepth(textureLoad(sceneDepth, vec2i(in.pos.xy), 0));
  if (z > zs) { discard; }
  return vec4f(h.y, 0.0, 0.0, 1.0);
}`;

// whitewater sprites, attenuated when they sit below the liquid surface
const WGSL_WWDRAW = WGSL_FRAME + WGSL_PARTICLE_VS + /* wgsl */`
@group(0) @binding(3) var fluidDepth: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  let p = parts[ii];
  let kind = p.vel.w;
  var r = 0.0011;
  if (kind > 0.5 && kind < 1.5) { r = 0.0016; }
  if (kind > 1.5) { r = 0.0010; }
  let c = (F.view * vec4f(p.pos.xyz, 1.0)).xyz;
  let minR = 1.2 * F.eye.w * max(-c.z, 0.01);
  var o = sprite(p.pos.xyz, max(r, minR), vi);
  o.kind = kind;
  o.life = p.pos.w;
  return o;
}
@fragment fn fs(in: VO) -> @location(0) vec4f {
  let d2 = dot(in.q.xy - in.vc.xy, in.q.xy - in.vc.xy) / (in.r * in.r);
  if (d2 > 1.0) { discard; }
  let z = -in.vc.z;
  let ip = vec2i(in.pos.xy);
  let zs = linDepth(textureLoad(sceneDepth, ip, 0));
  if (z > zs) { discard; }
  var a = (1.0 - d2) * (1.0 - d2);
  var col = vec3f(1.0);
  let lit = (F.skyIrr.rgb + F.sunColor.rgb * max(F.sunDir.y, 0.0) * 0.6) / PI;
  if (in.kind < 0.5) { a *= 0.55; col = lit * 1.4; }
  else if (in.kind < 1.5) { a *= 0.7 * clamp(in.life * 1.5, 0.0, 1.0); col = lit * 1.15; }
  else { a *= 0.45; col = lit * 0.9; }
  let zf = textureLoad(fluidDepth, ip, 0).r;
  if (zf > 0.0 && z > zf + 0.003) {
    let k = exp(-(z - zf) / 0.025);
    a *= k;
    col *= vec3f(0.75, 0.92, 0.95);
  }
  return vec4f(col * a, a);
}`;

// narrow-range depth filter: farther samples are clamped, nearer ones ignored
const WGSL_SMOOTH = WGSL_FRAME + /* wgsl */`
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var inTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> D: vec4f;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let p = vec2i(fc.xy);
  let sz = vec2i(textureDimensions(inTex)) - vec2i(1);
  let z = textureLoad(inTex, p, 0).r;
  if (z <= 0.0) { return vec4f(0.0); }
  let r = F.water.w;
  let rpx = r * F.misc.x / z;
  let sig = clamp(rpx * 1.2, 1.0, 16.0);
  let R = i32(min(ceil(sig * 2.0), 32.0));
  let mu = r * 1.6;
  let dir = vec2i(i32(D.x), i32(D.y));
  var sum = 0.0;
  var ws = 0.0;
  for (var i = -32; i <= 32; i++) {
    if (i < -R || i > R) { continue; }
    let q = clamp(p + dir * i, vec2i(0), sz);
    var zq = textureLoad(inTex, q, 0).r;
    if (zq <= 0.0) { continue; }
    if (zq < z - mu) { continue; }
    zq = min(zq, z + mu);
    let w = exp(-f32(i * i) / (2.0 * sig * sig));
    sum += zq * w;
    ws += w;
  }
  return vec4f(sum / ws, 0.0, 0.0, 1.0);
}`;

const WGSL_COMPOSITE = WGSL_FRAME + WGSL_SCENE_BINDINGS + /* wgsl */`
@group(1) @binding(0) var sceneColor: texture_2d<f32>;
@group(1) @binding(1) var sceneDepth: texture_depth_2d;
@group(1) @binding(2) var fDepth: texture_2d<f32>;
@group(1) @binding(3) var fThick: texture_2d<f32>;
@group(1) @binding(4) var foam: texture_2d<f32>;
@group(1) @binding(5) var ripple: texture_2d<f32>;
fn rippleAt(xz: vec2f) -> vec4f {
  let R = f32(textureDimensions(ripple).x) - 1.0;
  let uv = ((xz - F.wmap.xy) / F.wmap.zw * R + 0.5) / (R + 1.0);
  if (any(uv < vec2f(0.0)) || any(uv > vec2f(1.0))) { return vec4f(0.0); }
  let r = textureSampleLevel(ripple, samp, uv, 0.0);
  let sl = length(r.yz);
  return vec4f(r.x, r.yz * min(1.0, 0.5 / max(sl, 1e-6)), 0.0);
}
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
fn viewPos(p: vec2i, z: f32) -> vec3f {
  let ndc = vec2f((f32(p.x) + 0.5) * F.screen.z * 2.0 - 1.0, 1.0 - (f32(p.y) + 0.5) * F.screen.w * 2.0);
  return vec3f(ndc.x * z / F.proj2.x, ndc.y * z / F.proj2.y, -z);
}
fn toWorld(v: vec3f) -> vec3f { return F.camRight.xyz * v.x + F.camUp.xyz * v.y + F.camBack.xyz * v.z; }
struct FO { @location(0) color: vec4f, @builtin(frag_depth) depth: f32 };
@fragment fn fs(@builtin(position) fc: vec4f) -> FO {
  let p = vec2i(fc.xy);
  let sz = vec2i(textureDimensions(fDepth)) - vec2i(1);
  let sc = textureLoad(sceneColor, p, 0).rgb;
  let sdep = textureLoad(sceneDepth, p, 0);
  let zs = linDepth(sdep);
  let z = textureLoad(fDepth, p, 0).r;
  let fm = textureLoad(foam, p, 0);
  var o: FO;
  o.depth = sdep;
  if (z <= 0.0 || z > zs * 1.003) {
    o.color = vec4f(sc * (1.0 - fm.a) + fm.rgb, 1.0);
    return o;
  }
  let P = viewPos(p, z);
  let zr = textureLoad(fDepth, min(p + vec2i(1, 0), sz), 0).r;
  let zl = textureLoad(fDepth, max(p - vec2i(1, 0), vec2i(0)), 0).r;
  let zu = textureLoad(fDepth, max(p - vec2i(0, 1), vec2i(0)), 0).r;
  let zd = textureLoad(fDepth, min(p + vec2i(0, 1), sz), 0).r;
  var ddx = vec3f(1.0, 0.0, 0.0);
  if (zr > 0.0 && (zl <= 0.0 || abs(zr - z) < abs(zl - z))) { ddx = viewPos(p + vec2i(1, 0), zr) - P; }
  else if (zl > 0.0) { ddx = P - viewPos(p - vec2i(1, 0), zl); }
  var ddy = vec3f(0.0, 1.0, 0.0);
  if (zu > 0.0 && (zd <= 0.0 || abs(zu - z) < abs(zd - z))) { ddy = viewPos(p - vec2i(0, 1), zu) - P; }
  else if (zd > 0.0) { ddy = P - viewPos(p + vec2i(0, 1), zd); }
  var nV = normalize(cross(ddx, ddy));
  if (dot(nV, -P) < 0.0) { nV = -nV; }
  var n = normalize(toWorld(nV));
  let V = normalize(toWorld(-P));
  let wp = F.eye.xyz + toWorld(P);
  // the free surface of pools: smooth normal from the top-view height map plus fine ripples
  let top = waterTop(wp.xz);
  if (top >= 0.0) {
    let near = 1.0 - smoothstep(0.006, 0.025, abs(wp.y - top));
    let e = F.wmap.zw / vec2f(textureDimensions(topH));
    let hl = waterTop(wp.xz - vec2f(e.x, 0.0)); let hr = waterTop(wp.xz + vec2f(e.x, 0.0));
    let hd = waterTop(wp.xz - vec2f(0.0, e.y)); let hu = waterTop(wp.xz + vec2f(0.0, e.y));
    let rp = rippleAt(wp.xz);
    if (near > 0.0 && min(min(hl, hr), min(hd, hu)) >= 0.0) {
      let gr = vec2f((hr - hl) / (2.0 * e.x), (hu - hd) / (2.0 * e.y));
      let flatness = 1.0 - smoothstep(0.25, 0.5, length(gr));
      let nh = normalize(vec3f(-gr.x - rp.y, 1.0, -gr.y - rp.z));
      n = normalize(mix(n, nh, near * flatness * smoothstep(0.2, 0.6, n.y)));
      nV = normalize(vec3f(dot(n, F.camRight.xyz), dot(n, F.camUp.xyz), dot(n, F.camBack.xyz)));
    }
  }
  let th = textureLoad(fThick, p, 0).r;
  let Fr = fresnelW(dot(n, V));
  let R = reflect(-V, n);
  var refl = skyL(R, 0.0);
  if (R.y < 0.0) {
    let ground = vec3f(0.5, 0.49, 0.46) * (F.sunColor.rgb * F.sunDir.y + F.skyIrr.rgb) / PI;
    refl = mix(refl, ground, clamp(-R.y * 4.0, 0.0, 1.0));
  }
  let tc = clamp(th, 0.0, 0.25);
  // a deep pool shifts the view in proportion to its depth
  let shift = nV.xy * min(tc * 0.35, 0.03) * F.misc.x / z;
  let uv = clamp((vec2f(p) + 0.5 + vec2f(-shift.x, shift.y)) * F.screen.zw, F.screen.zw, vec2f(1.0) - F.screen.zw);
  // what is seen through the water must lie behind its surface; a shifted sample that lands on something in front
  // of it (the near side of a cup standing in the pool) is replaced by the view straight through
  var behind = sc;
  if (linDepth(textureLoad(sceneDepth, vec2i(uv * F.screen.xy), 0)) > z) { behind = textureSampleLevel(sceneColor, samp, uv, 0.0).rgb; }
  // a thin stream or a drop is a strong lens: the ray leaves its far side bent by 2(θi − θt) towards the axis and
  // picks up what lies behind on the opposite side, so the surroundings show through it flipped and squeezed
  let thin = 1.0 - smoothstep(0.02, 0.06, tc);
  if (thin > 0.0) {
    let d = normalize(P);
    let ti = acos(clamp(-dot(d, nV), 0.0, 1.0));
    let dev = 2.0 * (ti - asin(sin(ti) / 1.333));
    let side = nV - d * dot(nV, d);
    let sl = length(side);
    if (sl > 1e-4) {
      let dx = normalize(d * cos(dev) - (side / sl) * sin(dev));
      let pb = P + dx * (max(zs - z, 0.02) / max(-dx.z, 0.2));
      let cb = F.proj * vec4f(pb, 1.0);
      let ub = vec2f(cb.x / cb.w * 0.5 + 0.5, 0.5 - cb.y / cb.w * 0.5);
      var seen = skyL(toWorld(dx), 0.0);
      if (cb.w > 0.0 && all(ub > F.screen.zw) && all(ub < vec2f(1.0) - F.screen.zw) && linDepth(textureLoad(sceneDepth, vec2i(ub * F.screen.xy), 0)) > z) {
        seen = textureSampleLevel(sceneColor, samp, ub, 0.0).rgb;
      }
      behind = mix(behind, seen, thin);
    }
  }
  let absorb = exp(-F.water.rgb * tc);
  let body = vec3f(0.06, 0.16, 0.17) * (F.skyIrr.rgb + F.sunColor.rgb * 0.3) * (1.0 - absorb.g);
  var col = mix(behind * absorb + body, refl, Fr);
  let sh = shadowAt(wp, n);
  col += ggxSpec(n, V, F.sunDir.xyz, 0.012, vec3f(0.0204)) * F.sunColor.rgb * max(dot(n, F.sunDir.xyz), 0.0) * sh;
  let Td = refract(-V, n, 1.0 / 1.333);
  col += F.sunColor.rgb * 0.08 * pow(max(dot(Td, F.sunDir.xyz), 0.0), 24.0) * (1.0 - Fr) * sh;
  let alpha = 1.0 - exp(-th * 900.0);
  col = mix(sc, col, alpha);
  col = col * (1.0 - fm.a) + fm.rgb;
  o.color = vec4f(col, 1.0);
  let clip = F.proj * vec4f(P, 1.0);
  o.depth = clip.z / clip.w;
  return o;
}`;

const WGSL_FULLSCREEN = /* wgsl */`
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VO;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
`;
const WGSL_DOWN = WGSL_FULLSCREEN + /* wgsl */`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> U: vec4f;
@fragment fn fs(in: VO) -> @location(0) vec4f {
  let t = U.xy;
  var c = textureSampleLevel(src, samp, in.uv + t * vec2f(-1.0, -1.0), 0.0).rgb + textureSampleLevel(src, samp, in.uv + t * vec2f(1.0, -1.0), 0.0).rgb
        + textureSampleLevel(src, samp, in.uv + t * vec2f(-1.0, 1.0), 0.0).rgb + textureSampleLevel(src, samp, in.uv + t * vec2f(1.0, 1.0), 0.0).rgb;
  c *= 0.25;
  if (U.z > 0.0) {
    let l = max(c.r, max(c.g, c.b));
    let k = max(l - U.z, 0.0);
    c = min(c * (k * k / (k + U.z) / max(l, 1e-4)), vec3f(200.0));
  }
  return vec4f(c, 1.0);
}`;
const WGSL_UP = WGSL_FULLSCREEN + /* wgsl */`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> U: vec4f;
@fragment fn fs(in: VO) -> @location(0) vec4f {
  let t = U.xy;
  var c = textureSampleLevel(src, samp, in.uv, 0.0).rgb * 4.0;
  c += (textureSampleLevel(src, samp, in.uv + vec2f(t.x, 0.0), 0.0).rgb + textureSampleLevel(src, samp, in.uv - vec2f(t.x, 0.0), 0.0).rgb
      + textureSampleLevel(src, samp, in.uv + vec2f(0.0, t.y), 0.0).rgb + textureSampleLevel(src, samp, in.uv - vec2f(0.0, t.y), 0.0).rgb) * 2.0;
  c += textureSampleLevel(src, samp, in.uv + t, 0.0).rgb + textureSampleLevel(src, samp, in.uv - t, 0.0).rgb
     + textureSampleLevel(src, samp, in.uv + vec2f(t.x, -t.y), 0.0).rgb + textureSampleLevel(src, samp, in.uv + vec2f(-t.x, t.y), 0.0).rgb;
  return vec4f(c / 16.0, 1.0);
}`;
const WGSL_TONEMAP = WGSL_FULLSCREEN + /* wgsl */`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var bloom: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> U: vec4f;
fn aces(x: vec3f) -> vec3f { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0)); }
@fragment fn fs(in: VO) -> @location(0) vec4f {
  var c = textureSampleLevel(src, samp, in.uv, 0.0).rgb + textureSampleLevel(bloom, samp, in.uv, 0.0).rgb * U.y;
  let q = (in.uv - 0.5) * U.zw;
  c *= 1.0 - 0.2 * dot(q, q);
  c = pow(aces(c * U.x), vec3f(1.0 / 2.2));
  let n = fract(sin(dot(in.pos.xy, vec2f(12.9898, 78.233))) * 43758.5453) - 0.5;
  return vec4f(c + n / 255.0, 1.0);
}`;
const WGSL_FXAA = WGSL_FULLSCREEN + /* wgsl */`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var mask: texture_2d<f32>;
@group(0) @binding(3) var<uniform> U: vec4f;
@fragment fn fs(in: VO) -> @location(0) vec4f {
  let px = U.xy;
  let L = vec3f(0.299, 0.587, 0.114);
  let cM = textureSampleLevel(src, samp, in.uv, 0.0).rgb;
  let lNW = dot(textureSampleLevel(src, samp, in.uv + vec2f(-1.0, -1.0) * px, 0.0).rgb, L);
  let lNE = dot(textureSampleLevel(src, samp, in.uv + vec2f(1.0, -1.0) * px, 0.0).rgb, L);
  let lSW = dot(textureSampleLevel(src, samp, in.uv + vec2f(-1.0, 1.0) * px, 0.0).rgb, L);
  let lSE = dot(textureSampleLevel(src, samp, in.uv + vec2f(1.0, 1.0) * px, 0.0).rgb, L);
  let lM = dot(cM, L);
  let lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  let lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  var col = cM;
  if (lMax - lMin >= max(0.0312, lMax * 0.125)) {
    var dir = vec2f(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
    let red = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
    dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + red), vec2f(-8.0), vec2f(8.0)) * px;
    let A = 0.5 * (textureSampleLevel(src, samp, in.uv + dir * (1.0 / 3.0 - 0.5), 0.0).rgb + textureSampleLevel(src, samp, in.uv + dir * (2.0 / 3.0 - 0.5), 0.0).rgb);
    let B = A * 0.5 + 0.25 * (textureSampleLevel(src, samp, in.uv - dir * 0.5, 0.0).rgb + textureSampleLevel(src, samp, in.uv + dir * 0.5, 0.0).rgb);
    let lB = dot(B, L);
    col = select(B, A, lB < lMin || lB > lMax);
  }
  // selection outline
  let ms = textureDimensions(mask);
  let mp = vec2i(in.uv * vec2f(ms));
  let m0 = textureLoad(mask, clamp(mp, vec2i(0), vec2i(ms) - 1), 0).r;
  var edge = 0.0;
  for (var i = -2; i <= 2; i++) {
    for (var j = -2; j <= 2; j++) {
      let mq = textureLoad(mask, clamp(mp + vec2i(i, j), vec2i(0), vec2i(ms) - 1), 0).r;
      edge = max(edge, abs(mq - m0));
    }
  }
  if (edge > 0.5 && m0 < 0.5) { col = mix(col, vec3f(1.0, 0.62, 0.15), 0.95); }
  return vec4f(col, 1.0);
}`;
const WGSL_MASK = WGSL_FRAME + /* wgsl */`
@group(0) @binding(0) var<uniform> F: Frame;
struct ObjU { model: mat4x4f, color: vec4f, mat: vec4f };
@group(1) @binding(0) var<uniform> O: ObjU;
@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f) -> @builtin(position) vec4f { return F.vp * O.model * vec4f(p, 1.0); }
@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }`;
