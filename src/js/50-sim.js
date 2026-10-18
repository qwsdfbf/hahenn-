// ============================================================
//  Liquid simulation driver
// ============================================================
const QUALITY = {
  low:      { label: '低', h: 0.012, cap: 140000, ww: 60000, iters: 28, pixel: 0.75, ripple: 128 },
  standard: { label: '標準', h: 0.0085, cap: 320000, ww: 140000, iters: 40, pixel: 1.0, ripple: 256 },
  high:     { label: '高', h: 0.0065, cap: 700000, ww: 260000, iters: 56, pixel: 1.0, ripple: 512 },
};
const MAX_OBJ = 64;
const MAX_EMIT = 48;
const G = 9.81;

const PIPES = {
  geom: computePipe(WGSL_GEOM, 'geom'),
  p2g: computePipe(WGSL_P2G, 'p2g'),
  normalize: computePipe(WGSL_NORMALIZE, 'normalize'),
  forces: computePipe(WGSL_FORCES, 'forces'),
  divergence: computePipe(WGSL_DIVERGENCE, 'divergence'),
  pressure: computePipe(WGSL_PRESSURE, 'pressure'),
  project: computePipe(WGSL_PROJECT, 'project'),
  g2p: computePipe(WGSL_G2P, 'g2p'),
  emit: computePipe(WGSL_EMIT, 'emit'),
  compact: computePipe(WGSL_COMPACT, 'compact'),
  count: computePipe(WGSL_COUNT, 'count'),
  ww: computePipe(WGSL_WW, 'ww'),
};

class FluidSim {
  constructor(tank, qualityKey) {
    const q = QUALITY[qualityKey];
    this.q = q;
    this.serial = FluidSim.serial = (FluidSim.serial || 0) + 1;
    this.h = q.h;
    this.nx = Math.max(8, Math.round(tank.w / q.h));
    this.ny = Math.max(8, Math.round(tank.h / q.h));
    this.nz = Math.max(8, Math.round(tank.d / q.h));
    this.h = Math.min(tank.w / this.nx, tank.h / this.ny, tank.d / this.nz);
    this.origin = [-this.nx * this.h / 2, 0, -this.nz * this.h / 2];
    this.rim = this.ny * this.h;
    this.nodes = (this.nx + 1) * (this.ny + 1) * (this.nz + 1);
    this.cells = this.nx * this.ny * this.nz;
    this.cap = q.cap;
    this.wwCap = q.ww;
    this.vp = Math.pow(this.h / 2, 3);           // volume carried by one particle
    this.radius = 0.5 * this.h * 1.05;           // rendering radius
    this.frame = 0;
    this.time = 0;
    this.vmax = 1.0;
    this.count = 0;
    this.wwCount = 0;
    this.impacts = 0;
    this.full = false;
    this.geomDirty = true;
    this.cur = 0;
    this.wwCur = 0;
    this.emitAcc = new Map();
    this.objCount = 0;

    const S = BU.STORAGE, D = BU.COPY_DST;
    this.params = gbuf(128, BU.UNIFORM | D, 'params');
    this.parity = [0, 1].map((p) => { const b = gbuf(16, BU.UNIFORM | D, 'parity'); device.queue.writeBuffer(b, 0, new Uint32Array([p, 0, 0, 0])); return b; });
    this.countU = [0, 1, 2, 3, 4].map((m) => { const b = gbuf(16, BU.UNIFORM | D, 'countMode'); device.queue.writeBuffer(b, 0, new Uint32Array([m, 0, 0, 0])); return b; });
    this.emitU = gbuf(16, BU.UNIFORM | D, 'emitInfo');
    this.wwU = gbuf(16, BU.UNIFORM | D, 'wwInfo');
    this.parts = [0, 1].map(() => gbuf(this.cap * 32, S | D | BU.COPY_SRC, 'particles'));
    this.ww = [0, 1].map(() => gbuf(this.wwCap * 32, S | D | BU.COPY_SRC, 'whitewater'));
    this.counters = gbuf(32, S | D | BU.COPY_SRC, 'counters');
    this.args = gbuf(64, S | BU.INDIRECT, 'args');
    this.acc = gbuf(this.nodes * 24, S | D, 'acc');
    this.cellCount = gbuf(this.cells * 4, S | D, 'cellCount');
    this.vel = gbuf(this.nodes * 16, S | D, 'vel');
    this.velOld = gbuf(this.nodes * 16, S, 'velOld');
    this.frac = gbuf(this.nodes * 16, S, 'frac');
    this.svel = gbuf(this.nodes * 16, S, 'svel');
    this.cellType = gbuf(this.cells * 4, S | D, 'cellType');
    this.divg = gbuf(this.cells * 4, S, 'divg');
    this.pres = gbuf(this.cells * 4, S | D, 'pres');
    this.objs = gbuf(MAX_OBJ * 112, S | D, 'objs');
    this.emits = gbuf(MAX_EMIT * 80, S | D, 'emits');
    this.staging = [0, 1, 2].map(() => ({ buf: device.createBuffer({ size: 32, usage: BU.MAP_READ | BU.COPY_DST }), busy: false }));
    this.stagingIdx = 0;
    this.ripple = new RippleLayer(q.ripple);
    this.ripple.bindMask(this.params, this.objs, topHView);
    this.buildBindGroups();
    this.writeParams(1 / 60);
    const enc = device.createCommandEncoder();
    this.encodeCount(enc, 4);
    device.queue.submit([enc.finish()]);
  }

