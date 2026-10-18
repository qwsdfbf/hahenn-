# 水理ラボ — between Blender's axes (Z up) and the solver's (y up, z towards the front, as in the web version).
# Tank-local Blender coordinates (X, Y, Z) are solver (x, y, z) = (X, Z, -Y); the tank object sits at the middle of
# its floor and is neither rotated nor scaled.
import numpy as np


def to_solver(P):
    P = np.asarray(P, float)
    return np.stack([P[..., 0], P[..., 2], -P[..., 1]], -1)


def from_solver(P):
    P = np.asarray(P, float)
    return np.stack([P[..., 0], -P[..., 2], P[..., 1]], -1)


def tank_local(tank, co):
    """World point -> tank-local Blender coordinates."""
    t = tank.matrix_world.translation
    return np.array([co[0] - t[0], co[1] - t[1], co[2] - t[2]])
