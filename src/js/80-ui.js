// ============================================================
//  Panels: menus, scene list, properties, transport
// ============================================================
const settings = { playing: true, speed: 1, guides: true, whitewater: true, quality: 'standard' };
const isCoarse = window.matchMedia('(pointer: coarse)').matches;
const narrowMQ = window.matchMedia('(max-width: 820px)');

// ---------- undo ----------
// Each entry is a scene snapshot plus the selection, which follows the user's clicks until the next edit, so that
// undo comes back with the item that was being edited. `reset` marks a step that replaced the whole scene (a sample,
// a new scene, an opened file); crossing it with undo or redo also puts the water back to the starting state of the
// scene it lands on.
const undoStack = [], redoStack = [];
let current = null;
function pushUndo(reset = false) {
  const s = JSON.stringify(scene);
  if (current && s === current.s) { current.sel = selectedId; return; }
  if (current) undoStack.push(current);
  if (undoStack.length > 120) undoStack.shift();
  redoStack.length = 0;
  current = { s, sel: selectedId, reset };
  updateUndoButtons();
  saveSoon();
}
function restore(entry, waterToo) {
  const o = JSON.parse(entry.s);
  const tankChanged = JSON.stringify(o.tank) !== JSON.stringify(scene.tank);
  scene.tank = o.tank;
  scene.items = o.items;
  uid = Math.max(uid, ...scene.items.map((i) => i.id + 1));
  selectedId = entry.sel && (entry.sel === 'tank' || getItem(entry.sel)) ? entry.sel : null;
  current = entry;
  if (tankChanged) rebuildSim(true);
  else if (waterToo) resetSim(true);
  sceneChanged(true);
  updateUndoButtons();
  selectionChanged();
  saveSoon();
}
function undo() {
  if (!undoStack.length) return;
  const from = current;
  redoStack.push(from);
  restore(undoStack.pop(), from.reset);
  toast('元に戻しました', 1200);
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(current);
  const to = redoStack.pop();
  restore(to, to.reset);
  toast('やり直しました', 1200);
}
function updateUndoButtons() {
  document.querySelectorAll('[data-undo]').forEach((b) => { b.disabled = !undoStack.length; });
  document.querySelectorAll('[data-redo]').forEach((b) => { b.disabled = !redoStack.length; });
}
document.querySelectorAll('[data-undo]').forEach((b) => b.addEventListener('click', undo));
document.querySelectorAll('[data-redo]').forEach((b) => b.addEventListener('click', redo));

let saveTimer = 0;
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(() => store.set('suiri-lab-scene', JSON.stringify(sceneFile())), 400); }
function sceneFile() { return { v: 1, app: 'suiri-lab', scene, cam: { target: cam.target, dist: cam.dist, az: cam.az, el: cam.el } }; }

// ---------- selection & refresh ----------
// opts.reveal: the selection came from the 3D view, so on narrow screens the settings sheet follows it
function select(id, opts = {}) {
  selectedId = id;
  if (current) current.sel = id;
  editor.hover = null;
  refreshPanels();
  selectionChanged();
  if (narrowMQ.matches && opts.reveal) {
    if (id !== null) openSheet('props');
    else if (sheet.auto) closeSheet();
  }
}
function selectionChanged() { updateHint(); updateToolButtons(); }
let panelsDirty = true;
function sceneChanged(structural) {
  if (structural) panelsDirty = true;
  else liveRefresh();
}
function refreshPanels() { panelsDirty = true; }

// ---------- menus ----------
function addMenu() {
  return [
    { grp: '物体' },
    ...['box', 'plate', 'sphere', 'cylinder', 'cone', 'torus', 'cup', 'container', 'gutter'].map((s) => ({ label: SHAPES[s].label, icon: SHAPE_ICONS[s], act: () => addItem(makeObstacle(s)) })),
    { sep: true },
    { grp: '水' },
    { label: '水源', sub: '蛇口・水滴・シャワー・雨など', icon: ICONS.source, act: () => addItem(makeSource()) },
    { label: '水の塊', sub: '置いた所にすぐ水が入ります', icon: ICONS.block, act: () => addItem(makeBlock()) },
    { label: '排水口', sub: '触れた水を吸い込みます', icon: ICONS.drain, act: () => addItem(makeDrain()) },
  ];
}
function fileMenu() {
  return [
    { label: '新規（空の水槽）', act: newScene },
    { label: 'ファイルを開く…', act: openFile },
    { label: 'ファイルに保存', act: saveFile },
    { sep: true },
    { grp: 'サンプル' },
    ...PRESETS.map((p) => ({ label: p.label, act: () => loadPreset(p) })),
  ];
}
function viewMenu() {
  return [
    { grp: '表示' },
    { label: '水源・水の塊などの目印', check: () => settings.guides, act: () => { settings.guides = !settings.guides; } },
    { label: '白い泡としぶき', check: () => settings.whitewater, act: () => { settings.whitewater = !settings.whitewater; } },
    { sep: true },
    { grp: '計算の細かさ（細かいほど重くなります）' },
    ...Object.entries(QUALITY).map(([k, q]) => ({ label: q.label, radio: () => settings.quality === k, act: () => setQuality(k) })),
    { sep: true },
    { grp: '視点' },
    { label: '全体', key: 'Home', act: viewHome },
    { label: '正面から', key: '1', act: () => animateCamera({ ...VIEW_PRESETS.front, ...frameAll() }) },
    { label: '右から', key: '3', act: () => animateCamera({ ...VIEW_PRESETS.side, ...frameAll() }) },
    { label: '真上から', key: '7', act: () => animateCamera({ ...VIEW_PRESETS.top, ...frameAll() }) },
    { label: '選んだ物に寄る', key: '.', act: focusSelected },
  ];
}
function buildMenu(dd, entries) {
  dd.innerHTML = '';
  for (const e of entries) {
    if (e.sep) { const s = document.createElement('div'); s.className = 'sep'; dd.appendChild(s); continue; }
    if (e.grp) { const g = document.createElement('div'); g.className = 'grp'; g.textContent = e.grp; dd.appendChild(g); continue; }
    const b = document.createElement('button');
    b.type = 'button';
    if (e.check) { b.className = 'check'; b.setAttribute('role', 'menuitemcheckbox'); b.setAttribute('aria-checked', String(!!e.check())); }
    else if (e.radio) { b.className = 'radio'; b.setAttribute('role', 'menuitemradio'); b.setAttribute('aria-checked', String(!!e.radio())); }
    else b.setAttribute('role', 'menuitem');
    b.innerHTML = (e.icon || '') + '<span><span class="t"></span>' + (e.sub ? '<span class="sub"></span>' : '') + '</span>' + (e.key ? `<span class="k">${e.key}</span>` : '');
    b.querySelector('.t').textContent = e.label;
    if (e.sub) b.querySelector('.sub').textContent = e.sub;
    b.addEventListener('click', () => { closeMenus(); e.act(); });
    dd.appendChild(b);
  }
}
const menus = [['m-file', 'dd-file', fileMenu], ['m-add', 'dd-add', addMenu], ['m-view', 'dd-view', viewMenu]];
function closeMenus() {
  for (const [b, d] of menus) { const dd = $(d); dd.hidden = true; dd.style.cssText = ''; $(b).setAttribute('aria-expanded', 'false'); }
}
// opens a menu under its button, or at a point on the screen (Shift+A at the pointer); always kept inside the window
function openMenu(btn, dd, make, at) {
  closeMenus();
  const el = $(dd);
  buildMenu(el, make());
  el.hidden = false;
  $(btn).setAttribute('aria-expanded', 'true');
  if (at) { el.style.position = 'fixed'; el.style.left = at[0] + 'px'; el.style.top = at[1] + 'px'; }
  const r = el.getBoundingClientRect();
  const over = r.right - (window.innerWidth - 6);
  if (over > 0) el.style.left = (at ? at[0] - over : parseFloat(getComputedStyle(el).left) - over) + 'px';
  const r2 = el.getBoundingClientRect();
  if (r2.left < 6) el.style.left = (parseFloat(el.style.left || '0') + 6 - r2.left) + 'px';
  if (at && r2.bottom > window.innerHeight - 6) el.style.top = Math.max(6, at[1] - (r2.bottom - (window.innerHeight - 6))) + 'px';
  const f = el.querySelector('button');
  if (f) f.focus({ preventScroll: true });
}
for (const [btn, dd, make] of menus) {
  $(btn).addEventListener('click', (e) => {
    e.stopPropagation();
    if ($(dd).hidden) openMenu(btn, dd, make); else closeMenus();
  });
}
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.menu')) closeMenus(); });

