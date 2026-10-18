# 水理ラボ — operators
import bpy
from bpy.props import EnumProperty, StringProperty
from . import bake, build, shapes
from .props import MODES


def _tank_or_report(op, context):
    t = build.active_tank(context)
    if t is None:
        op.report({'WARNING'}, '先に「水槽を作る」で水槽を置いてください')
    return t


class SUIRI_OT_make_tank(bpy.types.Operator):
    bl_idname = 'suiri.make_tank'
    bl_label = '水槽を作る'
    bl_description = '水が入る水槽を 3D カーソルの位置に置きます'
    bl_options = {'REGISTER', 'UNDO'}

    def execute(self, context):
        t = build.make_tank(context, location=context.scene.cursor.location.copy())
        context.view_layer.objects.active = t
        return {'FINISHED'}


class SUIRI_OT_sample(bpy.types.Operator):
    bl_idname = 'suiri.sample'
    bl_label = 'サンプルを置く'
    bl_description = '水槽と物と水源をひとそろい置きます（太陽・空・カメラ・床がなければそれも）'
    bl_options = {'REGISTER', 'UNDO'}
    key: EnumProperty(items=[(k, l, '') for k, l in build.SAMPLES])

    def execute(self, context):
        t = build.build_sample(context, self.key, context.scene.cursor.location.copy())
        build.ensure_stage(context, t)
        return {'FINISHED'}


class SUIRI_OT_add_source(bpy.types.Operator):
    bl_idname = 'suiri.add_source'
    bl_label = '水源を追加'
    bl_description = '水を出す口を水槽の上に置きます（向きは物の -Z。回すと出る向きが変わります）'
    bl_options = {'REGISTER', 'UNDO'}
    mode: EnumProperty(items=MODES)

    def execute(self, context):
        t = _tank_or_report(self, context)
        if t is None:
            return {'CANCELLED'}
        build.add_source(context, t, self.mode)
        return {'FINISHED'}


class SUIRI_OT_add_shape(bpy.types.Operator):
    bl_idname = 'suiri.add_shape'
    bl_label = '物を追加'
    bl_description = '水がよける物を水槽の床に置きます'
    bl_options = {'REGISTER', 'UNDO'}
    shape: EnumProperty(items=[(k, v[0], '') for k, v in shapes.SHAPES.items()])

    def execute(self, context):
        t = _tank_or_report(self, context)
        if t is None:
            return {'CANCELLED'}
        kind = 'metal' if self.shape == 'GUTTER' else 'stone' if self.shape in ('SPHERE', 'CONE') else 'ceramic'
        color = '#e9e4da' if self.shape == 'CUP' else '#8a8f94' if self.shape == 'GUTTER' else '#c9c2b4'
        build.add_shape(context, t, self.shape, color=color, kind=kind)
        return {'FINISHED'}


class SUIRI_OT_add_block(bpy.types.Operator):
    bl_idname = 'suiri.add_block'
    bl_label = '水の塊を追加'
    bl_description = '計算の始めにこの箱の形に水が入ります（大きさは S キーなどで変えられます）'
    bl_options = {'REGISTER', 'UNDO'}

    def execute(self, context):
        t = _tank_or_report(self, context)
        if t is None:
            return {'CANCELLED'}
        build.add_block(context, t)
        return {'FINISHED'}


class SUIRI_OT_add_drain(bpy.types.Operator):
    bl_idname = 'suiri.add_drain'
    bl_label = '排水口を追加'
    bl_description = '触れた水を吸い込んで消す口を床に置きます'
    bl_options = {'REGISTER', 'UNDO'}

    def execute(self, context):
        t = _tank_or_report(self, context)
        if t is None:
            return {'CANCELLED'}
        build.add_drain(context, t)
        return {'FINISHED'}


class SUIRI_OT_mark(bpy.types.Operator):
    bl_idname = 'suiri.mark'
    bl_label = '選んだ物を障害物にする'
    bl_description = '選んでいるメッシュを、水がよける物として計算に入れます'
    bl_options = {'REGISTER', 'UNDO'}
    kind: EnumProperty(items=[('OBSTACLE', '障害物', ''), ('BLOCK', '水の塊', ''), ('NONE', '外す', '')])

    def execute(self, context):
        t = _tank_or_report(self, context)
        if t is None:
            return {'CANCELLED'}
        n = 0
        for ob in context.selected_objects:
            if ob.type != 'MESH' or ob.suiri.kind in ('TANK', 'WATER', 'FOAM'):
                continue
            ob.suiri.kind = self.kind
            ob.suiri.tank = t if self.kind != 'NONE' else None
            n += 1
        if n == 0:
            self.report({'WARNING'}, 'メッシュの物を選んでください')
            return {'CANCELLED'}
        return {'FINISHED'}


