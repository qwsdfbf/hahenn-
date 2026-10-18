# 水理ラボ — the tank, the items and their materials in the Blender scene
import math
import bpy
from mathutils import Euler, Vector
from . import shapes
from .solver import nozzle_diameter

COLL = '水理ラボ'
ABSORB = (1.6, 0.42, 0.26)          # per metre, as in the web version
MATERIALS = {                        # roughness, metallic (the web version's materials)
    'ceramic': (0.18, 0.0), 'plastic': (0.42, 0.0), 'metal': (0.28, 1.0), 'stone': (0.85, 0.0),
}


def collection(context):
    c = bpy.data.collections.get(COLL)
    if c is None:
        c = bpy.data.collections.new(COLL)
    if c.name not in context.scene.collection.children:
        context.scene.collection.children.link(c)
    return c


def tanks(scene):
    return [o for o in scene.objects if o.suiri.kind == 'TANK']


def active_tank(context):
    ob = context.active_object
    if ob is not None:
        if ob.suiri.kind == 'TANK':
            return ob
        if ob.suiri.tank is not None and ob.suiri.tank.suiri.kind == 'TANK':
            return ob.suiri.tank
    t = tanks(context.scene)
    return t[0] if t else None


def items_of(tank, kind=None):
    return [o for o in bpy.data.objects if o.suiri.tank == tank and o.suiri.kind in (('SOURCE', 'OBSTACLE', 'BLOCK', 'DRAIN') if kind is None else (kind,))]


def part(tank, name):
    for o in tank.children:
        if o.get('suiri_part') == name:
            return o
    return None


