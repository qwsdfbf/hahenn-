// ============================================================
//  Renderer
// ============================================================
const HDR_FMT = 'rgba16float';
const SHADOW_SIZE = 2048;
const OBJ_STRIDE = 256;
const MAX_DRAW = 160;
const SUN = v3.norm([Math.cos(52 * DEG) * Math.sin(140 * DEG), Math.sin(52 * DEG), Math.cos(52 * DEG) * Math.cos(140 * DEG)]);
const LIGHT = { sunColor: [3.0, 2.86, 2.62], skyIrr: [0.55, 0.66, 0.84], absorb: [1.6, 0.42, 0.26], sunRad: 9000, exposure: 1.0 };

const sampLinear = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
const sampShadow = device.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' });

// ---------- sky cube ----------
const SKY_SIZE = 256;
const SKY_MIPS = 9;
const skyTex = device.createTexture({ size: [SKY_SIZE, SKY_SIZE, 6], format: 'rgba16float', mipLevelCount: SKY_MIPS, usage: TU.STORAGE_BINDING | TU.TEXTURE_BINDING });
(() => {
  const bake = computePipe(WGSL_SKYBAKE, 'skybake');
  const u = gbuf(16, BU.UNIFORM | BU.COPY_DST);
  device.queue.writeBuffer(u, 0, new Float32Array([...SUN, SKY_SIZE]));
  const enc = device.createCommandEncoder();
  let pass = enc.beginComputePass();
  pass.setPipeline(bake);
  pass.setBindGroup(0, bindGroup(bake, { 0: skyTex.createView({ dimension: '2d-array', baseMipLevel: 0, mipLevelCount: 1 }), 1: u }));
  pass.dispatchWorkgroups(SKY_SIZE / 8, SKY_SIZE / 8, 6);
  pass.end();
  const mip = computePipe(WGSL_MIP, 'skymip');
  for (let l = 1; l < SKY_MIPS; l++) {
    const s = SKY_SIZE >> l;
    pass = enc.beginComputePass();
    pass.setPipeline(mip);
    pass.setBindGroup(0, bindGroup(mip, {
      0: skyTex.createView({ dimension: '2d-array', baseMipLevel: l - 1, mipLevelCount: 1 }),
      1: skyTex.createView({ dimension: '2d-array', baseMipLevel: l, mipLevelCount: 1 }),
    }));
    pass.dispatchWorkgroups(Math.max(1, Math.ceil(s / 8)), Math.max(1, Math.ceil(s / 8)), 6);
    pass.end();
  }
  device.queue.submit([enc.finish()]);
})();
const skyView = skyTex.createView({ dimension: 'cube' });
const shadowTex = device.createTexture({ size: [SHADOW_SIZE, SHADOW_SIZE], format: 'depth32float', usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING });
const shadowView = shadowTex.createView();

// ---------- layouts ----------
const frameBuf = gbuf(544, BU.UNIFORM | BU.COPY_DST, 'frame');
const WMAP = 256;
const topHTex = device.createTexture({ size: [WMAP, WMAP], format: 'r32float', usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING });
const topBTex = device.createTexture({ size: [WMAP, WMAP], format: 'r32float', usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING });
const topDepth = device.createTexture({ size: [WMAP, WMAP], format: 'depth32float', usage: TU.RENDER_ATTACHMENT });
const causticTexW = device.createTexture({ size: [WMAP, WMAP], format: 'r16float', usage: TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING });
const topHView = topHTex.createView(), topBView = topBTex.createView(), topDepthView = topDepth.createView(), causticView = causticTexW.createView();
const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
const layoutFrame = device.createBindGroupLayout({ entries: [
  { binding: 0, visibility: VF, buffer: { type: 'uniform' } },
  { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
  { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: 'cube' } },
  { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
  { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
  { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
  { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
] });
const layoutFrameOnly = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: VF, buffer: { type: 'uniform' } }] });
const layoutObj = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: VF, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 96 } }] });
const layoutComp = device.createBindGroupLayout({ entries: [
  { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
  { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
  { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
  { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
  { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
  { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
] });
const frameBG = device.createBindGroup({ layout: layoutFrame, entries: [
  { binding: 0, resource: { buffer: frameBuf } }, { binding: 1, resource: sampLinear }, { binding: 2, resource: skyView },
  { binding: 3, resource: shadowView }, { binding: 4, resource: sampShadow },
  { binding: 5, resource: topHView }, { binding: 6, resource: causticView },
] });
const frameOnlyBG = device.createBindGroup({ layout: layoutFrameOnly, entries: [{ binding: 0, resource: { buffer: frameBuf } }] });
const objBuf = gbuf(OBJ_STRIDE * MAX_DRAW, BU.UNIFORM | BU.COPY_DST, 'objects');
const objBG = device.createBindGroup({ layout: layoutObj, entries: [{ binding: 0, resource: { buffer: objBuf, size: 96 } }] });

const VB_SOLID = [{ arrayStride: 24, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }] }];
const VB_GLASS = [{ arrayStride: 28, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }, { shaderLocation: 1, offset: 12, format: 'float32x3' }, { shaderLocation: 2, offset: 24, format: 'float32' }] }];
const BLEND_ALPHA = { color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } };
const BLEND_ADD = { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } };
const BLEND_PREMUL = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } };

