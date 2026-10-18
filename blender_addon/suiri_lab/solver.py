# 水理ラボ — the liquid solver of the web version, ported from its WebGPU kernels to NumPy.
#
# FLIP/PIC on a staggered (MAC) grid with cut-cell open fractions, red-black SOR pressure, drift correction,
# sub-grid drops that merge with the pool and turn their momentum into a ripple impulse and a crown splash
# (K = We·Oh^-0.4), whitewater (spray / foam / bubbles), and the capillary-gravity ripple layer solved exactly in
# a mirrored cosine basis. Coordinates are those of the web version: metres, y up, the tank floor at y = 0 and the
# tank centred on x = z = 0. No Blender module is used here.
import math
import numpy as np

G = 9.81
SIGMA_RHO = 0.0728 / 998.0
RHO = 998.0
FLIP = 0.96
PPC = 8.0            # particles per cell at rest
DRIFT = 6.0          # drift correction strength
OMEGA = 1.6          # SOR over-relaxation
FRICTION = 0.03
WW_RATE = 7.0
RAIN_SPEED = 6.5
DEG = math.pi / 180.0

QUALITY = {
    'LOW': dict(h=0.012, cap=140000, ww=60000, iters=28, ripple=128, wmap=256),
    'STANDARD': dict(h=0.0085, cap=320000, ww=140000, iters=40, ripple=256, wmap=256),
    'HIGH': dict(h=0.0065, cap=700000, ww=260000, iters=56, ripple=512, wmap=384),
}


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def basis_of(d):
    ref = np.array([0.0, 1.0, 0.0]) if abs(d[1]) < 0.95 else np.array([1.0, 0.0, 0.0])
    u = np.cross(d, ref)
    u /= np.linalg.norm(u)
    return u, np.cross(d, u)


def fresnel_w(c):
    x = np.clip(1.0 - c, 0.0, 1.0)
    return 0.0204 + 0.9796 * x ** 5


class Solids:
    """Obstacles as a signed distance lattice at half-cell spacing, with the motion of the nearest obstacle.

    sdf: (2nx+1, 2nyl+1, 2nz+1) distances [m] at origin + 0.5 h * index; oid: index into `motions` (-1 none);
    motions: list of (linear velocity, angular velocity, centre) in solver coordinates. drains: list of
    (world->local 3x3, centre, radius, half height)."""

    def __init__(self, sdf, oid, motions, drains):
        self.sdf, self.oid, self.motions, self.drains = sdf, oid, motions, drains


