// ============================================================
//  Camera and per-frame drawing
// ============================================================
const cam = { target: [0, 0.1, 0], dist: 1.05, az: 0.55, el: 0.42, fov: 36 * DEG, near: 0.005, far: 60 };
const view = { eye: [0, 0, 0], fwd: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0], V: null, P: null, VP: null, invVP: null, focal: 1, pixAng: 0.001, w: 1, h: 1 };
function updateCamera(w, h) {
  const ce = Math.cos(cam.el), se = Math.sin(cam.el);
  const eye = [cam.target[0] + cam.dist * ce * Math.sin(cam.az), cam.target[1] + cam.dist * se, cam.target[2] + cam.dist * ce * Math.cos(cam.az)];
  const up = Math.abs(se) > 0.999 ? [-Math.sin(cam.az) * Math.sign(se), 0, -Math.cos(cam.az) * Math.sign(se)] : [0, 1, 0];
  const V = m4.lookAt(eye, cam.target, up);
  const P = m4.perspective(cam.fov, w / h, cam.near, cam.far);
  view.eye = eye;
  view.fwd = v3.norm(v3.sub(cam.target, eye));
  view.right = v3.norm(v3.cross(view.fwd, up));
  view.up = v3.cross(view.right, view.fwd);
  view.V = V; view.P = P; view.VP = m4.mul(P, V); view.invVP = m4.inv(view.VP);
  view.focal = h * 0.5 / Math.tan(cam.fov / 2);
  view.pixAng = 2 * Math.tan(cam.fov / 2) / h;
  view.w = w; view.h = h;
}
function shadowMatrix() {
  const R = Math.max(0.55, Math.hypot(scene.tank.w, scene.tank.d) * 0.5 + 0.35);
  const c = [0, scene.tank.h * 0.5, 0];
  const eye = v3.add(c, v3.mul(SUN, 3));
  const V = m4.lookAt(eye, c, Math.abs(SUN[1]) > 0.99 ? [1, 0, 0] : [0, 1, 0]);
  return m4.mul(m4.ortho(-R, R, -R, R, 0.5, 6), V);
}

const frameF = new Float32Array(136);
function writeFrame(sim) {
  const f = frameF;
  f.set(view.VP, 0); f.set(view.invVP, 16); f.set(view.V, 32); f.set(view.P, 48); f.set(shadowMatrix(), 64);
  f.set([...view.eye, view.pixAng], 80);
  f.set([...SUN, LIGHT.sunRad], 84);
  f.set([...LIGHT.sunColor, LIGHT.exposure], 88);
  f.set([...LIGHT.skyIrr, sim ? sim.time : 0], 92);
  f.set([view.w, view.h, 1 / view.w, 1 / view.h], 96);
  f.set([view.P[0], view.P[5], cam.near, cam.far], 100);
  f.set([scene.tank.w / 2, scene.tank.h, scene.tank.d / 2, 0.005], 104);
  f.set([...LIGHT.absorb, sim ? sim.radius : 0.004], 108);
  f.set([...view.right, 0], 112);
  f.set([...view.up, 0], 116);
  f.set([-view.fwd[0], -view.fwd[1], -view.fwd[2], 0], 120);
  f.set([view.focal, settings.whitewater ? 1 : 0, 0, 0], 124);
  // the water map follows the solver's grid footprint exactly
  if (sim) f.set([sim.origin[0], sim.origin[2], sim.nx * sim.h, sim.nz * sim.h], 128);
  else f.set([-scene.tank.w / 2, -scene.tank.d / 2, scene.tank.w, scene.tank.d], 128);
  const ct = SUN[1], st = Math.sqrt(1 - ct * ct) / 1.333;
  f.set([-SUN[0] / 1.333, -Math.sqrt(1 - st * st), -SUN[2] / 1.333, 0], 132);
  device.queue.writeBuffer(frameBuf, 0, f);
}

// orientation that maps local -Y (nozzle outlet) onto the source direction
function rotFromDown(dir) {
  const from = [0, -1, 0];
  const c = v3.dot(from, dir);
  if (c > 0.9999) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (c < -0.9999) return [1, 0, 0, 0, -1, 0, 0, 0, -1];
  const axis = v3.cross(from, dir);
  return m3.axisAngle(axis, Math.acos(clamp(c, -1, 1)));
}

