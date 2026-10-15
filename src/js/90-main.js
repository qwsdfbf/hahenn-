// ============================================================
//  Main loop and start-up
// ============================================================
let sim = null;
FluidSim.prototype.emitNow = function (list) {
  for (let i = 0; i < list.length; i += MAX_EMIT) {
    const total = this.writeEmits(list.slice(i, i + MAX_EMIT));
    if (!total) continue;
    const enc = device.createCommandEncoder();
    this.encodeEmit(enc, total);
    device.queue.submit([enc.finish()]);
  }
};
function rebuildSim(refill) {
  if (sim) sim.destroy();
  sim = new FluidSim(scene.tank, settings.quality);
  sim.setObjects(scene.items, 0);
  if (refill) sim.emitNow(blockEmits(sim));
  pBGCache.key = null;
  refreshPanels();
}
function resetSim() {
  sim.clearWater();
  sim.setObjects(scene.items, 0);
  sim.emitNow(blockEmits(sim));
  toast('最初の状態に戻しました', 1400);
}

// ---------- sizing ----------
let resizePending = true;
new ResizeObserver(() => { resizePending = true; }).observe($('view'));
function doResize() {
  resizePending = false;
  const r = $('view').getBoundingClientRect();
  cssW = Math.max(1, r.width); cssH = Math.max(1, r.height);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const s = QUALITY[settings.quality].pixel * Math.min(dpr, settings.quality === 'high' ? 2 : 1.5);
  const w = Math.max(16, Math.round(cssW * s)), h = Math.max(16, Math.round(cssH * s));
  if (RT && RT.w === w && RT.h === h) return;
  gpuCanvas.width = w; gpuCanvas.height = h;
  buildTargets(w, h);
  pBGCache.key = null;
}

// ---------- loop ----------
let last = performance.now();
const perf = { t: 0, frames: 0, shown: 0, acc: 0, n: 0, checked: false, touched: false };
function updateStats(realDt) {
  perf.acc += realDt; perf.n++;
  perf.shown += realDt;
  if (perf.shown < 0.25) return;
  const fps = perf.n / perf.acc;
  perf.shown = 0; perf.acc = 0; perf.n = 0;
  $('t-time').textContent = sim.time.toFixed(2) + ' s';
  $('t-water').textContent = sim.waterLiters.toFixed(2) + ' L';
  const ratio = sim.count / sim.cap;
  const meter = $('t-meter');
  meter.firstChild.style.width = `${Math.min(ratio, 1) * 100}%`;
  meter.classList.toggle('full', ratio > 0.9);
  $('t-fps').textContent = Number.isFinite(fps) ? Math.round(fps) + ' fps' : '--';
  const st = $('status');
  if (sim.full) { st.hidden = false; st.innerHTML = '<b>水の量が上限です。</b>排水口を置くか、水槽の設定で水を消してください。'; }
  else if (editor.modal) st.hidden = true;
  else st.hidden = true;
  liveRefresh();
}
// the solver only advances once the GPU has finished its previous step, so slow devices never build a backlog
let simBusy = false;
let frameCount = 0;
let holdRender = !!window.__holdRenderAtBoot;
function frame(now) {
  frameCount++;
  const realDt = clamp((now - last) / 1000, 0, 0.05);
  last = now;
  stepCameraAnim(realDt);
  if (resizePending) doResize();
  let simDt = settings.playing ? realDt * settings.speed : 0;
  if (!settings.playing && stepRequests > 0) { simDt = (stepRequests * settings.speed) / 60; stepRequests = 0; }
  if (simBusy) simDt = 0;
  sim.setObjects(scene.items, simDt);
  if (simDt > 0) {
    sim.step(simDt, sourceEmits);
    simBusy = true;
    device.queue.onSubmittedWorkDone().then(() => { simBusy = false; }, () => { simBusy = false; });
  }
  sim.pollStats();
  if (panelsDirty) { panelsDirty = false; buildOutliner(); buildProps(); }
  // the test presentation path paces itself on its own readback; the WebGPU canvas is paced by the browser
  if (!holdRender && !(offscreenPresent && present.busy)) drawFrame(sim, drawOverlay);
  updateStats(realDt);
  if (!perf.checked) {
    perf.t += realDt; perf.frames++;
    if (perf.t > 5) {
      perf.checked = true;
      if (perf.t / perf.frames > 0.06 && settings.quality !== 'low' && !perf.touched) {
        settings.quality = 'low';
        rebuildSim(true);
        toast('動作が重いため、計算の細かさを「低」にしました（表示メニューで変えられます）', 4200);
      }
    }
  }
  requestAnimationFrame(frame);
}
for (const ev of ['pointerdown', 'keydown', 'wheel']) window.addEventListener(ev, () => { perf.touched = true; }, { once: true, capture: true });