def _hex(c):
    c = c.lstrip('#')
    srgb = [int(c[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in srgb) + (1.0,)


def _new_object(context, name, mesh, parent=None):
    ob = bpy.data.objects.new(name, mesh)
    collection(context).objects.link(ob)
    if parent is not None:
        ob.parent = parent
    return ob


# ------------------------------------------------------------------ materials
def _maps_node(nt, tank, location, kind):
    """The baked maps over the water footprint: kind 'surface' (R top height, G/B ripple slopes d/dX, d/dY) or
    'light' (R top height, G light on the floor relative to plain sunlight)."""
    tc = nt.nodes.new('ShaderNodeTexCoord'); tc.object = tank; tc.location = (location[0] - 600, location[1])
    mp = nt.nodes.new('ShaderNodeMapping'); mp.vector_type = 'POINT'; mp.location = (location[0] - 400, location[1])
    mp.name = 'suiri_mapping_' + kind
    mp.inputs['Scale'].default_value = (1 / tank.suiri.width, 1 / tank.suiri.depth, 1)
    mp.inputs['Location'].default_value = (0.5, 0.5, 0)
    im = nt.nodes.new('ShaderNodeTexImage'); im.location = location; im.name = 'suiri_' + kind
    im.interpolation = 'Linear'; im.extension = 'EXTEND'
    nt.links.new(tc.outputs['Object'], mp.inputs['Vector'])
    nt.links.new(mp.outputs['Vector'], im.inputs['Vector'])
    sep = nt.nodes.new('ShaderNodeSeparateXYZ'); sep.location = (location[0] - 400, location[1] - 250)
    nt.links.new(tc.outputs['Object'], sep.inputs[0])
    return im, sep


def _math(nt, op, a, b=None, loc=(0, 0), clamp=False):
    n = nt.nodes.new('ShaderNodeMath'); n.operation = op; n.location = loc; n.use_clamp = clamp
    for i, v in enumerate((a, b)):
        if v is None:
            continue
        if isinstance(v, (int, float)):
            n.inputs[i].default_value = v
        else:
            nt.links.new(v, n.inputs[i])
    return n.outputs[0]


def _smooth(nt, x, e0, e1, to0=0.0, to1=1.0, loc=(0, 0)):
    n = nt.nodes.new('ShaderNodeMapRange'); n.interpolation_type = 'SMOOTHSTEP'; n.location = loc
    n.inputs['From Min'].default_value = e0; n.inputs['From Max'].default_value = e1
    n.inputs['To Min'].default_value = to0; n.inputs['To Max'].default_value = to1
    nt.links.new(x, n.inputs['Value'])
    return n.outputs['Result']


def underwater_group(tank):
    """Sunlight under the water: the baked light pattern (caustics) and the colour the water takes out on the way
    (the web version's underwaterSun / underwaterAmb). Input: surface colour; output: the colour to shade with."""
    name = '水理ラボ 水中の光 ' + tank.name
    ng = bpy.data.node_groups.get(name)
    if ng is not None:
        return ng
    ng = bpy.data.node_groups.new(name, 'ShaderNodeTree')
    ng.interface.new_socket('色', in_out='INPUT', socket_type='NodeSocketColor')
    ng.interface.new_socket('色', in_out='OUTPUT', socket_type='NodeSocketColor')
    gi = ng.nodes.new('NodeGroupInput'); gi.location = (-1200, 300)
    go = ng.nodes.new('NodeGroupOutput'); go.location = (900, 0)
    im, sep = _maps_node(ng, tank, (-600, 0), 'light')
    sp = ng.nodes.new('ShaderNodeSeparateColor'); sp.location = (-300, 0)
    ng.links.new(im.outputs['Color'], sp.inputs[0])
    top = sp.outputs['Red']
    depth = _math(ng, 'SUBTRACT', top, sep.outputs['Z'], (-100, -200))
    under = _math(ng, 'MULTIPLY', _math(ng, 'GREATER_THAN', depth, 0.0005, (0, -300)), _math(ng, 'GREATER_THAN', top, -0.5, (0, -400)), (150, -350))
    cosr = ng.nodes.new('ShaderNodeValue'); cosr.name = 'suiri_refracted_cos'; cosr.outputs[0].default_value = 0.85; cosr.location = (-100, -500)
    path = _math(ng, 'DIVIDE', depth, cosr.outputs[0], (100, -500))
    comb = ng.nodes.new('ShaderNodeCombineXYZ'); comb.location = (300, -200)
    comb_a = ng.nodes.new('ShaderNodeCombineXYZ'); comb_a.location = (300, -450)
    for i, a in enumerate(ABSORB):
        e = _math(ng, 'EXPONENT', _math(ng, 'MULTIPLY', path, -a, (150, -100 - 60 * i)), None, (220, -100 - 60 * i))
        ng.links.new(e, comb.inputs[i])
        ea = _math(ng, 'EXPONENT', _math(ng, 'MULTIPLY', depth, -1.5 * a, (150, -400 - 60 * i)), None, (220, -400 - 60 * i))
        ng.links.new(ea, comb_a.inputs[i])
    sun = ng.nodes.new('ShaderNodeVectorMath'); sun.operation = 'SCALE'; sun.location = (450, -200)
    ng.links.new(comb.outputs[0], sun.inputs[0]); ng.links.new(sp.outputs['Green'], sun.inputs['Scale'])
    # the sun gives most of the light, the sky the rest
    mix1 = ng.nodes.new('ShaderNodeMix'); mix1.data_type = 'VECTOR'; mix1.location = (600, -300)
    mix1.inputs['Factor'].default_value = 0.75
    ng.links.new(comb_a.outputs[0], mix1.inputs[4]); ng.links.new(sun.outputs[0], mix1.inputs[5])
    sc = ng.nodes.new('ShaderNodeVectorMath'); sc.operation = 'MULTIPLY'; sc.location = (650, -100)
    ng.links.new(mix1.outputs[1], sc.inputs[0])
    sc.inputs[1].default_value = (1.0, 1.0, 1.0)
    fac = ng.nodes.new('ShaderNodeMix'); fac.data_type = 'VECTOR'; fac.location = (700, 100)
    ng.links.new(under, fac.inputs['Factor'])
    fac.inputs[4].default_value = (1.0, 1.0, 1.0)
    ng.links.new(sc.outputs[0], fac.inputs[5])
    out = ng.nodes.new('ShaderNodeMix'); out.data_type = 'RGBA'; out.blend_type = 'MULTIPLY'; out.location = (750, 300)
    out.inputs['Factor'].default_value = 1.0
    ng.links.new(gi.outputs[0], out.inputs[6]); ng.links.new(fac.outputs[1], out.inputs[7])
    ng.links.new(out.outputs[2], go.inputs[0])
    return ng


def surface_material(name, color, kind, tank):
    """An opaque material whose colour goes through the underwater light of the tank."""
    m = bpy.data.materials.get(name)
    if m is None:
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        nt = m.node_tree
        bsdf = nt.nodes['Principled BSDF']
        rough, metal = MATERIALS[kind]
        bsdf.inputs['Roughness'].default_value = rough
        bsdf.inputs['Metallic'].default_value = metal
        g = nt.nodes.new('ShaderNodeGroup'); g.node_tree = underwater_group(tank); g.location = (-300, 200)
        g.inputs[0].default_value = color
        nt.links.new(g.outputs[0], bsdf.inputs['Base Color'])
    return m


def water_material(tank):
    """Water: refraction with IOR 1.333 and the web version's absorption; on the free surface the normal is tilted
    by the baked ripple slopes."""
    name = '水理ラボ 水 ' + tank.name
    m = bpy.data.materials.get(name)
    if m is not None:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (1, 1, 1, 1)
    bsdf.inputs['Roughness'].default_value = 0.0
    bsdf.inputs['IOR'].default_value = 1.333
    bsdf.inputs['Transmission Weight'].default_value = 1.0
    im, sep = _maps_node(nt, tank, (-900, 300), 'surface')
    sp = nt.nodes.new('ShaderNodeSeparateColor'); sp.location = (-650, 300)
    nt.links.new(im.outputs['Color'], sp.inputs[0])
    top = sp.outputs['Red']
    geo = nt.nodes.new('ShaderNodeNewGeometry'); geo.location = (-900, -200)
    gs = nt.nodes.new('ShaderNodeSeparateXYZ'); gs.location = (-700, -250)
    nt.links.new(geo.outputs['Normal'], gs.inputs[0])
    gap = _math(nt, 'ABSOLUTE', _math(nt, 'SUBTRACT', sep.outputs['Z'], top, (-650, 0)), None, (-500, 0))
    near = _smooth(nt, gap, 0.006, 0.025, 1.0, 0.0, (-350, 0))
    up = _smooth(nt, gs.outputs['Z'], 0.2, 0.6, 0.0, 1.0, (-500, -250))
    wet = _math(nt, 'GREATER_THAN', top, -0.5, (-500, 150))
    k = _math(nt, 'MULTIPLY', _math(nt, 'MULTIPLY', near, up, (-200, -100)), wet, (-50, -50))
    tilt = nt.nodes.new('ShaderNodeCombineXYZ'); tilt.location = (100, 100)
    nt.links.new(_math(nt, 'MULTIPLY', _math(nt, 'MULTIPLY', sp.outputs['Green'], -1.0, (-200, 300)), k, (0, 250)), tilt.inputs[0])
    nt.links.new(_math(nt, 'MULTIPLY', _math(nt, 'MULTIPLY', sp.outputs['Blue'], -1.0, (-200, 200)), k, (0, 150)), tilt.inputs[1])
    add = nt.nodes.new('ShaderNodeVectorMath'); add.operation = 'ADD'; add.location = (250, 0)
    nt.links.new(geo.outputs['Normal'], add.inputs[0]); nt.links.new(tilt.outputs[0], add.inputs[1])
    nrm = nt.nodes.new('ShaderNodeVectorMath'); nrm.operation = 'NORMALIZE'; nrm.location = (400, 0)
    nt.links.new(add.outputs[0], nrm.inputs[0])
    nt.links.new(nrm.outputs[0], bsdf.inputs['Normal'])
    vol = nt.nodes.new('ShaderNodeVolumeAbsorption'); vol.location = (300, -300)
    a = max(ABSORB)
    vol.inputs['Color'].default_value = tuple(1 - x / a for x in ABSORB) + (1.0,)
    vol.inputs['Density'].default_value = a
    # Cycles takes the colour out along the path through the water; EEVEE gets the surface only (Blender 4.0's EEVEE
    # cannot compile a Principled BSDF together with a volume)
    out = nt.nodes['Material Output']
    out.target = 'CYCLES'
    nt.links.new(vol.outputs[0], out.inputs['Volume'])
    ev = nt.nodes.new('ShaderNodeOutputMaterial'); ev.target = 'EEVEE'; ev.location = (out.location.x, out.location.y - 250)
    nt.links.new(bsdf.outputs[0], ev.inputs['Surface'])
    _refracting(m)
    return m


def _refracting(m):
    """Let EEVEE show what lies behind a transmitting material (screen space in 4.0/4.1, ray traced from 4.2), and
    let sunlight through it (the light under water is drawn by the light pattern of the floor)."""
    if hasattr(m, 'shadow_method'):
        m.shadow_method = 'NONE'
    if hasattr(m, 'use_screen_refraction'):
        m.use_screen_refraction = True
    if hasattr(m, 'use_raytrace_refraction'):
        m.use_raytrace_refraction = True


def eevee_settings(scene):
    """EEVEE's scene options that refraction needs (Blender's own settings, left as they are for Cycles)."""
    ee = scene.eevee
    for attr in ('use_ssr', 'use_ssr_refraction', 'use_raytracing'):
        if hasattr(ee, attr):
            setattr(ee, attr, True)


def glass_material():
    m = bpy.data.materials.get('水理ラボ ガラス')
    if m is None:
        m = bpy.data.materials.new('水理ラボ ガラス')
        m.use_nodes = True
        b = m.node_tree.nodes['Principled BSDF']
        b.inputs['Roughness'].default_value = 0.0
        b.inputs['IOR'].default_value = 1.5
        b.inputs['Transmission Weight'].default_value = 1.0
        _refracting(m)
        # the walls are thin sheets, not solid blocks of glass (EEVEE from 4.2)
        if hasattr(m, 'thickness_mode'):
            m.thickness_mode = 'SLAB'
            out = m.node_tree.nodes['Material Output']
            if 'Thickness' in out.inputs:
                th = m.node_tree.nodes.new('ShaderNodeValue'); th.outputs[0].default_value = 0.005
                th.location = (out.location.x - 200, out.location.y - 200)
                m.node_tree.links.new(th.outputs[0], out.inputs['Thickness'])
    return m


def foam_material(part_name, alpha, bright):
    name = '水理ラボ ' + part_name
    m = bpy.data.materials.get(name)
    if m is None:
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        nt = m.node_tree
        b = nt.nodes['Principled BSDF']
        b.inputs['Base Color'].default_value = (bright, bright, bright, 1)
        b.inputs['Roughness'].default_value = 0.45
        b.inputs['Alpha'].default_value = alpha
        if hasattr(m, 'blend_method'):
            m.blend_method = 'HASHED'
    return m


def particles_group():
    """Geometry nodes: each vertex becomes a small sphere of the given radius with the given material."""
    ng = bpy.data.node_groups.get('水理ラボ 粒')
    if ng is not None:
        return ng
    ng = bpy.data.node_groups.new('水理ラボ 粒', 'GeometryNodeTree')
    ng.interface.new_socket('Geometry', in_out='INPUT', socket_type='NodeSocketGeometry')
    ng.interface.new_socket('半径', in_out='INPUT', socket_type='NodeSocketFloat')
    ng.interface.new_socket('素材', in_out='INPUT', socket_type='NodeSocketMaterial')
    ng.interface.new_socket('Geometry', in_out='OUTPUT', socket_type='NodeSocketGeometry')
    gi = ng.nodes.new('NodeGroupInput'); go = ng.nodes.new('NodeGroupOutput')
    pts = ng.nodes.new('GeometryNodeMeshToPoints')
    ico = ng.nodes.new('GeometryNodeMeshIcoSphere'); ico.inputs['Radius'].default_value = 1.0; ico.inputs['Subdivisions'].default_value = 1
    sm = ng.nodes.new('GeometryNodeSetMaterial')
    inst = ng.nodes.new('GeometryNodeInstanceOnPoints')
    ng.links.new(gi.outputs[0], pts.inputs['Mesh'])
    ng.links.new(ico.outputs['Mesh'], sm.inputs['Geometry'])
    ng.links.new(gi.outputs[2], sm.inputs['Material'])
    ng.links.new(pts.outputs['Points'], inst.inputs['Points'])
    ng.links.new(sm.outputs['Geometry'], inst.inputs['Instance'])
    ng.links.new(gi.outputs[1], inst.inputs['Scale'])
    ng.links.new(inst.outputs['Instances'], go.inputs[0])
    return ng


# ------------------------------------------------------------------ tank
FOAM_PARTS = (('spray', 'しぶき', 0.55, 0.95, 0.0011), ('foam', '泡', 0.7, 0.9, 0.0016), ('bubble', '水中の泡', 0.45, 0.8, 0.0010))


def make_tank(context, w=0.6, d=0.4, h=0.32, location=(0, 0, 0)):
    me = bpy.data.meshes.new('水槽')
    tank = _new_object(context, '水槽', me)
    tank.location = location
    tank.suiri.kind = 'TANK'
    tank.lock_rotation = (True, True, True)
    tank.lock_scale = (True, True, True)
    tank.suiri['width'] = w; tank.suiri['depth'] = d; tank.suiri['height'] = h
    me.materials.append(glass_material())
    me.materials.append(surface_material('水理ラボ 水槽の底 ' + tank.name, (0.78, 0.76, 0.72, 1), 'stone', tank))
    tank.visible_shadow = False
    eevee_settings(context.scene)
    wme = bpy.data.meshes.new('水')
    water = _new_object(context, '水', wme, tank)
    water['suiri_part'] = 'water'
    water.suiri.kind = 'WATER'; water.suiri.tank = tank
    wme.materials.append(water_material(tank))
    water.visible_shadow = False
    water.hide_select = True
    for key, label, alpha, bright, radius in FOAM_PARTS:
        fme = bpy.data.meshes.new(label)
        f = _new_object(context, label, fme, tank)
        f['suiri_part'] = key
        f.suiri.kind = 'FOAM'; f.suiri.tank = tank
        mod = f.modifiers.new('粒', 'NODES')
        mod.node_group = particles_group()
        ids = [s.identifier for s in mod.node_group.interface.items_tree if s.item_type == 'SOCKET' and s.in_out == 'INPUT']
        mod[ids[1]] = radius * 1.4
        mod[ids[2]] = foam_material(label, alpha, bright)
        f.hide_select = True
    refresh_tank(tank)
    return tank


def refresh_tank(tank):
    if tank.suiri.kind != 'TANK':
        return
    s = tank.suiri
    shapes.tank_mesh(tank.data, s.width, s.depth, s.height)


# ------------------------------------------------------------------ items
def _place(context, ob, tank, loc):
    ob.suiri.tank = tank
    ob.location = Vector(loc) + tank.matrix_world.translation
    for o in context.selected_objects:
        o.select_set(False)
    ob.select_set(True)
    context.view_layer.objects.active = ob


def add_source(context, tank, mode='STREAM', loc=None, name=None):
    me = bpy.data.meshes.new(name or '水源')
    ob = _new_object(context, name or dict(STREAM='蛇口', DROPS='水滴', SHOWER='シャワー', BURST='まとめて', RAIN='雨')[mode], me)
    ob.suiri.kind = 'SOURCE'
    ob.suiri['mode'] = ['STREAM', 'DROPS', 'SHOWER', 'BURST', 'RAIN'].index(mode)
    if mode == 'DROPS':
        ob.suiri['speed'] = 0.0
    me.materials.append(surface_material('水理ラボ 金属の口', (0.8, 0.8, 0.82, 1), 'metal', tank))
    s = tank.suiri
    _place(context, ob, tank, loc if loc is not None else (0, 0, min(s.height + 0.08, 0.5)))
    refresh_item(ob)
    return ob


def add_shape(context, tank, shape, loc=None, name=None, color='#c9c2b4', kind='ceramic', dims=None, rot=(0, 0, 0)):
    label, d0 = shapes.SHAPES[shape]
    d = dict(d0, **(dims or {}))
    me = bpy.data.meshes.new(name or label)
    shapes.shape_mesh(me, shape, d)
    ob = _new_object(context, name or label, me)
    ob.suiri.kind = 'OBSTACLE'
    me.materials.append(surface_material('水理ラボ ' + kind + ' ' + color + ' ' + tank.name, _hex(color), kind, tank))
    for p in me.polygons:
        p.use_smooth = shape not in ('BOX', 'PLATE', 'CONTAINER')
    ob.rotation_euler = Euler([math.radians(a) for a in rot])
    if loc is None:
        z = {'PLATE': d.get('t', 0.01) / 2, 'SPHERE': d.get('r', 0.03), 'TORUS': d.get('r', 0.01), 'GUTTER': d.get('r', 0.03) + d.get('t', 0.006)}.get(shape, d.get('h', 0.05) / 2)
        loc = (0, 0, z + 0.0005)
    _place(context, ob, tank, loc)
    return ob


def add_block(context, tank, loc=None, dims=(0.16, 0.16, 0.10), name='水の塊'):
    me = bpy.data.meshes.new(name)
    shapes.block_mesh(me, *dims)
    ob = _new_object(context, name, me)
    ob.suiri.kind = 'BLOCK'
    ob.display_type = 'WIRE'
    ob.hide_render = True
    _place(context, ob, tank, loc if loc is not None else (0, 0, dims[2] / 2 + 0.001))
    return ob


def add_drain(context, tank, loc=(0, 0, 0), r=0.025, name='排水口'):
    me = bpy.data.meshes.new(name)
    ob = _new_object(context, name, me)
    ob.suiri.kind = 'DRAIN'
    ob.suiri['radius'] = r
    me.materials.append(surface_material('水理ラボ 排水口', (0.02, 0.02, 0.02, 1), 'metal', tank))
    _place(context, ob, tank, (loc[0], loc[1], loc[2] + 0.0005))
    refresh_item(ob)
    return ob


def refresh_item(ob):
    s = ob.suiri
    if s.kind == 'SOURCE':
        if s.mode == 'DROPS':
            dn = s.drop_d / 1000
        elif s.mode == 'BURST':
            dn = 0.02
        else:
            dn = nozzle_diameter(s.flow, s.speed)
        shapes.nozzle_mesh(ob.data, s.mode, dn, s.rain_size)
        ob.display_type = 'WIRE' if s.mode == 'RAIN' else 'TEXTURED'
        ob.hide_render = s.mode == 'RAIN'
    elif s.kind == 'DRAIN':
        shapes.drain_mesh(ob.data, s.radius)


def source_dir(ob):
    """Where the water leaves a source: along its local -Z (world, Blender axes)."""
    v = ob.matrix_world.to_3x3() @ Vector((0, 0, -1))
    return v.normalized()


def aim(ob, direction):
    """Turn a source so that its water leaves along `direction` (Blender axes)."""
    q = Vector((0, 0, -1)).rotation_difference(Vector(direction).normalized())
    ob.rotation_mode = 'XYZ'
    ob.rotation_euler = q.to_euler()


# ------------------------------------------------------------------ samples (the web version's six)
def _w(p):
    """web (x, y up, z front) -> Blender (x, y away, z up)"""
    return (p[0], -p[2], p[1])


def _wrot(r):
    """web rotation [x, y, z] in degrees -> Blender Euler in degrees"""
    return (r[0], -r[2], r[1])


SAMPLES = [('FAUCET', '蛇口とコップ'), ('CASCADE', '樋を流れる水'), ('DAM', 'ダムの決壊'), ('DROPS', '水滴と波紋'), ('FOUNTAIN', '噴水'), ('RAIN', '雨')]


def build_sample(context, key, location=(0, 0, 0)):
    tank = make_tank(context, location=location)
    def src(mode, pos, **kw):
        ob = add_source(context, tank, mode, _w(pos), kw.pop('name', None))
        for k, v in kw.items():
            if k == 'pitch':
                aim(ob, (0, 0, 1) if v > 0 else (0, 0, -1))
            else:
                ob.suiri[k] = v
        refresh_item(ob)
        return ob
    def block(pos, w, h, d, name='張った水'):
        return add_block(context, tank, _w(pos), (w, d, h), name)
    if key == 'FAUCET':
        add_shape(context, tank, 'CUP', _w((0.06, 0.06, 0.02)), 'コップ', '#e9e4da', 'ceramic', dict(r=0.045, h=0.12, t=0.006))
        src('STREAM', (0.06, 0.42, 0.02), name='蛇口', flow=4.0, speed=0.7)
        block((0, 0.03, 0), 0.6, 0.05, 0.4)
        add_shape(context, tank, 'SPHERE', _w((-0.14, 0.03, -0.06)), '石', '#8a8f94', 'stone', dict(r=0.045))
    elif key == 'CASCADE':
        add_shape(context, tank, 'GUTTER', _w((0.08, 0.24, -0.06)), '樋 1', '#8a8f94', 'metal', dict(len=0.34, r=0.032, t=0.006), _wrot((0, 0, -14)))
        add_shape(context, tank, 'GUTTER', _w((-0.08, 0.15, 0.07)), '樋 2', '#8a8f94', 'metal', dict(len=0.34, r=0.032, t=0.006), _wrot((0, 0, 14)))
        add_shape(context, tank, 'CONTAINER', _w((0.16, 0.035, 0.1)), '受け皿', '#3f6fa3', 'plastic', dict(w=0.16, h=0.07, d=0.12, t=0.008))
        src('STREAM', (0.21, 0.36, -0.06), name='蛇口', flow=5.0, speed=0.8)
        add_drain(context, tank, _w((-0.24, 0, -0.14)), 0.03)
    elif key == 'DAM':
        block((-0.2, 0.11, 0), 0.18, 0.22, 0.38, 'せき止めた水')
        add_shape(context, tank, 'CYLINDER', _w((0.08, 0.06, 0.04)), '柱', '#c75b45', 'plastic', dict(r=0.035, h=0.12))
        add_shape(context, tank, 'BOX', _w((0.12, 0.025, -0.1)), '箱', '#c9c2b4', 'ceramic', dict(w=0.08, h=0.05, d=0.08), _wrot((0, 30, 0)))
    elif key == 'DROPS':
        block((0, 0.03, 0), 0.6, 0.06, 0.4)
        src('DROPS', (0, 0.34, 0), name='水滴', drop_d=6.0, drop_interval=0.5, speed=0.0)
    elif key == 'FOUNTAIN':
        block((0, 0.025, 0), 0.6, 0.05, 0.4)
        add_shape(context, tank, 'CYLINDER', _w((0, 0.03, 0)), '台座', '#c9c2b4', 'stone', dict(r=0.05, h=0.06))
        src('STREAM', (0, 0.07, 0), name='噴水', pitch=90, flow=2.5, speed=1.6)
    elif key == 'RAIN':
        block((0, 0.03, 0), 0.6, 0.06, 0.4)
        src('RAIN', (0, 0.34, 0), name='雨', rain_rate=120.0, rain_size=0.5)
        add_shape(context, tank, 'CONE', _w((0.12, 0.09, 0.05)), '山', '#8a8f94', 'stone', dict(r=0.05, h=0.1))
    context.view_layer.objects.active = tank
    return tank


def ensure_stage(context, tank):
    """A sun, a sky and a camera like the web version's, unless the scene already has them."""
    sc = context.scene
    if not any(o.type == 'LIGHT' and o.data.type == 'SUN' for o in sc.objects):
        ld = bpy.data.lights.new('太陽', 'SUN')
        ld.energy = 4.0
        ld.angle = math.radians(1.0)
        sun = bpy.data.objects.new('太陽', ld)
        collection(context).objects.link(sun)
        # the web version's sun: 52° up, from 140° round the vertical
        el, az = math.radians(52), math.radians(140)
        to_sun = Vector(_w((math.cos(el) * math.sin(az), math.sin(el), math.cos(el) * math.cos(az))))
        sun.rotation_euler = Vector((0, 0, 1)).rotation_difference(to_sun).to_euler()
    if sc.world is None:
        sc.world = bpy.data.worlds.new('水理ラボ 空')
    w = sc.world
    if not w.use_nodes:
        w.use_nodes = True
        bg = w.node_tree.nodes.get('Background')
        if bg is not None:
            bg.inputs['Color'].default_value = (0.55, 0.66, 0.84, 1)
            bg.inputs['Strength'].default_value = 0.8
    if sc.camera is None:
        cd = bpy.data.cameras.new('カメラ')
        cd.lens = 35
        cam = bpy.data.objects.new('カメラ', cd)
        collection(context).objects.link(cam)
        sc.camera = cam
        frame_all(context, tank, cam)
    if not any(o.get('suiri_part') == 'ground' for o in sc.objects):
        me = bpy.data.meshes.new('床')
        import bmesh
        bm = bmesh.new()
        bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=3.0)
        bm.to_mesh(me); bm.free()
        g = bpy.data.objects.new('床', me)
        g['suiri_part'] = 'ground'
        collection(context).objects.link(g)
        g.location = tank.matrix_world.translation - Vector((0, 0, 0.0081))
        m = bpy.data.materials.new('水理ラボ 床')
        m.use_nodes = True
        nt = m.node_tree
        ck = nt.nodes.new('ShaderNodeTexChecker'); ck.inputs['Scale'].default_value = 24.0
        ck.inputs['Color1'].default_value = (0.72, 0.71, 0.68, 1); ck.inputs['Color2'].default_value = (0.62, 0.61, 0.58, 1)
        nt.links.new(ck.outputs['Color'], nt.nodes['Principled BSDF'].inputs['Base Color'])
        nt.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.7
        me.materials.append(m)


def frame_all(context, tank, cam):
    """The web version's home view: 0.55 rad round, 0.42 rad up, far enough for the tank and what hangs above it."""
    t = tank.matrix_world.translation
    s = tank.suiri
    lo = Vector((-s.width / 2, -s.depth / 2, 0)); hi = Vector((s.width / 2, s.depth / 2, s.height))
    for ob in items_of(tank):
        for c in ob.bound_box:
            p = ob.matrix_world @ Vector(c) - t
            lo = Vector(map(min, lo, p)); hi = Vector(map(max, hi, p))
    centre = (lo + hi) / 2
    radius = (hi - lo).length / 2
    sc = context.scene
    aspect = sc.render.resolution_x / sc.render.resolution_y
    # the narrower of the two view angles (the sensor fits the longer side of the picture)
    wide = cam.data.angle / 2
    half = math.atan(math.tan(wide) / aspect) if aspect >= 1 else math.atan(math.tan(wide) * aspect)
    dist = radius / math.sin(half) * 1.02
    az, el = 0.55, 0.42
    d = Vector(_w((math.cos(el) * math.sin(az), math.sin(el), math.cos(el) * math.cos(az))))
    cam.location = t + centre + d * dist
    cam.rotation_euler = (-d).to_track_quat('-Z', 'Y').to_euler()


def apply_underwater_light(mat, tank):
    """Put the tank's underwater light (light pattern and absorption) into an ordinary material: every Principled
    BSDF's base colour goes through it. Returns how many shaders were changed."""
    if mat is None or not mat.use_nodes:
        return 0
    nt = mat.node_tree
    group = underwater_group(tank)
    n = 0
    for b in [x for x in nt.nodes if x.type == 'BSDF_PRINCIPLED']:
        sock = b.inputs['Base Color']
        if sock.is_linked and sock.links[0].from_node.type == 'GROUP' and sock.links[0].from_node.node_tree == group:
            continue
        g = nt.nodes.new('ShaderNodeGroup')
        g.node_tree = group
        g.location = (b.location.x - 220, b.location.y - 120)
        if sock.is_linked:
            nt.links.new(sock.links[0].from_socket, g.inputs[0])
        else:
            g.inputs[0].default_value = sock.default_value
        nt.links.new(g.outputs[0], sock)
        n += 1
    return n
