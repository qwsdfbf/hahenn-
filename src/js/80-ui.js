// ============================================================
//  Panels: menus, scene list, properties, transport
// ============================================================
const settings = { playing: true, speed: 1, guides: true, whitewater: true, quality: 'standard' };

// ---------- undo ----------
const undoStack = [], redoStack = [];
let lastSnapshot = null;
function snapshot() { return JSON.stringify({ scene, selectedId }); }
function pushUndo() {
  const s = snapshot();
  if (s === lastSnapshot) return;
  if (lastSnapshot) undoStack.push(lastSnapshot);
  if (undoStack.length > 120) undoStack.shift();
  redoStack.length = 0;
  lastSnapshot = s;
  updateUndoButtons();
  saveSoon();
}
function restore(s) {
  const o = JSON.parse(s);
  const tankChanged = JSON.stringify(o.scene.tank) !== JSON.stringify(scene.tank);
  scene.tank = o.scene.tank;
  scene.items = o.scene.items;
  uid = Math.max(uid, ...scene.items.map((i) => i.id + 1));
  selectedId = o.selectedId && (o.selectedId === 'tank' || getItem(o.selectedId)) ? o.selectedId : null;
  lastSnapshot = s;
  if (tankChanged) rebuildSim(true);
  sceneChanged(true);
  updateUndoButtons();
  saveSoon();
}
function undo() { if (!undoStack.length) return; redoStack.push(lastSnapshot); restore(undoStack.pop()); toast('元に戻しました', 1200); }
function redo() { if (!redoStack.length) return; undoStack.push(lastSnapshot); restore(redoStack.pop()); toast('やり直しました', 1200); }
function updateUndoButtons() { $('btn-undo').disabled = !undoStack.length; $('btn-redo').disabled = !redoStack.length; }
$('btn-undo').addEventListener('click', undo);
$('btn-redo').addEventListener('click', redo);

let saveTimer = 0;
function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(() => store.set('suiri-lab-scene', JSON.stringify({ v: 1, scene, cam: { target: cam.target, dist: cam.dist, az: cam.az, el: cam.el } })), 400); }

// ---------- selection & refresh ----------
function select(id) {
  selectedId = id;
  editor.hover = null;
  refreshPanels();
  updateHint();
}
let panelsDirty = true;
function sceneChanged(structural) {
  if (structural) panelsDirty = true;
  else liveRefresh();
}
function refreshPanels() { panelsDirty = true; }