class SUIRI_OT_aim(bpy.types.Operator):
    bl_idname = 'suiri.aim'
    bl_label = '向き'
    bl_description = '水が出る向きを変えます'
    bl_options = {'REGISTER', 'UNDO'}
    to: EnumProperty(items=[('DOWN', '真下', ''), ('SIDE', '水平', ''), ('UP', '真上', '')])

    def execute(self, context):
        ob = context.active_object
        if ob is None or ob.suiri.kind != 'SOURCE':
            return {'CANCELLED'}
        build.aim(ob, {'DOWN': (0, 0, -1), 'SIDE': (1, 0, 0), 'UP': (0, 0, 1)}[self.to])
        return {'FINISHED'}


class SUIRI_OT_preset(bpy.types.Operator):
    bl_idname = 'suiri.preset'
    bl_label = '目安'
    bl_description = '流量と勢いをまとめて決めます'
    bl_options = {'REGISTER', 'UNDO'}
    which: EnumProperty(items=[('LOW', 'ちょろちょろ', '0.6 L/分・0.35 m/s'), ('MID', 'ふつう', '4 L/分・0.7 m/s'), ('HIGH', '勢いよく', '12 L/分・1.6 m/s')])

    def execute(self, context):
        ob = context.active_object
        if ob is None or ob.suiri.kind != 'SOURCE':
            return {'CANCELLED'}
        f, v = {'LOW': (0.6, 0.35), 'MID': (4.0, 0.7), 'HIGH': (12.0, 1.6)}[self.which]
        ob.suiri.flow = f
        ob.suiri.speed = v
        return {'FINISHED'}


class SUIRI_OT_bake(bpy.types.Operator):
    bl_idname = 'suiri.bake'
    bl_label = '計算する'
    bl_description = 'シーンの開始から終了フレームまで水を計算して保存します（Esc で途中で止められます）'

    _timer = None

    @classmethod
    def poll(cls, context):
        return not bake.state['baking_job']

    def invoke(self, context, event):
        t = _tank_or_report(self, context)
        if t is None:
            return {'CANCELLED'}
        self.baker = bake.Baker(context, t)
        bake.state['baking_job'] = True
        wm = context.window_manager
        wm.progress_begin(0, self.baker.end - self.baker.start + 1)
        self._timer = wm.event_timer_add(0.01, window=context.window)
        wm.modal_handler_add(self)
        context.scene.suiri.progress = 0.0
        return {'RUNNING_MODAL'}

    def modal(self, context, event):
        if event.type == 'ESC':
            self._end(context, stopped=True)
            return {'CANCELLED'}
        if event.type != 'TIMER':
            return {'PASS_THROUGH'}
        b = self.baker
        f = b.next()
        n = b.end - b.start + 1
        context.window_manager.progress_update(f - b.start + 1)
        context.scene.suiri.progress = (f - b.start + 1) / n
        context.scene.suiri.status = 'フレーム %d / %d を計算しました' % (f, b.end)
        for area in context.screen.areas:
            area.tag_redraw()
        if b.done():
            self._end(context)
            return {'FINISHED'}
        return {'RUNNING_MODAL'}

    def _end(self, context, stopped=False):
        wm = context.window_manager
        wm.event_timer_remove(self._timer)
        wm.progress_end()
        bake.state['baking_job'] = False
        self.baker.finish()
        context.scene.suiri.progress = -1.0
        context.scene.suiri.status = 'フレーム %d までで止めました' % (self.baker.frame - 1) if stopped else ''
        context.scene.frame_set(self.baker.start)


class SUIRI_OT_apply_light(bpy.types.Operator):
    bl_idname = 'suiri.apply_light'
    bl_label = '水中の光を素材に入れる'
    bl_description = '選んでいる物の素材（Principled BSDF の色）に、水槽の集光模様と水の色の吸収を入れます'
    bl_options = {'REGISTER', 'UNDO'}

    def execute(self, context):
        t = _tank_or_report(self, context)
        if t is None:
            return {'CANCELLED'}
        n = 0
        for ob in context.selected_objects:
            for slot in getattr(ob, 'material_slots', []):
                n += build.apply_underwater_light(slot.material, t)
        if n == 0:
            self.report({'WARNING'}, 'Principled BSDF を使う素材が見つかりませんでした（すでに入っている物も除きます）')
            return {'CANCELLED'}
        self.report({'INFO'}, '%d 個のシェーダーに入れました' % n)
        return {'FINISHED'}


class SUIRI_OT_free(bpy.types.Operator):
    bl_idname = 'suiri.free'
    bl_label = '計算結果を消す'
    bl_description = 'この水槽の保存した計算結果を消します'
    bl_options = {'REGISTER', 'UNDO'}

    def execute(self, context):
        t = _tank_or_report(self, context)
        if t is None:
            return {'CANCELLED'}
        bake.free(t)
        return {'FINISHED'}


CLASSES = (SUIRI_OT_make_tank, SUIRI_OT_sample, SUIRI_OT_add_source, SUIRI_OT_add_shape, SUIRI_OT_add_block,
           SUIRI_OT_add_drain, SUIRI_OT_mark, SUIRI_OT_aim, SUIRI_OT_preset, SUIRI_OT_bake, SUIRI_OT_apply_light, SUIRI_OT_free)
