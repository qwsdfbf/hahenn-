# 水理ラボ — running the solver over the frames of the scene and keeping what it gives for every frame
import glob
import math
import os
import time
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
from . import build, exr, meshing, space
from .solver import Solver, Solids

state = {'baking': False, 'baking_job': False, 'loaded': {}}


def cache_dir(tank):
    base = tank.suiri.cache_dir
    if base.startswith('//') and not bpy.data.filepath:
        base = os.path.join(bpy.app.tempdir or '/tmp', 'suiri_cache')
    path = os.path.join(bpy.path.abspath(base), bpy.path.clean_name(tank.name))
    return path


def frame_file(tank, f):
    return os.path.join(cache_dir(tank), 'frame_%05d.npz' % f)


def maps_file(tank, kind, f):
    """kind 'surface': top height, ripple slopes d/dX, d/dY; kind 'light': top height, light on the floor."""
    return os.path.join(cache_dir(tank), '%s_%05d.exr' % (kind, f))


def sun_direction(scene):
    """Towards the sun in Blender axes: the first visible sun lamp, else the web version's sun."""
    for o in scene.objects:
        if o.type == 'LIGHT' and o.data.type == 'SUN' and not o.hide_render:
            return np.array(o.matrix_world.to_3x3() @ Vector((0, 0, 1)))
    el, az = math.radians(52), math.radians(140)
    return np.array(build._w((math.cos(el) * math.sin(az), math.sin(el), math.cos(el) * math.cos(az))))