// ---------- menus ----------
const MENU_ADD = [
  { grp: '障害物' },
  ...['box', 'plate', 'sphere', 'cylinder', 'cone', 'torus', 'cup', 'container', 'gutter'].map((s) => ({ label: SHAPES[s].label, icon: ICONS.obstacle, act: () => addItem(makeObstacle(s)) })),
  { sep: true },
  { grp: '水' },
  { label: '水源', icon: ICONS.source, act: () => addItem(makeSource()) },
  { label: '水の塊', icon: ICONS.block, act: () => addItem(makeBlock()) },
  { label: '排水口', icon: ICONS.drain, act: () => addItem(makeDrain()) },
];
function buildMenu(dd, entries) {
  dd.innerHTML = '';
  for (const e of entries) {
    if (e.sep) { const s = document.createElement('div'); s.className = 'sep'; dd.appendChild(s); continue; }
    if (e.grp) { const g = document.createElement('div'); g.className = 'grp'; g.textContent = e.grp; dd.appendChild(g); continue; }
    const b = document.createElement('button');
    b.type = 'button';
    if (e.check !== undefined) { b.className = 'check'; b.setAttribute('role', 'menuitemcheckbox'); b.setAttribute('aria-checked', String(!!e.check())); }
    else b.setAttribute('role', 'menuitem');
    b.innerHTML = (e.icon || '') + '<span></span>' + (e.key ? `<span class="k">${e.key}</span>` : '');
    b.querySelector('span').textContent = e.label;
    b.addEventListener('click', () => { closeMenus(); e.act(); });
    dd.appendChild(b);
  }
}
function viewMenu() {
  return [
    { grp: '表示' },
    { label: '水源・水の塊などの目印', check: () => settings.guides, act: () => { settings.guides = !settings.guides; } },
    { label: '白い泡としぶき', check: () => settings.whitewater, act: () => { settings.whitewater = !settings.whitewater; } },
    { sep: true },
    { grp: '計算の細かさ' },
    ...Object.entries(QUALITY).map(([k, q]) => ({ label: q.label, check: () => settings.quality === k, act: () => { if (settings.quality !== k) { settings.quality = k; rebuildSim(true); toast(`計算の細かさを「${q.label}」にしました`); } } })),
    { sep: true },
    { grp: '視点' },
    { label: '全体', key: 'Home', act: () => animateCamera({ ...frameAll(), ...VIEW_PRESETS.home }) },
    { label: '正面', key: '1', act: () => animateCamera({ ...VIEW_PRESETS.front, ...frameAll() }) },
    { label: '横', key: '3', act: () => animateCamera({ ...VIEW_PRESETS.side, ...frameAll() }) },
    { label: '真上', key: '7', act: () => animateCamera({ ...VIEW_PRESETS.top, ...frameAll() }) },
    { label: '選択した物に寄る', key: '.', act: focusSelected },
  ];
}
const menus = [['m-add', 'dd-add', () => MENU_ADD], ['m-sample', 'dd-sample', () => PRESETS.map((p) => ({ label: p.label, act: () => loadPreset(p) }))], ['m-view', 'dd-view', viewMenu]];
function closeMenus() {
  for (const [b, d] of menus) { $(d).hidden = true; $(b).setAttribute('aria-expanded', 'false'); }
}
for (const [btn, dd, make] of menus) {
  $(btn).addEventListener('click', (e) => {
    e.stopPropagation();
    const open = $(dd).hidden;
    closeMenus();
    if (open) { buildMenu($(dd), make()); $(dd).hidden = false; $(btn).setAttribute('aria-expanded', 'true'); const f = $(dd).querySelector('button'); if (f) f.focus(); }
  });
}
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.menu')) closeMenus(); });

// ---------- adding / removing ----------
function placementPoint() {
  // where the camera looks, on the tank floor, kept inside the tank
  const t = scene.tank;
  return [clamp(cam.target[0], -t.w / 2 + 0.05, t.w / 2 - 0.05), 0, clamp(cam.target[2], -t.d / 2 + 0.05, t.d / 2 - 0.05)];
}
function addItem(it) {
  const p = placementPoint();
  if (it.kind === 'obstacle') {
    it.pos = [p[0], 0.2, p[2]];
    it.pos[1] += 0.2 - obstacleBottom(it) - 0.2 + 0.0005;
  } else if (it.kind === 'source') it.pos = [p[0], Math.min(scene.tank.h + 0.08, 0.5), p[2]];
  else if (it.kind === 'block') it.pos = [p[0], it.dims.h / 2 + 0.001, p[2]];
  else if (it.kind === 'drain') it.pos = [p[0], 0, p[2]];
  const same = scene.items.filter((x) => x.name.replace(/ \d+$/, '') === it.name).length;
  if (same > 0) it.name = `${it.name} ${same + 1}`;
  scene.items.push(it);
  select(it.id);
  pushUndo();
  sceneChanged(true);
  toast(`「${it.name}」を追加しました`, 1600);
}
function deleteSelected() {
  const it = selected();
  if (!it) return;
  scene.items = scene.items.filter((x) => x !== it);
  select(null);
  pushUndo();
  sceneChanged(true);
  toast(`「${it.name}」を削除しました（Ctrl+Z で戻せます）`);
}
function duplicateSelected(grab) {
  const it = selected();
  if (!it) return;
  const c = cloneScene(it);
  c.id = uid++;
  c.name = it.name.replace(/ \d+$/, '') + ' ' + (scene.items.filter((x) => x.name.startsWith(it.name.replace(/ \d+$/, ''))).length + 1);
  c.pos = [it.pos[0] + 0.03, it.pos[1], it.pos[2] + 0.03];
  scene.items.push(c);
  select(c.id);
  pushUndo();
  sceneChanged(true);
  if (grab && lastPointer) startModal('move', lastPointer[0], lastPointer[1]);
}
function focusSelected() {
  const it = selected();
  if (!it) { animateCamera({ ...frameAll() }); return; }
  const r = it.kind === 'obstacle' ? boundRadius(it) : it.kind === 'block' ? Math.max(it.dims.w, it.dims.h, it.dims.d) / 2 : 0.05;
  animateCamera({ target: [...it.pos].map((x, i) => (i === 1 ? Math.max(x, 0) : x)), dist: clamp(r * 4.5 + 0.12, 0.15, 3) });
}
$('btn-del').addEventListener('click', deleteSelected);
$('btn-dup').addEventListener('click', () => duplicateSelected(false));