class Solver:
    def __init__(self, tank_w, tank_h, tank_d, quality='STANDARD', whitewater=True, seed=1, extra_height=0.0):
        q = QUALITY[quality]
        self.q = q
        h = q['h']
        self.nx = max(8, round(tank_w / h))
        self.ny = max(8, round(tank_h / h))
        self.nz = max(8, round(tank_d / h))
        self.h = h = min(tank_w / self.nx, tank_h / self.ny, tank_d / self.nz)
        self.origin = np.array([-self.nx * h / 2, 0.0, -self.nz * h / 2])
        self.rim = self.ny * h
        # the obstacle lattice also covers what stands or hangs above the rim
        self.nyl = self.ny + max(0, int(math.ceil(extra_height / h)))
        self.cap, self.ww_cap = q['cap'], q['ww']
        self.iters = q['iters']
        self.vp = (h / 2) ** 3
        self.radius = 0.5 * h * 1.05
        self.whitewater = whitewater
        self.rng = np.random.default_rng(seed)
        self.time = 0.0
        self.frame = 0
        self.vmax = 1.0
        self.impacts = 0
        self.full = False
        n0 = 0
        self.pos = np.zeros((n0, 3))
        self.vel = np.zeros((n0, 3))
        self.air = np.zeros(n0)
        self.wpos = np.zeros((0, 3)); self.wvel = np.zeros((0, 3)); self.wlife = np.zeros(0); self.wkind = np.zeros(0)
        ns = (self.nx + 1, self.ny + 1, self.nz + 1)
        self.ns = ns
        self.velg = np.zeros((3,) + ns)
        self.velold = np.zeros((3,) + ns)
        self.mask = np.zeros((3,) + ns, bool)
        self.frac = np.ones((3,) + ns)
        self.svel = np.zeros((3,) + ns)
        self.count = np.zeros((self.nx, self.ny, self.nz), np.int64)
        self.pres = np.zeros((self.nx, self.ny, self.nz))
        self.solids = None
        self.emit_state = {}
        self.ripple = RippleLayer(q['ripple'], self.nx * h, self.nz * h)
        self.rsrc = np.zeros((q['ripple'] + 1, q['ripple'] + 1))
        self._geom()

    # ------------------------------------------------------------------ obstacles
    def lattice_shape(self):
        return (2 * self.nx + 1, 2 * self.nyl + 1, 2 * self.nz + 1)

    def lattice_points(self):
        """Positions of the obstacle lattice (for the host that measures distances)."""
        s = self.lattice_shape()
        hh = self.h / 2
        return [self.origin[a] + hh * np.arange(s[a]) for a in range(3)]

    def set_solids(self, solids):
        self.solids = solids
        self._geom()

    def sdf_at(self, p):
        """Distance to the nearest obstacle at points p (N,3), trilinear in the lattice; far outside it: large."""
        n = len(p)
        if self.solids is None or not self.solids.motions or n == 0:
            return np.full(n, 1e9)
        sdf = self.solids.sdf
        g = (p - self.origin) / (self.h / 2)
        s = np.array(sdf.shape)
        inside = np.all((g >= 0) & (g <= s - 1), axis=1)
        out = np.full(n, 1e9)
        if not inside.any():
            return out
        gi = g[inside]
        b = np.minimum(np.floor(gi).astype(np.int64), s - 2)
        f = gi - b
        acc = np.zeros(len(gi))
        for dx in (0, 1):
            wx = f[:, 0] if dx else 1 - f[:, 0]
            for dy in (0, 1):
                wy = f[:, 1] if dy else 1 - f[:, 1]
                for dz in (0, 1):
                    wz = f[:, 2] if dz else 1 - f[:, 2]
                    acc += wx * wy * wz * sdf[b[:, 0] + dx, b[:, 1] + dy, b[:, 2] + dz]
        out[inside] = acc
        return out

    def sdf_normal(self, p):
        e = 0.0006
        n = np.stack([self.sdf_at(p + [e, 0, 0]) - self.sdf_at(p - [e, 0, 0]),
                      self.sdf_at(p + [0, e, 0]) - self.sdf_at(p - [0, e, 0]),
                      self.sdf_at(p + [0, 0, e]) - self.sdf_at(p - [0, 0, e])], axis=1)
        ln = np.linalg.norm(n, axis=1)
        ok = ln > 1e-9
        out = np.tile([0.0, 1.0, 0.0], (len(p), 1))
        out[ok] = n[ok] / ln[ok, None]
        return out

    def solid_vel(self, p):
        v = np.zeros((len(p), 3))
        if self.solids is None or not self.solids.motions or len(p) == 0:
            return v
        oid = self.solids.oid
        g = np.rint((p - self.origin) / (self.h / 2)).astype(np.int64)
        g = np.clip(g, 0, np.array(oid.shape) - 1)
        ids = oid[g[:, 0], g[:, 1], g[:, 2]]
        for k, (lin, ang, c) in enumerate(self.solids.motions):
            m = ids == k
            if m.any():
                v[m] = lin + np.cross(ang, p[m] - c)
        return v

    def in_drain(self, p):
        out = np.zeros(len(p), bool)
        if self.solids is None:
            return out
        for (Rt, c, r, hh) in self.solids.drains:
            q = (p - c) @ Rt.T
            out |= (np.hypot(q[:, 0], q[:, 2]) < r) & (np.abs(q[:, 1]) < hh)
        return out

    def _geom(self):
        """Open fraction of every face and the solid velocity there (the web version's WGSL_GEOM)."""
        nx, ny, nz, h = self.nx, self.ny, self.nz, self.h
        self.frac = np.zeros((3,) + self.ns)
        self.svel = np.zeros((3,) + self.ns)
        have = self.solids is not None and len(self.solids.motions) > 0
        L = self.solids.sdf[:, :2 * ny + 1, :] if have else None

        def open_frac(s0, s1, s2, s3, sc):
            pos = np.maximum(s0, 0) + np.maximum(s1, 0) + np.maximum(s2, 0) + np.maximum(s3, 0) + 2 * np.maximum(sc, 0)
            tot = np.abs(s0) + np.abs(s1) + np.abs(s2) + np.abs(s3) + 2 * np.abs(sc)
            return np.where(tot < 1e-12, 1.0, np.clip(pos / np.maximum(tot, 1e-30), 0, 1))
        # x faces at nodes (i, j+.5, k+.5) for 0 < i < nx
        if have:
            I = slice(2, 2 * nx - 1, 2); J0 = slice(0, 2 * ny - 1, 2); J1 = slice(2, 2 * ny + 1, 2); Jc = slice(1, 2 * ny, 2)
            K0 = slice(0, 2 * nz - 1, 2); K1 = slice(2, 2 * nz + 1, 2); Kc = slice(1, 2 * nz, 2)
            self.frac[0, 1:nx, :ny, :nz] = open_frac(L[I, J0, K0], L[I, J1, K0], L[I, J1, K1], L[I, J0, K1], L[I, Jc, Kc])
            Ic = slice(1, 2 * nx, 2); I0 = slice(0, 2 * nx - 1, 2); I1 = slice(2, 2 * nx + 1, 2); Jy = slice(2, 2 * ny - 1, 2)
            self.frac[1, :nx, 1:ny, :nz] = open_frac(L[I0, Jy, K0], L[I1, Jy, K0], L[I1, Jy, K1], L[I0, Jy, K1], L[Ic, Jy, Kc])
            Kz = slice(2, 2 * nz - 1, 2)
            self.frac[2, :nx, :ny, 1:nz] = open_frac(L[I0, J0, Kz], L[I1, J0, Kz], L[I1, J1, Kz], L[I0, J1, Kz], L[Ic, Jc, Kz])
        else:
            self.frac[0, 1:nx, :ny, :nz] = 1
            self.frac[1, :nx, 1:ny, :nz] = 1
            self.frac[2, :nx, :ny, 1:nz] = 1
        self.frac[1, :nx, ny, :nz] = 1.0   # open air above the grid
        if have and any(np.any(m[0]) or np.any(m[1]) for m in self.solids.motions):
            for a, sl in ((0, (slice(1, nx), slice(0, ny), slice(0, nz))), (1, (slice(0, nx), slice(1, ny), slice(0, nz))), (2, (slice(0, nx), slice(0, ny), slice(1, nz)))):
                ii, jj, kk = np.meshgrid(np.arange(self.ns[0])[sl[0]], np.arange(self.ns[1])[sl[1]], np.arange(self.ns[2])[sl[2]], indexing='ij')
                off = np.full(3, 0.5); off[a] = 0.0
                p = self.origin + h * (np.stack([ii, jj, kk], -1).reshape(-1, 3) + off)
                self.svel[a][sl] = self.solid_vel(p)[:, a].reshape(ii.shape)

    # ------------------------------------------------------------------ helpers on the node lattice
    def _grid_pos(self, x):
        return (x - self.origin) / self.h

    def _in_grid(self, g):
        return np.all((g >= 0) & (g < [self.nx, self.ny, self.nz]), axis=1)

    def _corners(self, q):
        """The 8 nodes around points q (node units): flat index, whether the node exists, trilinear weight."""
        b = np.floor(q).astype(np.int64)
        f = q - b
        s0, s1, s2 = self.ns
        bx, by, bz = b[:, 0], b[:, 1], b[:, 2]
        vx = ((bx >= 0) & (bx < s0), (bx >= -1) & (bx < s0 - 1))
        vy = ((by >= 0) & (by < s1), (by >= -1) & (by < s1 - 1))
        vz = ((bz >= 0) & (bz < s2), (bz >= -1) & (bz < s2 - 1))
        wx = (1 - f[:, 0], f[:, 0]); wy = (1 - f[:, 1], f[:, 1]); wz = (1 - f[:, 2], f[:, 2])
        base = (bx * s1 + by) * s2 + bz
        for dx in (0, 1):
            for dy in (0, 1):
                vxy = vx[dx] & vy[dy]
                wxy = wx[dx] * wy[dy]
                for dz in (0, 1):
                    yield base + ((dx * s1 + dy) * s2 + dz), vxy & vz[dz], wxy * wz[dz]

    _OFF = (np.array([0.0, 0.5, 0.5]), np.array([0.5, 0.0, 0.5]), np.array([0.5, 0.5, 0.0]))

    def _transfer(self, g, comp, vp):
        """PIC and FLIP velocity of one component from faces that took part this step (WGSL transfer1)."""
        q = g - self._OFF[comp]
        sn = np.zeros(len(g)); so = np.zeros(len(g)); sw = np.zeros(len(g))
        vn = self.velg[comp].ravel(); vo = self.velold[comp].ravel(); mk = self.mask[comp].ravel()
        for idx, ok, w in self._corners(q):
            idx = np.where(ok, idx, 0)
            use = ok & mk[idx]
            ww = np.where(use, w, 0.0)
            sn += ww * vn[idx]; so += ww * vo[idx]; sw += ww
        good = sw >= 1e-6
        pic = np.where(good, sn / np.maximum(sw, 1e-30), vp)
        flip = np.where(good, vp + (sn - so) / np.maximum(sw, 1e-30), vp)
        return pic, flip

    def _sample(self, g, comp):
        q = g - self._OFF[comp]
        b = np.floor(q).astype(np.int64)
        f = q - b
        vn = self.velg[comp]
        s = np.zeros(len(g))
        hi = np.array(self.ns) - 1
        for dx in (0, 1):
            wx = f[:, 0] if dx else 1 - f[:, 0]
            for dy in (0, 1):
                wy = f[:, 1] if dy else 1 - f[:, 1]
                for dz in (0, 1):
                    wz = f[:, 2] if dz else 1 - f[:, 2]
                    c = np.clip(b + (dx, dy, dz), 0, hi)
                    s += wx * wy * wz * vn[c[:, 0], c[:, 1], c[:, 2]]
        return s

    def _count_at(self, c):
        """Particles in cells c (M,3); above the grid and outside it: 0."""
        ok = np.all(c >= 0, axis=1) & (c[:, 0] < self.nx) & (c[:, 1] < self.ny) & (c[:, 2] < self.nz)
        out = np.zeros(len(c), np.int64)
        cc = c[ok]
        out[ok] = self.count[cc[:, 0], cc[:, 1], cc[:, 2]]
        return out

    def _air_at(self, c):
        above = c[:, 1] >= self.ny
        outside = np.any(c < 0, axis=1) | (c[:, 0] >= self.nx) | (c[:, 2] >= self.nz)
        return above | (~outside & (self._count_at(c) == 0))

    # ------------------------------------------------------------------ tank walls
    def _fp(self):
        lo = self.origin[[0, 2]]
        return lo, lo + np.array([self.nx, self.nz]) * self.h

    def _in_footprint(self, x):
        lo, hi = self._fp()
        return (x[:, 0] > lo[0]) & (x[:, 0] < hi[0]) & (x[:, 2] > lo[1]) & (x[:, 2] < hi[1])

    def _tank_clamp(self, x0, x, v, r):
        lo, hi = self._fp()
        was = self._in_footprint(x0)
        m = was & (x[:, 1] < self.rim)
        for a, (l, u) in ((0, (lo[0], hi[0])), (2, (lo[1], hi[1]))):
            low = m & (x[:, a] < l + r); x[low, a] = l + r; v[low, a] = np.maximum(v[low, a], 0)
            high = m & (x[:, a] > u - r); x[high, a] = u - r; v[high, a] = np.minimum(v[high, a], 0)
        fl = was & (x[:, 1] < self.origin[1] + r)
        x[fl, 1] = self.origin[1] + r; v[fl, 1] = np.maximum(v[fl, 1], 0)
        back = ~was & (x[:, 1] < self.rim) & self._in_footprint(x)
        x[back, 0] = x0[back, 0]; x[back, 2] = x0[back, 2]
        v[back, 0] *= -0.2; v[back, 2] *= -0.2

    # ------------------------------------------------------------------ emission
    def _add(self, p, v, mark):
        room = self.cap - len(self.pos) - 64
        if room <= 0:
            self.full = True
            return 0
        if len(p) > room:
            p, v, mark = p[:room], v[:room], mark[:room]
            self.full = True
        alive = self.sdf_at(p) >= 0.0
        p, v, mark = p[alive], v[alive], mark[alive]
        self.pos = np.concatenate([self.pos, p]); self.vel = np.concatenate([self.vel, v]); self.air = np.concatenate([self.air, mark])
        return len(p)

    def emit_block(self, lo, hi, fill=False):
        """A box of water (solver coordinates) as a jittered lattice at half-cell spacing, clipped to the tank."""
        sp = self.h / 2
        lo = np.array(lo, float); hi = np.array(hi, float)
        tlo = np.array([self.origin[0] + sp * 0.5, 0.0005, self.origin[2] + sp * 0.5])
        thi = np.array([-self.origin[0] - sp * 0.5, np.inf, -self.origin[2] - sp * 0.5])
        if lo[0] < thi[0] and hi[0] > tlo[0] and lo[2] < thi[2] and hi[2] > tlo[2]:
            for k in (0, 2):
                lo[k] = max(lo[k], tlo[k]); hi[k] = min(hi[k], thi[k])
            lo[1] = max(lo[1], tlo[1])
        n = np.maximum(0, np.floor((hi - lo) / sp)).astype(np.int64)
        if np.prod(n) <= 0:
            return 0
        start = lo + ((hi - lo) - n * sp) / 2
        ii, jj, kk = np.meshgrid(np.arange(n[0]), np.arange(n[1]), np.arange(n[2]), indexing='ij')
        lat = np.stack([ii, jj, kk], -1).reshape(-1, 3).astype(float)
        p = start + (lat + 0.5 + (self.rng.random(lat.shape) - 0.5) * 0.3) * sp
        if fill:
            self._count_cells()
            g = self._grid_pos(p)
            ing = self._in_grid(g)
            c = g.astype(np.int64)
            keep = np.ones(len(p), bool)
            cc = c[ing]
            keep[ing] = self.count[cc[:, 0], cc[:, 1], cc[:, 2]] < 0.5 * PPC
            p = p[keep]
        return self._add(p, np.zeros_like(p), np.zeros(len(p)))

    def _emit_sources(self, sources, dt):
        rng = self.rng
        for s in sources:
            if not s['enabled']:
                continue
            st = self.emit_state.setdefault(s['id'], dict(acc=0.0, liters=0.0, timer=0.0, fired=False))
            if s['total'] > 0 and st['liters'] >= s['total']:
                continue
            d = np.asarray(s['dir'], float)
            d = d / np.linalg.norm(d)
            u, w = basis_of(d)
            pos = np.asarray(s['pos'], float)
            mode = s['mode']
            if mode in ('STREAM', 'SHOWER'):
                Q = s['flow'] / 60000.0
                st['acc'] += Q * dt / self.vp
                n = int(math.floor(st['acc']))
                st['acc'] -= n
                if n <= 0:
                    continue
                shower = mode == 'SHOWER'
                noz = nozzle_diameter(s['flow'], s['speed'])
                r = max(noz / 2, 0.022) if shower else max(noz / 2, 0.0005)
                spread = min(max(s['spread'], 0), 80) * DEG if shower else 0.0
                p = pos + d * 0.002
                rr = r * np.sqrt(rng.random(n)); th = 2 * math.pi * rng.random(n)
                ring = np.cos(th)[:, None] * u + np.sin(th)[:, None] * w
                P = p + ring * rr[:, None] + d * (rng.random(n) * s['speed'] * dt)[:, None]
                dv = np.tile(d, (n, 1))
                if spread > 0:
                    ca = 1 - rng.random(n) * (1 - math.cos(spread))
                    sa = np.sqrt(np.maximum(1 - ca * ca, 0))
                    ph = 2 * math.pi * rng.random(n)
                    dv = d * ca[:, None] + (np.cos(ph)[:, None] * u + np.sin(ph)[:, None] * w) * sa[:, None]
                V = dv * s['speed'] + (rng.random((n, 3)) - 0.5) * (0.02 * s['speed'])
                k = self._add(P, V, np.zeros(n))
                st['liters'] += k * self.vp * 1000
            elif mode == 'DROPS':
                st['timer'] -= dt
                if st['timer'] > 0:
                    continue
                st['timer'] = max(st['timer'] + 1.0 / min(max(s['drop_rate'], 0.05), 60.0), 0.0)
                dd = min(max(s['drop_d'], 1), 40) / 1000.0
                V = math.pi / 6 * dd ** 3
                n = max(1, round(V / self.vp))
                R = max(dd / 2, (3 * n * self.vp / (4 * math.pi)) ** (1 / 3) * 0.9)
                k = self._sphere(pos + d * (R + 0.002), 0.0 if n == 1 else R, d * s['speed'], 1.0 if n <= 8 else 0.0, n)
                st['liters'] += k * self.vp * 1000
            elif mode == 'BURST':
                if st['fired']:
                    if not s['burst_every'] > 0:
                        continue
                    st['timer'] -= dt
                    if st['timer'] > 0:
                        continue
                st['fired'] = True
                st['timer'] = s['burst_every'] if s['burst_every'] > 0 else 0.0
                st['liters'] += self.burst(s) * self.vp * 1000
            elif mode == 'RAIN':
                side = min(max(s['rain_size'], 0.05), 2.0)
                flux = min(max(s['rain_rate'], 1), 500) / 3.6e6 * side * side
                st['acc'] += flux * dt / self.vp
                n = int(math.floor(st['acc']))
                st['acc'] -= n
                if n <= 0:
                    continue
                P = pos + np.stack([(rng.random(n) * 2 - 1) * side / 2, -rng.random(n) * RAIN_SPEED * dt, (rng.random(n) * 2 - 1) * side / 2], 1)
                k = self._add(P, np.tile([0.0, -RAIN_SPEED, 0.0], (n, 1)), np.ones(n))
                st['liters'] += k * self.vp * 1000

    def _sphere(self, c, R, v, mark, n):
        dd = self.rng.random((n, 3)) * 2 - 1 + 1e-4
        dd /= np.linalg.norm(dd, axis=1)[:, None]
        P = c + dd * (R * self.rng.random(n) ** (1 / 3))[:, None]
        return self._add(P, np.tile(v, (n, 1)), np.full(n, mark))

    def burst(self, s):
        """One release of a burst source: a ball of water in front of the outlet."""
        d = np.asarray(s['dir'], float); d = d / np.linalg.norm(d)
        V = min(max(s['burst'], 0.01), 50) / 1000.0
        n = max(1, round(V / self.vp))
        R = (3 * V / (4 * math.pi)) ** (1 / 3)
        return self._sphere(np.asarray(s['pos'], float) + d * (R + 0.004), R, d * s['speed'], 0.0, n)

    # ------------------------------------------------------------------ one sub-step
    def _count_cells(self):
        g = self._grid_pos(self.pos)
        ing = self._in_grid(g)
        c = g[ing].astype(np.int64)
        flat = (c[:, 0] * self.ny + c[:, 1]) * self.nz + c[:, 2]
        self.count = np.bincount(flat, minlength=self.nx * self.ny * self.nz).reshape(self.nx, self.ny, self.nz)
        return g, ing

    def _substep(self, dt, sources):
        if sources:
            self._emit_sources(sources, dt)
        h, nx, ny, nz = self.h, self.nx, self.ny, self.nz
        g, ing = self._count_cells()
        # particle -> grid
        size = int(np.prod(self.ns))
        vclamp = np.clip(self.vel, -30, 30)
        gi = g[ing]
        for comp in range(3):
            q = gi - self._OFF[comp]
            mom = np.zeros(size); wt = np.zeros(size)
            vals = vclamp[ing, comp]
            for idx, ok, w in self._corners(q):
                use = ok & (w > 0)
                idx = idx[use]
                mom += np.bincount(idx, w[use] * vals[use], size)
                wt += np.bincount(idx, w[use], size)
            m = wt > 4e-6
            v = np.where(m, mom / np.maximum(wt, 1e-30), 0.0).reshape(self.ns)
            self.velg[comp] = v
            self.velold[comp] = v
            self.mask[comp] = m.reshape(self.ns)
        fluid = self.count > 0
        # forces and solid faces
        self.velg[1] -= G * dt
        for a in range(3):
            solid = self.frac[a] <= 0
            self.velg[a][solid] = self.svel[a][solid]
        # divergence with cut-cell fluxes and the drift correction
        F = [self.frac[a] * self.velg[a] + (1 - self.frac[a]) * self.svel[a] for a in range(3)]
        div = (F[0][1:nx + 1, :ny, :nz] - F[0][:nx, :ny, :nz] + F[1][:nx, 1:ny + 1, :nz] - F[1][:nx, :ny, :nz]
               + F[2][:nx, :ny, 1:nz + 1] - F[2][:nx, :ny, :nz]) / h
        div -= DRIFT * np.maximum(self.count / PPC - 1, 0)
        div[~fluid] = 0
        # red-black SOR, on the box that holds the liquid (cells outside it have no pressure)
        p = np.where(fluid, self.pres, 0.0)
        if fluid.any():
            rng_ = [np.nonzero(fluid.any(axis=tuple(b for b in range(3) if b != a)))[0] for a in range(3)]
            (i0, i1), (j0, j1), (k0, k1) = [(max(r_[0] - 1, 0), min(r_[-1] + 2, m)) for r_, m in zip(rng_, (nx, ny, nz))]
            f32 = np.float32
            fx = self.frac[0][i0:i1 + 1, j0:j1, k0:k1].astype(f32); fy = self.frac[1][i0:i1, j0:j1 + 1, k0:k1].astype(f32); fz = self.frac[2][i0:i1, j0:j1, k0:k1 + 1].astype(f32)
            C = [np.ascontiguousarray(a) for a in (fx[:-1], fx[1:], fy[:, :-1], fy[:, 1:], fz[:, :, :-1], fz[:, :, 1:])]
            den = C[0] + C[1] + C[2] + C[3] + C[4] + C[5]
            fl_ = fluid[i0:i1, j0:j1, k0:k1]
            inv = np.where(den > 0, 1.0 / np.maximum(den, 1e-30), 0.0).astype(f32)
            ii, jj, kk = np.meshgrid(np.arange(i0, i1), np.arange(j0, j1), np.arange(k0, k1), indexing='ij', sparse=True)
            color = (ii + jj + kk) & 1
            U = [(fl_ & (den > 0) & (color == c)).astype(f32) * f32(OMEGA) for c in (0, 1)]
            rhs = (h * h * div[i0:i1, j0:j1, k0:k1]).astype(f32)
            X, Y, Z = fl_.shape
            P = np.zeros((X + 2, Y + 2, Z + 2), f32)
            Pi = P[1:-1, 1:-1, 1:-1]
            Pi[...] = p[i0:i1, j0:j1, k0:k1]
            nbr = (P[:-2, 1:-1, 1:-1], P[2:, 1:-1, 1:-1], P[1:-1, :-2, 1:-1], P[1:-1, 2:, 1:-1], P[1:-1, 1:-1, :-2], P[1:-1, 1:-1, 2:])
            num = np.empty((X, Y, Z), f32); tmp = np.empty((X, Y, Z), f32)
            for _ in range(self.iters):
                for Uc in U:
                    # non-liquid cells hold zero pressure, so the neighbour sum needs no mask
                    np.multiply(C[0], nbr[0], out=num)
                    for d in range(1, 6):
                        np.multiply(C[d], nbr[d], out=tmp)
                        num += tmp
                    num -= rhs
                    num *= inv
                    num -= Pi
                    num *= Uc
                    Pi += num
            pc = Pi.astype(np.float64)
            p[i0:i1, j0:j1, k0:k1] = pc
        p[~fluid] = 0
        self.pres = p
        # projection
        pp = np.zeros((nx + 2, ny + 2, nz + 2)); pp[1:-1, 1:-1, 1:-1] = p
        ff = np.zeros((nx + 2, ny + 2, nz + 2), bool); ff[1:-1, 1:-1, 1:-1] = fluid
        for a in range(3):
            sl = [slice(0, nx), slice(0, ny), slice(0, nz)]
            sl[a] = slice(0, self.ns[a])
            hi_ = [slice(1, nx + 1), slice(1, ny + 1), slice(1, nz + 1)]; lo_ = list(hi_)
            hi_[a] = slice(1, self.ns[a] + 1); lo_[a] = slice(0, self.ns[a])
            grad = (pp[tuple(hi_)] - pp[tuple(lo_)]) / h
            touch = ff[tuple(hi_)] | ff[tuple(lo_)]
            fa = self.frac[a][tuple(sl)]
            va = self.velg[a][tuple(sl)]
            sa = self.svel[a][tuple(sl)]
            va[:] = np.where(fa <= 0, sa, np.where(touch, va - grad, va))
        self._g2p(dt)
        self.time += dt

    def _g2p(self, dt):
        h = self.h
        N = len(self.pos)
        if N == 0:
            return
        x0 = self.pos
        v = self.vel.copy()
        g = self._grid_pos(x0)
        ing = self._in_grid(g)
        if ing.any():
            gi = g[ing]
            vi = v[ing]
            new = np.empty_like(vi)
            for comp in range(3):
                pic, flip = self._transfer(gi, comp, vi[:, comp])
                new[:, comp] = pic + FLIP * (flip - pic)
            v[ing] = new
        v[~ing, 1] -= G * dt
        x = x0 + v * dt
        rc = 0.32 * h
        d = self.sdf_at(x)
        hit = d < rc
        if hit.any():
            xs = x[hit]
            nrm = self.sdf_normal(xs)
            xs += nrm * (rc - d[hit])[:, None]
            vs = self.solid_vel(xs)
            rel = v[hit] - vs
            vn = np.sum(rel * nrm, axis=1)
            neg = vn < 0
            vh = v[hit]
            vh[neg] = vs[neg] + (rel[neg] - nrm[neg] * vn[neg, None]) * (1 - FRICTION)
            v[hit] = vh
            x[hit] = xs
        self._tank_clamp(x0, x, v, rc)
        alive = ~self.in_drain(x)
        alive &= ~(~self._in_footprint(x) & (x[:, 1] < 0.002))
        alive &= ~(np.any(np.abs(x[:, [0, 2]]) > 20, axis=1) | (x[:, 1] < -1) | (x[:, 1] > 30))
        # sub-grid drops: free-flying mark, merging with the pool, ripple impulse and crown splash
        c0 = np.floor(g).astype(np.int64)
        air = self.air.copy()
        if ing.any():
            idx = np.nonzero(ing)[0]
            cc = c0[idx]
            n0 = self._count_at(cc)
            air[idx[n0 >= 4]] = 0.0
            cand = (n0 <= 2) & (cc[:, 1] + 2 < self.ny)
            if cand.any():
                ci = cc[cand]
                around = np.zeros(len(ci), np.int64); above = np.zeros(len(ci), np.int64)
                for dz in (-1, 0, 1):
                    for dx in (-1, 0, 1):
                        for dy in (-1, 0, 1):
                            around += self._count_at(ci + (dx, dy, dz))
                        above += self._count_at(ci + (dx, 1, dz)) + self._count_at(ci + (dx, 2, dz))
                sel = idx[cand][(around <= 4) & (above == 0)]
                air[sel] = 1.0
        g1 = self._grid_pos(x)
        c1 = np.floor(g1).astype(np.int64)
        cand = (air > 0.5) & (self.vel[:, 1] < -0.3) & self._in_grid(g1)
        if cand.any():
            ids = np.nonzero(cand)[0]
            others = self._count_at(c1[ids]) - np.all(c1[ids] == c0[ids], axis=1)
            ids = ids[others >= 3]
            if len(ids):
                gl = g1[ids]
                vl = np.stack([self._transfer(gl, a, v[ids, a])[0] for a in range(3)], 1)
                dv = vl[:, 1] - self.vel[ids, 1]
                ok = dv > 0.3
                ids, vl, dv = ids[ok], vl[ok], dv[ok]
                if len(ids):
                    v[ids] = vl
                    air[ids] = 0.0
                    self.impacts += len(ids)
                    m = RHO * (0.5 * h) ** 3
                    self._ripple_deposit(x[ids], 2.0 * m * np.minimum(dv, 8.0), 2e-3)
                    cnt = self._count_at(c1[ids])
                    level = self.origin[1] + (c1[ids, 1] + np.minimum(cnt / PPC, 1.0)) * h
                    for k in range(len(ids)):
                        self._crown(np.array([x[ids[k], 0], level[k] + 0.25 * h, x[ids[k], 2]]), -self.vel[ids[k], 1], m)
        if ing.any():
            sp = np.linalg.norm(v[ing], axis=1)
            self.vmax = float(min(sp.max(), 60.0)) if len(sp) else 0.0
        if self.whitewater and ing.any():
            idx = np.nonzero(ing)[0]
            sp = np.linalg.norm(v[idx], axis=1)
            fast = sp > 0.75
            if fast.any():
                fi = idx[fast]
                cc = c0[fi]
                near = np.zeros(len(fi), bool)
                for a in range(3):
                    for sgn in (-1, 1):
                        o = np.zeros(3, np.int64); o[a] = sgn
                        near |= self._air_at(cc + o)
                fi = fi[near]
                e = np.clip((np.linalg.norm(v[fi], axis=1) - 0.75) / 1.6, 0, 1)
                born = self.rng.random(len(fi)) < WW_RATE * e * e * dt
                fi = fi[born]
                if len(fi):
                    j = self.rng.random((len(fi), 3)) - 0.5
                    self._ww_add(x[fi] + j * h * 0.6, v[fi] * (0.8 + 0.35 * self.rng.random(len(fi)))[:, None] + j * 0.35,
                                 1.0 + 2.5 * self.rng.random(len(fi)), np.zeros(len(fi)))
        self.pos = x[alive]; self.vel = v[alive]; self.air = air[alive]

    def _crown(self, x, U, m):
        """Splash of a drop of mass m at speed U: a ring of droplets above K = We·Oh^-0.4 ≈ 2100, a jet above 700."""
        if not self.whitewater:
            return
        D = (6 * m / (math.pi * RHO)) ** (1 / 3)
        We = RHO * U * U * D / 0.0728
        Oh = 0.001 / math.sqrt(RHO * 0.0728 * D)
        K = We * Oh ** -0.4
        n = int(min(max(round(4 * (K / 2100 - 1)), 0), 24))
        nj = (2 if K > 2100 else 1) if K > 700 else 0
        if n + nj == 0:
            return
        rnd = self.rng.random
        P, V, L = [], [], []
        r0 = 0.6 * D
        ph0 = rnd() * 2 * math.pi
        for i in range(n):
            ph = ph0 + 2 * math.pi * (i + 0.3 * rnd()) / n
            el = 0.9 + 0.45 * rnd()
            sp = U * (0.15 + 0.2 * rnd())
            d = np.array([math.cos(ph), 0.0, math.sin(ph)])
            P.append(x + d * r0); V.append(d * math.cos(el) * sp + np.array([0, math.sin(el) * sp, 0])); L.append(0.5 + 0.4 * rnd())
        for j in range(nj):
            sp = U * (0.22 + 0.04 * j) * (0.9 + 0.2 * rnd())
            P.append(x + np.array([0, 0.001 * j, 0])); V.append(np.array([(rnd() - 0.5) * 0.05, sp, (rnd() - 0.5) * 0.05])); L.append(0.7)
        self._ww_add(np.array(P), np.array(V), np.array(L), np.zeros(len(P)))

    def _ww_add(self, p, v, life, kind):
        room = self.ww_cap - len(self.wpos)
        if room <= 0:
            return
        p, v, life, kind = p[:room], v[:room], life[:room], kind[:room]
        self.wpos = np.concatenate([self.wpos, p]); self.wvel = np.concatenate([self.wvel, v])
        self.wlife = np.concatenate([self.wlife, life]); self.wkind = np.concatenate([self.wkind, kind])

    def _ripple_deposit(self, x, impulse, cap):
        R = self.ripple.R
        lo, hi = self._fp()
        uv = (x[:, [0, 2]] - lo) / (hi - lo)
        ij = np.clip(np.rint(uv * R), 0, R).astype(np.int64)
        np.add.at(self.rsrc, (ij[:, 1], ij[:, 0]), np.clip(impulse, 0, cap))

    # ------------------------------------------------------------------ whitewater (once per frame)
    def _whitewater(self, dt):
        if len(self.wpos) == 0:
            return
        x = self.wpos; v = self.wvel.copy(); life = self.wlife.copy()
        g = self._grid_pos(x)
        ing = self._in_grid(g)
        kind = np.zeros(len(x))
        if ing.any():
            idx = np.nonzero(ing)[0]
            c = g[idx].astype(np.int64)
            n = self.count[c[:, 0], c[:, 1], c[:, 2]]
            up = self._count_at(c + (0, 1, 0))
            k = np.where(n > 0, np.where(up > 0, 2.0, np.where(g[idx, 1] - c[:, 1] < np.minimum(n / PPC, 1.0), 1.0, 0.0)), 0.0)
            kind[idx] = k
        land = (self.wkind < 0.5) & (kind > 0.5) & (self.wvel[:, 1] < -0.3)
        if land.any():
            self._ripple_deposit(x[land], 4.2e-6 * -self.wvel[land, 1], 1e-4)
        spray = kind == 0
        v[spray, 1] -= G * dt
        v[spray] *= 1.0 / (1.0 + 0.6 * dt)
        life[spray] -= dt * 0.7
        wet = ~spray
        if wet.any():
            gw = g[wet]
            vf = np.stack([self._sample(gw, a) for a in range(3)], 1)
            foam = kind[wet] == 1
            vw = np.where(foam[:, None], vf * [1, 0.2, 1], vf + [0, 0.16, 0])
            v[wet] = vw
            life[wet] -= dt * np.where(foam, 0.5, 0.3)
        x0 = x
        x = x0 + v * dt
        d = self.sdf_at(x)
        inside = d < 0
        if inside.any():
            x[inside] -= self.sdf_normal(x[inside]) * d[inside][:, None]
        self._tank_clamp(x0, x, v, 0.001)
        outside = ~self._in_footprint(x) & (x[:, 1] < 0.001)
        keep = (life > 0) & ~outside & (x[:, 1] > -0.5) & ~self.in_drain(x)
        self.wpos, self.wvel, self.wlife, self.wkind = x[keep], v[keep], life[keep], kind[keep]

    # ------------------------------------------------------------------ one frame
    def step(self, frame_dt, sources=()):
        vmax = max(self.vmax, 0.4)
        n = int(min(max(math.ceil(frame_dt / (1.4 * self.h / vmax)), 1), 6))
        dt = frame_dt / n
        for _ in range(n):
            self.frame += 1
            self._substep(dt, sources)
        self._count_cells()
        self._whitewater(frame_dt)
        self.top = self.top_height()
        mean_depth = min(max(len(self.pos) * self.vp / (self.nx * self.nz * self.h * self.h), 0.003), self.rim)
        self.ripple.frame(frame_dt, mean_depth, self.rsrc, self._ripple_mask())
        self.rsrc[:] = 0

    @property
    def liters(self):
        return len(self.pos) * self.vp * 1000

    # ------------------------------------------------------------------ the water seen from above
    def wmap_size(self):
        return self.q['wmap']

    def top_height(self):
        """Top surface height over the tank footprint (the web version's top-view height map, blurred); -1: dry."""
        W = self.wmap_size()
        lo, hi = self._fp()
        texel = (hi - lo) / W
        H = np.full((W, W), -1.0)
        if len(self.pos):
            sel = self.pos[:, 1] <= self.rim + 0.01
            p = self.pos[sel]
            t = np.floor((p[:, [0, 2]] - lo) / texel).astype(np.int64)
            ok = np.all((t >= 0) & (t < W), axis=1)
            t, y = t[ok], p[ok, 1]
            top = np.full((W, W), -np.inf)
            np.maximum.at(top, (t[:, 1], t[:, 0]), y)
            r = self.radius * 1.25
            ri = int(math.ceil(r / texel.min()))
            for oy in range(-ri, ri + 1):
                for ox in range(-ri, ri + 1):
                    q = r * r - (ox * texel[0]) ** 2 - (oy * texel[1]) ** 2
                    if q <= 0:
                        continue
                    sh = np.full((W, W), -np.inf)
                    ys = slice(max(oy, 0), W + min(oy, 0)); yd = slice(max(-oy, 0), W + min(-oy, 0))
                    xs = slice(max(ox, 0), W + min(ox, 0)); xd = slice(max(-ox, 0), W + min(-ox, 0))
                    sh[yd, xd] = top[ys, xs]
                    H = np.maximum(H, sh + math.sqrt(q))
            H[~np.isfinite(H)] = -1.0
        # Gaussian over wet texels only, about one and a half cells wide: bumps of single particles are not waves the
        # grid resolves (shorter waves are the ripple layer's), and as lenses they would draw a false light net
        sigma = 1.5 * self.h / texel.min()
        rad = int(math.ceil(2.5 * sigma))
        wet = H >= 0
        for axis in (1, 0):
            s = np.zeros_like(H); wsum = np.zeros_like(H)
            for i in range(-rad, rad + 1):
                k = math.exp(-0.5 * (i / sigma) ** 2)
                idx = np.clip(np.arange(W) + i, 0, W - 1)
                hs = np.take(H, idx, axis=axis)
                ws = np.take(wet, idx, axis=axis)
                s += np.where(ws, hs * k, 0); wsum += np.where(ws, k, 0)
            H = np.where(wet, s / np.maximum(wsum, 1e-12), -1.0)
        return H

    def _ripple_mask(self):
        R = self.ripple.R
        lo, hi = self._fp()
        uv = np.linspace(0, 1, R + 1)
        X, Z = np.meshgrid(lo[0] + uv * (hi[0] - lo[0]), lo[1] + uv * (hi[1] - lo[1]))
        W = self.top.shape[0]
        ti = np.clip((np.stack([X, Z], -1) - lo) / (hi - lo) * W, 0, W - 1).astype(np.int64)
        h = self.top[ti[..., 1], ti[..., 0]]
        m = np.full(X.shape, 0.75)
        wet = h >= 0
        if wet.any():
            d = self.sdf_at(np.stack([X[wet], h[wet] - 0.002, Z[wet]], 1))
            m[wet] = smoothstep(-0.003, 0.006, d)
        return m

    def caustics(self, sun_dir):
        """Light on the floor relative to plain sunlight (1 where there is no water), from the sun refracted
        through the smoothed surface and the ripples, with the Fresnel loss (the web version's WGSL_CAUSTIC)."""
        H = self.top
        W = H.shape[0]
        lo, hi = self._fp()
        texel = (hi - lo) / W
        sun = np.asarray(sun_dir, float); sun = sun / np.linalg.norm(sun)
        out = np.zeros((W, W))
        ss = 2   # samples per texel side
        jj, ii = np.meshgrid(np.arange(W * ss), np.arange(W * ss), indexing='ij')
        fx = (ii + 0.5) / ss - 0.5; fz = (jj + 0.5) / ss - 0.5
        def bil(A, fx, fz):
            x0 = np.clip(np.floor(fx).astype(np.int64), 0, W - 1); z0 = np.clip(np.floor(fz).astype(np.int64), 0, W - 1)
            x1 = np.minimum(x0 + 1, W - 1); z1 = np.minimum(z0 + 1, W - 1)
            ax = np.clip(fx - x0, 0, 1); az = np.clip(fz - z0, 0, 1)
            return (A[z0, x0] * (1 - ax) + A[z0, x1] * ax) * (1 - az) + (A[z1, x0] * (1 - ax) + A[z1, x1] * ax) * az
        Hn = np.where(H >= 0, H, np.nan)
        def nb(sh, ax):
            s = np.roll(Hn, sh, axis=ax)
            return np.where(np.isnan(s), Hn, s)
        gx = (nb(-1, 1) - nb(1, 1)) / (2 * texel[0])
        gz = (nb(-1, 0) - nb(1, 0)) / (2 * texel[1])
        gx = np.nan_to_num(gx); gz = np.nan_to_num(gz)
        h = bil(np.where(H >= 0, H, -1.0), fx, fz)
        wet = (h >= 0) & (bil((H >= 0).astype(float), fx, fz) > 0.999)
        rs = self.ripple.slope_at((fx + 0.5) * texel[0], (fz + 0.5) * texel[1])
        n = np.stack([-bil(gx, fx, fz) - rs[0], np.ones_like(h), -bil(gz, fx, fz) - rs[1]], -1)
        n /= np.linalg.norm(n, axis=-1)[..., None]
        cosi = np.sum(n * sun, -1)
        eta = 1 / 1.333
        k = 1 - eta * eta * (1 - cosi * cosi)
        r = -sun * eta + n * (eta * cosi - np.sqrt(np.maximum(k, 0)))[..., None]
        t = 1 - fresnel_w(cosi)
        # flat water maps every texel onto itself
        st = math.sqrt(max(1 - sun[1] ** 2, 0)) / 1.333
        r0 = np.array([-sun[0] / 1.333, -math.sqrt(1 - st * st), -sun[2] / 1.333])
        depth = np.where(wet, h, 0.0)
        px = (fx + 0.5) * texel[0] + np.where(wet, r[..., 0] * depth / np.maximum(-r[..., 1], 0.05) - r0[0] * depth / -r0[1], 0)
        pz = (fz + 0.5) * texel[1] + np.where(wet, r[..., 2] * depth / np.maximum(-r[..., 1], 0.05) - r0[2] * depth / -r0[1], 0)
        energy = np.where(wet, t, 1.0) / (ss * ss)
        ux = px / texel[0] - 0.5; uz = pz / texel[1] - 0.5
        x0 = np.floor(ux).astype(np.int64); z0 = np.floor(uz).astype(np.int64)
        ax = ux - x0; az = uz - z0
        for dx, dz, w in ((0, 0, (1 - ax) * (1 - az)), (1, 0, ax * (1 - az)), (0, 1, (1 - ax) * az), (1, 1, ax * az)):
            xi = x0 + dx; zi = z0 + dz
            ok = (xi >= 0) & (xi < W) & (zi >= 0) & (zi < W)
            np.add.at(out, (zi[ok], xi[ok]), (energy * w)[ok])
        # a slight blur like the rasterised triangles of the web version
        out = (out + np.roll(out, 1, 0) + np.roll(out, -1, 0) + np.roll(out, 1, 1) + np.roll(out, -1, 1)) / 5
        return out


