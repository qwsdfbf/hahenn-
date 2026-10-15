// ============================================================
//  Scene model
// ============================================================
// Obstacle shapes. `type` is the shape id used by the GPU signed-distance code.
const SHAPES = {
  box:       { label: '箱',       type: 0, dims: { w: 0.10, h: 0.06, d: 0.08 } },
  plate:     { label: '板',       type: 0, dims: { w: 0.22, d: 0.10, t: 0.012 } },
  sphere:    { label: '球',       type: 1, dims: { r: 0.035 } },
  cylinder:  { label: '円柱',     type: 2, dims: { r: 0.025, h: 0.12 } },
  cone:      { label: '円錐',     type: 3, dims: { r: 0.04, h: 0.08 } },
  torus:     { label: 'ドーナツ', type: 4, dims: { R: 0.05, r: 0.014 } },
  cup:       { label: 'コップ',   type: 5, dims: { r: 0.04, h: 0.10, t: 0.006 } },
  container: { label: '容器',     type: 6, dims: { w: 0.14, h: 0.06, d: 0.10, t: 0.008 } },
  gutter:    { label: '樋（とい）', type: 7, dims: { len: 0.28, r: 0.03, t: 0.006 } },
};
const DIM_LABELS = { w: '幅', h: '高さ', d: '奥行き', t: '厚み', r: '半径', R: '輪の半径', len: '長さ' };
const DIM_LIMITS = { w: [0.01, 1.2], h: [0.005, 1.0], d: [0.01, 1.2], t: [0.004, 0.05], r: [0.004, 0.4], R: [0.01, 0.4], len: [0.04, 1.2] };
const DRAIN_LIMITS = [0.005, 0.2];

const MATERIALS = {
  ceramic: { label: '陶器', rough: 0.18, metal: 0 },
  plastic: { label: '樹脂', rough: 0.42, metal: 0 },
  metal:   { label: '金属', rough: 0.28, metal: 1 },
  stone:   { label: '石',   rough: 0.85, metal: 0 },
};
const PALETTE = ['#e9e4da', '#c9c2b4', '#8a8f94', '#3c4247', '#c75b45', '#e3a33c', '#5f8f5a', '#3f6fa3'];

const SOURCE_MODES = {
  stream: { label: '蛇口' },
  drops:  { label: '水滴' },
  shower: { label: 'シャワー' },
  burst:  { label: 'まとめて' },
  rain:   { label: '雨' },
};

let uid = 1;
const SHAPE_ICONS = {
  box: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M9 2.5l6 3.2v6.6L9 15.5l-6-3.2V5.7z"/><path d="M3 5.7L9 9l6-3.3M9 9v6.5"/></svg>',
  plate: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M2 8.5l7-3 7 3-7 3z"/><path d="M2 8.5v1.6l7 3 7-3V8.5M9 11.5v1.6"/></svg>',
  sphere: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="9" cy="9" r="6.2"/><path d="M2.8 9c1.6 1.6 10.8 1.6 12.4 0" stroke-dasharray="1.6 1.4"/></svg>',
  cylinder: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.3"><ellipse cx="9" cy="4.2" rx="4.2" ry="1.7"/><path d="M4.8 4.2v9.6c0 .9 1.9 1.7 4.2 1.7s4.2-.8 4.2-1.7V4.2"/></svg>',
  cone: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M9 2.3l5 11.4M9 2.3L4 13.7"/><ellipse cx="9" cy="13.7" rx="5" ry="1.8"/></svg>',
  torus: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.3"><ellipse cx="9" cy="9.5" rx="6.8" ry="3.8"/><ellipse cx="9" cy="9" rx="2.8" ry="1.2"/></svg>',
  cup: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><ellipse cx="9" cy="3.8" rx="4.6" ry="1.5"/><path d="M4.4 3.8l.9 10.3c.1.9 1.7 1.5 3.7 1.5s3.6-.6 3.7-1.5l.9-10.3"/></svg>',
  container: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M2.5 6.5L9 9.3l6.5-2.8M2.5 6.5v5.2L9 14.5l6.5-2.8V6.5M9 9.3v5.2"/><path d="M2.5 6.5L9 3.7l6.5 2.8" stroke-dasharray="1.5 1.3"/></svg>',
  gutter: '<svg viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M2 6.5c0 3.2 2.2 5.2 5 5.2h4c2.8 0 5-2 5-5.2"/><path d="M2 6.5h2.2M13.8 6.5H16M4.2 6.5c0 2 1.3 3.2 3 3.2h3.6c1.7 0 3-1.2 3-3.2"/></svg>',
};
const ICONS = {
  obstacle: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M8 1.8l5.5 3.1v6.2L8 14.2 2.5 11.1V4.9z"/><path d="M2.5 4.9L8 8l5.5-3.1M8 8v6.2"/></svg>',
  source: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 3.5h6.5a2 2 0 0 1 2 2V7"/><path d="M3 2v3"/><path d="M11.5 9.5v1.5M11.5 13v1"/></svg>',
  block: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2.5" y="5" width="11" height="8.5" rx="1"/><path d="M2.5 8c1.8-1 3.7-1 5.5 0s3.7 1 5.5 0"/></svg>',
  drain: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="5.5"/><path d="M5 8h6M8 5v6"/></svg>',
  tank: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2 4v9.5h12V4"/><path d="M2 8.5h12" stroke-dasharray="2 1.5"/></svg>',
};

