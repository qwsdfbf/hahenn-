// ============================================================
//  Turning water sources and blocks into particle emissions
// ============================================================
function basisOf(dir) {
  const ref = Math.abs(dir[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
  const u = v3.norm(v3.cross(dir, ref));
  const w = v3.cross(dir, u);
  return [u, w];
}
const RAIN_SPEED = 6.5;

// emissions for one sub-step of length dt starting at simulation time t
function sourceEmits(sim, dt, t) {
  const list = [];
  const Vp = sim.vp;
  for (const src of scene.items) {
    if (src.kind !== 'source' || !src.enabled) continue;
    let st = sim.emitAcc.get(src.id);
    if (!st) { st = { acc: 0, liters: 0, timer: 0, fired: false }; sim.emitAcc.set(src.id, st); }
    if (src.total > 0 && st.liters >= src.total) continue;
    const dir = sourceDir(src);
    const [u, w] = basisOf(dir);
    const add = (e, liters) => { list.push(e); st.liters += liters; };
    if (src.mode === 'stream' || src.mode === 'shower') {
      const Q = src.flow / 60000;
      st.acc += (Q * dt) / Vp;
      const n = Math.floor(st.acc);
      st.acc -= n;
      if (n <= 0) continue;
      const shower = src.mode === 'shower';
      const r = shower ? Math.max(sourceNozzle(src) / 2, 0.022) : Math.max(sourceNozzle(src) / 2, 0.0005);
      const spread = shower ? clamp(src.spread, 0, 80) * DEG : 0;
      // the outlet sits a little in front of the nozzle so particles never start inside it
      const p = v3.add(src.pos, v3.mul(dir, 0.002));
      add({ shape: 0, a: [...p, r], b: [...dir, src.speed], c: [...u, spread], d: [...w, src.speed * dt], count: n }, n * Vp * 1000);
    } else if (src.mode === 'drops') {
      st.timer -= dt;
      if (st.timer > 0) continue;
      st.timer += 1 / clamp(src.dropRate, 0.05, 60);
      if (st.timer < 0) st.timer = 0;
      const d = clamp(src.dropD, 1, 40) / 1000;
      const V = Math.PI / 6 * d * d * d;
      const n = Math.max(1, Math.round(V / Vp));
      const R = Math.max(d / 2, Math.cbrt((3 * n * Vp) / (4 * Math.PI)) * 0.9);
      const p = v3.add(src.pos, v3.mul(dir, R + 0.002));
      add({ shape: 1, a: [...p, n === 1 ? 0 : R], b: [...v3.mul(dir, src.speed), 0], count: n }, n * Vp * 1000);
    } else if (src.mode === 'burst') {
      if (st.fired) {
        if (!(src.burstEvery > 0)) continue;
        st.timer -= dt;
        if (st.timer > 0) continue;
      }
      st.fired = true;
      st.timer = src.burstEvery > 0 ? src.burstEvery : 0;
      const V = clamp(src.burst, 0.01, 50) / 1000;
      const n = Math.max(1, Math.round(V / Vp));
      const R = Math.cbrt((3 * V) / (4 * Math.PI));
      const p = v3.add(src.pos, v3.mul(dir, R + 0.004));
      add({ shape: 1, a: [...p, R], b: [...v3.mul(dir, src.speed), 0], count: n }, n * Vp * 1000);
    } else if (src.mode === 'rain') {
      const side = clamp(src.rainSize, 0.05, 2);
      const flux = (clamp(src.rainRate, 1, 500) / 3.6e6) * side * side;
      st.acc += (flux * dt) / Vp;
      const n = Math.floor(st.acc);
      st.acc -= n;
      if (n <= 0) continue;
      add({ shape: 3, a: [...src.pos, side / 2], b: [0, -RAIN_SPEED, 0, 0], d: [0, 0, 0, RAIN_SPEED * dt], count: n }, n * Vp * 1000);
    }
  }
  return list;
}

// lattice fills for the water blocks (used when the simulation is reset)
function blockEmits(sim) {
  const list = [];
  const sp = sim.h / 2;
  for (const b of scene.items) {
    if (b.kind !== 'block') continue;
    const lo = [b.pos[0] - b.dims.w / 2, b.pos[1] - b.dims.h / 2, b.pos[2] - b.dims.d / 2];
    const hi = [b.pos[0] + b.dims.w / 2, b.pos[1] + b.dims.h / 2, b.pos[2] + b.dims.d / 2];
    // clip to the inside of the tank
    const tlo = [sim.origin[0] + sp * 0.5, 0.0005, sim.origin[2] + sp * 0.5];
    const thi = [-sim.origin[0] - sp * 0.5, Infinity, -sim.origin[2] - sp * 0.5];
    const insideX = lo[0] < thi[0] && hi[0] > tlo[0] && lo[2] < thi[2] && hi[2] > tlo[2];
    if (insideX) {
      for (const k of [0, 2]) { lo[k] = Math.max(lo[k], tlo[k]); hi[k] = Math.min(hi[k], thi[k]); }
      lo[1] = Math.max(lo[1], tlo[1]);
    }
    const n = [0, 1, 2].map((k) => Math.max(0, Math.floor((hi[k] - lo[k]) / sp)));
    const total = n[0] * n[1] * n[2];
    if (total <= 0) continue;
    // centre the lattice inside the clipped box
    const start = [0, 1, 2].map((k) => lo[k] + ((hi[k] - lo[k]) - n[k] * sp) / 2);
    list.push({ shape: 2, a: [...start, sp], b: [n[0], n[1], n[2], 0], c: [0, 0, 0, 0], count: total });
  }
  return list;
}