// ---------- adding / removing ----------
// a spot on the floor inside the tank, clear of other items and close to where the camera looks
function footprint(it) {
  if (it.kind === 'obstacle') return boundRadius(it);
  if (it.kind === 'drain') return it.r;
  if (it.kind === 'source') return it.mode === 'rain' ? it.rainSize / 2 : 0.03;
  return Math.hypot(it.dims.w, it.dims.d) / 2;
}
function freeSpot(r, avoidBlocks) {
  const t = scene.tank;
  const others = scene.items.filter((x) => x.kind !== 'block' || avoidBlocks).map((x) => ({ p: x.pos, r: footprint(x) }));
  const mx = Math.max(t.w / 2 - r - 0.01, 0), mz = Math.max(t.d / 2 - r - 0.01, 0);
  let best = [0, 0], bs = -Infinity;
  for (let i = 0; i <= 10; i++) for (let k = 0; k <= 8; k++) {
    const x = -mx + (2 * mx * i) / 10, z = -mz + (2 * mz * k) / 8;
    let clear = 1;
    for (const o of others) clear = Math.min(clear, Math.hypot(x - o.p[0], z - o.p[2]) - o.r - r);
    const score = Math.min(clear, 0.04) * 20 - Math.hypot(x - cam.target[0], z - cam.target[2]);
    if (score > bs) { bs = score; best = [x, z]; }
  }
  return best;
}
function placeNew(it) {
  const [x, z] = freeSpot(footprint(it), it.kind === 'block');
  if (it.kind === 'obstacle') { it.pos = [x, 0.3, z]; it.pos[1] += -obstacleBottom(it) + 0.0005; }
  else if (it.kind === 'source') it.pos = [x, Math.min(scene.tank.h + 0.08, 0.5), z];
  else if (it.kind === 'block') it.pos = [x, it.dims.h / 2 + 0.001, z];
  else if (it.kind === 'drain') it.pos = [x, 0, z];
}
function uniqueName(base) {
  const root = base.replace(/ \d+$/, '');
  const used = new Set(scene.items.map((x) => x.name));
  if (!used.has(root)) return root;
  for (let n = 2; ; n++) if (!used.has(`${root} ${n}`)) return `${root} ${n}`;
}
function addItem(it) {
  placeNew(it);
  it.name = uniqueName(it.name);
  scene.items.push(it);
  if (sim) sim.setObjects(scene.items, 0);
  if (it.kind === 'block') sim.emitNow(blockEmits(sim, [it], true), true);
  select(it.id, { reveal: true });
  pushUndo();
  sceneChanged(true);
  toast(it.kind === 'block' ? `「${it.name}」を追加して水を入れました` : `「${it.name}」を追加しました`, 2000);
}
function deleteSelected() {
  const it = selected();
  if (!it) return;
  scene.items = scene.items.filter((x) => x !== it);
  select(null);
  pushUndo();
  sceneChanged(true);
  const msg = it.kind === 'block' ? `「${it.name}」を削除しました（いま水槽にある水はそのままです）` : `「${it.name}」を削除しました`;
  toast(msg, 4000, { label: '元に戻す', run: undo });
}
function duplicateSelected(grab) {
  const it = selected();
  if (!it) return;
  const c = cloneScene(it);
  c.id = uid++;
  c.name = uniqueName(it.name);
  if (grab) c.pos = [...it.pos];
  else {
    const r = footprint(it);
    const t = scene.tank;
    const side = it.pos[0] + 2.2 * r + 0.01 < t.w / 2 ? 1 : -1;
    c.pos = clampItemPos(c, [it.pos[0] + side * (2 * r + 0.01), it.pos[1], it.pos[2]]);
  }
  scene.items.push(c);
  select(c.id);
  pushUndo();
  sceneChanged(true);
  if (c.kind === 'block') sim.emitNow(blockEmits(sim, [c], true), true);
  if (grab && lastPointer) startModal('move', lastPointer[0], lastPointer[1]);
  else toast(`「${c.name}」を作りました`, 1600);
}
function focusSelected() {
  const it = selected();
  if (!it) { animateCamera({ ...frameAll() }); return; }
  const r = it.kind === 'obstacle' ? boundRadius(it) : it.kind === 'block' ? Math.max(it.dims.w, it.dims.h, it.dims.d) / 2 : 0.05;
  animateCamera({ target: [...it.pos].map((x, i) => (i === 1 ? Math.max(x, 0) : x)), dist: clamp(r * 4.5 + 0.12, 0.15, 3) });
}
function pourBlock(it) {
  sim.emitNow(blockEmits(sim, [it], true), true);
  toast(`「${it.name}」の形に水を入れました`, 1800);
}
$('btn-del').addEventListener('click', () => { if (selected()) deleteSelected(); else toolUnavailable('del'); });
$('btn-dup').addEventListener('click', () => { if (selected()) duplicateSelected(false); else toolUnavailable('dup'); });