function makeObstacle(shape, pos) {
  const s = SHAPES[shape];
  return {
    id: uid++, kind: 'obstacle', shape, name: s.label,
    pos: pos ? [...pos] : [0, 0.05, 0], rot: [0, 0, 0], dims: { ...s.dims },
    color: shape === 'cup' ? '#e9e4da' : shape === 'gutter' ? '#8a8f94' : '#c9c2b4',
    material: shape === 'gutter' ? 'metal' : shape === 'sphere' || shape === 'cone' ? 'stone' : 'ceramic',
  };
}
function makeSource(pos) {
  return {
    id: uid++, kind: 'source', name: '水源', pos: pos ? [...pos] : [0, 0.4, 0],
    pitch: -90, yaw: 0, mode: 'stream', enabled: true,
    flow: 3.0,          // L/min
    speed: 0.6,         // m/s at the outlet
    dropD: 5,           // mm
    dropRate: 3,        // drops per second
    spread: 18,         // degrees (shower)
    burst: 0.5,         // L per release
    burstEvery: 0,      // s (0 = once)
    rainRate: 60,       // mm/h
    rainSize: 0.3,      // m (area side)
    total: 0,           // L (0 = no limit)
  };
}
function makeBlock(pos) {
  return { id: uid++, kind: 'block', name: '水の塊', pos: pos ? [...pos] : [0, 0.05, 0], dims: { w: 0.16, h: 0.10, d: 0.16 } };
}
function makeDrain(pos) {
  return { id: uid++, kind: 'drain', name: '排水口', pos: pos ? [...pos] : [0, 0, 0], rot: [0, 0, 0], r: 0.025 };
}

function cloneScene(s) { return JSON.parse(JSON.stringify(s)); }

// source outlet geometry derived from flow and speed
function sourceNozzle(src) {
  const Q = src.flow / 60000; // m^3/s
  const v = Math.max(src.speed, 0.05);
  return Math.sqrt(4 * Q / (Math.PI * v)); // diameter [m]
}
function sourceDir(src) {
  const p = src.pitch * DEG, y = src.yaw * DEG;
  return [Math.cos(p) * Math.sin(y), Math.sin(p), Math.cos(p) * Math.cos(y)];
}
// diameter of the nozzle drawn for a source (the outlet itself for streams)
function sourceOutlet(src) {
  if (src.mode === 'shower') return Math.max(sourceNozzle(src), 0.044);
  if (src.mode === 'drops') return Math.max(src.dropD / 1000 * 0.7, 0.004);
  if (src.mode === 'burst') return 0.03;
  return sourceNozzle(src);
}