const objF = new Float32Array((OBJ_STRIDE / 4) * MAX_DRAW);
function buildDraws() {
  const draws = [];
  const push = (mesh, R, t, color, mat, shadow = true, item = null) => draws.push({ mesh, model: m4.fromRT(R, t), color, mat, shadow, item });
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  push(floorMesh, I, [0, 0, 0], [0.56, 0.55, 0.52], [0.85, 0, 2, 0], false);
  for (const it of scene.items) {
    if (it.kind === 'obstacle') {
      const sp = shapeParams(it);
      const key = `o:${sp.map((x) => x.toFixed(5)).join(',')}`;
      const mesh = cachedMesh(key, () => meshForObstacle(it));
      const m = MATERIALS[it.material] || MATERIALS.ceramic;
      push(mesh, obstacleRot(it), it.pos, hexToRgb(it.color), [m.rough, m.metal, it.material === 'stone' ? 1 : 0, 0], true, it);
    } else if (it.kind === 'source') {
      if (it.mode === 'rain') continue;
      const d = sourceOutlet(it);
      const key = `n:${d.toFixed(4)}`;
      const mesh = cachedMesh(key, () => meshNozzle(d));
      push(mesh, rotFromDown(sourceDir(it)), it.pos, [0.82, 0.83, 0.85], [0.22, 1, 0, 0], true, it);
    } else if (it.kind === 'drain') {
      const R = m3.euler(it.rot[0], it.rot[1], it.rot[2]);
      push(cachedMesh(`d:${it.r.toFixed(4)}`, () => meshDrainRing(it.r)), R, it.pos, [0.7, 0.71, 0.73], [0.3, 1, 0, 0], false, it);
      push(cachedMesh(`dd:${it.r.toFixed(4)}`, () => meshDisc(Math.max(it.r - 0.004, 0.002), 0.0008)), R, it.pos, [0, 0, 0], [0.9, 0, 3, 0], false, it);
    }
  }
  return draws.slice(0, MAX_DRAW);
}

const pBGCache = { key: null, depth: null, thick: null, ww: null };
function particleBGs(sim) {
  const key = `${sim.serial}:${sim.cur}:${sim.wwCur}:${RT.serial}`;
  if (pBGCache.key !== key) {
    const mk = (pipe, buf, extra) => device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: frameBuf } }, { binding: 1, resource: { buffer: buf } }, { binding: 2, resource: RT.sceneDepthV }, ...(extra || []),
    ] });
    pBGCache.depth = mk(RP.pdepth, sim.parts[sim.cur]);
    pBGCache.thick = mk(RP.pthick, sim.parts[sim.cur]);
    pBGCache.ww = mk(RP.ww, sim.ww[sim.wwCur], [{ binding: 3, resource: RT.fBV }]);
    pBGCache.top = device.createBindGroup({ layout: RP.top.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: frameBuf } }, { binding: 1, resource: { buffer: sim.parts[sim.cur] } }] });
    pBGCache.key = key;
  }
  return pBGCache;
}

