// ============================================================
//  Utilities
// ============================================================
const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
const DEG = Math.PI / 180;

const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
};

// 3x3 rotation matrices are row-major arrays of 9; world = R * local
const m3 = {
  euler(rx, ry, rz) {
    // degrees, applied X then Y then Z (R = Rz * Ry * Rx)
    const [cx, sx, cy, sy, cz, sz] = [Math.cos(rx * DEG), Math.sin(rx * DEG), Math.cos(ry * DEG), Math.sin(ry * DEG), Math.cos(rz * DEG), Math.sin(rz * DEG)];
    return [
      cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
      sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
      -sy, cy * sx, cy * cx,
    ];
  },
  apply(R, p) { return [R[0] * p[0] + R[1] * p[1] + R[2] * p[2], R[3] * p[0] + R[4] * p[1] + R[5] * p[2], R[6] * p[0] + R[7] * p[1] + R[8] * p[2]]; },
  applyT(R, p) { return [R[0] * p[0] + R[3] * p[1] + R[6] * p[2], R[1] * p[0] + R[4] * p[1] + R[7] * p[2], R[2] * p[0] + R[5] * p[1] + R[8] * p[2]]; },
  mul(A, B) {
    const o = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    return o;
  },
  transpose(R) { return [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]]; },
  axisAngle(axis, ang) {
    const [x, y, z] = v3.norm(axis), c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
    return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
  },
  toEuler(R) {
    // inverse of euler(): returns degrees
    const sy = clamp(-R[6], -1, 1);
    const ry = Math.asin(sy);
    let rx, rz;
    if (Math.abs(sy) < 0.99999) { rx = Math.atan2(R[7], R[8]); rz = Math.atan2(R[3], R[0]); }
    else { rx = Math.atan2(-R[5], R[4]); rz = 0; }
    return [rx / DEG, ry / DEG, rz / DEG];
  },
  // rotation vector (axis * angle) of R
  log(R) {
    const c = clamp((R[0] + R[4] + R[8] - 1) / 2, -1, 1);
    const ang = Math.acos(c);
    if (ang < 1e-6) return [0, 0, 0];
    const s = 2 * Math.sin(ang);
    if (Math.abs(s) < 1e-6) return [0, 0, 0];
    return v3.mul([(R[7] - R[5]) / s, (R[2] - R[6]) / s, (R[3] - R[1]) / s], ang);
  },
};

// 4x4 column-major (WebGPU / WGSL convention)
const m4 = {
  mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    return o;
  },
  inv(a) {
    const o = new Float32Array(16);
    const b00 = a[0] * a[5] - a[1] * a[4], b01 = a[0] * a[6] - a[2] * a[4], b02 = a[0] * a[7] - a[3] * a[4];
    const b03 = a[1] * a[6] - a[2] * a[5], b04 = a[1] * a[7] - a[3] * a[5], b05 = a[2] * a[7] - a[3] * a[6];
    const b06 = a[8] * a[13] - a[9] * a[12], b07 = a[8] * a[14] - a[10] * a[12], b08 = a[8] * a[15] - a[11] * a[12];
    const b09 = a[9] * a[14] - a[10] * a[13], b10 = a[9] * a[15] - a[11] * a[13], b11 = a[10] * a[15] - a[11] * a[14];
    const det = 1 / (b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06);
    o[0] = (a[5] * b11 - a[6] * b10 + a[7] * b09) * det; o[1] = (a[2] * b10 - a[1] * b11 - a[3] * b09) * det;
    o[2] = (a[13] * b05 - a[14] * b04 + a[15] * b03) * det; o[3] = (a[10] * b04 - a[9] * b05 - a[11] * b03) * det;
    o[4] = (a[6] * b08 - a[4] * b11 - a[7] * b07) * det; o[5] = (a[0] * b11 - a[2] * b08 + a[3] * b07) * det;
    o[6] = (a[14] * b02 - a[12] * b05 - a[15] * b01) * det; o[7] = (a[8] * b05 - a[10] * b02 + a[11] * b01) * det;
    o[8] = (a[4] * b10 - a[5] * b08 + a[7] * b06) * det; o[9] = (a[1] * b08 - a[0] * b10 - a[3] * b06) * det;
    o[10] = (a[12] * b04 - a[13] * b02 + a[15] * b00) * det; o[11] = (a[9] * b02 - a[8] * b04 - a[11] * b00) * det;
    o[12] = (a[5] * b07 - a[4] * b09 - a[6] * b06) * det; o[13] = (a[0] * b09 - a[1] * b07 + a[2] * b06) * det;
    o[14] = (a[13] * b01 - a[12] * b03 - a[14] * b00) * det; o[15] = (a[8] * b03 - a[9] * b01 + a[10] * b00) * det;
    return o;
  },
  // rotation (row-major 3x3) + translation -> column-major 4x4
  fromRT(R, t) {
    return new Float32Array([R[0], R[3], R[6], 0, R[1], R[4], R[7], 0, R[2], R[5], R[8], 0, t[0], t[1], t[2], 1]);
  },
  lookAt(eye, target, up) {
    const f = v3.norm(v3.sub(target, eye));
    const r = v3.norm(v3.cross(f, up));
    const u = v3.cross(r, f);
    return new Float32Array([r[0], u[0], -f[0], 0, r[1], u[1], -f[1], 0, r[2], u[2], -f[2], 0, -v3.dot(r, eye), -v3.dot(u, eye), v3.dot(f, eye), 1]);
  },
  // WebGPU clip space: z in [0, 1]
  perspective(fovy, aspect, n, f) {
    const t = 1 / Math.tan(fovy / 2);
    const o = new Float32Array(16);
    o[0] = t / aspect; o[5] = t; o[10] = f / (n - f); o[11] = -1; o[14] = n * f / (n - f);
    return o;
  },
  ortho(l, r, b, t, n, f) {
    const o = new Float32Array(16);
    o[0] = 2 / (r - l); o[5] = 2 / (t - b); o[10] = 1 / (n - f);
    o[12] = -(r + l) / (r - l); o[13] = -(t + b) / (t - b); o[14] = n / (n - f); o[15] = 1;
    return o;
  },
  transform(m, p) {
    const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const z = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14], w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    return [x / w, y / w, z / w, w];
  },
};

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  const s = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255);
  return s.map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
}

// a short message at the top of the view; `action` adds a button ({ label, run }) and keeps the message up longer
let toastTimer = 0;
function toast(msg, ms = 2600, action = null) {
  const t = $('toast');
  t.querySelector('.msg').textContent = msg;
  const b = t.querySelector('.act');
  b.hidden = !action;
  b.textContent = action ? action.label : '';
  b.onclick = action ? () => { t.classList.remove('show'); action.run(); } : null;
  t.step = action && action.step;
  t.classList.toggle('has-act', !!action);
  // on narrow screens the message sits at the bottom of the 3D view, above the sheet and the transport
  const v = $('view').getBoundingClientRect();
  t.style.setProperty('--toast-bottom', `${Math.max(window.innerHeight - v.bottom + 12, 12)}px`);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), action ? Math.max(ms, 5000) : ms);
}
function fatal(title, body) {
  const d = document.createElement('div');
  d.className = 'fatal';
  d.innerHTML = '<div><h2></h2><p></p></div>';
  d.querySelector('h2').textContent = title;
  d.querySelector('p').textContent = body;
  document.body.appendChild(d);
}
const store = {
  get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
  set(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* storage unavailable */ } },
};