// ---------- axes shown in the editor ----------
// The editor uses Blender's axes: X to the right, Y away from the front view, Z up. The solver and the renderer work
// with Y up and +Z towards the front view, so positions and rotations are converted at the panel and the gizmos.
const UI_FROM_WORLD = [1, 0, 0, 0, 0, -1, 0, 1, 0];
const WORLD_FROM_UI = [1, 0, 0, 0, 0, 1, 0, -1, 0];
function toUI(p) { return [p[0], -p[2], p[1]]; }
function fromUI(u) { return [u[0], u[2], -u[1]]; }
function uiAxisDir(i) { return fromUI([i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0]); }
// editor axis (0 X, 1 Y, 2 Z) that an item's own local axis k shows up as (its local y is its height)
const UI_OF_LOCAL = [0, 2, 1];
function uiEuler(rot) { return m3.toEuler(m3.mul(m3.mul(UI_FROM_WORLD, m3.euler(rot[0], rot[1], rot[2])), WORLD_FROM_UI)); }
function worldEuler(ui) { return m3.toEuler(m3.mul(m3.mul(WORLD_FROM_UI, m3.euler(ui[0], ui[1], ui[2])), UI_FROM_WORLD)); }
// compass heading of a source in the editor: 0° = away from the front view (+Y), 90° = right (+X)
function sourceHeading(src) { return ((180 - src.yaw) % 360 + 360) % 360; }
function setSourceHeading(src, h) { src.yaw = ((180 - h) % 360 + 360) % 360; }

// ---------- signed distance (mirrors the WGSL code; used for picking and placement) ----------
function sdRoundBox(p, b, r) {
  const q = [Math.abs(p[0]) - b[0] + r, Math.abs(p[1]) - b[1] + r, Math.abs(p[2]) - b[2] + r];
  return Math.hypot(Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0)) + Math.min(Math.max(q[0], q[1], q[2]), 0) - r;
}
function sdCyl(p, r, hh) {
  const dx = Math.hypot(p[0], p[2]) - r, dy = Math.abs(p[1]) - hh;
  return Math.min(Math.max(dx, dy), 0) + Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
}
function sdCone(p, r, hh) {
  const qx = Math.hypot(p[0], p[2]), qy = p[1];
  const k1 = [0, hh], k2 = [-r, 2 * hh];
  const ca = [qx - Math.min(qx, qy < 0 ? r : 0), Math.abs(qy) - hh];
  const t = clamp(((k1[0] - qx) * k2[0] + (k1[1] - qy) * k2[1]) / (k2[0] * k2[0] + k2[1] * k2[1]), 0, 1);
  const cb = [qx - k1[0] + k2[0] * t, qy - k1[1] + k2[1] * t];
  const s = cb[0] < 0 && ca[1] < 0 ? -1 : 1;
  return s * Math.sqrt(Math.min(ca[0] * ca[0] + ca[1] * ca[1], cb[0] * cb[0] + cb[1] * cb[1]));
}
// GPU parameters of an obstacle: [type, d0, d1, d2, d3]
function shapeParams(o) {
  const d = o.dims;
  switch (o.shape) {
    case 'box': return [0, d.w / 2, d.h / 2, d.d / 2, Math.min(0.003, d.w / 4, d.h / 4, d.d / 4)];
    case 'plate': return [0, d.w / 2, d.t / 2, d.d / 2, Math.min(0.002, d.t / 4)];
    case 'sphere': return [1, d.r, 0, 0, 0];
    case 'cylinder': return [2, d.r, d.h / 2, 0, 0];
    case 'cone': return [3, d.r, d.h / 2, 0, 0];
    case 'torus': return [4, d.R, d.r, 0, 0];
    case 'cup': return [5, d.r, d.h / 2, Math.min(d.t, d.r * 0.8), 0];
    case 'container': return [6, d.w / 2, d.h / 2, d.d / 2, Math.min(d.t, d.w / 3, d.d / 3, d.h * 0.8)];
    case 'gutter': return [7, d.len / 2, d.r, d.t, 0];
  }
  return [0, 0.05, 0.05, 0.05, 0];
}
function shapeSdfLocal(o, q) {
  const [t, a, b, c, e] = shapeParams(o);
  switch (t) {
    case 0: return sdRoundBox(q, [a, b, c], e);
    case 1: return Math.hypot(q[0], q[1], q[2]) - a;
    case 2: return sdCyl(q, a, b);
    case 3: return sdCone(q, a, b);
    case 4: return Math.hypot(Math.hypot(q[0], q[2]) - a, q[1]) - b;
    case 5: return Math.max(sdCyl(q, a, b), -sdCyl([q[0], q[1] - c, q[2]], a - c, b));
    case 6: return Math.max(sdRoundBox(q, [a, b, c], 0.002), -sdRoundBox([q[0], q[1] - e, q[2]], [a - e, b, c - e], 0.001));
    case 7: return Math.max(Math.abs(Math.hypot(q[1], q[2]) - b) - 0.5 * c, q[1], Math.abs(q[0]) - a);
  }
  return 1e9;
}
function obstacleRot(o) { return m3.euler(o.rot[0], o.rot[1], o.rot[2]); }
function obstacleSdf(o, p, R) {
  const q = m3.applyT(R || obstacleRot(o), v3.sub(p, o.pos));
  return shapeSdfLocal(o, q);
}
function boundRadius(o) {
  const [t, a, b, c, e] = shapeParams(o);
  switch (t) {
    case 0: return Math.hypot(a, b, c);
    case 1: return a;
    case 2: case 3: case 5: return Math.hypot(a, b);
    case 4: return a + b;
    case 6: return Math.hypot(a, b, c);
    case 7: return Math.hypot(a, b + c);
  }
  return 0.1;
}
// lowest point of an obstacle in world space (for dropping new objects onto the floor)
function obstacleBottom(o) {
  const R = obstacleRot(o);
  let lo = Infinity;
  const r = boundRadius(o);
  // sample the bounding sphere's surface by sphere tracing straight up from below
  for (let i = -2; i <= 2; i++) for (let k = -2; k <= 2; k++) {
    const x = o.pos[0] + (i / 2) * r * 0.9, z = o.pos[2] + (k / 2) * r * 0.9;
    let y = o.pos[1] - r - 0.01;
    for (let s = 0; s < 64; s++) {
      const d = obstacleSdf(o, [x, y, z], R);
      if (d < 0.0005) { lo = Math.min(lo, y); break; }
      y += Math.max(d, 0.0005);
      if (y > o.pos[1] + r) break;
    }
  }
  return lo === Infinity ? o.pos[1] - r : lo;
}