// ---------- scenes: samples, new, files ----------
function replaceScene(s, message) {
  scene.tank = s.tank;
  scene.items = s.items;
  uid = Math.max(uid, ...scene.items.map((i) => (i.id | 0) + 1));
  selectedId = null;
  rebuildSim(true);
  sceneChanged(true);
  selectionChanged();
  pushUndo(true);
  viewHome();
  if (message) toast(message, 4000, { label: '元に戻す', run: undo });
}
function loadPreset(p, quiet) { replaceScene(p.make(), quiet ? null : `サンプル「${p.label}」を開きました`); }
function newScene() { replaceScene({ tank: { w: 0.6, h: 0.32, d: 0.4 }, items: [] }, '空の水槽にしました'); }
function saveFile() {
  const blob = new Blob([JSON.stringify(sceneFile(), null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'suiri-lab-scene.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('シーンをファイルに保存しました', 1800);
}
function validScene(o) {
  if (!o || !o.scene || !o.scene.tank || !Array.isArray(o.scene.items)) return null;
  const t = o.scene.tank;
  if (![t.w, t.h, t.d].every((x) => Number.isFinite(x) && x > 0)) return null;
  const items = o.scene.items.filter((it) => it && ['obstacle', 'source', 'block', 'drain'].includes(it.kind) && Array.isArray(it.pos) && it.pos.length === 3 && it.pos.every(Number.isFinite));
  // fill in fields that an older file may not have, from fresh items of the same kind
  const fresh = { obstacle: (it) => makeObstacle(SHAPES[it.shape] ? it.shape : 'box'), source: () => makeSource(), block: () => makeBlock(), drain: () => makeDrain() };
  return { tank: { w: clamp(t.w, 0.2, 1.2), h: clamp(t.h, 0.1, 0.6), d: clamp(t.d, 0.15, 1.0) }, items: items.map((it) => { const base = fresh[it.kind](it); return { ...base, ...it, dims: it.dims ? { ...base.dims, ...it.dims } : base.dims }; }) };
}
function openFile() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.json,application/json';
  inp.addEventListener('change', () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    f.text().then((txt) => {
      let s = null;
      try { s = validScene(JSON.parse(txt)); } catch (e) { s = null; }
      if (!s) { toast('このファイルは水理ラボのシーンとして読めませんでした', 3000); return; }
      replaceScene(s, `「${f.name}」を開きました`);
    });
  });
  inp.click();
}

// ---------- number fields (drag sideways to scrub, tap or type to enter a value) ----------
const numberFields = new WeakMap();
function numberField({ get, set, unit = '', scale = 1, digits = 1, step = 0.1, min = -Infinity, max = Infinity, axis = null, prefix = null, zeroText = null, label, fill = null }) {
  const el = document.createElement('div');
  el.className = 'nf';
  el.tabIndex = 0;
  el.setAttribute('role', 'spinbutton');
  if (label) el.setAttribute('aria-label', label);
  el.innerHTML = (fill ? '<span class="fill"></span>' : '') + (axis ? `<span class="ax ${axis}">${axis.toUpperCase()}</span>` : '') + (prefix ? '<span class="ax pre"></span>' : '') + '<span class="val"></span>';
  if (prefix) el.querySelector('.pre').textContent = prefix;
  const val = el.querySelector('.val');
  const lim = () => [typeof min === 'function' ? min() : min, typeof max === 'function' ? max() : max];
  const num = (v) => (v * scale).toFixed(digits);
  const fmt = (v) => (zeroText && Math.abs(v) < 1e-9 ? zeroText : num(v) + (unit ? ' ' + unit : ''));
  const render = () => {
    const v = get();
    val.textContent = fmt(v);
    el.setAttribute('aria-valuenow', num(v));
    const [lo, hi] = lim();
    if (Number.isFinite(lo) && Number.isFinite(hi)) el.title = `${label || ''}：${num(lo)}〜${num(hi)}${unit ? ' ' + unit : ''}`;
    if (fill) el.querySelector('.fill').style.width = `${clamp((v - fill[0]) / (fill[1] - fill[0]), 0, 1) * 100}%`;
  };
  // typed values outside the range are brought into it, and the range is shown
  const apply = (v, typed) => {
    const [lo, hi] = lim();
    const c = clamp(v, lo, hi);
    set(c);
    render();
    if (typed && Math.abs(c - v) > 1e-9) toast(`「${label}」は ${num(lo)}〜${num(hi)}${unit ? ' ' + unit : ''} の範囲です`, 2600);
  };
  let start = null;
  el.addEventListener('pointerdown', (e) => {
    if (el.querySelector('input') || e.button > 0) return;
    start = { x: e.clientX, y: e.clientY, v: get(), moved: false, touch: e.pointerType !== 'mouse', t: performance.now(), id: e.pointerId };
    if (!start.touch) { e.preventDefault(); el.setPointerCapture(e.pointerId); el.focus({ preventScroll: true }); }
  });
  el.addEventListener('pointermove', (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (!start.moved) {
      // a finger moving up or down is scrolling the panel; only a clearly sideways drag changes the value
      if (start.touch && Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx)) { start = null; return; }
      if (Math.abs(dx) < (start.touch ? 10 : 8) || Math.abs(dx) < Math.abs(dy)) return;
      start.moved = true;
      start.x = e.clientX;
      if (start.touch) el.setPointerCapture(e.pointerId);
      el.classList.add('focus');
      return;
    }
    const k = e.shiftKey ? 0.1 : 1;
    let v = start.v + ((e.clientX - start.x) / 4) * (step / scale) * k;
    if (e.ctrlKey) v = Math.round(v / (step / scale * 10)) * (step / scale * 10);
    apply(v, false);
  });
  el.addEventListener('pointerup', (e) => {
    if (!start || e.pointerId !== start.id) return;
    const s = start;
    start = null;
    el.classList.remove('focus');
    if (s.moved) pushUndo();
    else if (!s.touch || (Math.hypot(e.clientX - s.x, e.clientY - s.y) < 10 && performance.now() - s.t < 700)) edit('');
  });
  el.addEventListener('pointercancel', () => { start = null; el.classList.remove('focus'); });
  function edit(initial) {
    if (el.querySelector('input')) return;
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.inputMode = 'decimal';
    inp.enterKeyHint = 'done';
    inp.value = initial || num(get());
    el.appendChild(inp);
    inp.focus();
    if (initial) inp.setSelectionRange(inp.value.length, inp.value.length); else inp.select();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (ok) {
        const n = parseFloat(inp.value.replace(/,/g, '.').replace(/[^0-9.+\-eE]/g, ''));
        if (Number.isFinite(n) && Math.abs(n / scale - get()) > 1e-12) { apply(n / scale, true); pushUndo(); }
      }
      inp.remove();
      render();
    };
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); el.focus({ preventScroll: true }); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); el.focus({ preventScroll: true }); }
      else if (e.key === 'Tab') {
        // like Blender: Tab commits and goes on typing in the next field
        e.preventDefault();
        finish(true);
        const all = [...$('props').querySelectorAll('.nf')];
        const next = all[all.indexOf(el) + (e.shiftKey ? -1 : 1)];
        if (next) { next.focus({ preventScroll: true }); numberFields.get(next).edit(''); } else el.focus({ preventScroll: true });
      }
    });
    inp.addEventListener('blur', () => finish(true));
  }
  el.addEventListener('keydown', (e) => {
    if (el.querySelector('input') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); edit(''); }
    else if (/^[0-9.\-]$/.test(e.key)) { e.preventDefault(); e.stopPropagation(); edit(e.key); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); apply(get() + (step / scale) * (e.shiftKey ? 10 : 1), false); pushUndo(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); apply(get() - (step / scale) * (e.shiftKey ? 10 : 1), false); pushUndo(); }
  });
  render();
  el.refresh = render;
  numberFields.set(el, { edit });
  return el;
}
function row(labelText, control, small) {
  const r = document.createElement('div');
  r.className = 'prow';
  const l = document.createElement('span');
  l.className = 'lbl';
  l.textContent = labelText;
  if (small) { const s = document.createElement('small'); s.textContent = small; l.appendChild(s); }
  r.append(l, control);
  return r;
}
function group(title, ...rows) {
  const g = document.createElement('div');
  g.className = 'pgroup';
  if (title) { const h = document.createElement('h3'); h.textContent = title; g.appendChild(h); }
  g.append(...rows.filter(Boolean));
  return g;
}
function trio(fields) { const d = document.createElement('div'); d.className = 'trio'; d.append(...fields); return d; }
function segmented(options, get, set, label) {
  const d = document.createElement('div');
  d.className = 'seg';
  d.setAttribute('role', 'radiogroup');
  if (label) d.setAttribute('aria-label', label);
  for (const [k, text] of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.textContent = text;
    b.setAttribute('aria-checked', String(get() === k));
    b.addEventListener('click', () => { if (get() === k) return; set(k); pushUndo(); refreshPanels(); });
    d.appendChild(b);
  }
  return d;
}
function toggle(get, set, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'toggle';
  b.setAttribute('role', 'switch');
  b.setAttribute('aria-checked', String(get()));
  b.innerHTML = '<span class="sw"></span><span></span>';
  b.lastChild.textContent = label;
  b.addEventListener('click', () => { set(!get()); b.setAttribute('aria-checked', String(get())); pushUndo(); refreshPanels(); });
  return b;
}
const CM = { unit: 'cm', scale: 100, digits: 1, step: 0.5 };
const AXIS_WORDS = ['左右', '前後', '高さ'];
// position in the editor's axes (X right, Y away, Z up)
function posFields(it) {
  return trio([0, 1, 2].map((i) => numberField({
    ...CM, unit: '', axis: 'xyz'[i], label: `位置 ${'XYZ'[i]}（${AXIS_WORDS[i]}, cm）`,
    get: () => toUI(it.pos)[i],
    set: (v) => { const u = toUI(it.pos); u[i] = v; it.pos = clampItemPos(it, fromUI(u)); sceneChanged(false); },
    min: () => uiPosLimit(it, i)[0], max: () => uiPosLimit(it, i)[1],
  })));
}
function uiPosLimit(it, i) {
  const L = posLimits(it);
  if (i === 0) return L[0];
  if (i === 1) return [-L[2][1], -L[2][0]];
  return L[1];
}
function rotFields(it) {
  return trio([0, 1, 2].map((i) => numberField({
    unit: '', digits: 0, step: 1, axis: 'xyz'[i], label: `回転 ${'XYZ'[i]}（度）`,
    get: () => uiEuler(it.rot)[i],
    set: (v) => { const u = uiEuler(it.rot); u[i] = ((v % 360) + 540) % 360 - 180; it.rot = worldEuler(u).map((x) => Math.round(x * 100) / 100); sceneChanged(false); },
  })));
}
function axisNote() { return noteEl('X 左右（＋が右）・Y 前後（＋が奥）・Z 高さ'); }

