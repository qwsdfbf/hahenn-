# 水理ラボ — water in a tank, computed with the solver of the web version (FLIP liquid, capillary ripples, drop
# splashes, whitewater) and shown in Blender with its surface, ripples and light on the floor.
bl_info = {
    'name': '水理ラボ',
    'author': 'hahenn-',
    'version': (1, 0, 0),
    'blender': (4, 0, 0),
    'location': '3D ビュー > サイドバー > 水理ラボ',
    'description': '水槽に物と水源を置き、量と勢いを決めて水を流す（波紋・水しぶき・水底の光まで計算）',
    'category': 'Physics',
}

if 'bpy' in locals():
    import importlib
    for _m in (props, solver, meshing, space, shapes, build, bake, ops, ui):
        importlib.reload(_m)
else:
    from . import props, solver, meshing, space, shapes, build, bake, ops, ui

import bpy


def register():
    props.register()
    for c in ops.CLASSES + ui.CLASSES:
        bpy.utils.register_class(c)
    bpy.app.handlers.frame_change_pre.append(bake.on_frame_change)
    bpy.app.handlers.load_post.append(bake.on_load)


def unregister():
    for h, f in ((bpy.app.handlers.frame_change_pre, bake.on_frame_change), (bpy.app.handlers.load_post, bake.on_load)):
        if f in h:
            h.remove(f)
    for c in reversed(ops.CLASSES + ui.CLASSES):
        bpy.utils.unregister_class(c)
    props.unregister()