// ---------- presets ----------
function loadPreset(p, quiet) {
  const s = p.make();
  scene.tank = s.tank;
  scene.items = s.items;
  selectedId = null;
  rebuildSim(true);
  sceneChanged(true);
  pushUndo();
  animateCamera({ ...frameAll(), ...VIEW_PRESETS.home });
  if (!quiet) toast(`サンプル「${p.label}」を読み込みました`);
}

// ---------- number fields (drag to scrub, click to type) ----------
function numberField({ get, set, unit = '', scale = 1, digits = 1, step = 0.1, min = -Infinity, max = Infinity, axis = null, prefix = null, zeroText = null, label, fill = null }) {
  const el = document.createElement('div');
  el.className = 'nf';
  el.tabIndex = 0;
  el.setAttribute('role', 'spinbutton');
  if (label) el.setAttribute('aria-label', label);
  el.innerHTML = (fill ? '<span class="fill"></span>' : '') + (axis ? `<span class="ax ${axis}">${axis.toUpperCase()}</span>` : '') + (prefix ? '<span class="ax pre"></span>' : '') + '<span class="val"></span>';
  if (prefix) el.querySelector('.pre').textContent = prefix;
  const val = el.querySelector('.val');
  const fmt = (v) => (zeroText && Math.abs(v) < 1e-9 ? zeroText : (v * scale).toFixed(digits) + (unit ? ' ' + unit : ''));
  const render = () => {
    const v = get();
    val.textContent = fmt(v);
    el.setAttribute('aria-valuenow', (v * scale).toFixed(digits));
    if (fill) el.querySelector('.fill').style.width = `${clamp((v - fill[0]) / (fill[1] - fill[0]), 0, 1) * 100}%`;
  };
  const apply = (v) => { set(clamp(v, min, max)); render(); };
  let start = null;
  el.addEventListener('pointerdown', (e) => {
    if (el.querySelector('input')) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    start = { x: e.clientX, v: get(), moved: false };
    el.classList.add('focus');
  });
  el.addEventListener('pointermove', (e) => {
    if (!start) return;
    const dx = e.clientX - start.x;
    if (!start.moved && Math.abs(dx) < 3) return;
    start.moved = true;
    const k = e.shiftKey ? 0.1 : 1;
    let v = start.v + (dx / 4) * (step / scale) * k;
    if (e.ctrlKey) v = Math.round(v / (step / scale * 10)) * (step / scale * 10);
    apply(v);
  });
  const up = () => {
    if (!start) return;
    const moved = start.moved;
    start = null;
    el.classList.remove('focus');
    if (moved) pushUndo(); else edit();
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', () => { start = null; el.classList.remove('focus'); });
  function edit() {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.inputMode = 'decimal';
    inp.value = (get() * scale).toFixed(digits);
    el.appendChild(inp);
    inp.focus();
    inp.select();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (ok) {
        const n = parseFloat(inp.value.replace(/[^0-9.+\-eE]/g, ''));
        if (Number.isFinite(n)) { apply(n / scale); pushUndo(); }
      }
      inp.remove();
      render();
    };
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { finish(true); el.focus(); }
      else if (e.key === 'Escape') { finish(false); el.focus(); }
    });
    inp.addEventListener('blur', () => finish(true));
  }
  el.addEventListener('keydown', (e) => {
    if (el.querySelector('input')) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); edit(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); apply(get() + (step / scale) * (e.shiftKey ? 10 : 1)); pushUndo(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); apply(get() - (step / scale) * (e.shiftKey ? 10 : 1)); pushUndo(); }
  });
  render();
  el.refresh = render;
  return el;
}
function row(labelText, control) {
  const r = document.createElement('div');
  r.className = 'prow';
  const l = document.createElement('span');
  l.className = 'lbl';
  l.textContent = labelText;
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
    b.addEventListener('click', () => { set(k); pushUndo(); refreshPanels(); });
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
const liveFields = [];
function posFields(it) {
  return trio([0, 1, 2].map((i) => numberField({ ...CM, unit: '', axis: 'xyz'[i], label: `位置 ${'XYZ'[i]}（cm）`, get: () => it.pos[i], set: (v) => { it.pos[i] = clamp(v, -3, 3); sceneChanged(false); } })));
}
function rotFields(it) {
  return trio([0, 1, 2].map((i) => numberField({ unit: '', digits: 0, step: 1, axis: 'xyz'[i], label: `回転 ${'XYZ'[i]}（度）`, get: () => it.rot[i], set: (v) => { it.rot[i] = ((v % 360) + 540) % 360 - 180; sceneChanged(false); } })));
}

// ---------- property panel ----------
function buildProps() {
  const host = $('props');
  host.innerHTML = '';
  liveFields.length = 0;
  const title = $('props-title');
  if (selectedId === 'tank') {
    title.textContent = 'プロパティ：水槽';
    const t = scene.tank;
    const tankField = (k, lbl, lo, hi) => numberField({ ...CM, label: lbl, get: () => t[k], set: (v) => { t[k] = clamp(v, lo, hi); tankEdited(); }, min: lo, max: hi });
    host.append(
      group('大きさ', row('幅', tankField('w', '幅', 0.2, 1.2)), row('高さ', tankField('h', '高さ', 0.1, 0.6)), row('奥行き', tankField('d', '奥行き', 0.15, 1.0))),
      group('計算の細かさ', segmented(Object.entries(QUALITY).map(([k, q]) => [k, q.label]), () => settings.quality, (k) => { settings.quality = k; rebuildSim(true); }, '計算の細かさ')),
      group(null, noteEl(`格子 ${sim.nx} × ${sim.ny} × ${sim.nz}（1 マス ${(sim.h * 1000).toFixed(1)} mm）・粒子の上限 ${sim.cap.toLocaleString('ja-JP')}`)),
      actions([['水をすべて消す', () => { sim.clearWater(); toast('水を消しました'); }, 'danger'], ['最初の状態に戻す', resetSim]]),
    );
    return;
  }
  const it = selected();
  if (!it) {
    title.textContent = 'プロパティ';
    const p = document.createElement('p');
    p.className = 'empty';
    p.textContent = '3D ビューかシーン一覧で項目を選ぶと、ここで位置や大きさ、水の量と勢いを変えられます。';
    host.appendChild(p);
    return;
  }
  title.textContent = 'プロパティ：' + it.name;
  const name = document.createElement('input');
  name.className = 'txt'; name.value = it.name; name.setAttribute('aria-label', '名前');
  name.addEventListener('change', () => { it.name = name.value.trim() || it.name; pushUndo(); refreshPanels(); });
  name.addEventListener('keydown', (e) => e.stopPropagation());
  host.appendChild(row('名前', name));

  if (it.kind === 'obstacle') {
    host.appendChild(group('配置', row('位置 cm', posFields(it)), row('回転 °', rotFields(it))));
    const dimsRows = Object.keys(it.dims).map((k) => {
      const lim = DIM_LIMITS[k] || [0.004, 1];
      return row(DIM_LABELS[k] || k, numberField({ ...CM, step: k === 't' ? 0.1 : 0.5, label: DIM_LABELS[k], get: () => it.dims[k], set: (v) => { it.dims[k] = v; sceneChanged(false); }, min: lim[0], max: lim[1] }));
    });
    host.appendChild(group(`形：${SHAPES[it.shape].label}`, ...dimsRows));
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
    host.appendChild(actions([['床に置く', () => { it.pos[1] += -obstacleBottom(it) + 0.0005; pushUndo(); sceneChanged(false); refreshPanels(); }], ['複製', () => duplicateSelected(false)], ['削除', deleteSelected, 'danger']]));
  } else if (it.kind === 'source') {
    host.appendChild(group(null, toggle(() => it.enabled, (v) => { it.enabled = v; }, '水を出す')));
    host.appendChild(group('出し方', segmented(Object.entries(SOURCE_MODES).map(([k, m]) => [k, m.label]), () => it.mode, (k) => { it.mode = k; if (k === 'rain' && it.pitch > -80) it.pitch = -90; }, '出し方')));
    const aim = document.createElement('div');
    aim.className = 'duo';
    aim.append(
      numberField({ unit: '°', digits: 0, step: 1, prefix: '上下', label: '上下の角度（-90 で真下）', get: () => it.pitch, set: (v) => { it.pitch = clamp(v, -90, 90); }, min: -90, max: 90 }),
      numberField({ unit: '°', digits: 0, step: 1, prefix: '方位', label: '水平の向き', get: () => it.yaw, set: (v) => { it.yaw = ((v % 360) + 360) % 360; } }),
    );
    host.appendChild(group('配置', row('位置 cm', posFields(it)), it.mode === 'rain' ? null : row('向き', aim)));
    const amount = [];
    const F = (lbl, key, o) => row(lbl, numberField({ label: lbl, get: () => it[key], set: (v) => { it[key] = v; liveRefresh(); }, ...o }));
    if (it.mode === 'stream' || it.mode === 'shower') {
      amount.push(F('水量', 'flow', { unit: 'L/分', digits: 2, step: 0.05, min: 0.05, max: 40, fill: [0, 10] }));
      amount.push(F('勢い', 'speed', { unit: 'm/s', digits: 2, step: 0.05, min: 0.05, max: 12, fill: [0, 4] }));
      if (it.mode === 'shower') amount.push(F('広がり', 'spread', { unit: '°', digits: 0, step: 1, min: 0, max: 80 }));
      const n = noteEl('');
      n.dataset.live = 'nozzle';
      amount.push(n);
    } else if (it.mode === 'drops') {
      amount.push(F('粒の直径', 'dropD', { unit: 'mm', digits: 1, step: 0.1, min: 1, max: 40, fill: [1, 15] }));
      amount.push(F('間隔', 'dropRate', { unit: '粒/秒', digits: 1, step: 0.1, min: 0.05, max: 60 }));
      amount.push(F('勢い', 'speed', { unit: 'm/s', digits: 2, step: 0.05, min: 0, max: 12, fill: [0, 4] }));
    } else if (it.mode === 'burst') {
      amount.push(F('一度の量', 'burst', { unit: 'L', digits: 2, step: 0.01, min: 0.01, max: 50, fill: [0, 2] }));
      amount.push(F('勢い', 'speed', { unit: 'm/s', digits: 2, step: 0.05, min: 0, max: 12, fill: [0, 4] }));
      amount.push(F('繰り返し', 'burstEvery', { unit: '秒ごと', digits: 1, step: 0.1, min: 0, max: 60 }));
    } else if (it.mode === 'rain') {
      amount.push(F('雨量', 'rainRate', { unit: 'mm/時', digits: 0, step: 1, min: 1, max: 500, fill: [0, 200] }));
      amount.push(row('範囲', numberField({ ...CM, label: '範囲', get: () => it.rainSize, set: (v) => { it.rainSize = v; }, min: 0.05, max: 2 })));
    }
    if (it.mode !== 'burst') amount.push(F('総量', 'total', { unit: 'L', digits: 2, step: 0.05, min: 0, max: 100, zeroText: '無制限' }));
    const n2 = noteEl('');
    n2.dataset.live = 'emitted';
    amount.push(n2);
    host.appendChild(group('水の量と勢い', ...amount));
    host.appendChild(actions([['複製', () => duplicateSelected(false)], ['削除', deleteSelected, 'danger']]));
  } else if (it.kind === 'block') {
    host.appendChild(group('配置', row('位置 cm', posFields(it))));
    host.appendChild(group('大きさ', ...['w', 'h', 'd'].map((k) => row(DIM_LABELS[k], numberField({ ...CM, label: DIM_LABELS[k], get: () => it.dims[k], set: (v) => { it.dims[k] = v; sceneChanged(false); }, min: 0.01, max: 1.2 })))));
    host.appendChild(group(null, noteEl(`約 <b>${(it.dims.w * it.dims.h * it.dims.d * 1000).toFixed(2)} L</b>`)));
    host.appendChild(actions([['この形で水を入れ直す', resetSim], ['複製', () => duplicateSelected(false)], ['削除', deleteSelected, 'danger']]));
  } else if (it.kind === 'drain') {
    host.appendChild(group('配置', row('位置 cm', posFields(it)), row('回転 °', rotFields(it))));
    host.appendChild(group('大きさ', row('半径', numberField({ ...CM, step: 0.1, label: '半径', get: () => it.r, set: (v) => { it.r = v; sceneChanged(false); }, min: 0.005, max: 0.2 }))));
    host.appendChild(actions([['複製', () => duplicateSelected(false)], ['削除', deleteSelected, 'danger']]));
  }
  liveRefresh();
}
function noteEl(html) { const p = document.createElement('p'); p.className = 'note'; p.innerHTML = html; return p; }
function actions(list) {
  const d = document.createElement('div');
  d.className = 'actions';
  for (const [label, fn, cls] of list) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn' + (cls ? ' ' + cls : ''); b.textContent = label;
    b.addEventListener('click', fn);
    d.appendChild(b);
  }
  return d;
}
// update numbers shown in the panel without rebuilding it (during drags)
function liveRefresh() {
  for (const el of $('props').querySelectorAll('.nf')) if (el.refresh && !el.querySelector('input') && !el.classList.contains('focus')) el.refresh();
  const it = selected();
  if (!it || it.kind !== 'source') return;
  const nz = $('props').querySelector('[data-live="nozzle"]');
  if (nz) nz.innerHTML = it.mode === 'shower' ? `吹き出し口の直径 <b>${Math.max(sourceNozzle(it) * 1000, 44).toFixed(0)} mm</b>` : `出口の太さ <b>${(sourceNozzle(it) * 1000).toFixed(1)} mm</b>（水量 ÷ 勢い）`;
  const em = $('props').querySelector('[data-live="emitted"]');
  if (em && sim) {
    const st = sim.emitAcc.get(it.id);
    em.innerHTML = `これまでに出した量 <b>${(st ? st.liters : 0).toFixed(2)} L</b>`;
  }
}