// ---------- property panel ----------
function headerActions(list) {
  const host = $('props-acts');
  host.innerHTML = '';
  for (const [label, fn, cls, icon] of list) {
    const b = document.createElement('button');
    b.type = 'button';
    if (cls) b.className = cls;
    b.innerHTML = icon || '';
    b.append(label);
    b.addEventListener('click', fn);
    host.appendChild(b);
  }
}
const ICON_DUP = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="6.5" y="6.5" width="10" height="10" rx="1.5"/><path d="M13.5 6.5v-2a1 1 0 0 0-1-1h-8a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2"/></svg>';
const ICON_DEL = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 5.5h12M8 5.5V4h4v1.5M5.5 5.5l.8 11h7.4l.8-11"/></svg>';
function nameRow(it) {
  const name = document.createElement('input');
  name.className = 'txt'; name.value = it.name; name.setAttribute('aria-label', '名前');
  name.addEventListener('change', () => { it.name = name.value.trim() || it.name; pushUndo(); refreshPanels(); });
  name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') name.blur(); });
  return row('名前', name);
}
function buildProps() {
  const host = $('props');
  host.innerHTML = '';
  const title = $('props-title');
  if (selectedId === 'tank') {
    title.textContent = '水槽';
    headerActions([]);
    const t = scene.tank;
    const tankField = (k, lbl, lo, hi) => numberField({ ...CM, label: lbl, get: () => t[k], set: (v) => { t[k] = v; tankEdited(); }, min: lo, max: hi });
    host.append(
      group('大きさ', row('幅', tankField('w', '幅', 0.2, 1.2), 'X'), row('奥行き', tankField('d', '奥行き', 0.15, 1.0), 'Y'), row('高さ', tankField('h', '高さ', 0.1, 0.6), 'Z')),
      group('計算の細かさ', segmented(Object.entries(QUALITY).map(([k, q]) => [k, q.label]), () => settings.quality, setQuality, '計算の細かさ'),
        noteEl('細かいほど細い水流や小さなしぶきまで表せますが、動きは重くなります。')),
      noteEl('大きさや計算の細かさを変えると、水は最初の状態から計算し直します。'),
      actions([['水を最初の状態に戻す', () => resetSim()], ['水をすべて消す', clearAllWater, 'danger', true]]),
      details('計算の詳細', `格子 ${sim.nx} × ${sim.ny} × ${sim.nz}（1 マス ${(sim.h * 1000).toFixed(1)} mm）<br>水の粒の上限 ${sim.cap.toLocaleString('ja-JP')} 個（${(sim.cap * sim.vp * 1000).toFixed(1)} L 分）`),
    );
    return;
  }
  const it = selected();
  if (!it) {
    title.textContent = '設定';
    headerActions([]);
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = isCoarse
      ? '3D の画面か「一覧」で物や水源をタップすると、ここで位置や大きさ、水の量と勢いを変えられます。'
      : '3D の画面かシーン一覧で物や水源をクリックすると、ここで位置や大きさ、水の量と勢いを変えられます。';
    host.appendChild(p);
    return;
  }
  title.textContent = it.name;
  headerActions([['複製', () => duplicateSelected(false), null, ICON_DUP], ['削除', deleteSelected, 'danger', ICON_DEL]]);

  if (it.kind === 'obstacle') {
    host.appendChild(group('配置', row('位置', posFields(it), 'cm'), axisNote(), SHAPES[it.shape] && it.shape !== 'sphere' ? row('回転', rotFields(it), '度') : null, actions([['床に置く', () => { it.pos[1] += -obstacleBottom(it) + 0.0005; pushUndo(); sceneChanged(false); refreshPanels(); }]])));
    const dimsRows = Object.keys(it.dims).map((k) => {
      const lim = DIM_LIMITS[k] || [0.004, 1];
      return row(DIM_LABELS[k] || k, numberField({ ...CM, step: k === 't' ? 0.1 : 0.5, label: DIM_LABELS[k], get: () => it.dims[k], set: (v) => { keepOnFloor(it, () => { it.dims[k] = v; }); sceneChanged(false); }, min: lim[0], max: lim[1] }));
    });
    host.appendChild(group(`大きさ（${SHAPES[it.shape].label}）`, ...dimsRows));
    const sw = document.createElement('div');
    sw.className = 'swatches';
    sw.setAttribute('role', 'radiogroup'); sw.setAttribute('aria-label', '色');
    for (const c of PALETTE) {
      const b = document.createElement('button');
      b.type = 'button'; b.style.background = c; b.setAttribute('role', 'radio'); b.setAttribute('aria-label', c);
      b.setAttribute('aria-checked', String(it.color === c));
      b.addEventListener('click', () => { it.color = c; pushUndo(); refreshPanels(); });
      sw.appendChild(b);
    }
    host.appendChild(group('見た目', row('素材', segmented(Object.entries(MATERIALS).map(([k, m]) => [k, m.label]), () => it.material, (k) => { it.material = k; }, '素材')), row('色', sw)));
    host.appendChild(nameRow(it));
  } else if (it.kind === 'source') {
    host.appendChild(group(null, toggle(() => it.enabled, (v) => { it.enabled = v; }, '水を出す')));
    host.appendChild(group('出し方', segmented(Object.entries(SOURCE_MODES).map(([k, m]) => [k, m.label]), () => it.mode, (k) => setSourceMode(it, k), '出し方')));
    const amount = [];
    const F = (lbl, key, o) => row(lbl, numberField({ label: lbl, get: () => it[key], set: (v) => { it[key] = v; liveRefresh(); }, ...o }));
    if (it.mode === 'stream' || it.mode === 'shower') {
      amount.push(F('流量', 'flow', { unit: 'L/分', digits: 2, step: 0.05, min: 0.05, max: 40, fill: [0, 10] }));
      amount.push(F('勢い', 'speed', { unit: 'm/s', digits: 2, step: 0.05, min: 0.05, max: 12, fill: [0, 4] }));
      if (it.mode === 'stream') {
        // the outlet diameter follows from flow and speed; setting it keeps the speed and changes the flow
        amount.push(row('出口の太さ', numberField({ unit: 'mm', scale: 1000, digits: 1, step: 0.1, label: '出口の太さ', get: () => sourceNozzle(it), set: (d) => { it.flow = clamp((Math.PI * d * d / 4) * Math.max(it.speed, 0.05) * 60000, 0.05, 40); liveRefresh(); }, min: 0.001, max: 0.12 })));
        const n = noteEl('');
        n.dataset.live = 'nozzle';
        amount.push(n);
      } else amount.push(F('広がり', 'spread', { unit: '°', digits: 0, step: 1, min: 0, max: 80 }));
    } else if (it.mode === 'drops') {
      amount.push(F('粒の直径', 'dropD', { unit: 'mm', digits: 1, step: 0.1, min: 1, max: 40, fill: [1, 15] }));
      amount.push(row('間隔', numberField({ unit: '秒', digits: 2, step: 0.01, label: '落ちる間隔', get: () => 1 / it.dropRate, set: (v) => { it.dropRate = 1 / v; }, min: 1 / 60, max: 20 })));
      amount.push(F('勢い', 'speed', { unit: 'm/s', digits: 2, step: 0.05, min: 0, max: 12, fill: [0, 4], zeroText: '0（自然に落ちる）' }));
      const n = noteEl('');
      n.dataset.live = 'drop';
      amount.push(n);
    } else if (it.mode === 'burst') {
      amount.push(F('一度に出す量', 'burst', { unit: 'L', digits: 2, step: 0.01, min: 0.01, max: 50, fill: [0, 2] }));
      amount.push(F('勢い', 'speed', { unit: 'm/s', digits: 2, step: 0.05, min: 0, max: 12, fill: [0, 4] }));
      amount.push(F('繰り返し', 'burstEvery', { unit: '秒ごと', digits: 1, step: 0.1, min: 0, max: 60, zeroText: '1回だけ' }));
      amount.push(actions([['今すぐ出す', () => { fireBurst(it); toast(`「${it.name}」から ${it.burst.toFixed(2)} L 出しました`, 1600); }, 'primary']]));
    } else if (it.mode === 'rain') {
      amount.push(F('雨の強さ', 'rainRate', { unit: 'mm/時', digits: 0, step: 1, min: 1, max: 500, fill: [0, 200] }));
      amount.push(row('降る範囲', numberField({ ...CM, label: '降る範囲（一辺）', get: () => it.rainSize, set: (v) => { it.rainSize = v; sceneChanged(false); }, min: 0.05, max: 2 })));
    }
    if (it.mode !== 'burst') amount.push(F('総量', 'total', { unit: 'L', digits: 2, step: 0.05, min: 0, max: 100, zeroText: '無制限' }));
    const n2 = noteEl('');
    n2.dataset.live = 'emitted';
    amount.push(n2);
    host.appendChild(group('水の量と勢い', ...amount));
    if (it.mode !== 'rain') {
      const aim = document.createElement('div');
      aim.className = 'duo';
      aim.append(
        numberField({ unit: '°', digits: 0, step: 1, prefix: '上下', label: '上下の角度', get: () => it.pitch, set: (v) => { it.pitch = v; sceneChanged(false); }, min: -90, max: 90 }),
        numberField({ unit: '°', digits: 0, step: 1, prefix: '方位', label: '方位', get: () => sourceHeading(it), set: (v) => { setSourceHeading(it, v); sceneChanged(false); } }),
      );
      host.appendChild(group('水の向き', aim, noteEl('上下：−90° で真下、0° で水平、90° で真上。方位：0° で奥（＋Y）、90° で右（＋X）'), actions([['真下', () => { it.pitch = -90; pushUndo(); refreshPanels(); }], ['水平', () => { it.pitch = 0; pushUndo(); refreshPanels(); }], ['真上', () => { it.pitch = 90; pushUndo(); refreshPanels(); }]])));
    }
    host.appendChild(group('配置', row('位置', posFields(it), 'cm'), axisNote()));
    host.appendChild(nameRow(it));
  } else if (it.kind === 'block') {
    host.appendChild(group(null, noteEl('追加したときと、水を最初の状態に戻したとき（下の |◀）に、この枠の形に水が入ります。')));
    host.appendChild(group('大きさ', ...[['w', 'X'], ['d', 'Y'], ['h', 'Z']].map(([k, ax]) => row(DIM_LABELS[k], numberField({ ...CM, label: DIM_LABELS[k], get: () => it.dims[k], set: (v) => { const onFloor = Math.abs(it.pos[1] - it.dims.h / 2) < 0.002; it.dims[k] = v; if (k === 'h' && onFloor) it.pos[1] = v / 2 + 0.001; it.pos = clampItemPos(it, it.pos); sceneChanged(false); }, min: 0.01, max: 1.2 }), ax))));
    const vol = noteEl('');
    vol.dataset.live = 'block';
    host.appendChild(group(null, vol, actions([['いま水を入れる', () => pourBlock(it), 'primary']]), noteEl('すでに水がある所には入れません。')));
    host.appendChild(group('配置', row('位置', posFields(it), 'cm'), axisNote()));
    host.appendChild(nameRow(it));
  } else if (it.kind === 'drain') {
    host.appendChild(group(null, noteEl('触れた水を吸い込んで消します。')));
    host.appendChild(group('大きさ', row('半径', numberField({ ...CM, step: 0.1, label: '半径', get: () => it.r, set: (v) => { it.r = v; sceneChanged(false); }, min: DRAIN_LIMITS[0], max: DRAIN_LIMITS[1] }))));
    host.appendChild(group('配置', row('位置', posFields(it), 'cm'), axisNote(), row('回転', rotFields(it), '度')));
    host.appendChild(nameRow(it));
  }
  liveRefresh();
}
function noteEl(html) { const p = document.createElement('p'); p.className = 'note'; p.innerHTML = html; return p; }
function details(summary, html) {
  const d = document.createElement('details');
  d.className = 'more';
  d.innerHTML = '<summary></summary><p class="note"></p>';
  d.querySelector('summary').textContent = summary;
  d.querySelector('p').innerHTML = html;
  return d;
}
// buttons; `confirm` asks for a second press before doing something that cannot be undone
function actions(list) {
  const d = document.createElement('div');
  d.className = 'actions';
  for (const [label, fn, cls, confirm] of list) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn' + (cls ? ' ' + cls : ''); b.textContent = label;
    let armed = 0;
    b.addEventListener('click', () => {
      if (confirm && !armed) {
        b.classList.add('armed'); b.textContent = 'もう一度押すと実行します';
        armed = setTimeout(() => { armed = 0; b.classList.remove('armed'); b.textContent = label; }, 3500);
        return;
      }
      if (armed) { clearTimeout(armed); armed = 0; b.classList.remove('armed'); b.textContent = label; }
      fn();
    });
    d.appendChild(b);
  }
  return d;
}
// applies a change of size; an obstacle that stood on the floor keeps standing on it
function keepOnFloor(it, change) {
  if (it.kind !== 'obstacle') { change(); return; }
  const b0 = obstacleBottom(it);
  change();
  if (Math.abs(b0) < 0.004) it.pos[1] += b0 - obstacleBottom(it);
}
function setSourceMode(it, k) {
  const was = it.mode;
  it.mode = k;
  if (k === 'rain' && it.pitch > -80) it.pitch = -90;
  // drops fall by themselves; streams need some speed to leave the outlet
  if (k === 'drops' && was !== 'drops') it.speed = 0;
  if ((k === 'stream' || k === 'shower') && it.speed < 0.05) it.speed = 0.6;
  if (k === 'burst' && sim) { const st = sim.emitAcc.get(it.id); if (st) st.fired = true; }
}
// releases one burst right away, also while paused; a repeating source counts its interval from here
function fireBurst(it) {
  let st = sim.emitAcc.get(it.id);
  if (!st) { st = { acc: 0, liters: 0, timer: 0, fired: false }; sim.emitAcc.set(it.id, st); }
  sim.setObjects(scene.items, 0);
  const e = burstEmit(sim, it);
  sim.emitNow([e]);
  st.liters += e.count * sim.vp * 1000;
  st.fired = true;
  st.timer = it.burstEvery > 0 ? it.burstEvery : 0;
}
function clearAllWater() { sim.clearWater(); toast('水槽の水をすべて消しました', 1800); }
function setQuality(k) {
  if (settings.quality === k) return;
  settings.quality = k;
  rebuildSim(true);
  toast(`計算の細かさを「${QUALITY[k].label}」にしました。水は最初の状態から計算し直します`, 3200);
}
function litersText(L) { return L < 1 ? `${(L * 1000).toFixed(L < 0.01 ? 1 : 0)} mL` : `${L.toFixed(2)} L`; }
// numbers shown in the panel that change without rebuilding it (during drags and while water flows)
function liveRefresh() {
  for (const el of $('props').querySelectorAll('.nf')) if (el.refresh && !el.querySelector('input') && !el.classList.contains('focus')) el.refresh();
  const it = selected();
  if (!it) return;
  if (it.kind === 'block') {
    const v = $('props').querySelector('[data-live="block"]');
    if (v) v.innerHTML = `水槽に入る量 約 <b>${blockLiters(it).toFixed(2)} L</b>`;
    return;
  }
  if (it.kind !== 'source') return;
  const minD = sim ? sim.h * 0.5 : 0.004;
  const nz = $('props').querySelector('[data-live="nozzle"]');
  if (nz) nz.innerHTML = sourceNozzle(it) < minD
    ? `いまの計算の細かさでは、約 ${(minD * 1000).toFixed(0)} mm より細い水流は粒の列になります（表示メニューの「計算の細かさ」を上げると細くできます）。`
    : '流量と勢いから決まります。太さを変えると、勢いはそのままで流量が変わります。';
  const dr = $('props').querySelector('[data-live="drop"]');
  if (dr) dr.innerHTML = `1 秒に ${it.dropRate.toFixed(it.dropRate < 10 ? 1 : 0)} 粒`;
  const em = $('props').querySelector('[data-live="emitted"]');
  if (em && sim) {
    const st = sim.emitAcc.get(it.id);
    em.innerHTML = `これまでに出した量 <b>${litersText(st ? st.liters : 0)}</b>`;
  }
}

