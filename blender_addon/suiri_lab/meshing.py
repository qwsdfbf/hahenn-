# 水理ラボ — the liquid surface from the particles, as the web version draws it: every particle is a sphere of
# radius 0.525 h and the union of the spheres is smoothed. Here the union is a distance field on a half-cell grid,
# blurred, and meshed with surface nets. Particles that are alone (drops, spray from a stream) stay spheres.
import math
import numpy as np


def _blur(f, sigma):
    r = max(1, int(math.ceil(2.5 * sigma)))
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sigma) ** 2)
    k /= k.sum()
    for ax in range(3):
        pad = [(0, 0)] * 3
        pad[ax] = (r, r)
        g = np.pad(f, pad, mode='edge')
        out = np.zeros_like(f)
        for i, w in enumerate(k):
            sl = [slice(None)] * 3
            sl[ax] = slice(i, i + f.shape[ax])
            out += w * g[tuple(sl)]
        f = out
    return f


def _icosphere():
    t = (1 + 5 ** 0.5) / 2
    v = np.array([[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
                  [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]], float)
    v /= np.linalg.norm(v, axis=1)[:, None]
    f = np.array([[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6],
                  [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]])
    # one subdivision: 42 vertices, 80 faces
    edges = {}
    verts = list(v)
    def mid(a, b):
        key = (min(a, b), max(a, b))
        if key not in edges:
            m = verts[a] + verts[b]
            verts.append(m / np.linalg.norm(m))
            edges[key] = len(verts) - 1
        return edges[key]
    nf = []
    for a, b, c in f:
        ab, bc, ca = mid(a, b), mid(b, c), mid(c, a)
        nf += [[a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]]
    return np.array(verts), np.array(nf)


ICO_V, ICO_F = _icosphere()


def surface(sv, smooth=0.8):
    """Triangle/quad mesh of the liquid of solver `sv`: (verts (V,3), faces as list of arrays, quads (Q,4), tris (T,3))."""
    pos = sv.pos
    h = sv.h
    r = sv.radius
    if len(pos) == 0:
        return np.zeros((0, 3)), np.zeros((0, 4), np.int64), np.zeros((0, 3), np.int64)
    # particles with little company are drawn as their own spheres
    g = (pos - sv.origin) / h
    c = np.floor(g).astype(np.int64)
    ing = np.all((g >= 0) & (g < [sv.nx, sv.ny, sv.nz]), axis=1)
    near = np.zeros(len(pos), np.int64)
    if ing.any():
        cnt = np.pad(sv.count, 1)
        s = np.zeros_like(cnt)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for dz in (-1, 0, 1):
                    s += np.roll(np.roll(np.roll(cnt, dx, 0), dy, 1), dz, 2)
        ci = c[ing] + 1
        near[ing] = s[ci[:, 0], ci[:, 1], ci[:, 2]]
    lone = near <= 6
    body = pos[~lone]
    quads = np.zeros((0, 4), np.int64)
    verts = np.zeros((0, 3))
    if len(body):
        sp = h / 2
        lo = body.min(0) - (r + 4 * sp)
        hi = body.max(0) + (r + 4 * sp)
        n = np.ceil((hi - lo) / sp).astype(np.int64) + 1
        far = 2 * sp
        phi = np.full(n, far, np.float32)
        q = (body - lo) / sp
        b = np.floor(q).astype(np.int64)
        flat = phi.ravel()
        for dx in (-1, 0, 1, 2):
            for dy in (-1, 0, 1, 2):
                for dz in (-1, 0, 1, 2):
                    nb = b + (dx, dy, dz)
                    d = np.linalg.norm((nb - q) * sp, axis=1) - r
                    ok = np.all((nb >= 0) & (nb < n), axis=1) & (d < far)
                    idx = (nb[ok, 0] * n[1] + nb[ok, 1]) * n[2] + nb[ok, 2]
                    np.minimum.at(flat, idx, d[ok].astype(np.float32))
        phi = np.clip(phi, -r, far)
        phi = _blur(phi, smooth)
        verts, quads = _surface_nets(phi)
        verts = lo + verts * sp
        # keep the surface inside the glass and above the floor where the water is in the tank
        x0, z0 = sv.origin[0], sv.origin[2]
        x1, z1 = x0 + sv.nx * h, z0 + sv.nz * h
        m = 0.0005
        intank = (verts[:, 0] > x0 - sp) & (verts[:, 0] < x1 + sp) & (verts[:, 2] > z0 - sp) & (verts[:, 2] < z1 + sp) & (verts[:, 1] < sv.rim)
        verts[intank, 0] = np.clip(verts[intank, 0], x0 + m, x1 - m)
        verts[intank, 2] = np.clip(verts[intank, 2], z0 + m, z1 - m)
        verts[intank, 1] = np.maximum(verts[intank, 1], m)
    drops = pos[lone]
    tris = np.zeros((0, 3), np.int64)
    if len(drops):
        base = len(verts)
        dv = (drops[:, None, :] + ICO_V[None] * r).reshape(-1, 3)
        tris = (ICO_F[None] + (base + np.arange(len(drops)) * len(ICO_V))[:, None, None]).reshape(-1, 3)
        verts = np.concatenate([verts, dv])
    return verts, quads, tris


def _surface_nets(phi):
    """Naive surface nets on node values phi (inside < 0): one vertex per cell the surface crosses, one quad per
    crossed grid edge. Returns vertices in node units and quads (outward facing)."""
    X, Y, Z = phi.shape
    inside = phi < 0
    cin = np.zeros((X - 1, Y - 1, Z - 1), np.int8)
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                cin += inside[dx:X - 1 + dx, dy:Y - 1 + dy, dz:Z - 1 + dz]
    mixed = (cin > 0) & (cin < 8)
    cells = np.argwhere(mixed)
    if len(cells) == 0:
        return np.zeros((0, 3)), np.zeros((0, 4), np.int64)
    vid = np.full(mixed.shape, -1, np.int64)
    vid[mixed] = np.arange(len(cells))
    acc = np.zeros((len(cells), 3)); cnt = np.zeros(len(cells))
    corners = [(a, b, c) for a in (0, 1) for b in (0, 1) for c in (0, 1)]
    edges = [(p, q) for p in corners for q in corners if sum(abs(np.subtract(p, q))) == 1 and p < q]
    for pa, pb in edges:
        fa = phi[cells[:, 0] + pa[0], cells[:, 1] + pa[1], cells[:, 2] + pa[2]]
        fb = phi[cells[:, 0] + pb[0], cells[:, 1] + pb[1], cells[:, 2] + pb[2]]
        cross = (fa < 0) != (fb < 0)
        t = np.where(cross, fa / np.where(cross, fa - fb, 1), 0)
        pt = np.array(pa, float) + t[:, None] * (np.array(pb, float) - np.array(pa, float))
        acc[cross] += pt[cross]
        cnt[cross] += 1
    verts = cells + acc / np.maximum(cnt, 1)[:, None]
    quads = []
    # x edges: cells around the edge (i, j, k)-(i+1, j, k) are (i, j-1..j, k-1..k)
    for ax in range(3):
        a1, a2 = [a for a in range(3) if a != ax]
        sl0 = [slice(None)] * 3; sl1 = [slice(None)] * 3
        sl0[ax] = slice(0, phi.shape[ax] - 1); sl1[ax] = slice(1, phi.shape[ax])
        lo_in = inside[tuple(sl0)]; hi_in = inside[tuple(sl1)]
        crossing = lo_in != hi_in
        # the four cells need j-1 >= 0 and j < shape-1 on both other axes
        crossing[tuple(slice(0, 1) if a == a1 else slice(None) for a in range(3))] = False
        crossing[tuple(slice(0, 1) if a == a2 else slice(None) for a in range(3))] = False
        crossing[tuple(slice(phi.shape[a] - 1, None) if a == a1 else slice(None) for a in range(3))] = False
        crossing[tuple(slice(phi.shape[a] - 1, None) if a == a2 else slice(None) for a in range(3))] = False
        e = np.argwhere(crossing)
        if len(e) == 0:
            continue
        def cell(o1, o2):
            c = e.copy()
            c[:, a1] -= o1; c[:, a2] -= o2
            return vid[c[:, 0], c[:, 1], c[:, 2]]
        q = np.stack([cell(1, 1), cell(0, 1), cell(0, 0), cell(1, 0)], 1)
        # winding: the quad faces from the inside to the outside (the cell order turns the other way round the y axis)
        flip = ~lo_in[e[:, 0], e[:, 1], e[:, 2]]
        if ax == 1:
            flip = ~flip
        q[flip] = q[flip][:, ::-1]
        quads.append(q)
    quads = np.concatenate(quads) if quads else np.zeros((0, 4), np.int64)
    quads = quads[np.all(quads >= 0, axis=1)]
    return verts, quads


def settle_on_top(sv, verts):
    """The free surface of pools as the web version draws it: vertices close below or above the smoothed top-view
    height map take its height, so the pool is as smooth as that map (the ripples come on top as a texture)."""
    H = sv.top
    W = H.shape[0]
    if len(verts) == 0:
        return
    lo = sv.origin[[0, 2]]
    size = np.array([sv.nx, sv.nz]) * sv.h
    q = (verts[:, [0, 2]] - lo) / size * W - 0.5
    inside = np.all((q >= 0) & (q <= W - 1), axis=1)
    if not inside.any():
        return
    qi = q[inside]
    b = np.minimum(np.floor(qi).astype(np.int64), W - 2)
    f = qi - b
    h00 = H[b[:, 1], b[:, 0]]; h10 = H[b[:, 1], b[:, 0] + 1]; h01 = H[b[:, 1] + 1, b[:, 0]]; h11 = H[b[:, 1] + 1, b[:, 0] + 1]
    wet = (h00 >= 0) & (h10 >= 0) & (h01 >= 0) & (h11 >= 0)
    top = (h00 * (1 - f[:, 0]) + h10 * f[:, 0]) * (1 - f[:, 1]) + (h01 * (1 - f[:, 0]) + h11 * f[:, 0]) * f[:, 1]
    y = verts[inside, 1]
    near = wet & (y > top - 0.6 * sv.h) & (y < top + 0.6 * sv.h)
    idx = np.nonzero(inside)[0][near]
    verts[idx, 1] = top[near]