  buildBindGroups() {
    const Pb = this.params;
    this.bg = {
      geom: bindGroup(PIPES.geom, { 0: Pb, 1: this.objs, 2: this.frac, 3: this.svel }),
      p2g: [0, 1].map((c) => bindGroup(PIPES.p2g, { 0: Pb, 1: this.parts[c], 2: this.counters, 3: this.acc, 4: this.cellCount })),
      normalize: bindGroup(PIPES.normalize, { 0: Pb, 1: this.acc, 2: this.vel, 3: this.velOld, 4: this.cellCount, 5: this.cellType }),
      forces: bindGroup(PIPES.forces, { 0: Pb, 1: this.vel, 2: this.frac, 3: this.svel }),
      divergence: bindGroup(PIPES.divergence, { 0: Pb, 1: this.vel, 2: this.frac, 3: this.svel, 4: this.cellType, 5: this.cellCount, 6: this.divg }),
      pressure: [0, 1].map((p) => bindGroup(PIPES.pressure, { 0: Pb, 1: this.frac, 2: this.cellType, 3: this.divg, 4: this.pres, 5: this.parity[p] })),
      project: bindGroup(PIPES.project, { 0: Pb, 1: this.vel, 2: this.frac, 3: this.svel, 4: this.cellType, 5: this.pres }),
      g2p: [0, 1].map((c) => [0, 1].map((w) => bindGroup(PIPES.g2p, { 0: Pb, 1: this.parts[c], 2: this.counters, 3: this.vel, 4: this.velOld, 5: this.objs, 6: this.cellCount, 7: this.ww[w], 8: this.ripple.src }))),
      emit: [0, 1].map((c) => bindGroup(PIPES.emit, { 0: Pb, 1: this.parts[c], 2: this.counters, 3: this.emits, 4: this.emitU, 5: this.objs, 6: this.cellCount })),
      compact: [0, 1].map((c) => bindGroup(PIPES.compact, { 0: Pb, 1: this.parts[c], 2: this.parts[1 - c], 3: this.counters })),
      count: this.countU.map((u) => bindGroup(PIPES.count, { 0: Pb, 1: this.counters, 2: this.args, 3: u })),
      ww: [0, 1].map((w) => bindGroup(PIPES.ww, { 0: Pb, 1: this.ww[w], 2: this.ww[1 - w], 3: this.counters, 4: this.vel, 5: this.cellCount, 6: this.objs, 7: this.wwU, 8: this.ripple.src })),
    };
  }