function mod(code, label) { return device.createShaderModule({ code, label }); }
const modSolid = mod(WGSL_SOLID, 'solid');
const modSky = mod(WGSL_SKY, 'sky');
const modGlass = mod(WGSL_GLASS, 'glass');
const modPDepth = mod(WGSL_PDEPTH, 'pdepth');
const modWW = mod(WGSL_WWDRAW, 'wwdraw');
const modSmooth = mod(WGSL_SMOOTH, 'smooth');
const modComp = mod(WGSL_COMPOSITE, 'composite');
const modMask = mod(WGSL_MASK, 'mask');

const RP = {
  solid: device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layoutFrame, layoutObj] }),
    vertex: { module: modSolid, entryPoint: 'vs', buffers: VB_SOLID },
    fragment: { module: modSolid, entryPoint: 'fs', targets: [{ format: HDR_FMT }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
  }),
  shadow: device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layoutFrameOnly, layoutObj] }),
    vertex: { module: mod(WGSL_FRAME + '@group(0) @binding(0) var<uniform> F: Frame;\nstruct ObjU { model: mat4x4f, color: vec4f, mat: vec4f };\n@group(1) @binding(0) var<uniform> O: ObjU;\n@vertex fn vs(@location(0) p: vec3f, @location(1) n: vec3f) -> @builtin(position) vec4f { return F.shadowVp * O.model * vec4f(p, 1.0); }', 'shadow'), entryPoint: 'vs', buffers: VB_SOLID },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2.5 },
  }),
  sky: device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layoutFrame] }),
    vertex: { module: modSky, entryPoint: 'vs' },
    fragment: { module: modSky, entryPoint: 'fs', targets: [{ format: HDR_FMT }] },
    depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'less-equal' },
  }),
  glass: device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layoutFrame] }),
    vertex: { module: modGlass, entryPoint: 'vs', buffers: VB_GLASS },
    fragment: { module: modGlass, entryPoint: 'fs', targets: [{ format: HDR_FMT, blend: BLEND_ALPHA }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'less' },
  }),
  pdepth: device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: modPDepth, entryPoint: 'vs' },
    fragment: { module: modPDepth, entryPoint: 'fsDepth', targets: [{ format: 'r32float' }] },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
  }),
  pthick: device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: modPDepth, entryPoint: 'vs' },
    fragment: { module: modPDepth, entryPoint: 'fsThick', targets: [{ format: 'r16float', blend: BLEND_ADD }] },
  }),
  ww: device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: modWW, entryPoint: 'vs' },
    fragment: { module: modWW, entryPoint: 'fs', targets: [{ format: HDR_FMT, blend: BLEND_PREMUL }] },
  }),
  smooth: device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: modSmooth, entryPoint: 'vs' },
    fragment: { module: modSmooth, entryPoint: 'fs', targets: [{ format: 'r32float' }] },
  }),
  composite: device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layoutFrame, layoutComp] }),
    vertex: { module: modComp, entryPoint: 'vs' },
    fragment: { module: modComp, entryPoint: 'fs', targets: [{ format: HDR_FMT }] },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'always' },
  }),
  mask: device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [layoutFrameOnly, layoutObj] }),
    vertex: { module: modMask, entryPoint: 'vs', buffers: VB_SOLID },
    fragment: { module: modMask, entryPoint: 'fs', targets: [{ format: 'r8unorm' }] },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
  }),
};
const modTop = mod(WGSL_TOPH, 'toph'), modTopBlur = mod(WGSL_TOPBLUR, 'topblur'), modCaustic = mod(WGSL_CAUSTIC, 'caustic');
RP.top = device.createRenderPipeline({
  layout: 'auto',
  vertex: { module: modTop, entryPoint: 'vs' },
  fragment: { module: modTop, entryPoint: 'fs', targets: [{ format: 'r32float' }] },
  depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
});
RP.topBlur = device.createRenderPipeline({ layout: 'auto', vertex: { module: modTopBlur, entryPoint: 'vs' }, fragment: { module: modTopBlur, entryPoint: 'fs', targets: [{ format: 'r32float' }] } });
RP.caustic = device.createRenderPipeline({
  layout: 'auto',
  vertex: { module: modCaustic, entryPoint: 'vs' },
  fragment: { module: modCaustic, entryPoint: 'fs', targets: [{ format: 'r16float', blend: BLEND_ADD }] },
  primitive: { topology: 'triangle-list', cullMode: 'none' },
});
const topBlurBG = [
  [topHView, 0], [topBView, 1],
].map(([v, d]) => device.createBindGroup({ layout: RP.topBlur.getBindGroupLayout(0), entries: [{ binding: 1, resource: v }, { binding: 2, resource: { buffer: smoothDirBuf(d) } }] }));
const solverBG = { key: null, comp: null, caustic: null };
function solverBindGroups(sim) {
  const key = `${sim.serial}:${RT.serial}`;
  if (solverBG.key !== key) {
    solverBG.comp = device.createBindGroup({ layout: layoutComp, entries: [
      { binding: 0, resource: RT.sceneV }, { binding: 1, resource: RT.sceneDepthV }, { binding: 2, resource: RT.fBV }, { binding: 3, resource: RT.fThickV }, { binding: 4, resource: RT.foamV },
      { binding: 5, resource: sim.ripple.view },
    ] });
    solverBG.caustic = device.createBindGroup({ layout: RP.caustic.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: frameBuf } }, { binding: 1, resource: topHView }, { binding: 2, resource: sim.ripple.view }] });
    solverBG.key = key;
  }
  return solverBG;
}
const postPipe = (code, label, format) => {
  const m = mod(code, label);
  return device.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [{ format, blend: label === 'up' ? BLEND_ADD : undefined }] } });
};
RP.down = postPipe(WGSL_DOWN, 'down', HDR_FMT);
RP.up = postPipe(WGSL_UP, 'up', HDR_FMT);
RP.tonemap = postPipe(WGSL_TONEMAP, 'tonemap', 'rgba8unorm');
RP.fxaa = postPipe(WGSL_FXAA, 'fxaa', canvasFormat);

