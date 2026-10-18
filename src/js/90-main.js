// ============================================================
//  Main loop and start-up
// ============================================================
let sim = null;
function rebuildSim(refill) {
  if (sim) sim.destroy();
  sim = new FluidSim(scene.tank, settings.quality);
  sim.setObjects(scene.items, 0);
  if (refill) sim.emitNow(blockEmits(sim));
  pBGCache.key = null;
  forgetStaleWaterSteps();
  refreshPanels();
}
// water and time back to the start: the water blocks are filled again, sources start over
function restartWater() {
  sim.clearWater();
  sim.setObjects(scene.items, 0);
  sim.emitNow(blockEmits(sim));
}
// resetting or clearing the water first keeps a copy of it, so that the step can be undone
function waterAction(kind) {
  const copy = sim.saveWater();
  if (kind === 'reset') restartWater();
  else sim.clearWater();
  return copy;
}
function resetSim() {
  pushWaterStep('reset', waterAction('reset'));
  toast('水と時間を最初の状態に戻しました（物の配置はそのまま）', 6000, undoAction());
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
  perf.shown += realDt;
  if (perf.shown < 0.2 && (settings.playing || stepShown === sim.time)) return;
  perf.shown = 0;
  stepShown = sim.time;
  for (const el of document.querySelectorAll('[data-info="time"]')) el.textContent = timeText(sim.time);
  for (const el of document.querySelectorAll('[data-info="water"]')) el.textContent = sim.waterLiters.toFixed(2) + ' L';
  const ratio = sim.count / sim.cap;
  const cap = document.querySelector('[data-info="cap"]');
  cap.textContent = ratio >= 0.5 ? `（計算できる量の ${Math.round(Math.min(ratio, 1) * 100)}%）` : '';
  cap.classList.toggle('full', ratio > 0.9);
  const st = $('status');
  st.hidden = !sim.full;
  if (sim.full) st.innerHTML = '<b>水の量が計算できる上限です。</b>排水口を置くか、水槽の設定で水を消してください。';
  liveRefresh();
}
let stepShown = -1;
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
    let o = null;
    try { o = JSON.parse(saved); } catch (e) { o = null; }
    const s = validScene(o);
    if (s) {
      scene.tank = s.tank;
      scene.items = s.items;
      uid = Math.max(1, ...scene.items.map((i) => (i.id | 0) + 1));
      if (o.cam && Array.isArray(o.cam.target) && [o.cam.dist, o.cam.az, o.cam.el].every(Number.isFinite)) Object.assign(cam, o.cam);
      loaded = true;
    }
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
  selectionChanged();
  updateSheetSizeButton();
  if (store.get('suiri-lab-welcome') !== '1' && !window.__noWelcome) showWelcome();
  requestAnimationFrame(frame);
})();

window.suiriLab = {
  scene, settings, cam, editor,
  sim: () => sim,
  select, selectedId: () => selectedId, undo, redo,
  loadPreset: (id) => loadPreset(PRESETS.find((p) => p.id === id), true),
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
  // page coordinates of a world point and of the selected item's gizmo handles (for automated checks)
  screen(p) { const q = project(p); const [x, y] = clientFromLocal([q.x, q.y]); return { x, y, ok: q.ok }; },
  pick(x, y) { const r = gpuCanvas.getBoundingClientRect(); const it = pickItem(x - r.left, y - r.top); return it === 'tank' ? 'tank' : it ? it.id : null; },
  handles() { const it = selected(); return it ? gizmoHandles(it).map((h) => { const a = h.b || h.a; const [x, y] = clientFromLocal([a.x, a.y]); return { type: h.type, i: h.i, ci: h.ci, x, y }; }) : []; },
  navAxes() { return navBallAxes().map((a) => { const [x, y] = clientFromLocal([a.x, a.y]); return { i: a.i, s: a.s, x, y }; }); },
  async idle() { await device.queue.onSubmittedWorkDone(); },
  setPlaying,
};