class Baker:
    """One tank: the solver, the obstacles as a distance lattice, and the files of every frame."""

    def __init__(self, context, tank):
        self.context = context
        self.scene = context.scene
        self.tank = tank
        s = tank.suiri
        self.start, self.end = self.scene.frame_start, self.scene.frame_end
        self.frame = self.start
        self.dt = self.scene.render.fps_base / self.scene.render.fps
        self.scene.frame_set(self.start)
        dg = context.evaluated_depsgraph_get()
        obstacles = build.items_of(tank, 'OBSTACLE')
        top = 0.0
        for ob in obstacles:
            for c in ob.bound_box:
                top = max(top, space.tank_local(tank, ob.matrix_world @ Vector(c))[2])
        extra = max(0.0, top - s.height) + 0.1
        self.sv = Solver(s.width, s.height, s.depth, s.quality, s.whitewater, extra_height=extra)
        sv = self.sv
        s.sim_w, s.sim_d, s.sim_h = sv.nx * sv.h, sv.nz * sv.h, sv.rim
        self.sun = space.to_solver(sun_direction(self.scene))
        self.lattice_cache = {}
        self.prev_xf = {}
        self._motions = None
        self._ndrains = None
        self._drain_xf = {}
        self._update_solids(dg, first=True)
        for ob in build.items_of(tank, 'BLOCK'):
            pts = np.array([space.tank_local(tank, ob.matrix_world @ Vector(c)) for c in ob.bound_box])
            lo, hi = pts.min(0), pts.max(0)
            sv.emit_block([lo[0], lo[2], -hi[1]], [hi[0], hi[2], -lo[1]])
        os.makedirs(cache_dir(tank), exist_ok=True)
        for f in glob.glob(os.path.join(cache_dir(tank), '*_*.npz')) + glob.glob(os.path.join(cache_dir(tank), '*_*.exr')):
            os.remove(f)
        s.baked_frames = 0
        s.baked_start = self.start
        self.times = []

    # -------------------------------------------------------------- obstacles
    def _object_lattice(self, ob, dg):
        """Distances from ob's surface at the lattice points around it (sign from the face normal)."""
        sv = self.sv
        ev = ob.evaluated_get(dg)
        me = ev.to_mesh()
        try:
            M = ob.matrix_world
            co = np.empty(len(me.vertices) * 3)
            me.vertices.foreach_get('co', co)
            co = co.reshape(-1, 3)
            Mw = np.array(M)
            world = co @ Mw[:3, :3].T + Mw[:3, 3]
            t = np.array(self.tank.matrix_world.translation)
            P = space.to_solver(world - t)
            polys = [tuple(p.vertices) for p in me.polygons]
        finally:
            ev.to_mesh_clear()
        if not polys:
            return None
        bvh = BVHTree.FromPolygons(P.tolist(), polys)
        hh = sv.h / 2
        shape = np.array(sv.lattice_shape())
        band = 3 * sv.h
        lo = np.maximum(np.floor((P.min(0) - band - sv.origin) / hh).astype(int), 0)
        hi = np.minimum(np.ceil((P.max(0) + band - sv.origin) / hh).astype(int) + 1, shape)
        if np.any(hi <= lo):
            return None
        axes = [sv.origin[a] + hh * np.arange(lo[a], hi[a]) for a in range(3)]
        X, Y, Z = np.meshgrid(*axes, indexing='ij')
        pts = np.stack([X, Y, Z], -1).reshape(-1, 3)
        d = np.empty(len(pts))
        find = bvh.find_nearest
        for i, p in enumerate(pts.tolist()):
            loc, nrm, _, dist = find(p)
            dp = (p[0] - loc[0]) * nrm[0] + (p[1] - loc[1]) * nrm[1] + (p[2] - loc[2]) * nrm[2]
            d[i] = dist if dp >= 0 else -dist
        return (tuple(lo), tuple(hi), d.reshape(X.shape))

    def _update_solids(self, dg, first=False):
        sv = self.sv
        obstacles = build.items_of(self.tank, 'OBSTACLE')
        drains = build.items_of(self.tank, 'DRAIN')
        changed = first
        motions = []
        parts = []
        for k, ob in enumerate(obstacles):
            M = ob.matrix_world.copy()
            key = (ob.name, tuple(tuple(r) for r in M), ob.data.name if ob.data else '', len(ob.data.vertices) if ob.type == 'MESH' else 0)
            lat = self.lattice_cache.get(ob.name)
            if lat is None or lat[0] != key:
                lat = (key, self._object_lattice(ob, dg))
                self.lattice_cache[ob.name] = lat
                changed = True
            parts.append(lat[1])
            # velocities from the previous frame's transform let moving obstacles push the water
            c = space.to_solver(space.tank_local(self.tank, M.translation))
            lin = np.zeros(3); ang = np.zeros(3)
            prev = self.prev_xf.get(ob.name)
            if prev is not None:
                lin = (c - prev[0]) / self.dt
                dq = (M.to_quaternion() @ prev[1].inverted())
                axis, angle = dq.to_axis_angle()
                if angle > math.pi:
                    angle -= 2 * math.pi
                ang = space.to_solver(np.array(axis)) * angle / self.dt
                if np.linalg.norm(lin) > 4:
                    lin *= 4 / np.linalg.norm(lin)
                if np.linalg.norm(ang) > 40:
                    ang *= 40 / np.linalg.norm(ang)
            self.prev_xf[ob.name] = (c, M.to_quaternion())
            motions.append((lin, ang, c))
        # a change of speed (also coming to rest) changes the solid velocities on the faces
        if self._motions is None or len(motions) != len(self._motions) or any(np.any(a[0] != b[0]) or np.any(a[1] != b[1]) for a, b in zip(motions, self._motions)):
            changed = True
        self._motions = motions
        if not changed and self._ndrains == len(drains) and not any(self._drain_moved(o) for o in drains):
            return
        shape = sv.lattice_shape()
        sdf = np.full(shape, 1e9)
        oid = np.full(shape, -1, np.int32)
        for k, p in enumerate(parts):
            if p is None:
                continue
            lo, hi, d = p
            sl = tuple(slice(lo[a], hi[a]) for a in range(3))
            cur = sdf[sl]
            closer = d < cur
            cur[closer] = d[closer]
            oid[sl][closer] = k
        dl = []
        for ob in drains:
            R = ob.matrix_world.to_3x3().normalized()
            ax = [space.to_solver(np.array(R.col[i])) for i in range(3)]
            Rt = np.stack([ax[0], ax[2], ax[1]])
            c = space.to_solver(space.tank_local(self.tank, ob.matrix_world.translation))
            dl.append((Rt, c, ob.suiri.radius, 0.012))
        self._ndrains = len(drains)
        self._drain_xf = {o.name: tuple(tuple(r) for r in o.matrix_world) for o in drains}
        sv.set_solids(Solids(sdf, oid, motions, dl))

    def _drain_moved(self, ob):
        return self._drain_xf.get(ob.name) != tuple(tuple(r) for r in ob.matrix_world)

    # -------------------------------------------------------------- sources
    def sources(self):
        out = []
        t = np.array(self.tank.matrix_world.translation)
        for ob in build.items_of(self.tank, 'SOURCE'):
            s = ob.suiri
            out.append(dict(
                id=ob.name, mode=s.mode, enabled=s.enabled, total=s.total,
                pos=space.to_solver(np.array(ob.matrix_world.translation) - t),
                dir=space.to_solver(np.array(build.source_dir(ob))),
                flow=s.flow, speed=s.speed, drop_d=s.drop_d, drop_rate=1.0 / s.drop_interval, spread=s.spread,
                burst=s.burst, burst_every=s.burst_every, rain_rate=s.rain_rate, rain_size=s.rain_size))
        return out

    # -------------------------------------------------------------- frames
    def done(self):
        return self.frame > self.end

    def next(self):
        """Compute and write one frame; returns the frame number written."""
        t0 = time.time()
        f = self.frame
        sv = self.sv
        if f > self.start:
            state['baking'] = True
            try:
                self.scene.frame_set(f)
            finally:
                state['baking'] = False
            self._update_solids(self.context.evaluated_depsgraph_get())
            sv.step(self.dt, self.sources())
        else:
            sv._count_cells()
            sv.top = sv.top_height()
        self._write(f)
        self.tank.suiri.baked_frames = f - self.start + 1
        self.frame += 1
        self.times.append(time.time() - t0)
        return f

    def _write(self, f):
        sv = self.sv
        v, q, tr = meshing.surface(sv)
        meshing.settle_on_top(sv, v)
        # the liquid's velocity at the surface, for motion blur and the vector pass (m/s, Blender axes)
        vel = np.zeros((len(v), 3))
        if len(v):
            g = (v - sv.origin) / sv.h
            vel = np.stack([sv._sample(g, a) for a in range(3)], 1)
            vel[~sv._in_grid(g)] = 0.0
        out = dict(v=space.from_solver(v).astype(np.float32), vel=space.from_solver(vel).astype(np.float32), q=q.astype(np.int32), t=tr.astype(np.int32),
                   liters=np.float32(sv.liters), particles=np.int32(len(sv.pos)), time=np.float32(sv.time))
        for k, kind in (('spray', 0), ('foam', 1), ('bubble', 2)):
            out[k] = space.from_solver(sv.wpos[sv.wkind == kind]).astype(np.float32)
        np.savez(frame_file(self.tank, f), **out)
        # maps over the water footprint; the solver's rows run from the back of the tank (+Y), which is the top of
        # the picture
        W = sv.wmap_size()
        top = sv.top
        texel_x, texel_z = sv.nx * sv.h / W, sv.nz * sv.h / W
        ii, jj = np.meshgrid(np.arange(W), np.arange(W))
        sx, sz = sv.ripple.slope_at((ii + 0.5) * texel_x, (jj + 0.5) * texel_z)
        exr.write_rgb(maps_file(self.tank, 'surface', f), top, sx, -sz)
        exr.write_rgb(maps_file(self.tank, 'light', f), top, sv.caustics(self.sun), np.zeros_like(top))

    def finish(self):
        attach_maps(self.tank)
        # meshes are replaced between frames; the interface must not touch them while a frame renders
        self.scene.render.use_lock_interface = True
        self.tank.suiri.bake_note = '%d フレーム・1 フレーム平均 %.1f 秒' % (len(self.times), sum(self.times) / max(len(self.times), 1))
        state['loaded'].pop(self.tank.name, None)
        load_frame(self.tank, self.scene.frame_current)