// ---------- meshes ----------
const meshCache = new Map();
function uploadMesh(mb) {
  const { verts, idx } = mb.build();
  const vb = device.createBuffer({ size: Math.max(verts.byteLength, 16), usage: BU.VERTEX | BU.COPY_DST });
  device.queue.writeBuffer(vb, 0, verts);
  const ib = device.createBuffer({ size: Math.max(Math.ceil(idx.byteLength / 4) * 4, 16), usage: BU.INDEX | BU.COPY_DST });
  device.queue.writeBuffer(ib, 0, idx);
  return { vb, ib, count: idx.length };
}
function cachedMesh(key, make) {
  let m = meshCache.get(key);
  if (!m) { m = uploadMesh(make()); meshCache.set(key, m); }
  m.used = true;
  return m;
}
function sweepMeshes() {
  for (const [k, m] of meshCache) {
    if (!m.used && !k.startsWith('static:')) { m.vb.destroy(); m.ib.destroy(); meshCache.delete(k); }
    m.used = false;
  }
}
const floorMesh = (() => {
  const mb = new MeshBuilder();
  const S = 30;
  const a = mb.vert([-S, 0, -S], [0, 1, 0]), b = mb.vert([S, 0, -S], [0, 1, 0]), c = mb.vert([S, 0, S], [0, 1, 0]), d = mb.vert([-S, 0, S], [0, 1, 0]);
  mb.quad(a, b, c, d);
  return uploadMesh(mb);
})();