  // a copy of the water (particles, whitewater, counters, ripples, the sources' progress) taken before a reset or a
  // clear, so that undo can bring it back exactly. Only the latest copy is kept; its number tells it apart.
  saveWater() {
    const C = BU.COPY_SRC | BU.COPY_DST;
    const rippleBytes = this.ripple.M * this.ripple.M * 8;
    if (!this.saved) this.saved = { parts: gbuf(this.cap * 32, C, 'savedParts'), ww: gbuf(this.wwCap * 32, C, 'savedWhitewater'), counters: gbuf(32, C, 'savedCounters'), ripple: gbuf(rippleBytes, C, 'savedRipple') };
    const s = this.saved;
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(this.parts[this.cur], 0, s.parts, 0, this.cap * 32);
    enc.copyBufferToBuffer(this.ww[this.wwCur], 0, s.ww, 0, this.wwCap * 32);
    enc.copyBufferToBuffer(this.counters, 0, s.counters, 0, 32);
    enc.copyBufferToBuffer(this.ripple.state, 0, s.ripple, 0, rippleBytes);
    device.queue.submit([enc.finish()]);
    s.meta = { time: this.time, count: this.count, wwCount: this.wwCount, impacts: this.impacts, full: this.full, acc: new Map([...this.emitAcc].map(([k, v]) => [k, { ...v }])) };
    s.id = FluidSim.copies = (FluidSim.copies || 0) + 1;
    return s.id;
  }
  hasWaterCopy(id) { return !!(this.saved && this.saved.meta && this.saved.id === id); }
  restoreWater(id) {
    if (!this.hasWaterCopy(id)) return false;
    const s = this.saved;
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(s.parts, 0, this.parts[this.cur], 0, this.cap * 32);
    enc.copyBufferToBuffer(s.ww, 0, this.ww[this.wwCur], 0, this.wwCap * 32);
    enc.copyBufferToBuffer(s.counters, 0, this.counters, 0, 32);
    enc.copyBufferToBuffer(s.ripple, 0, this.ripple.state, 0, this.ripple.M * this.ripple.M * 8);
    device.queue.submit([enc.finish()]);
    const m = s.meta;
    this.time = m.time; this.count = m.count; this.wwCount = m.wwCount; this.impacts = m.impacts; this.full = m.full;
    this.emitAcc = new Map([...m.acc].map(([k, v]) => [k, { ...v }]));
    s.meta = null;
    return true;
  }

  destroy() {
    this.dead = true;
    if (this.saved) for (const b of Object.values(this.saved)) if (b instanceof GPUBuffer) b.destroy();
    for (const k of Object.keys(this)) { const b = this[k]; if (b instanceof GPUBuffer) b.destroy(); }
    for (const b of [...this.parts, ...this.ww, ...this.parity, ...this.countU, ...this.staging.map((st) => st.buf)]) b.destroy();
    this.ripple.destroy();
  }

  writeParams(dt) {
    const f = new Float32Array(32);
    const u = new Uint32Array(f.buffer);
    u[0] = this.nx; u[1] = this.ny; u[2] = this.nz; u[3] = this.nodes;
    u[4] = this.cells; u[5] = this.cap; u[6] = this.objCount; u[7] = this.frame;
    f[8] = this.origin[0]; f[9] = this.origin[1]; f[10] = this.origin[2]; f[11] = this.h;
    f[12] = dt; f[13] = G; f[14] = 0.96; f[15] = 1 / this.h;
    f[16] = 8; f[17] = 6.0; f[18] = 1.6; f[19] = 0.32 * this.h;
    f[20] = this.rim; f[21] = settings.whitewater ? 7.0 : 0.0; f[22] = this.wwCap; f[23] = 0.03;
    f[24] = this.time; f[25] = this.radius; f[26] = this.ripple.R; f[27] = 0;
    device.queue.writeBuffer(this.params, 0, f);
  }

  // obstacles and drains -> GPU objects; velocities from the previous transforms let moving obstacles push water
  setObjects(items, dtMove) {
    const data = new Float32Array(MAX_OBJ * 28);
    let n = 0;
    this.prevXf = this.prevXf || new Map();
    const nextXf = new Map();
    let moving = false;
    for (const it of items) {
      if (n >= MAX_OBJ) break;
      if (it.kind !== 'obstacle' && it.kind !== 'drain') continue;
      const R = it.kind === 'obstacle' ? obstacleRot(it) : m3.euler(it.rot[0], it.rot[1], it.rot[2]);
      const RT = m3.transpose(R);
      let type, d, flag, bound;
      if (it.kind === 'obstacle') {
        const sp = shapeParams(it);
        type = sp[0]; d = sp.slice(1); flag = 1; bound = boundRadius(it) + 0.002;
      } else {
        type = 9; d = [it.r, 0.012, 0, 0]; flag = 2; bound = it.r + 0.02;
      }
      let lin = [0, 0, 0], ang = [0, 0, 0];
      const prev = this.prevXf.get(it.id);
      if (prev && dtMove > 0) {
        lin = v3.mul(v3.sub(it.pos, prev.pos), 1 / dtMove);
        ang = v3.mul(m3.log(m3.mul(R, m3.transpose(prev.R))), 1 / dtMove);
        if (v3.len(lin) > 1e-5 || v3.len(ang) > 1e-4) moving = true;
        // clamp teleports (typed values) so they do not fling water
        if (v3.len(lin) > 4) lin = v3.mul(v3.norm(lin), 4);
        if (v3.len(ang) > 40) ang = v3.mul(v3.norm(ang), 40);
      }
      nextXf.set(it.id, { pos: [...it.pos], R });
      const o = n * 28;
      data.set([RT[0], RT[1], RT[2], 0, RT[3], RT[4], RT[5], 0, RT[6], RT[7], RT[8], 0], o);
      data.set([it.pos[0], it.pos[1], it.pos[2], type], o + 12);
      data.set([d[0], d[1], d[2], d[3]], o + 16);
      data.set([lin[0], lin[1], lin[2], bound], o + 20);
      data.set([ang[0], ang[1], ang[2], flag], o + 24);
      n++;
    }
    this.prevXf = nextXf;
    const sig = n + ':' + Array.prototype.join.call(data.subarray(0, n * 28), ',');
    if (sig !== this.objSig) {
      this.objSig = sig;
      this.objCount = n;
      device.queue.writeBuffer(this.objs, 0, data, 0, Math.max(n, 1) * 28);
      this.geomDirty = true;
    }
    return moving;
  }