// ---------- where items may be placed ----------
// inside the tank's footprint and not far above the rim; an obstacle may sink into the floor up to its middle
// (a half-buried stone), a water block and a source stay above it
function posLimits(it) {
  const t = scene.tank;
  let lo = 0;
  if (it.kind === 'block') lo = it.dims.h / 2;
  else if (it.kind === 'source') lo = 0.01;
  return [[-t.w / 2, t.w / 2], [lo, t.h + 0.4], [-t.d / 2, t.d / 2]];
}
function clampItemPos(it, p) {
  const L = posLimits(it);
  return p.map((x, i) => clamp(x, L[i][0], Math.max(L[i][0], L[i][1])));
}

// ---------- scene ----------
const scene = {
  tank: { w: 0.6, h: 0.32, d: 0.4 },
  items: [],
};
let selectedId = null;
function getItem(id) { return scene.items.find((it) => it.id === id) || null; }
function selected() { return selectedId === 'tank' ? null : getItem(selectedId); }

// ---------- presets ----------
function presetFaucetCup() {
  const items = [];
  const cup = makeObstacle('cup', [0.06, 0.06, 0.02]);
  cup.dims = { r: 0.045, h: 0.12, t: 0.006 }; cup.color = '#e9e4da'; cup.name = 'コップ';
  items.push(cup);
  const src = makeSource([0.06, 0.42, 0.02]);
  src.name = '蛇口'; src.flow = 4; src.speed = 0.7;
  items.push(src);
  const block = makeBlock([0, 0.03, 0]);
  block.dims = { w: 0.6, h: 0.05, d: 0.4 }; block.name = '張った水';
  items.push(block);
  const rock = makeObstacle('sphere', [-0.14, 0.03, -0.06]);
  rock.dims = { r: 0.045 }; rock.color = '#8a8f94'; rock.material = 'stone'; rock.name = '石';
  items.push(rock);
  return { tank: { w: 0.6, h: 0.32, d: 0.4 }, items };
}
function presetCascade() {
  const items = [];
  const g1 = makeObstacle('gutter', [0.08, 0.24, -0.06]);
  g1.dims = { len: 0.34, r: 0.032, t: 0.006 }; g1.rot = [0, 0, -14]; g1.name = '樋 1';
  const g2 = makeObstacle('gutter', [-0.08, 0.15, 0.07]);
  g2.dims = { len: 0.34, r: 0.032, t: 0.006 }; g2.rot = [0, 0, 14]; g2.name = '樋 2';
  const box = makeObstacle('container', [0.16, 0.035, 0.1]);
  box.dims = { w: 0.16, h: 0.07, d: 0.12, t: 0.008 }; box.color = '#3f6fa3'; box.material = 'plastic'; box.name = '受け皿';
  const src = makeSource([0.21, 0.36, -0.06]);
  src.name = '蛇口'; src.flow = 5; src.speed = 0.8;
  const drain = makeDrain([-0.24, 0, -0.14]);
  drain.r = 0.03;
  items.push(g1, g2, box, src, drain);
  return { tank: { w: 0.6, h: 0.32, d: 0.4 }, items };
}
function presetDamBreak() {
  const items = [];
  const block = makeBlock([-0.2, 0.11, 0]);
  block.dims = { w: 0.18, h: 0.22, d: 0.38 }; block.name = 'せき止めた水';
  const pillar = makeObstacle('cylinder', [0.08, 0.06, 0.04]);
  pillar.dims = { r: 0.035, h: 0.12 }; pillar.name = '柱'; pillar.color = '#c75b45'; pillar.material = 'plastic';
  const box = makeObstacle('box', [0.12, 0.025, -0.1]);
  box.dims = { w: 0.08, h: 0.05, d: 0.08 }; box.rot = [0, 30, 0]; box.name = '箱';
  items.push(block, pillar, box);
  return { tank: { w: 0.6, h: 0.32, d: 0.4 }, items };
}
function presetDrops() {
  const items = [];
  const block = makeBlock([0, 0.03, 0]);
  block.dims = { w: 0.6, h: 0.06, d: 0.4 }; block.name = '張った水';
  const src = makeSource([0, 0.34, 0]);
  src.name = '水滴'; src.mode = 'drops'; src.dropD = 6; src.dropRate = 2; src.speed = 0.0;
  items.push(block, src);
  return { tank: { w: 0.6, h: 0.32, d: 0.4 }, items };
}
function presetFountain() {
  const items = [];
  const block = makeBlock([0, 0.025, 0]);
  block.dims = { w: 0.6, h: 0.05, d: 0.4 }; block.name = '張った水';
  const basin = makeObstacle('cylinder', [0, 0.03, 0]);
  basin.dims = { r: 0.05, h: 0.06 }; basin.name = '台座'; basin.color = '#c9c2b4'; basin.material = 'stone';
  const src = makeSource([0, 0.07, 0]);
  src.name = '噴水'; src.pitch = 90; src.flow = 2.5; src.speed = 1.6;
  const torus = makeObstacle('torus', [0, 0.11, 0.0]);
  torus.dims = { R: 0.11, r: 0.012 }; torus.rot = [0, 0, 0]; torus.material = 'metal'; torus.color = '#c9c2b4'; torus.name = '輪';
  items.push(block, basin, src);
  return { tank: { w: 0.6, h: 0.32, d: 0.4 }, items };
}
function presetRain() {
  const items = [];
  const block = makeBlock([0, 0.03, 0]);
  block.dims = { w: 0.6, h: 0.06, d: 0.4 }; block.name = '張った水';
  const rain = makeSource([0, 0.34, 0]);
  rain.name = '雨'; rain.mode = 'rain'; rain.rainRate = 120; rain.rainSize = 0.5;
  const cone = makeObstacle('cone', [0.12, 0.09, 0.05]);
  cone.dims = { r: 0.05, h: 0.1 }; cone.name = '山'; cone.material = 'stone'; cone.color = '#8a8f94';
  items.push(block, rain, cone);
  return { tank: { w: 0.6, h: 0.32, d: 0.4 }, items };
}
const PRESETS = [
  { id: 'faucet', label: '蛇口とコップ', make: presetFaucetCup },
  { id: 'cascade', label: '樋を流れる水', make: presetCascade },
  { id: 'dam', label: 'ダムの決壊', make: presetDamBreak },
  { id: 'drops', label: '水滴と波紋', make: presetDrops },
  { id: 'fountain', label: '噴水', make: presetFountain },
  { id: 'rain', label: '雨', make: presetRain },
];