// ---------- scene list ----------
function buildOutliner() {
  const ul = $('outliner');
  ul.innerHTML = '';
  let selBtn = null;
  const entry = (id, icon, name, cls, extra) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(selectedId === id));
    b.innerHTML = icon + '<span class="nm"></span>' + (extra ? `<span class="off">${extra}</span>` : '');
    b.querySelector('.nm').textContent = name;
    b.addEventListener('click', () => { select(id); if (narrowMQ.matches) setSheetTab('props'); });
    b.addEventListener('dblclick', () => { select(id); focusSelected(); });
    li.appendChild(b);
    ul.appendChild(li);
    if (selectedId === id) selBtn = b;
  };
  entry('tank', ICONS.tank, `水槽（${Math.round(scene.tank.w * 100)}×${Math.round(scene.tank.d * 100)}×${Math.round(scene.tank.h * 100)} cm）`, 'kind-tank');
  for (const it of scene.items) entry(it.id, it.kind === 'obstacle' ? SHAPE_ICONS[it.shape] || ICONS.obstacle : ICONS[it.kind], it.name, 'kind-' + it.kind, it.kind === 'source' && !it.enabled ? '停止中' : '');
  if (selBtn) selBtn.scrollIntoView({ block: 'nearest' });
}

// ---------- tank edits rebuild the solver ----------
let tankTimer = 0;
function tankEdited() {
  clearTimeout(tankTimer);
  tankTimer = setTimeout(() => {
    for (const it of scene.items) it.pos = clampItemPos(it, it.pos);
    rebuildSim(true);
    refreshPanels();
    toast('水槽の大きさを変えたので、水を最初の状態から計算し直しました', 2600);
  }, 450);
  buildOutliner();
}

