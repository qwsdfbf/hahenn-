# 水理ラボ — the sidebar of the 3D view
import bpy
from . import bake, build, shapes
from .props import MODES
from .solver import QUALITY, nozzle_diameter


class _Panel:
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = '水理ラボ'


class SUIRI_PT_main(_Panel, bpy.types.Panel):
    bl_idname = 'SUIRI_PT_main'
    bl_label = '水理ラボ'

    def draw(self, context):
        lay = self.layout
        tank = build.active_tank(context)
        if tank is None:
            lay.operator('suiri.make_tank', icon='MESH_CUBE')
            lay.label(text='サンプル（水槽ごと置きます）')
            g = lay.grid_flow(columns=2, even_columns=True, align=True)
            for k, label in build.SAMPLES:
                g.operator('suiri.sample', text=label).key = k
            return
        s = tank.suiri
        col = lay.column(align=True)
        col.label(text='水槽「%s」' % tank.name, icon='MESH_CUBE')
        col.prop(s, 'width')
        col.prop(s, 'depth')
        col.prop(s, 'height')
        lay.label(text='計算の細かさ')
        lay.row().prop(s, 'quality', expand=True)
        lay.prop(s, 'whitewater')
        if len(build.tanks(context.scene)) > 1:
            lay.label(text='水槽が複数あります。選んだ物の水槽が対象です', icon='INFO')


class SUIRI_PT_add(_Panel, bpy.types.Panel):
    bl_idname = 'SUIRI_PT_add'
    bl_label = '追加'
    bl_parent_id = 'SUIRI_PT_main'

    @classmethod
    def poll(cls, context):
        return build.active_tank(context) is not None

    def draw(self, context):
        lay = self.layout
        lay.label(text='水源')
        g = lay.grid_flow(columns=3, even_columns=True, align=True)
        for k, label, _ in MODES:
            g.operator('suiri.add_source', text=label).mode = k
        lay.label(text='物（水がよける）')
        g = lay.grid_flow(columns=3, even_columns=True, align=True)
        for k, (label, _) in shapes.SHAPES.items():
            g.operator('suiri.add_shape', text=label).shape = k
        row = lay.row(align=True)
        row.operator('suiri.add_block', icon='MOD_FLUIDSIM')
        row.operator('suiri.add_drain', icon='RADIOBUT_OFF')
        lay.operator('suiri.mark', text='選んだメッシュを障害物にする', icon='MOD_PHYSICS').kind = 'OBSTACLE'
        lay.label(text='サンプル（別の水槽として置きます）')
        g = lay.grid_flow(columns=2, even_columns=True, align=True)
        for k, label in build.SAMPLES:
            g.operator('suiri.sample', text=label).key = k


