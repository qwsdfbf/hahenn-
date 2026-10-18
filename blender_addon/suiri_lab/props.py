# 水理ラボ — properties stored on objects and on the scene
import bpy
from bpy.props import BoolProperty, EnumProperty, FloatProperty, IntProperty, PointerProperty, StringProperty

KINDS = [
    ('NONE', '—', ''),
    ('TANK', '水槽', ''),
    ('SOURCE', '水源', ''),
    ('OBSTACLE', '障害物', ''),
    ('BLOCK', '水の塊', ''),
    ('DRAIN', '排水口', ''),
    ('WATER', '水（計算結果）', ''),
    ('FOAM', '泡としぶき（計算結果）', ''),
]
MODES = [
    ('STREAM', '蛇口', '流量と勢いを決めて流し続ける'),
    ('DROPS', '水滴', '決まった大きさの粒を決まった間隔で落とす'),
    ('SHOWER', 'シャワー', '広がって出る'),
    ('BURST', 'まとめて', '一度に決まった量を出す'),
    ('RAIN', '雨', '四角い範囲に雨を降らせる'),
]
QUALITIES = [
    ('LOW', '低', '格子 12 mm。速いが粗い'),
    ('STANDARD', '標準', '格子 8.5 mm'),
    ('HIGH', '高', '格子 6.5 mm。細い水流や小さなしぶきまで。重い'),
]


def _refresh(self, context):
    from . import build
    build.refresh_item(self.id_data)


def _refresh_tank(self, context):
    from . import build
    build.refresh_tank(self.id_data)


class SuiriItem(bpy.types.PropertyGroup):
    kind: EnumProperty(name='種類', items=KINDS, default='NONE')
    # tank
    width: FloatProperty(name='幅 X', default=0.6, min=0.2, max=1.2, unit='LENGTH', update=_refresh_tank)
    depth: FloatProperty(name='奥行き Y', default=0.4, min=0.15, max=1.0, unit='LENGTH', update=_refresh_tank)
    height: FloatProperty(name='高さ Z', default=0.32, min=0.1, max=0.6, unit='LENGTH', update=_refresh_tank)
    quality: EnumProperty(name='計算の細かさ', items=QUALITIES, default='STANDARD')
    whitewater: BoolProperty(name='白い泡としぶき', default=True)
    cache_dir: StringProperty(name='計算結果の保存先', subtype='DIR_PATH', default='//suiri_cache')
    baked_frames: IntProperty(default=0)
    baked_start: IntProperty(default=1)
    sim_w: FloatProperty(default=0.6)
    sim_d: FloatProperty(default=0.4)
    sim_h: FloatProperty(default=0.32)
    bake_note: StringProperty(default='')
    # source
    enabled: BoolProperty(name='水を出す', default=True, update=_refresh)
    mode: EnumProperty(name='出し方', items=MODES, default='STREAM', update=_refresh)
    flow: FloatProperty(name='流量', description='L/分', default=3.0, min=0.05, max=40.0, soft_max=12.0, precision=2, update=_refresh)
    speed: FloatProperty(name='勢い', description='出口での速さ m/s（水滴は 0 で自然に落ちる）', default=0.6, min=0.0, max=12.0, soft_max=4.0, precision=2, update=_refresh)
    drop_d: FloatProperty(name='粒の直径', description='mm', default=6.0, min=1.0, max=40.0, soft_max=15.0, precision=1, update=_refresh)
    drop_interval: FloatProperty(name='間隔', description='秒', default=0.33, min=1 / 60, max=20.0, precision=2, update=_refresh)
    spread: FloatProperty(name='広がり', description='度', default=18.0, min=0.0, max=80.0, precision=0, update=_refresh)
    burst: FloatProperty(name='1回の量', description='L', default=0.5, min=0.01, max=50.0, soft_max=2.0, precision=2, update=_refresh)
    burst_every: FloatProperty(name='繰り返し', description='秒ごと（0 で 1 回だけ）', default=0.0, min=0.0, max=60.0, precision=1, update=_refresh)
    rain_rate: FloatProperty(name='雨の強さ', description='mm/時', default=60.0, min=1.0, max=500.0, soft_max=200.0, precision=0, update=_refresh)
    rain_size: FloatProperty(name='降る範囲', description='一辺', default=0.3, min=0.05, max=2.0, unit='LENGTH', update=_refresh)
    total: FloatProperty(name='総量', description='L（0 で無制限）', default=0.0, min=0.0, max=100.0, precision=2, update=_refresh)
    # drain
    radius: FloatProperty(name='半径', default=0.025, min=0.005, max=0.2, unit='LENGTH', update=_refresh)
    # what an output or an item belongs to
    tank: PointerProperty(type=bpy.types.Object)


class SuiriScene(bpy.types.PropertyGroup):
    progress: FloatProperty(default=-1.0)
    status: StringProperty(default='')


CLASSES = (SuiriItem, SuiriScene)


def register():
    for c in CLASSES:
        bpy.utils.register_class(c)
    bpy.types.Object.suiri = PointerProperty(type=SuiriItem)
    bpy.types.Scene.suiri = PointerProperty(type=SuiriScene)


def unregister():
    del bpy.types.Scene.suiri
    del bpy.types.Object.suiri
    for c in reversed(CLASSES):
        bpy.utils.unregister_class(c)