// ---------- transport ----------
function setPlaying(p) {
  settings.playing = p;
  $('btn-play').setAttribute('aria-pressed', String(!p));
  $('lbl-play').textContent = p ? '一時停止' : '再生';
  $('ico-play').innerHTML = p ? '<rect x="3.5" y="2.5" width="3.2" height="11" rx="0.8"/><rect x="9.3" y="2.5" width="3.2" height="11" rx="0.8"/>' : '<path d="M4 2.6v10.8a.6.6 0 0 0 .9.5l8.3-5.4a.6.6 0 0 0 0-1L4.9 2.1a.6.6 0 0 0-.9.5z"/>';
}
$('btn-play').addEventListener('click', () => setPlaying(!settings.playing));
let stepRequests = 0;
function stepOnce() {
  if (settings.playing) { setPlaying(false); toast('一時停止してコマ送りします', 1400); }
  stepRequests++;
}
$('btn-step').addEventListener('click', stepOnce);
$('btn-reset').addEventListener('click', () => resetSim());
function setSpeed(s) {
  settings.speed = s;
  document.querySelectorAll('[data-speed]').forEach((b) => b.setAttribute('aria-checked', String(+b.dataset.speed === s)));
}
document.querySelectorAll('[data-speed]').forEach((b) => b.addEventListener('click', () => setSpeed(+b.dataset.speed)));
function timeText(t) { return t.toFixed(settings.speed >= 1 ? 2 : settings.speed >= 0.25 ? 3 : 4) + ' s'; }