  encodeCount(enc, mode) {
    const pass = enc.beginComputePass();
    pass.setPipeline(PIPES.count);
    pass.setBindGroup(0, this.bg.count[mode]);
    pass.dispatchWorkgroups(1);
    pass.end();
  }

  // emission list for one sub-step: [{shape, a, b, c, d, count}]
  writeEmits(list) {
    const f = new Float32Array(MAX_EMIT * 20);
    const u = new Uint32Array(f.buffer);
    let off = 0, k = 0;
    const room = Math.max(0, this.cap - this.count - 64);
    let budget = room;
    for (const e of list) {
      if (k >= MAX_EMIT || budget <= 0) break;
      const cnt = Math.min(e.count, budget);
      if (cnt <= 0) continue;
      const o = k * 20;
      f.set(e.a, o); f.set(e.b, o + 4); f.set(e.c || [0, 0, 0, 0], o + 8); f.set(e.d || [0, 0, 0, 0], o + 12);
      u[o + 16] = off; u[o + 17] = cnt; u[o + 18] = (Math.random() * 4294967295) >>> 0; u[o + 19] = e.shape;
      off += cnt; budget -= cnt; k++;
    }
    if (list.some((e) => e.count > 0) && budget <= 0) this.full = true;
    if (off > 0) {
      device.queue.writeBuffer(this.emits, 0, f, 0, k * 20);
      device.queue.writeBuffer(this.emitU, 0, new Uint32Array([k, off, 0, 0]));
      device.queue.writeBuffer(this.countU[2], 0, new Uint32Array([2, off, 0, 0]));
      this.count += off;
    }
    return off;
  }

  // emissions outside the time stepping (water blocks at a reset, or poured in while running)
  emitNow(list, fill) {
    for (let i = 0; i < list.length; i += MAX_EMIT) {
      const total = this.writeEmits(list.slice(i, i + MAX_EMIT));
      if (!total) continue;
      const enc = device.createCommandEncoder();
      if (fill) {
        // fresh per-cell particle counts, so that the pour only fills cells without water
        this.encodeCount(enc, 0);
        enc.clearBuffer(this.acc);
        enc.clearBuffer(this.cellCount);
        const pass = enc.beginComputePass();
        pass.setPipeline(PIPES.p2g); pass.setBindGroup(0, this.bg.p2g[this.cur]); pass.dispatchWorkgroupsIndirect(this.args, 0);
        pass.end();
      }
      this.encodeEmit(enc, total);
      device.queue.submit([enc.finish()]);
    }
  }

  encodeEmit(enc, total) {
    const pass = enc.beginComputePass();
    pass.setPipeline(PIPES.emit);
    pass.setBindGroup(0, this.bg.emit[this.cur]);
    pass.dispatchWorkgroups(wgCount(total));
    pass.end();
    this.encodeCount(enc, 2);
  }

