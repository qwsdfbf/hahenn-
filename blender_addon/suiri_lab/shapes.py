# 水理ラボ — meshes of the shapes, sources and the tank (Blender axes, metres)
import math
import bmesh
import numpy as np

SHAPES = {
    'BOX': ('箱', dict(w=0.10, h=0.06, d=0.08)),
    'PLATE': ('板', dict(w=0.22, d=0.10, t=0.012)),
    'SPHERE': ('球', dict(r=0.035)),
    'CYLINDER': ('円柱', dict(r=0.025, h=0.12)),
    'CONE': ('円錐', dict(r=0.04, h=0.08)),
    'TORUS': ('ドーナツ', dict(R=0.05, r=0.014)),
    'CUP': ('コップ', dict(r=0.04, h=0.10, t=0.006)),
    'CONTAINER': ('容器', dict(w=0.14, h=0.06, d=0.10, t=0.008)),
    'GUTTER': ('樋（とい）', dict(len=0.28, r=0.03, t=0.006)),
}
SEG = 40


def _to_mesh(bm, me):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    me.update()


def _lathe(bm, prof, seg=SEG, close_top=False, close_bottom=False):
    """Revolve a profile [(r, z), ...] about Z. Points with r = 0 become poles."""
    rings = []
    for r, z in prof:
        if r <= 1e-9:
            rings.append([bm.verts.new((0, 0, z))])
        else:
            rings.append([bm.verts.new((r * math.cos(2 * math.pi * i / seg), r * math.sin(2 * math.pi * i / seg), z)) for i in range(seg)])
    for a, b in zip(rings, rings[1:]):
        for i in range(seg):
            if len(a) == 1 and len(b) == 1:
                continue
            if len(a) == 1:
                bm.faces.new((a[0], b[i], b[(i + 1) % seg]))
            elif len(b) == 1:
                bm.faces.new((a[i], a[(i + 1) % seg], b[0]))
            else:
                bm.faces.new((a[i], a[(i + 1) % seg], b[(i + 1) % seg], b[i]))
    if close_bottom and len(rings[0]) > 1:
        bm.faces.new(list(reversed(rings[0])))
    if close_top and len(rings[-1]) > 1:
        bm.faces.new(rings[-1])


def _box(bm, lo, hi):
    (x0, y0, z0), (x1, y1, z1) = lo, hi
    v = [bm.verts.new(p) for p in ((x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1))]
    for f in ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
        bm.faces.new([v[i] for i in f])


