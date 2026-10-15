// ============================================================
//  Capillary ripple layer
//  Short waves the liquid grid cannot resolve (rings from drops, rain, splashes) are solved on a fine 2D grid over
//  the tank footprint with the exact capillary-gravity dispersion. The cosine series (mirrored domain) gives
//  reflecting tank walls. Impacts found by the particle update feed it as pressure impulses.
// ============================================================

const WGSL_RIPPLE_COMMON = /* wgsl */`
struct RP { n: vec4u, l: vec4f, phys: vec4f, phys2: vec4f };
// n: physical cells R, FFT size M, unused, unused
// l: tank width, tank depth, dt, mean water depth
// phys: g, sigma/rho, nu, film damping
// phys2: high-pass wavenumber, impulse scale, unused, unused
@group(0) @binding(0) var<uniform> U: RP;
const PI: f32 = 3.141592653589793;
`;
// mirrored source field (pressure impulse density) -> complex input of the forward FFT
const WGSL_RSRC = WGSL_RIPPLE_COMMON + /* wgsl */`
@group(0) @binding(1) var<storage, read> src: array<i32>;
@group(0) @binding(2) var<storage, read_write> outB: array<vec2f>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let M = U.n.y; let R = U.n.x;
  let idx = gid.x;
  if (idx >= M * M) { return; }
  let i = idx % M; let j = idx / M;
  let pi = select(M - i, i, i <= R);
  let pj = select(M - j, j, j <= R);
  let dx = U.l.x / f32(R); let dz = U.l.y / f32(R);
  let v = f32(src[pj * (R + 1u) + pi]) / U.phys2.y / (dx * dz);
  outB[idx] = vec2f(v, 0.0);
}`;
// one radix-2 Stockham pass along x or z; the twiddle factors come from a table computed in double precision,
// because the shader's sin/cos are only accurate to about 1e-3 and the field goes through the transform every frame
const WGSL_RFFT = WGSL_RIPPLE_COMMON + /* wgsl */`
struct FP { ns: u32, horiz: u32, sign: f32, pad: u32 };
@group(0) @binding(1) var<storage, read> inB: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> outB: array<vec2f>;
@group(0) @binding(3) var<uniform> FPm: FP;
@group(0) @binding(4) var<storage, read> tw: array<vec2f>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let M = U.n.y;
  let id = gid.x;
  if (id >= M * M) { return; }
  let x = id % M; let y = id / M;
  let idx = select(y, x, FPm.horiz == 1u);
  let ns = FPm.ns;
  let hs = ns >> 1u;
  let e = (idx / ns) * hs + (idx % hs);
  let o = e + (M >> 1u);
  let ie = select(e * M + x, y * M + e, FPm.horiz == 1u);
  let io = select(o * M + x, y * M + o, FPm.horiz == 1u);
  let a = inB[ie]; let b = inB[io];
  let t = tw[(idx % ns) * (M / ns)];
  let w = vec2f(t.x, FPm.sign * t.y);
  outB[id] = a + vec2f(w.x * b.x - w.y * b.y, w.x * b.y + w.y * b.x);
}`;
// exact damped oscillator per mode + the new impulses (velocity kick at the end of the step)
const WGSL_REVOLVE = WGSL_RIPPLE_COMMON + /* wgsl */`
@group(0) @binding(1) var<storage, read_write> state: array<vec2f>;
@group(0) @binding(2) var<storage, read> srcHat: array<vec2f>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let M = U.n.y; let R = U.n.x;
  let id = gid.x;
  if (id >= M * M) { return; }
  let i = i32(id % M); let j = i32(id / M);
  let mx = select(i - i32(M), i, i < i32(R));
  let mz = select(j - i32(M), j, j < i32(R));
  if ((mx == 0 && mz == 0) || mx == -i32(R) || mz == -i32(R)) { state[id] = vec2f(0.0); return; }
  let kx = f32(mx) * PI / U.l.x; let kz = f32(mz) * PI / U.l.y;
  let kk = sqrt(kx * kx + kz * kz);
  let D = max(U.l.w, 0.002);
  let kd = min(kk * D, 15.0);
  let th = 1.0 - 2.0 / (exp(2.0 * kd) + 1.0);
  let w2 = (U.phys.x * kk + U.phys.y * kk * kk * kk) * th;
  let w = sqrt(w2);
  let gam = 2.0 * U.phys.z * kk * kk + U.phys.w * kk * sqrt(U.phys.z * w * 0.125) + kk * sqrt(U.phys.z * w * 0.5) / max(sinh(min(2.0 * kd, 30.0)), 1e-4);
  let wd = sqrt(max(w2 - gam * gam, 1e-6));
  let dt = U.l.z;
  var s = state[id];
  if (dt > 0.0) {
    let c = cos(wd * dt); let sn = sin(wd * dt); let e = exp(-gam * dt);
    s = e * vec2f(s.x * c + (s.y + gam * s.x) / wd * sn, s.y * c - (w2 * s.x + gam * s.y) / wd * sn);
  }
  // impulses are spread over a few millimetres and only the scales the liquid grid cannot carry are kept
  let hp = 1.0 - exp(-(kk * kk) / (U.phys2.x * U.phys2.x));
  let sw = max(1.2 * U.l.x / f32(R), 0.003);
  let spread = exp(-0.5 * kk * kk * sw * sw);
  s.y += -(kk * th / 998.0) * srcHat[id].x * hp * spread;
  state[id] = s;
}`;
const WGSL_RMASK = WGSL_RIPPLE_COMMON + /* wgsl */`
@group(0) @binding(1) var<storage, read> field: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> outB: array<vec2f>;
@group(0) @binding(3) var mask: texture_2d<f32>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let M = U.n.y; let R = U.n.x;
  let idx = gid.x;
  if (idx >= M * M) { return; }
  let i = idx % M; let j = idx / M;
  let pi = select(M - i, i, i <= R);
  let pj = select(M - j, j, j <= R);
  let m = textureLoad(mask, vec2i(i32(pi), i32(pj)), 0).r;
  outB[idx] = field[idx] * m;
}`;
// per ripple vertex: 1 on open water, falling to 0 inside obstacles at the water level and on dry floor
const WGSL_RMASKBUILD = WGSL_SIM_COMMON + WGSL_SDF(1) + /* wgsl */`
@group(0) @binding(2) var topH: texture_2d<f32>;
@group(0) @binding(3) var outTex: texture_storage_2d<r32float, write>;
@group(0) @binding(4) var<uniform> RU: vec4f;
@compute @workgroup_size(16, 16, 1) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let R = u32(RU.x);
  if (gid.x > R || gid.y > R) { return; }
  let uv = vec2f(gid.xy) / f32(R);
  let lo = P.origin.xz; let hi = P.origin.xz + vec2f(f32(P.dims.x), f32(P.dims.z)) * P.origin.w;
  let xz = lo + uv * (hi - lo);
  let dims = vec2f(textureDimensions(topH));
  let h = textureLoad(topH, vec2i(clamp(uv * dims, vec2f(0.0), dims - 1.0)), 0).r;
  var m = 0.0;
  if (h >= 0.0) {
    let d = sceneSdf(vec3f(xz.x, h - 0.002, xz.y));
    m = smoothstep(0.0, 0.006, d);
    // gentle absorption over a few frames rather than a hard edge
    m = mix(0.92, 1.0, m);
    if (d < 0.0) { m = 0.7; }
  } else { m = 0.75; }
  textureStore(outTex, vec2i(gid.xy), vec4f(m, 0.0, 0.0, 0.0));
}`;
const WGSL_RSCALE = WGSL_RIPPLE_COMMON + /* wgsl */`
@group(0) @binding(1) var<storage, read_write> state: array<vec2f>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let M = U.n.y;
  if (gid.x >= M * M) { return; }
  state[gid.x] = state[gid.x] / f32(M * M);
}`;
const WGSL_REXTRACT = WGSL_RIPPLE_COMMON + /* wgsl */`
@group(0) @binding(1) var<storage, read> field: array<vec2f>;
@group(0) @binding(2) var outTex: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(16, 16, 1) fn main(@builtin(global_invocation_id) gid: vec3u) {
  let R = U.n.x; let M = U.n.y;
  if (gid.x > R || gid.y > R) { return; }
  let s = 1.0 / f32(M * M);
  let i = gid.x; let j = gid.y;
  let h = field[j * M + i].x * s;
  let hl = field[j * M + (i + M - 1u) % M].x * s; let hr = field[j * M + (i + 1u) % M].x * s;
  let hd = field[((j + M - 1u) % M) * M + i].x * s; let hu = field[((j + 1u) % M) * M + i].x * s;
  let dx = U.l.x / f32(R); let dz = U.l.y / f32(R);
  textureStore(outTex, vec2i(gid.xy), vec4f(h, (hr - hl) / (2.0 * dx), (hu - hd) / (2.0 * dz), 0.0));
}`;