// ---------- scene list ----------
function buildOutliner() {
  const ul = $('outliner');
  ul.innerHTML = '';
  const entry = (id, icon, name, cls, extra) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', String(selectedId === id));
    b.innerHTML = icon + '<span class="nm"></span>' + (extra ? `<span class="off">${extra}</span>` : '');
    b.querySelector('.nm').textContent = name;
    b.addEventListener('click', () => select(id));
    b.addEventListener('dblclick', () => { select(id); focusSelected(); });
    li.appendChild(b);
    ul.appendChild(li);
  };
  entry('tank', ICONS.tank, `水槽（${Math.round(scene.tank.w * 100)}×${Math.round(scene.tank.h * 100)}×${Math.round(scene.tank.d * 100)} cm）`, 'kind-tank');
  for (const it of scene.items) entry(it.id, ICONS[it.kind], it.name, 'kind-' + it.kind, it.kind === 'source' && !it.enabled ? '停止中' : '');
}

// ---------- tank edits rebuild the solver ----------
let tankTimer = 0;
function tankEdited() {
  clearTimeout(tankTimer);
  tankTimer = setTimeout(() => { rebuildSim(true); refreshPanels(); }, 350);
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
$('btn-step').addEventListener('click', () => { setPlaying(false); stepRequests++; });
$('btn-reset').addEventListener('click', resetSim);
function setSpeed(s) {
  settings.speed = s;
  document.querySelectorAll('[data-speed]').forEach((b) => b.setAttribute('aria-checked', String(+b.dataset.speed === s)));
}
document.querySelectorAll('[data-speed]').forEach((b) => b.addEventListener('click', () => setSpeed(+b.dataset.speed)));

// tool strip
function setTool(t) {
  editor.tool = t;
  document.querySelectorAll('[data-tool]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.tool === t)));
  updateHint();
}
document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));