// glass walls of the tank: per wall a slab; vertices carry an "edge" flag for the thin faces
function glassMesh(tank, which) {
  const t = 0.005;
  const hw = tank.w / 2, hd = tank.d / 2, H = tank.h;
  const v = [], idx = [];
  const slab = (lo, hi) => {
    const P = (x, y, z) => [x ? hi[0] : lo[0], y ? hi[1] : lo[1], z ? hi[2] : lo[2]];
    const ext = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const thin = ext.indexOf(Math.min(...ext));
    const faces = [
      [[1, 0, 0], [P(1, 0, 0), P(1, 1, 0), P(1, 1, 1), P(1, 0, 1)], 0],
      [[-1, 0, 0], [P(0, 0, 1), P(0, 1, 1), P(0, 1, 0), P(0, 0, 0)], 0],
      [[0, 1, 0], [P(0, 1, 0), P(0, 1, 1), P(1, 1, 1), P(1, 1, 0)], 1],
      [[0, -1, 0], [P(0, 0, 0), P(1, 0, 0), P(1, 0, 1), P(0, 0, 1)], 1],
      [[0, 0, 1], [P(0, 0, 1), P(1, 0, 1), P(1, 1, 1), P(0, 1, 1)], 2],
      [[0, 0, -1], [P(1, 0, 0), P(0, 0, 0), P(0, 1, 0), P(1, 1, 0)], 2],
    ];
    for (const [n, q, ax] of faces) {
      const edge = ax === thin ? 0 : 1;
      const base = v.length / 7;
      for (const p of q) v.push(p[0], p[1], p[2], n[0], n[1], n[2], edge);
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  };
  const walls = {
    px: [[hw, 0, -hd - t], [hw + t, H, hd + t]],
    nx: [[-hw - t, 0, -hd - t], [-hw, H, hd + t]],
    pz: [[-hw, 0, hd], [hw, H, hd + t]],
    nz: [[-hw, 0, -hd - t], [hw, H, -hd]],
  };
  for (const k of which) slab(...walls[k]);
  const vb = device.createBuffer({ size: Math.max(v.length * 4, 16), usage: BU.VERTEX | BU.COPY_DST });
  device.queue.writeBuffer(vb, 0, new Float32Array(v));
  const ib = device.createBuffer({ size: Math.max(idx.length * 4, 16), usage: BU.INDEX | BU.COPY_DST });
  device.queue.writeBuffer(ib, 0, new Uint32Array(idx));
  return { vb, ib, count: idx.length };
}
const glassCache = new Map();
function glassFor(tank, which) {
  const key = `${tank.w},${tank.h},${tank.d}:${which.join('')}`;
  let g = glassCache.get(key);
  if (!g) {
    if (glassCache.size > 24) { for (const x of glassCache.values()) { x.vb.destroy(); x.ib.destroy(); } glassCache.clear(); }
    g = glassFor.make(tank, which);
    glassCache.set(key, g);
  }
  return g;
}
glassFor.make = glassMesh;

// ---------- render targets ----------
let RT = null;
function buildTargets(w, h) {
  if (RT) for (const t of RT.all) t.destroy();
  const T = (format, usage, size = [w, h]) => device.createTexture({ size, format, usage: usage | TU.TEXTURE_BINDING });
  const RA = TU.RENDER_ATTACHMENT;
  const r = {
    w, h,
    scene: T(HDR_FMT, RA), sceneDepth: T('depth32float', RA),
    fDepth: T('r32float', RA), fDepthZ: T('depth32float', RA), fA: T('r32float', RA), fB: T('r32float', RA),
    fThick: T('r16float', RA), foam: T(HDR_FMT, RA),
    comp: T(HDR_FMT, RA), compDepth: T('depth32float', RA),
    ldr: T('rgba8unorm', RA), mask: T('r8unorm', RA),
    bloom: [],
  };
  let bw = w, bh = h;
  for (let i = 0; i < 6; i++) { bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1); r.bloom.push(T(HDR_FMT, RA, [bw, bh])); }
  r.all = [r.scene, r.sceneDepth, r.fDepth, r.fDepthZ, r.fA, r.fB, r.fThick, r.foam, r.comp, r.compDepth, r.ldr, r.mask, ...r.bloom];
  for (const k of Object.keys(r)) if (r[k] instanceof GPUTexture) r[k + 'V'] = r[k].createView();
  r.bloomV = r.bloom.map((t) => t.createView());
  // bind groups that only depend on targets
  r.smoothBG = [
    device.createBindGroup({ layout: RP.smooth.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: frameBuf } }, { binding: 1, resource: r.fDepthV }, { binding: 2, resource: { buffer: smoothDir[0] } }] }),
    device.createBindGroup({ layout: RP.smooth.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: frameBuf } }, { binding: 1, resource: r.fAV }, { binding: 2, resource: { buffer: smoothDir[1] } }] }),
    device.createBindGroup({ layout: RP.smooth.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: frameBuf } }, { binding: 1, resource: r.fBV }, { binding: 2, resource: { buffer: smoothDir[0] } }] }),
    device.createBindGroup({ layout: RP.smooth.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: frameBuf } }, { binding: 1, resource: r.fAV }, { binding: 2, resource: { buffer: smoothDir[1] } }] }),
  ];
  r.downBG = r.bloom.map((t, i) => device.createBindGroup({ layout: RP.down.getBindGroupLayout(0), entries: [
    { binding: 0, resource: i === 0 ? r.compV : r.bloomV[i - 1] }, { binding: 1, resource: sampLinear }, { binding: 2, resource: { buffer: postU[i] } },
  ] }));
  r.upBG = r.bloom.map((t, i) => device.createBindGroup({ layout: RP.up.getBindGroupLayout(0), entries: [
    { binding: 0, resource: r.bloomV[i] }, { binding: 1, resource: sampLinear }, { binding: 2, resource: { buffer: postU[6 + i] } },
  ] }));
  r.toneBG = device.createBindGroup({ layout: RP.tonemap.getBindGroupLayout(0), entries: [
    { binding: 0, resource: r.compV }, { binding: 1, resource: r.bloomV[0] }, { binding: 2, resource: sampLinear }, { binding: 3, resource: { buffer: postU[12] } },
  ] });
  r.fxaaBG = device.createBindGroup({ layout: RP.fxaa.getBindGroupLayout(0), entries: [
    { binding: 0, resource: r.ldrV }, { binding: 1, resource: sampLinear }, { binding: 2, resource: r.maskV }, { binding: 3, resource: { buffer: postU[13] } },
  ] });
  for (let i = 0; i < 6; i++) {
    const src = i === 0 ? [w, h] : [r.bloom[i - 1].width, r.bloom[i - 1].height];
    device.queue.writeBuffer(postU[i], 0, new Float32Array([0.5 / src[0], 0.5 / src[1], i === 0 ? 1.4 : 0, 0]));
    device.queue.writeBuffer(postU[6 + i], 0, new Float32Array([1 / r.bloom[i].width, 1 / r.bloom[i].height, 0, 0]));
  }
  device.queue.writeBuffer(postU[12], 0, new Float32Array([LIGHT.exposure, 0.3, w / Math.max(w, h), h / Math.max(w, h)]));
  device.queue.writeBuffer(postU[13], 0, new Float32Array([1 / w, 1 / h, 0, 0]));
  r.serial = (RT ? RT.serial : 0) + 1;
  RT = r;
}
const smoothDir = [0, 1].map(smoothDirBuf);
function smoothDirBuf(i) {
  smoothDirBuf.cache = smoothDirBuf.cache || [];
  if (!smoothDirBuf.cache[i]) {
    const b = gbuf(16, BU.UNIFORM | BU.COPY_DST);
    device.queue.writeBuffer(b, 0, new Float32Array(i === 0 ? [1, 0, 0, 0] : [0, 1, 0, 0]));
    smoothDirBuf.cache[i] = b;
  }
  return smoothDirBuf.cache[i];
}
const postU = Array.from({ length: 14 }, () => gbuf(16, BU.UNIFORM | BU.COPY_DST));