# ------------------------------------------------------------------ showing the frames
def attach_maps(tank):
    s = tank.suiri
    n = s.baked_frames
    trees = [build.water_material(tank).node_tree, build.underwater_group(tank)]
    for kind, label in (('surface', '水面'), ('light', '水中の光')):
        name = '水理ラボ %s %s' % (label, tank.name)
        img = bpy.data.images.get(name)
        if n <= 0:
            if img is not None:
                bpy.data.images.remove(img)
            img = None
        else:
            path = maps_file(tank, kind, s.baked_start)
            if img is None:
                img = bpy.data.images.load(path, check_existing=False)
                img.name = name
            img.filepath = path
            img.source = 'SEQUENCE'
            img.colorspace_settings.name = 'Non-Color'
            img.reload()
        for nt in trees:
            node = nt.nodes.get('suiri_' + kind)
            if node is None:
                continue
            node.image = img
            if img is not None:
                iu = node.image_user
                iu.frame_duration = n
                iu.frame_start = s.baked_start
                iu.frame_offset = s.baked_start - 1
                iu.use_auto_refresh = True
                iu.use_cyclic = False
    for nt in trees:
        for mp in nt.nodes:
            if mp.name.startswith('suiri_mapping'):
                mp.inputs['Scale'].default_value = (1 / s.sim_w, 1 / s.sim_d, 1)
                mp.inputs['Location'].default_value = (0.5, 0.5, 0)
    # the refracted sun's slope for the path length under water
    sun = sun_direction(bpy.context.scene)
    sun = sun / np.linalg.norm(sun)
    st = math.sqrt(max(1 - sun[2] ** 2, 0)) / 1.333
    g = build.underwater_group(tank)
    g.nodes['suiri_refracted_cos'].outputs[0].default_value = max(math.sqrt(1 - st * st), 0.2)