// ---------- tool strip ----------
function setTool(t) {
  editor.tool = t;
  document.querySelectorAll('[data-tool]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.tool === t)));
  updateHint();
}
function toolAvailable(t) {
  const it = selected();
  if (t === 'dup' || t === 'del') return !!it;
  if (!it) return true;
  if (t === 'rotate') return canRotate(it);
  if (t === 'scale') return canScale(it);
  return true;
}
function toolUnavailable(t) {
  const it = selected();
  if (t === 'dup' || t === 'del') toast(selectedId === 'tank' ? '水槽は複製・削除できません' : '先に物や水源を選んでください', 2000);
  else toast(toolNote(t, it) || 'いま選んでいる物にはこの道具を使えません', 2200);
}
function updateToolButtons() {
  for (const b of document.querySelectorAll('[data-tool]')) b.setAttribute('aria-disabled', String(!toolAvailable(b.dataset.tool)));
  $('btn-dup').setAttribute('aria-disabled', String(!toolAvailable('dup')));
  $('btn-del').setAttribute('aria-disabled', String(!toolAvailable('del')));
}
document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => {
  setTool(b.dataset.tool);
  if (!toolAvailable(b.dataset.tool)) toolUnavailable(b.dataset.tool);
}));

// ---------- settings sheet on narrow screens ----------
const sheet = { auto: false };
function openSheet(tab) {
  setSheetTab(tab || $('side').dataset.tab);
  if (!$('side').classList.contains('open')) sheet.auto = true;
  $('side').classList.add('open');
  $('btn-side').setAttribute('aria-expanded', 'true');
}
function closeSheet() {
  $('side').classList.remove('open', 'tall');
  $('btn-side').setAttribute('aria-expanded', 'false');
  sheet.auto = false;
  updateSheetSizeButton();
}
function setSheetTab(tab) {
  $('side').dataset.tab = tab;
  document.querySelectorAll('.sheet-head [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
}
function updateSheetSizeButton() {
  const tall = $('side').classList.contains('tall');
  const b = $('btn-side-size');
  b.setAttribute('aria-label', tall ? '縮める' : '広げる');
  b.title = tall ? '縮める' : '広げる';
  b.querySelector('path').setAttribute('d', tall ? 'M4 6l4 4 4-4' : 'M4 10l4-4 4 4');
}
$('btn-side').addEventListener('click', () => { if ($('side').classList.contains('open')) closeSheet(); else { openSheet(); sheet.auto = false; } });
$('btn-side-close').addEventListener('click', closeSheet);
$('btn-side-size').addEventListener('click', () => { $('side').classList.toggle('tall'); sheet.auto = false; updateSheetSizeButton(); });
document.querySelectorAll('.sheet-head [data-tab]').forEach((b) => b.addEventListener('click', () => setSheetTab(b.dataset.tab)));

// the boundary between the scene list and the settings can be dragged on wide screens
(() => {
  const sp = $('split');
  sp.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    sp.setPointerCapture(e.pointerId);
    const side = $('side').getBoundingClientRect();
    const move = (ev) => { const h = clamp(ev.clientY - side.top, 70, side.height - 160); $('side').style.gridTemplateRows = `${h}px 6px minmax(0, 1fr)`; };
    const up = () => { sp.removeEventListener('pointermove', move); sp.removeEventListener('pointerup', up); sp.removeEventListener('pointercancel', up); };
    sp.addEventListener('pointermove', move); sp.addEventListener('pointerup', up); sp.addEventListener('pointercancel', up);
  });
})();

// ---------- hint line ----------
function updateHint() {
  const m = editor.modal;
  let h;
  if (m) {
    const nm = { move: '移動', rotate: '回転', scale: '大きさ' }[m.type];
    const ax = m.axis >= 0 ? `　<b>${'XYZ'[m.axis]}（${AXIS_WORDS[m.axis]}）に固定</b>` : '';
    const typed = m.typed ? `　入力：<b>${m.typed}${m.type === 'move' ? ' cm' : m.type === 'rotate' ? '°' : ' 倍'}</b>` : '';
    h = `${nm}中${ax}${typed}　<kbd>X</kbd><kbd>Y</kbd><kbd>Z</kbd> で軸を固定（Z が上下）・数字で値を入力・クリックか <kbd>Enter</kbd> で確定・右クリックか <kbd>Esc</kbd> で取り消し`;
  } else if (selectedId === 'tank') {
    h = '右の欄で水槽の大きさと計算の細かさを変えられます　空いた所をクリックで選択を解除';
  } else if (selected()) {
    const it = selected();
    const note = toolNote(editor.tool, it);
    let what;
    if (note) what = note;
    else if (editor.tool === 'move') what = it.kind === 'block' ? '矢印や中央の丸をドラッグで移動' : '矢印をドラッグでその向きに移動・本体をドラッグで床に沿って移動（<kbd>Shift</kbd> で上下）';
    else if (editor.tool === 'rotate') what = it.kind === 'source' ? '橙の丸をドラッグで水の向きを変える・本体をドラッグで水平に回す' : '輪をドラッグで回転・本体をドラッグで水平に回す';
    else what = '四角をドラッグでその向きの大きさ・中央の四角か本体をドラッグで全体の大きさ';
    h = `${what}　<kbd>G</kbd> 移動 <kbd>R</kbd> 回転 <kbd>S</kbd> 大きさ <kbd>X</kbd> 削除 <kbd>Shift</kbd>+<kbd>D</kbd> 複製`;
  } else if (editor.panMode) {
    h = 'ドラッグで平行移動しています（右上の十字のボタンで回転に戻ります）';
  } else {
    h = '空いた所をドラッグで視点を回す・<kbd>Shift</kbd>+ドラッグで平行移動・ホイール（トラックパッドは2本指の上下）で拡大　物をクリックで選択　<kbd>Shift</kbd>+<kbd>A</kbd> で追加';
  }
  $('hint').innerHTML = h;
}