class RippleLayer {
  constructor(R) {
    this.R = R; this.M = 2 * R;
    const S = BU.STORAGE, D = BU.COPY_DST;
    const M2 = this.M * this.M;
    this.u = gbuf(64, BU.UNIFORM | D, 'rippleU');
    this.src = gbuf((R + 1) * (R + 1) * 4, S | D, 'rippleSrc');
    this.state = gbuf(M2 * 8, S | D, 'rippleState');
    this.a = gbuf(M2 * 8, S, 'rippleA');
    this.b = gbuf(M2 * 8, S, 'rippleB');
    this.hat = gbuf(M2 * 8, S, 'rippleHat');
    this.tex = device.createTexture({ size: [R + 1, R + 1], format: 'rgba16float', usage: TU.STORAGE_BINDING | TU.TEXTURE_BINDING | TU.COPY_SRC });
    this.view = this.tex.createView();
    this.maskTex = device.createTexture({ size: [R + 1, R + 1], format: 'r32float', usage: TU.STORAGE_BINDING | TU.TEXTURE_BINDING });
    this.maskView = this.maskTex.createView();
    this.maskU = gbuf(16, BU.UNIFORM | D, 'rippleMaskU');
    device.queue.writeBuffer(this.maskU, 0, new Float32Array([R, 0, 0, 0]));
    if (!RippleLayer.pipes) {
      RippleLayer.pipes = {
        src: computePipe(WGSL_RSRC, 'rsrc'), fft: computePipe(WGSL_RFFT, 'rfft'), evolve: computePipe(WGSL_REVOLVE, 'revolve'),
        extract: computePipe(WGSL_REXTRACT, 'rextract'), mask: computePipe(WGSL_RMASK, 'rmask'), maskBuild: computePipe(WGSL_RMASKBUILD, 'rmaskbuild'),
        scale: computePipe(WGSL_RSCALE, 'rscale'),
      };
    }
    const P = RippleLayer.pipes;
    // FFT pass parameter blocks: forward (source) and inverse (field); twiddles e^(2πi·t/M)
    const tw = new Float32Array(this.M * 2);
    for (let t = 0; t < this.M; t++) { tw[2 * t] = Math.cos((2 * Math.PI * t) / this.M); tw[2 * t + 1] = Math.sin((2 * Math.PI * t) / this.M); }
    this.tw = gbuf(tw.byteLength, S | D, 'rippleTwiddle');
    device.queue.writeBuffer(this.tw, 0, tw);
    this.fftU = [];
    for (const sign of [-1, 1]) for (const horiz of [1, 0]) for (let ns = 2; ns <= this.M; ns <<= 1) {
      const b = gbuf(16, BU.UNIFORM | D);
      const f = new ArrayBuffer(16);
      new Uint32Array(f, 0, 2).set([ns, horiz]);
      new Float32Array(f, 8, 1).set([sign]);
      device.queue.writeBuffer(b, 0, f);
      this.fftU.push({ sign, buf: b });
    }
    this.bg = {
      src: bindGroup(P.src, { 0: this.u, 1: this.src, 2: this.a }),
      evolve: bindGroup(P.evolve, { 0: this.u, 1: this.state, 2: this.hat }),
    };
    // ping-pong bind groups per FFT pass are built on demand
    this.fftBG = new Map();
    const enc = device.createCommandEncoder();
    enc.clearBuffer(this.state); enc.clearBuffer(this.src);
    device.queue.submit([enc.finish()]);
  }
  fftBind(inBuf, outBuf, u) {
    const key = inBuf.label + '>' + outBuf.label + '#' + this.fftU.indexOf(u);
    let g = this.fftBG.get(key);
    if (!g) { g = bindGroup(RippleLayer.pipes.fft, { 0: this.u, 1: inBuf, 2: outBuf, 3: u.buf, 4: this.tw }); this.fftBG.set(key, g); }
    return g;
  }
  // runs a 2D FFT of `input` (sign -1 forward, +1 inverse); returns the buffer holding the result
  encodeFFT(pass, input, sign, finalOut) {
    const list = this.fftU.filter((x) => x.sign === sign);
    let src = input;
    list.forEach((u, i) => {
      const last = i === list.length - 1;
      const dst = last ? finalOut : (src === this.a ? this.b : this.a);
      pass.setBindGroup(0, this.fftBind(src, dst, u));
      pass.dispatchWorkgroups(wgCount(this.M * this.M));
      src = dst;
    });
    return src;
  }
  // obstacles and water level come from the solver's objects and the renderer's top-view height map
  bindMask(simParams, objs, topHView) {
    const P = RippleLayer.pipes;
    this.bg.maskBuild = bindGroup(P.maskBuild, { 0: simParams, 1: objs, 2: topHView, 3: this.maskView, 4: this.maskU });
  }
  encodeFrame(enc, dt, tank, meanDepth, h) {
    const f = new ArrayBuffer(64);
    new Uint32Array(f, 0, 4).set([this.R, this.M, 0, 0]);
    new Float32Array(f, 16, 12).set([tank.w, tank.d, dt, meanDepth, G, PHYS_SIGMA_RHO, 1.0e-6, 0.3, (2 * Math.PI) / 0.12, RIPPLE_SCALE, 0, 0]);
    device.queue.writeBuffer(this.u, 0, f);
    const P = RippleLayer.pipes;
    const pass = enc.beginComputePass();
    pass.setPipeline(P.src); pass.setBindGroup(0, this.bg.src); pass.dispatchWorkgroups(wgCount(this.M * this.M));
    pass.setPipeline(P.fft);
    // forward transform of the source; the last pass lands in `hat`
    this.encodeFFT(pass, this.a, -1, this.hat);
    pass.setPipeline(P.evolve); pass.setBindGroup(0, this.bg.evolve); pass.dispatchWorkgroups(wgCount(this.M * this.M));
    pass.setPipeline(P.fft);
    const out = this.encodeFFT(pass, this.state, 1, this.b);
    pass.setPipeline(P.extract);
    pass.setBindGroup(0, this.extractBG(out));
    pass.dispatchWorkgroups(Math.ceil((this.R + 1) / 16), Math.ceil((this.R + 1) / 16));
    if (this.bg.maskBuild) {
      // absorb waves inside obstacles and on dry ground: mask the spatial field and transform it back
      pass.setPipeline(P.maskBuild); pass.setBindGroup(0, this.bg.maskBuild);
      pass.dispatchWorkgroups(Math.ceil((this.R + 1) / 16), Math.ceil((this.R + 1) / 16));
      pass.setPipeline(P.mask);
      if (!this.bg.mask) this.bg.mask = bindGroup(P.mask, { 0: this.u, 1: this.b, 2: this.a, 3: this.maskView });
      pass.setBindGroup(0, this.bg.mask); pass.dispatchWorkgroups(wgCount(this.M * this.M));
      pass.setPipeline(P.fft);
      this.encodeFFT(pass, this.a, -1, this.state);
      if (!this.bg.scale) this.bg.scale = bindGroup(P.scale, { 0: this.u, 1: this.state });
      pass.setPipeline(P.scale); pass.setBindGroup(0, this.bg.scale); pass.dispatchWorkgroups(wgCount(this.M * this.M));
    }
    pass.end();
    enc.clearBuffer(this.src);
  }
  extractBG(buf) {
    if (!this._ex || this._exBuf !== buf) { this._ex = bindGroup(RippleLayer.pipes.extract, { 0: this.u, 1: buf, 2: this.view }); this._exBuf = buf; }
    return this._ex;
  }
  clear() {
    const enc = device.createCommandEncoder();
    enc.clearBuffer(this.state); enc.clearBuffer(this.src);
    device.queue.submit([enc.finish()]);
  }
  destroy() {
    for (const b of [this.u, this.maskU, this.tw, this.src, this.state, this.a, this.b, this.hat, ...this.fftU.map((x) => x.buf)]) b.destroy();
    this.tex.destroy(); this.maskTex.destroy();
  }
}
const PHYS_SIGMA_RHO = 0.0728 / 998;