def _set_mesh(me, v, q, t, vel=None):
    me.clear_geometry()
    if len(v) == 0:
        me.update()
        return
    me.vertices.add(len(v))
    me.vertices.foreach_set('co', v.ravel())
    nq, nt = len(q), len(t)
    if nq + nt:
        loops = np.concatenate([q.ravel(), t.ravel()]).astype(np.int32)
        starts = np.concatenate([np.arange(nq) * 4, nq * 4 + np.arange(nt) * 3]).astype(np.int32)
        totals = np.concatenate([np.full(nq, 4), np.full(nt, 3)]).astype(np.int32)
        me.loops.add(len(loops))
        me.loops.foreach_set('vertex_index', loops)
        me.polygons.add(nq + nt)
        me.polygons.foreach_set('loop_start', starts)
        me.polygons.foreach_set('loop_total', totals)
        me.polygons.foreach_set('use_smooth', np.ones(nq + nt, bool))
    if vel is not None:
        # Cycles reads this attribute for motion blur of meshes whose topology changes every frame
        a = me.attributes.get('velocity') or me.attributes.new('velocity', 'FLOAT_VECTOR', 'POINT')
        a.data.foreach_set('vector', vel.ravel())
    me.update(calc_edges=True)


def load_frame(tank, frame):
    s = tank.suiri
    n = s.baked_frames
    water = build.part(tank, 'water')
    if water is None:
        return
    if n <= 0:
        if state['loaded'].get(tank.name) is not None:
            for p in ('water', 'spray', 'foam', 'bubble'):
                o = build.part(tank, p)
                if o is not None:
                    _set_mesh(o.data, np.zeros((0, 3)), np.zeros((0, 4), int), np.zeros((0, 3), int))
            state['loaded'][tank.name] = None
        return
    f = min(max(frame, s.baked_start), s.baked_start + n - 1)
    if state['loaded'].get(tank.name) == f:
        return
    path = frame_file(tank, f)
    if not os.path.exists(path):
        return
    d = np.load(path)
    _set_mesh(water.data, d['v'], d['q'], d['t'], d['vel'])
    for p in ('spray', 'foam', 'bubble'):
        o = build.part(tank, p)
        if o is not None:
            _set_mesh(o.data, d[p], np.zeros((0, 4), int), np.zeros((0, 3), int))
    state['loaded'][tank.name] = f


def free(tank):
    d = cache_dir(tank)
    for f in glob.glob(os.path.join(d, 'frame_*.npz')) + glob.glob(os.path.join(d, '*_*.exr')):
        os.remove(f)
    tank.suiri.baked_frames = 0
    tank.suiri.bake_note = ''
    attach_maps(tank)
    load_frame(tank, 0)


# Before the frame is evaluated, so that rendering (also an animation rendered from the command line) gets the
# frame's water with all the usual passes.
@bpy.app.handlers.persistent
def on_frame_change(scene, depsgraph=None):
    if state['baking']:
        return
    for tank in build.tanks(scene):
        load_frame(tank, scene.frame_current)


@bpy.app.handlers.persistent
def on_load(dummy=None):
    state['loaded'].clear()