// ---------- keyboard (Blender-like) ----------
let lastPointer = null;
gpuCanvas.addEventListener('pointermove', (e) => { lastPointer = localXY(e); });
function clientFromLocal(p) { const r = gpuCanvas.getBoundingClientRect(); return [r.left + p[0], r.top + p[1]]; }
function confirmDelete() {
  const it = selected();
  if (!it) return;
  const at = lastPointer ? clientFromLocal(lastPointer) : null;
  closeMenus();
  const dd = $('dd-add');
  buildMenu(dd, [{ grp: `「${it.name}」を削除しますか？` }, { label: '削除', act: deleteSelected }]);
  dd.hidden = false;
  if (at) { dd.style.position = 'fixed'; dd.style.left = at[0] + 'px'; dd.style.top = at[1] + 'px'; }
  dd.querySelector('button').focus({ preventScroll: true });
}
function modalTyped(k) {
  const m = editor.modal;
  let s = m.typed || '';
  if (k === 'Backspace') s = s.slice(0, -1);
  else if (k === '-') s = s.startsWith('-') ? s.slice(1) : '-' + s;
  else if (k === '.' && s.includes('.')) return;
  else s += k;
  m.typed = s;
  applyTyped();
  updateHint();
}
function applyTyped() {
  const m = editor.modal, it = m.item;
  const v = parseFloat(m.typed);
  Object.assign(it, cloneScene(m.start));
  if (!Number.isFinite(v)) { sceneChanged(false); return; }
  const ax = m.axis >= 0 ? m.axis : 0;
  if (m.type === 'move') setPos(it, v3.add(m.start.pos, v3.mul(uiAxisDir(ax), v / 100)));
  else if (m.type === 'rotate') {
    if (it.kind === 'source') setAim(it, m3.apply(m3.axisAngle(uiAxisDir(ax), v * DEG), sourceDir(m.start)), false);
    else setItemRotation(it, m3.mul(m3.axisAngle(uiAxisDir(ax), v * DEG), m.R0));
  } else if (m.type === 'scale' && v > 0) {
    const map = scaleMap(it);
    setDims(it, m.start, m.axis >= 0 ? map[localOfUI(it, m.axis)] : [...map[0], ...map[1], ...map[2]], v);
    afterScale(it, m.start, v, m.lastX ?? m.cx, m.lastY ?? m.cy);
  }
  sceneChanged(false);
}
const VIEW_KEYS = { 1: 'front', 3: 'side', 7: 'top' };
window.addEventListener('keydown', (e) => {
  const tgt = e.target;
  if (tgt instanceof HTMLInputElement || tgt instanceof HTMLTextAreaElement) return;
  const k = e.key;
  if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if ((e.ctrlKey || e.metaKey) && (k === 'y' || k === 'Y')) { e.preventDefault(); redo(); return; }
  if ((e.ctrlKey || e.metaKey) && (k === 's' || k === 'S')) { e.preventDefault(); saveFile(); return; }
  if ((e.ctrlKey || e.metaKey) && (k === 'o' || k === 'O')) { e.preventDefault(); openFile(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (editor.modal) {
    e.preventDefault();
    if (k === 'Escape') endModal(false);
    else if (k === 'Enter') endModal(true);
    else if ('xyzXYZ'.includes(k) && k.length === 1) {
      const a = 'xyz'.indexOf(k.toLowerCase());
      editor.modal.axis = editor.modal.axis === a ? -1 : a;
      if (editor.modal.typed) applyTyped();
      else if (editor.modal.lastX !== undefined) updateModal(editor.modal.lastX, editor.modal.lastY, e.shiftKey);
      updateHint();
    } else if (/^[0-9.\-]$/.test(k) || k === 'Backspace') modalTyped(k);
    return;
  }
  // Space plays and pauses wherever the focus is (buttons are pressed with Enter)
  if (k === ' ') { e.preventDefault(); setPlaying(!settings.playing); return; }
  if (k === 'Escape') { if (!$('welcome').hidden) { $('welcome-ok').click(); return; } closeMenus(); if (selectedId !== null) select(null); return; }
  // the remaining single keys act on the 3D view; inside the panels and menus they keep their usual meaning
  if (tgt instanceof Element && tgt.closest('aside, .dropdown')) return;
  if (k === 'A' && e.shiftKey) { e.preventDefault(); openMenu('m-add', 'dd-add', addMenu, lastPointer ? clientFromLocal(lastPointer) : null); }
  else if ((k === 'D' || k === 'd') && e.shiftKey) { e.preventDefault(); duplicateSelected(true); }
  else if (k === 'g' || k === 'G') { if (lastPointer) startModal('move', lastPointer[0], lastPointer[1]); }
  else if (k === 'r' || k === 'R') { if (lastPointer) startModal('rotate', lastPointer[0], lastPointer[1]); }
  else if (k === 's' || k === 'S') { if (lastPointer) startModal('scale', lastPointer[0], lastPointer[1]); }
  else if (k === 'x' || k === 'X') { if (selected()) { e.preventDefault(); confirmDelete(); } }
  else if (k === 'Delete' || k === 'Backspace') { if (selected()) { e.preventDefault(); deleteSelected(); } }
  else if (k === 'Home') viewHome();
  else if (VIEW_KEYS[k]) animateCamera({ ...VIEW_PRESETS[VIEW_KEYS[k]], ...frameAll() });
  else if (k === '.') focusSelected();
  else if (k === 'ArrowRight') stepOnce();
  else if (k === 'ArrowLeft' && e.shiftKey) resetSim();
  else if (k === 'w' || k === 'W') setTool('move');
  else if (k === 'e' || k === 'E') setTool('rotate');
});

// ---------- first visit ----------
function showWelcome() {
  const steps = isCoarse ? [
    '<b>1本指でなぞる</b>と視点が回り、<b>2本指</b>で拡大・平行移動できます。',
    '<b>物や水源をタップ</b>すると、下に出る「設定」で水の量や勢い、大きさを変えられます。',
    '選んだ物の<b>矢印や輪をなぞる</b>と、動かしたり回したりできます。',
    '<b>＋追加</b>で物・水源・水を置き、<b>ファイル</b>からサンプルを開けます。',
  ] : [
    '<b>空いた所をドラッグ</b>すると視点が回ります（Shift+ドラッグで平行移動、ホイールで拡大）。',
    '<b>物や水源をクリック</b>すると、右の欄で水の量や勢い、大きさを変えられます。',
    '選んだ物の<b>矢印や輪をドラッグ</b>すると、動かしたり回したりできます。Blender と同じ G・R・S キーも使えます。',
    '<b>＋追加</b>で物・水源・水を置き、<b>ファイル</b>からサンプルを開けます。',
  ];
  $('welcome-steps').innerHTML = steps.map((s) => `<li>${s}</li>`).join('');
  $('welcome').hidden = false;
  $('welcome-ok').focus({ preventScroll: true });
}
$('welcome-ok').addEventListener('click', () => { $('welcome').hidden = true; store.set('suiri-lab-welcome', '1'); gpuCanvas.focus({ preventScroll: true }); });