def shape_mesh(me, shape, d):
    """Mesh of an obstacle shape centred on its origin, as the web version's distance functions describe them."""
    bm = bmesh.new()
    if shape == 'BOX':
        _box(bm, (-d['w'] / 2, -d['d'] / 2, -d['h'] / 2), (d['w'] / 2, d['d'] / 2, d['h'] / 2))
    elif shape == 'PLATE':
        _box(bm, (-d['w'] / 2, -d['d'] / 2, -d['t'] / 2), (d['w'] / 2, d['d'] / 2, d['t'] / 2))
    elif shape == 'SPHERE':
        bmesh.ops.create_uvsphere(bm, u_segments=SEG, v_segments=SEG // 2, radius=d['r'])
    elif shape == 'CYLINDER':
        _lathe(bm, [(0, -d['h'] / 2), (d['r'], -d['h'] / 2), (d['r'], d['h'] / 2), (0, d['h'] / 2)])
    elif shape == 'CONE':
        _lathe(bm, [(0, -d['h'] / 2), (d['r'], -d['h'] / 2), (0, d['h'] / 2)])
    elif shape == 'TORUS':
        R, r = d['R'], d['r']
        n2 = 16
        rings = []
        for i in range(SEG):
            a = 2 * math.pi * i / SEG
            rings.append([bm.verts.new(((R + r * math.cos(2 * math.pi * j / n2)) * math.cos(a), (R + r * math.cos(2 * math.pi * j / n2)) * math.sin(a), r * math.sin(2 * math.pi * j / n2))) for j in range(n2)])
        for i in range(SEG):
            a, b = rings[i], rings[(i + 1) % SEG]
            for j in range(n2):
                bm.faces.new((a[j], b[j], b[(j + 1) % n2], a[(j + 1) % n2]))
    elif shape == 'CUP':
        r, h, t = d['r'], d['h'], min(d['t'], d['r'] * 0.8)
        _lathe(bm, [(0, -h / 2), (r, -h / 2), (r, h / 2), (r - t, h / 2), (r - t, -h / 2 + t), (0, -h / 2 + t)])
    elif shape == 'CONTAINER':
        w, h, dd = d['w'] / 2, d['h'] / 2, d['d'] / 2
        t = min(d['t'], d['w'] / 3, d['d'] / 3, d['h'] * 0.8)
        o = [bm.verts.new(p) for p in ((-w, -dd, -h), (w, -dd, -h), (w, dd, -h), (-w, dd, -h), (-w, -dd, h), (w, -dd, h), (w, dd, h), (-w, dd, h))]
        wi, di = w - t, dd - t
        i_ = [bm.verts.new(p) for p in ((-wi, -di, -h + t), (wi, -di, -h + t), (wi, di, -h + t), (-wi, di, -h + t), (-wi, -di, h), (wi, -di, h), (wi, di, h), (-wi, di, h))]
        for f in ((0, 3, 2, 1), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
            bm.faces.new([o[k] for k in f])
        for f in ((0, 1, 2, 3), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)):
            bm.faces.new([i_[k] for k in f])
        for a, b in ((4, 5), (5, 6), (6, 7), (7, 4)):
            bm.faces.new((o[a], o[b], i_[b], i_[a]))
    elif shape == 'GUTTER':
        L, r, t = d['len'] / 2, d['r'], d['t']
        n = SEG // 2
        prof_o = [((r + t / 2) * math.cos(math.pi + math.pi * k / n), (r + t / 2) * math.sin(math.pi + math.pi * k / n)) for k in range(n + 1)]
        prof_i = [((r - t / 2) * math.cos(math.pi + math.pi * k / n), (r - t / 2) * math.sin(math.pi + math.pi * k / n)) for k in range(n + 1)]
        ring = prof_o + list(reversed(prof_i))          # (y, z) around the half annulus
        a = [bm.verts.new((-L, y, z)) for y, z in ring]
        b = [bm.verts.new((L, y, z)) for y, z in ring]
        m = len(ring)
        for k in range(m):
            bm.faces.new((a[k], a[(k + 1) % m], b[(k + 1) % m], b[k]))
        # end caps as strips between the outer and inner arcs
        for side in (a, b):
            for k in range(n):
                q = (side[k], side[k + 1], side[m - 2 - k], side[m - 1 - k])
                bm.faces.new(q if side is b else tuple(reversed(q)))
    _to_mesh(bm, me)


def nozzle_mesh(me, mode, nozzle_d, rain_size):
    """A source's look: the outlet at the origin, the body above it (water leaves along local -Z)."""
    bm = bmesh.new()
    if mode == 'RAIN':
        s = rain_size / 2
        v = [bm.verts.new(p) for p in ((-s, -s, 0), (s, -s, 0), (s, s, 0), (-s, s, 0))]
        for i in range(4):
            bm.edges.new((v[i], v[(i + 1) % 4]))
        bm.to_mesh(me)
        bm.free()
        me.update()
        return
    if mode == 'SHOWER':
        R = max(nozzle_d / 2, 0.022)
        _lathe(bm, [(0, 0), (R, 0), (R + 0.004, 0.006), (0.009, 0.02), (0.009, 0.07), (0, 0.07)])
    else:
        ri = max(nozzle_d / 2, 0.0015)
        ro, rb = ri + 0.0025, ri + 0.009
        _lathe(bm, [(ri, 0.0), (ro, 0.0), (ro, 0.022), (rb, 0.026), (rb, 0.05), (0, 0.05)], close_bottom=False)
        # the bore
        _lathe(bm, [(0, 0.012), (ri, 0.012), (ri, 0.0)])
    _to_mesh(bm, me)


def drain_mesh(me, r):
    bm = bmesh.new()
    _lathe(bm, [(0, -0.002), (r, -0.002), (r, 0.0005), (r - 0.003, 0.0005), (r - 0.003, -0.0005), (0, -0.0005)])
    _to_mesh(bm, me)


def block_mesh(me, w, d, h):
    bm = bmesh.new()
    _box(bm, (-w / 2, -d / 2, -h / 2), (w / 2, d / 2, h / 2))
    _to_mesh(bm, me)


def tank_mesh(me, w, d, h, wall=0.005, floor=0.008):
    """Glass walls (material 0) around the inside w x d x h, on a slab (material 1) under local Z = 0."""
    bm = bmesh.new()
    t = wall
    _box(bm, (-w / 2 - t, -d / 2 - t, 0), (w / 2 + t, -d / 2, h))
    _box(bm, (-w / 2 - t, d / 2, 0), (w / 2 + t, d / 2 + t, h))
    _box(bm, (-w / 2 - t, -d / 2, 0), (-w / 2, d / 2, h))
    _box(bm, (w / 2, -d / 2, 0), (w / 2 + t, d / 2, h))
    nglass = len(bm.faces)
    _box(bm, (-w / 2 - t, -d / 2 - t, -floor), (w / 2 + t, d / 2 + t, 0))
    for i, f in enumerate(bm.faces):
        f.material_index = 0 if i < nglass else 1
    _to_mesh(bm, me)