class SUIRI_PT_item(_Panel, bpy.types.Panel):
    bl_idname = 'SUIRI_PT_item'
    bl_label = '選んでいる物'
    bl_parent_id = 'SUIRI_PT_main'

    @classmethod
    def poll(cls, context):
        ob = context.active_object
        return ob is not None and build.active_tank(context) is not None

    def draw(self, context):
        lay = self.layout
        ob = context.active_object
        s = ob.suiri
        tank = build.active_tank(context)
        h = QUALITY[tank.suiri.quality]['h']
        if s.kind == 'SOURCE':
            lay.label(text='水源「%s」' % ob.name, icon='MOD_FLUIDSIM')
            lay.prop(s, 'enabled')
            lay.row().prop(s, 'mode', expand=True)
            col = lay.column(align=True)
            if s.mode in ('STREAM', 'SHOWER'):
                col.prop(s, 'flow', text='流量（L/分）')
                col.prop(s, 'speed', text='勢い（m/s）')
                if s.mode == 'STREAM':
                    row = lay.row(align=True)
                    row.label(text='目安')
                    for k, label in (('LOW', 'ちょろちょろ'), ('MID', 'ふつう'), ('HIGH', '勢いよく')):
                        row.operator('suiri.preset', text=label).which = k
                    dn = nozzle_diameter(s.flow, s.speed)
                    lay.label(text='出口の太さ %.1f mm（流量と勢いで決まります）' % (dn * 1000))
                    if dn < h * 0.5:
                        lay.label(text='格子（%.1f mm）より細い水流は粒の列になります' % (h * 1000), icon='INFO')
                else:
                    col.prop(s, 'spread', text='広がり（度）')
            elif s.mode == 'DROPS':
                col.prop(s, 'drop_d', text='粒の直径（mm）')
                col.prop(s, 'drop_interval', text='間隔（秒）')
                col.prop(s, 'speed', text='勢い（m/s・0 で自然に落ちる）')
                lay.label(text='1 秒に %.1f 粒' % (1 / s.drop_interval))
            elif s.mode == 'BURST':
                col.prop(s, 'burst', text='1回の量（L）')
                col.prop(s, 'speed', text='勢い（m/s）')
                col.prop(s, 'burst_every', text='繰り返し（秒ごと・0 で 1 回だけ）')
            elif s.mode == 'RAIN':
                col.prop(s, 'rain_rate', text='雨の強さ（mm/時）')
                col.prop(s, 'rain_size', text='降る範囲（一辺）')
            if s.mode != 'BURST':
                lay.prop(s, 'total', text='総量（L・0 で無制限）')
            if s.mode != 'RAIN':
                lay.label(text='水は物の -Z の向きに出ます（回すと向きが変わります）')
                row = lay.row(align=True)
                for k, label in (('DOWN', '真下'), ('SIDE', '水平'), ('UP', '真上')):
                    row.operator('suiri.aim', text=label).to = k
        elif s.kind == 'OBSTACLE':
            lay.label(text='障害物「%s」' % ob.name, icon='MOD_PHYSICS')
            lay.label(text='形・位置・回転・動き（キーフレーム）がそのまま計算に入ります')
            lay.operator('suiri.apply_light', icon='LIGHT_SUN')
            lay.operator('suiri.mark', text='障害物から外す').kind = 'NONE'
        elif s.kind == 'BLOCK':
            lay.label(text='水の塊「%s」' % ob.name, icon='MOD_FLUIDSIM')
            lay.label(text='計算の始めに、この箱（外形の四角）の中に水が入ります')
            lay.operator('suiri.mark', text='水の塊から外す').kind = 'NONE'
        elif s.kind == 'DRAIN':
            lay.label(text='排水口「%s」' % ob.name, icon='RADIOBUT_OFF')
            lay.prop(s, 'radius')
        elif s.kind == 'TANK':
            lay.label(text='水槽を選んでいます。大きさは上の欄で変えられます')
        elif s.kind in ('WATER', 'FOAM'):
            lay.label(text='計算結果の表示用です（計算のたびに作り直します）')
        else:
            lay.label(text='「%s」は計算に入っていません' % ob.name)
            if ob.type == 'MESH':
                row = lay.row(align=True)
                row.operator('suiri.mark', text='障害物にする').kind = 'OBSTACLE'
                row.operator('suiri.mark', text='水の塊にする').kind = 'BLOCK'
                lay.operator('suiri.apply_light', icon='LIGHT_SUN')


class SUIRI_PT_bake(_Panel, bpy.types.Panel):
    bl_idname = 'SUIRI_PT_bake'
    bl_label = '計算'
    bl_parent_id = 'SUIRI_PT_main'

    @classmethod
    def poll(cls, context):
        return build.active_tank(context) is not None

    def draw(self, context):
        lay = self.layout
        sc = context.scene
        tank = build.active_tank(context)
        s = tank.suiri
        fps = sc.render.fps / sc.render.fps_base
        n = sc.frame_end - sc.frame_start + 1
        lay.label(text='フレーム %d〜%d（%.1f 秒）を計算します' % (sc.frame_start, sc.frame_end, n / fps))
        if sc.suiri.progress >= 0:
            lay.progress(factor=sc.suiri.progress, text=sc.suiri.status) if hasattr(lay, 'progress') else lay.label(text=sc.suiri.status)
            lay.label(text='Esc で止められます（そこまでの結果は残ります）')
        else:
            lay.operator('suiri.bake', icon='PLAY')
            if sc.suiri.status:
                lay.label(text=sc.suiri.status)
        if s.baked_frames:
            lay.label(text='計算済み: %s' % s.bake_note, icon='CHECKMARK')
            lay.operator('suiri.free', icon='TRASH')
        lay.prop(s, 'cache_dir')


CLASSES = (SUIRI_PT_main, SUIRI_PT_add, SUIRI_PT_item, SUIRI_PT_bake)