// ---------- start ----------
(() => {
  let loaded = false;
  const saved = store.get('suiri-lab-scene');
  if (saved) {
    try {
      const o = JSON.parse(saved);
      if (o && o.v === 1 && o.scene && Array.isArray(o.scene.items) && o.scene.tank) {
        scene.tank = o.scene.tank;
        scene.items = o.scene.items;
        uid = Math.max(1, ...scene.items.map((i) => (i.id | 0) + 1));
        if (o.cam) Object.assign(cam, o.cam);
        loaded = true;
      }
    } catch (e) { loaded = false; }
  }
  if (!loaded) {
    const s = PRESETS[0].make();
    scene.tank = s.tank; scene.items = s.items;
    const vr = $('view').getBoundingClientRect();
    cssW = vr.width; cssH = vr.height;
    Object.assign(cam, frameAll(), VIEW_PRESETS.home);
  }
  const narrow = window.matchMedia('(max-width: 820px)').matches;
  const hashQ = location.hash.slice(1);
  settings.quality = QUALITY[hashQ] ? hashQ : isCoarse && narrow ? 'low' : 'standard';
  $('status').hidden = true;
  rebuildSim(true);
  pushUndo();
  setPlaying(!window.__pauseAtBoot);
  setSpeed(1);
  setTool('move');
  updateHint();
  requestAnimationFrame(frame);
})();

window.suiriLab = {
  scene, settings, cam, editor,
  sim: () => sim,
  select, loadPreset: (id) => loadPreset(PRESETS.find((p) => p.id === id), true),
  addItem, resetSim,
  async run(seconds, dt = 1 / 120) {
    setPlaying(false);
    holdRender = true;
    for (let t = 0; t < seconds - 1e-9; t += dt) {
      sim.setObjects(scene.items, dt);
      sim.step(dt, sourceEmits);
      await device.queue.onSubmittedWorkDone();
      sim.pollStats();
    }
    await device.queue.onSubmittedWorkDone();
    sim.pollStats();
    holdRender = !!window.__holdRenderAtBoot;
    await new Promise((r) => setTimeout(r, 50));
    return this.stats();
  },
  async frame() {
    await device.queue.onSubmittedWorkDone();
    updateCamera(RT.w, RT.h);
    drawFrame(sim, drawOverlay);
    await device.queue.onSubmittedWorkDone();
    await new Promise((r) => setTimeout(r, 300));
    return true;
  },
  hold(v) { holdRender = v; },
  async rippleStats() {
    const r = sim.ripple;
    const n = (r.R + 1);
    const bpr = Math.ceil(n * 8 / 256) * 256;
    const buf = device.createBuffer({ size: bpr * n, usage: BU.COPY_DST | BU.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: r.tex }, { buffer: buf, bytesPerRow: bpr }, [n, n]);
    device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const u16 = new Uint16Array(buf.getMappedRange());
    const f16 = (h) => { const s = h >> 15, e = (h >> 10) & 31, m = h & 1023; return (s ? -1 : 1) * (e === 0 ? m / 1024 * 2 ** -14 : e === 31 ? Infinity : (1 + m / 1024) * 2 ** (e - 15)); };
    let maxH = 0, maxS = 0, sumS = 0;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const o = (y * bpr) / 2 + x * 4;
      const h = f16(u16[o]), sx = f16(u16[o + 1]), sz = f16(u16[o + 2]);
      maxH = Math.max(maxH, Math.abs(h)); const sl = Math.hypot(sx, sz); maxS = Math.max(maxS, sl); sumS += sl;
    }
    buf.unmap(); buf.destroy();
    return { maxH, maxS, meanS: sumS / (n * n) };
  },
  noRippleMask() { sim.ripple.bg.maskBuild = null; },
  stats: () => ({ frames: frameCount, impacts: sim.impacts, count: sim.count, ww: sim.wwCount, vmax: sim.vmax, time: sim.time, liters: sim.waterLiters, grid: [sim.nx, sim.ny, sim.nz], gpuErrors }),
  noAutoQuality() { perf.checked = true; },
  async idle() { await device.queue.onSubmittedWorkDone(); },
  setPlaying,
};