function drawFrame(sim, overlayFn) {
  updateCamera(RT.w, RT.h);
  writeFrame(sim);
  for (const m of meshCache.values()) m.used = false;
  const draws = buildDraws();
  sweepMeshes();
  draws.forEach((d, i) => {
    const o = (OBJ_STRIDE / 4) * i;
    objF.set(d.model, o);
    objF.set([...d.color, 1], o + 16);
    objF.set(d.mat, o + 20);
  });
  device.queue.writeBuffer(objBuf, 0, objF, 0, (OBJ_STRIDE / 4) * draws.length);

  const enc = device.createCommandEncoder();
  // water surface seen from above, then the light it focuses on the floor
  const pbg0 = particleBGs(sim);
  let wpass = enc.beginRenderPass({
    colorAttachments: [{ view: topHView, clearValue: [-1, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }],
    depthStencilAttachment: { view: topDepthView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
  });
  wpass.setPipeline(RP.top); wpass.setBindGroup(0, pbg0.top); wpass.drawIndirect(sim.args, 24);
  wpass.end();
  for (const [bg, dst] of [[topBlurBG[0], topBView], [topBlurBG[1], topHView], [topBlurBG[0], topBView], [topBlurBG[1], topHView]]) {
    wpass = enc.beginRenderPass({ colorAttachments: [{ view: dst, clearValue: [-1, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }] });
    wpass.setPipeline(RP.topBlur); wpass.setBindGroup(0, bg); wpass.draw(3);
    wpass.end();
  }
  wpass = enc.beginRenderPass({ colorAttachments: [{ view: causticView, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }] });
  const sbg = solverBindGroups(sim);
  wpass.setPipeline(RP.caustic); wpass.setBindGroup(0, sbg.caustic); wpass.draw((WMAP - 1) * (WMAP - 1) * 6);
  wpass.end();
  // shadows
  let pass = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: shadowView, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } });
  pass.setPipeline(RP.shadow);
  pass.setBindGroup(0, frameOnlyBG);
  draws.forEach((d, i) => {
    if (!d.shadow) return;
    pass.setBindGroup(1, objBG, [i * OBJ_STRIDE]);
    pass.setVertexBuffer(0, d.mesh.vb); pass.setIndexBuffer(d.mesh.ib, 'uint32');
    pass.drawIndexed(d.mesh.count);
  });
  pass.end();

  // opaque scene, sky, far glass walls
  pass = enc.beginRenderPass({
    colorAttachments: [{ view: RT.sceneV, clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }],
    depthStencilAttachment: { view: RT.sceneDepthV, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
  });
  pass.setPipeline(RP.solid);
  pass.setBindGroup(0, frameBG);
  draws.forEach((d, i) => {
    pass.setBindGroup(1, objBG, [i * OBJ_STRIDE]);
    pass.setVertexBuffer(0, d.mesh.vb); pass.setIndexBuffer(d.mesh.ib, 'uint32');
    pass.drawIndexed(d.mesh.count);
  });
  pass.setPipeline(RP.sky);
  pass.setBindGroup(0, frameBG);
  pass.draw(3);
  const t = scene.tank, e = view.eye;
  const near = [], far = [];
  (e[0] > t.w / 2 ? near : far).push('px');
  (e[0] < -t.w / 2 ? near : far).push('nx');
  (e[2] > t.d / 2 ? near : far).push('pz');
  (e[2] < -t.d / 2 ? near : far).push('nz');
  if (far.length) {
    const g = glassFor(t, far);
    pass.setPipeline(RP.glass);
    pass.setBindGroup(0, frameBG);
    pass.setVertexBuffer(0, g.vb); pass.setIndexBuffer(g.ib, 'uint32');
    pass.drawIndexed(g.count);
  }
  pass.end();

  // liquid surface depth, thickness and smoothing
  const pbg = particleBGs(sim);
  pass = enc.beginRenderPass({
    colorAttachments: [{ view: RT.fDepthV, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }],
    depthStencilAttachment: { view: RT.fDepthZV, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
  });
  pass.setPipeline(RP.pdepth); pass.setBindGroup(0, pbg.depth); pass.drawIndirect(sim.args, 24);
  pass.end();
  pass = enc.beginRenderPass({ colorAttachments: [{ view: RT.fThickV, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }] });
  pass.setPipeline(RP.pthick); pass.setBindGroup(0, pbg.thick); pass.drawIndirect(sim.args, 24);
  pass.end();
  const smoothTargets = [RT.fAV, RT.fBV, RT.fAV, RT.fBV];
  for (let i = 0; i < 4; i++) {
    pass = enc.beginRenderPass({ colorAttachments: [{ view: smoothTargets[i], clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(RP.smooth); pass.setBindGroup(0, RT.smoothBG[i]); pass.draw(3);
    pass.end();
  }
  // whitewater
  pass = enc.beginRenderPass({ colorAttachments: [{ view: RT.foamV, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }] });
  if (settings.whitewater) { pass.setPipeline(RP.ww); pass.setBindGroup(0, pbg.ww); pass.drawIndirect(sim.args, 40); }
  pass.end();

  // composite + near glass walls
  pass = enc.beginRenderPass({
    colorAttachments: [{ view: RT.compV, clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }],
    depthStencilAttachment: { view: RT.compDepthV, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
  });
  pass.setPipeline(RP.composite); pass.setBindGroup(0, frameBG); pass.setBindGroup(1, sbg.comp); pass.draw(3);
  if (near.length) {
    const g = glassFor(t, near);
    pass.setPipeline(RP.glass); pass.setBindGroup(0, frameBG);
    pass.setVertexBuffer(0, g.vb); pass.setIndexBuffer(g.ib, 'uint32');
    pass.drawIndexed(g.count);
  }
  pass.end();

  // selection mask
  pass = enc.beginRenderPass({ colorAttachments: [{ view: RT.maskV, clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' }] });
  pass.setPipeline(RP.mask); pass.setBindGroup(0, frameOnlyBG);
  draws.forEach((d, i) => {
    if (!d.item || d.item.id !== selectedId) return;
    pass.setBindGroup(1, objBG, [i * OBJ_STRIDE]);
    pass.setVertexBuffer(0, d.mesh.vb); pass.setIndexBuffer(d.mesh.ib, 'uint32');
    pass.drawIndexed(d.mesh.count);
  });
  pass.end();

  // bloom
  for (let i = 0; i < RT.bloom.length; i++) {
    pass = enc.beginRenderPass({ colorAttachments: [{ view: RT.bloomV[i], clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }] });
    pass.setPipeline(RP.down); pass.setBindGroup(0, RT.downBG[i]); pass.draw(3);
    pass.end();
  }
  for (let i = RT.bloom.length - 1; i > 0; i--) {
    pass = enc.beginRenderPass({ colorAttachments: [{ view: RT.bloomV[i - 1], loadOp: 'load', storeOp: 'store' }] });
    pass.setPipeline(RP.up); pass.setBindGroup(0, RT.upBG[i]); pass.draw(3);
    pass.end();
  }
  pass = enc.beginRenderPass({ colorAttachments: [{ view: RT.ldrV, clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }] });
  pass.setPipeline(RP.tonemap); pass.setBindGroup(0, RT.toneBG); pass.draw(3);
  pass.end();
  const outView = offscreenPresent ? presentTarget().view : gpuCtx.getCurrentTexture().createView();
  pass = enc.beginRenderPass({ colorAttachments: [{ view: outView, clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }] });
  pass.setPipeline(RP.fxaa); pass.setBindGroup(0, RT.fxaaBG); pass.draw(3);
  pass.end();
  const readback = offscreenPresent && presentCopy(enc);
  device.queue.submit([enc.finish()]);
  if (readback) presentShow();
  if (overlayFn) overlayFn();
}

// ---------- test presentation path (see offscreenPresent) ----------
const present = { tex: null, view: null, buf: null, busy: false, w: 0, h: 0, bpr: 0, canvas: null };
function presentTarget() {
  if (present.w !== RT.w || present.h !== RT.h) {
    if (present.tex) { present.tex.destroy(); present.buf.destroy(); }
    present.w = RT.w; present.h = RT.h;
    present.bpr = Math.ceil(RT.w * 4 / 256) * 256;
    present.tex = device.createTexture({ size: [RT.w, RT.h], format: canvasFormat, usage: TU.RENDER_ATTACHMENT | TU.COPY_SRC });
    present.view = present.tex.createView();
    present.buf = device.createBuffer({ size: present.bpr * RT.h, usage: BU.COPY_DST | BU.MAP_READ });
  }
  if (!present.canvas) {
    present.canvas = document.createElement('canvas');
    present.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
    $('view').insertBefore(present.canvas, $('overlay'));
  }
  return present;
}
function presentCopy(enc) {
  if (present.busy) return false;
  enc.copyTextureToBuffer({ texture: present.tex }, { buffer: present.buf, bytesPerRow: present.bpr }, [present.w, present.h]);
  present.busy = true;
  return true;
}
function presentShow() {
  const { buf, w, h, bpr } = present;
  buf.mapAsync(GPUMapMode.READ).then(() => {
    const src = new Uint8Array(buf.getMappedRange());
    const img = new ImageData(w, h);
    for (let y = 0; y < h; y++) img.data.set(src.subarray(y * bpr, y * bpr + w * 4), y * w * 4);
    buf.unmap();
    if (present.canvas.width !== w || present.canvas.height !== h) { present.canvas.width = w; present.canvas.height = h; }
    present.canvas.getContext('2d').putImageData(img, 0, 0);
    present.busy = false;
  }, () => { present.busy = false; });
}