// side drawer on narrow screens
function setDrawer(open) { $('side').classList.toggle('open', open); $('btn-side').setAttribute('aria-expanded', String(open)); }
$('btn-side').addEventListener('click', () => setDrawer(!$('side').classList.contains('open')));
$('btn-side-close').addEventListener('click', () => setDrawer(false));

// hint line
const isCoarse = window.matchMedia('(pointer: coarse)').matches;
function updateHint() {
  const m = editor.modal;
  let h;
  if (m) {
    const nm = { move: '移動', rotate: '回転', scale: '寸法' }[m.type];
    h = `${nm}中：<kbd>X</kbd><kbd>Y</kbd><kbd>Z</kbd> で軸を固定・クリックか <kbd>Enter</kbd> で確定・右クリックか <kbd>Esc</kbd> で取り消し`;
  } else if (selected()) {
    h = '矢印・輪をドラッグで編集　<kbd>G</kbd> 移動 <kbd>R</kbd> 回転 <kbd>S</kbd> 寸法 <kbd>X</kbd> 削除 <kbd>Shift</kbd>+<kbd>D</kbd> 複製';
  } else {
    h = '空いた所をドラッグで回転・<kbd>Shift</kbd>+ドラッグで平行移動・ホイールで拡大　<kbd>Shift</kbd>+<kbd>A</kbd> で追加';
  }
  $('hint').innerHTML = h;
}