def nozzle_diameter(flow_l_min, speed):
    Q = flow_l_min / 60000.0
    v = max(speed, 0.05)
    return math.sqrt(4 * Q / (math.pi * v))


class RippleLayer:
    """Capillary-gravity ripples on an (R+1)² grid over the footprint, exact damped oscillator per cosine mode
    (the web version's RippleLayer: mirrored domain of size M = 2R, reflecting walls, masked by obstacles)."""

    def __init__(self, R, Lx, Lz):
        self.R, self.M, self.Lx, self.Lz = R, 2 * R, Lx, Lz
        M = self.M
        i = np.arange(M)
        mx = np.where(i < R, i, i - M)
        kx = mx * math.pi / Lx
        kz = mx * math.pi / Lz
        self.KX, self.KZ = np.meshgrid(kx, kz)            # [j, i]
        MX, MZ = np.meshgrid(mx, mx)
        self.dead = ((MX == 0) & (MZ == 0)) | (MX == -R) | (MZ == -R)
        self.S = np.zeros((M, M), complex)              # height + i·velocity, per mode
        self.field = np.zeros((R + 1, R + 1, 3))       # height, slope x, slope z

    def _mirror(self, a):
        R, M = self.R, self.M
        idx = np.arange(M)
        p = np.where(idx <= R, idx, M - idx)
        return a[np.ix_(p, p)]

    def frame(self, dt, depth, src, mask):
        R, M = self.R, self.M
        dx, dz = self.Lx / R, self.Lz / R
        hat = np.fft.fft2(self._mirror(src) / (dx * dz))
        kk = np.sqrt(self.KX ** 2 + self.KZ ** 2)
        D = max(depth, 0.002)
        kd = np.minimum(kk * D, 15.0)
        th = np.tanh(kd)
        nu, film = 1.0e-6, 0.3
        w2 = (G * kk + SIGMA_RHO * kk ** 3) * th
        w = np.sqrt(w2)
        gam = 2 * nu * kk * kk + film * kk * np.sqrt(nu * w * 0.125) + kk * np.sqrt(nu * w * 0.5) / np.maximum(np.sinh(np.minimum(2 * kd, 30.0)), 1e-4)
        wd = np.sqrt(np.maximum(w2 - gam * gam, 1e-6))
        Hs, Vs = self.S.real, self.S.imag
        if dt > 0:
            c, sn, e = np.cos(wd * dt), np.sin(wd * dt), np.exp(-gam * dt)
            Hs, Vs = e * (Hs * c + (Vs + gam * Hs) / wd * sn), e * (Vs * c - (w2 * Hs + gam * Vs) / wd * sn)
        hp = 1 - np.exp(-(kk * kk) / (2 * math.pi / 0.12) ** 2)
        sw = max(1.2 * self.Lx / R, 0.003)
        spread = np.exp(-0.5 * kk * kk * sw * sw)
        Vs = Vs - (kk * th / RHO) * hat.real * hp * spread
        Hs = np.where(self.dead, 0, Hs); Vs = np.where(self.dead, 0, Vs)
        fld = np.fft.ifft2(Hs + 1j * Vs) * 1.0          # numpy's inverse already divides by M²
        h = fld.real
        self.field[..., 0] = h[:R + 1, :R + 1]
        self.field[..., 1] = (np.roll(h, -1, 1) - np.roll(h, 1, 1))[:R + 1, :R + 1] / (2 * dx)
        self.field[..., 2] = (np.roll(h, -1, 0) - np.roll(h, 1, 0))[:R + 1, :R + 1] / (2 * dz)
        # waves end inside obstacles at the water line and on dry floor
        masked = fld * self._mirror(mask)
        self.S = np.fft.fft2(masked)

    def slope_at(self, x, z):
        """Ripple slopes (d/dx, d/dz) at solver positions, bilinear (x, z relative to the footprint corner)."""
        R = self.R
        qx = np.clip(x / self.Lx * R, 0, R); qz = np.clip(z / self.Lz * R, 0, R)
        bx = np.minimum(np.floor(qx).astype(np.int64), R - 1); bz = np.minimum(np.floor(qz).astype(np.int64), R - 1)
        fx = qx - bx; fz = qz - bz
        out = []
        for c in (1, 2):
            F = self.field[..., c]
            out.append((F[bz, bx] * (1 - fx) + F[bz, bx + 1] * fx) * (1 - fz) + (F[bz + 1, bx] * (1 - fx) + F[bz + 1, bx + 1] * fx) * fz)
        return out

    def height_at(self, x, z):
        R = self.R
        qx = np.clip(x / self.Lx * R, 0, R); qz = np.clip(z / self.Lz * R, 0, R)
        bx = np.minimum(np.floor(qx).astype(np.int64), R - 1); bz = np.minimum(np.floor(qz).astype(np.int64), R - 1)
        fx = qx - bx; fz = qz - bz
        F = self.field[..., 0]
        return (F[bz, bx] * (1 - fx) + F[bz, bx + 1] * fx) * (1 - fz) + (F[bz + 1, bx] * (1 - fx) + F[bz + 1, bx + 1] * fx) * fz