  encodeSubstep(enc) {
    enc.clearBuffer(this.acc);
    enc.clearBuffer(this.cellCount);
    const pass = enc.beginComputePass();
    const nodeWG = wgCount(this.nodes), cellWG = wgCount(this.cells);
    if (this.geomDirty) {
      pass.setPipeline(PIPES.geom); pass.setBindGroup(0, this.bg.geom); pass.dispatchWorkgroups(nodeWG);
      this.geomDirty = false;
    }
    pass.setPipeline(PIPES.p2g); pass.setBindGroup(0, this.bg.p2g[this.cur]); pass.dispatchWorkgroupsIndirect(this.args, 0);
    pass.setPipeline(PIPES.normalize); pass.setBindGroup(0, this.bg.normalize); pass.dispatchWorkgroups(nodeWG);
    pass.setPipeline(PIPES.forces); pass.setBindGroup(0, this.bg.forces); pass.dispatchWorkgroups(nodeWG);
    pass.setPipeline(PIPES.divergence); pass.setBindGroup(0, this.bg.divergence); pass.dispatchWorkgroups(cellWG);
    pass.setPipeline(PIPES.pressure);
    for (let i = 0; i < this.q.iters; i++) {
      pass.setBindGroup(0, this.bg.pressure[0]); pass.dispatchWorkgroups(cellWG);
      pass.setBindGroup(0, this.bg.pressure[1]); pass.dispatchWorkgroups(cellWG);
    }
    pass.setPipeline(PIPES.project); pass.setBindGroup(0, this.bg.project); pass.dispatchWorkgroups(nodeWG);
    pass.setPipeline(PIPES.g2p); pass.setBindGroup(0, this.bg.g2p[this.cur][this.wwCur]); pass.dispatchWorkgroupsIndirect(this.args, 0);
    pass.end();
  }

  // advances the liquid by frameDt seconds; emitFn(dt, tSub) returns the emission list for each sub-step
  step(frameDt, emitFn) {
    if (frameDt <= 0) return;
    const vmax = Math.max(this.vmax, 0.4);
    let n = Math.ceil(frameDt / (1.4 * this.h / vmax));
    n = clamp(n, 1, 6);
    const dt = frameDt / n;
    device.queue.writeBuffer(this.counters, 16, new Uint32Array([0]));
    for (let s = 0; s < n; s++) {
      this.frame++;
      this.writeParams(dt);
      const list = emitFn ? emitFn(this, dt, this.time) : [];
      const total = this.writeEmits(list);
      const enc = device.createCommandEncoder();
      if (total > 0) this.encodeEmit(enc, total);
      this.encodeCount(enc, 0);
      this.encodeSubstep(enc);
      device.queue.submit([enc.finish()]);
      this.time += dt;
    }
    // remove drained particles, advance whitewater
    device.queue.writeBuffer(this.wwU, 0, new Float32Array([frameDt, 0, 0, 0]));
    const enc = device.createCommandEncoder();
    let pass = enc.beginComputePass();
    pass.setPipeline(PIPES.compact); pass.setBindGroup(0, this.bg.compact[this.cur]); pass.dispatchWorkgroupsIndirect(this.args, 0);
    pass.end();
    this.cur = 1 - this.cur;
    this.encodeCount(enc, 1);
    pass = enc.beginComputePass();
    pass.setPipeline(PIPES.ww); pass.setBindGroup(0, this.bg.ww[this.wwCur]); pass.dispatchWorkgroupsIndirect(this.args, 12);
    pass.end();
    this.wwCur = 1 - this.wwCur;
    this.encodeCount(enc, 3);
    const meanDepth = clamp(this.waterLiters / 1000 / (this.nx * this.nz * this.h * this.h), 0.003, this.rim);
    this.ripple.encodeFrame(enc, frameDt, { w: this.nx * this.h, d: this.nz * this.h }, meanDepth, this.h);
    this.readStats(enc);
    device.queue.submit([enc.finish()]);
  }

  readStats(enc) {
    const st = this.staging[this.stagingIdx];
    if (st.busy) return;
    this.stagingIdx = (this.stagingIdx + 1) % this.staging.length;
    enc.copyBufferToBuffer(this.counters, 0, st.buf, 0, 32);
    st.busy = true;
    st.pending = true;
  }
  pollStats() {
    for (const st of this.staging) {
      if (!st.pending) continue;
      st.pending = false;
      st.buf.mapAsync(GPUMapMode.READ).then(() => {
        const u = new Uint32Array(st.buf.getMappedRange().slice(0));
        st.buf.unmap();
        st.busy = false;
        if (this.dead) return;
        this.count = u[0];
        this.impacts = u[5];
        this.wwCount = Math.min(u[2], this.wwCap);
        const vm = new Float32Array(new Uint32Array([u[4]]).buffer)[0];
        if (Number.isFinite(vm)) this.vmax = vm;
        if (this.count < this.cap * 0.9) this.full = false;
      }).catch(() => { st.busy = false; });
    }
  }

  clearWater() {
    const enc = device.createCommandEncoder();
    this.encodeCount(enc, 4);
    enc.clearBuffer(this.pres);
    device.queue.submit([enc.finish()]);
    this.ripple.clear();
    this.count = 0; this.wwCount = 0; this.impacts = 0; this.full = false; this.time = 0; this.vmax = 1;
    this.emitAcc.clear();
  }

  get waterLiters() { return this.count * this.vp * 1000; }
}