// keyboard (Blender-like)
let lastPointer = null;
gpuCanvas.addEventListener('pointermove', (e) => { lastPointer = localXY(e); });
window.addEventListener('keydown', (e) => {
  const tgt = e.target;
  if (tgt instanceof HTMLInputElement || tgt instanceof HTMLTextAreaElement) return;
  const k = e.key;
  if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if ((e.ctrlKey || e.metaKey) && (k === 'y' || k === 'Y')) { e.preventDefault(); redo(); return; }
  if (e.ctrlKey || e.metaKey) return;
  if (editor.modal) {
    if (k === 'Escape') { endModal(false); e.preventDefault(); }
    else if (k === 'Enter') { endModal(true); e.preventDefault(); }
    else if ('xyzXYZ'.includes(k) && k.length === 1) {
      const a = 'xyz'.indexOf(k.toLowerCase());
      editor.modal.axis = editor.modal.axis === a ? -1 : a;
      if (editor.modal.lastX !== undefined) updateModal(editor.modal.lastX, editor.modal.lastY, e.shiftKey);
    }
    return;
  }
  if (tgt instanceof HTMLButtonElement && (k === ' ' || k === 'Enter')) return;
  if (k === ' ') { e.preventDefault(); setPlaying(!settings.playing); }
  else if (k === 'A' && e.shiftKey) { e.preventDefault(); $('m-add').click(); }
  else if ((k === 'D' || k === 'd') && e.shiftKey) { e.preventDefault(); duplicateSelected(true); }
  else if (k === 'g' || k === 'G') { if (lastPointer) startModal('move', lastPointer[0], lastPointer[1]); }
  else if (k === 'r' || k === 'R') { if (lastPointer) startModal('rotate', lastPointer[0], lastPointer[1]); }
  else if (k === 's' || k === 'S') { if (lastPointer) startModal('scale', lastPointer[0], lastPointer[1]); }
  else if (k === 'x' || k === 'X' || k === 'Delete' || k === 'Backspace') { if (selected()) { e.preventDefault(); deleteSelected(); } }
  else if (k === 'Escape') { closeMenus(); select(null); }
  else if (k === 'Home') { animateCamera({ ...frameAll(), ...VIEW_PRESETS.home }); }
  else if (k === '1') animateCamera({ ...VIEW_PRESETS.front, ...frameAll() });
  else if (k === '3') animateCamera({ ...VIEW_PRESETS.side, ...frameAll() });
  else if (k === '7') animateCamera({ ...VIEW_PRESETS.top, ...frameAll() });
  else if (k === '.') focusSelected();
  else if (k === 'ArrowRight' && !settings.playing) stepRequests++;
  else if (k === 'w' || k === 'W') setTool('move');
  else if (k === 'e' || k === 'E') setTool('rotate');
});
