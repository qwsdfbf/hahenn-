# 水理ラボ — a minimal OpenEXR writer (uncompressed scanlines, 32-bit float R, G, B) for the baked maps.
# Values are kept exactly, negative ones included.
import struct
import numpy as np


def _attr(name, typ, data):
    return name.encode() + b'\0' + typ.encode() + b'\0' + struct.pack('<i', len(data)) + data


def write_rgb(path, r, g, b):
    """r, g, b: (H, W) arrays, row 0 at the top of the picture."""
    H, W = r.shape
    chans = b''.join(c.encode() + b'\0' + struct.pack('<iB3xii', 2, 0, 1, 1) for c in 'BGR') + b'\0'
    box = struct.pack('<iiii', 0, 0, W - 1, H - 1)
    header = b''.join([
        b'\x76\x2f\x31\x01', struct.pack('<i', 2),
        _attr('channels', 'chlist', chans),
        _attr('compression', 'compression', b'\0'),
        _attr('dataWindow', 'box2i', box),
        _attr('displayWindow', 'box2i', box),
        _attr('lineOrder', 'lineOrder', b'\0'),
        _attr('pixelAspectRatio', 'float', struct.pack('<f', 1.0)),
        _attr('screenWindowCenter', 'v2f', struct.pack('<ff', 0.0, 0.0)),
        _attr('screenWindowWidth', 'float', struct.pack('<f', 1.0)),
        b'\0',
    ])
    line = 8 + 3 * 4 * W
    start = len(header) + 8 * H
    offsets = np.arange(H, dtype='<u8') * line + start
    data = np.empty((H, 2 + 3 * W), '<f4')
    hdr = data.view('<i4')
    hdr[:, 0] = np.arange(H)
    hdr[:, 1] = 3 * 4 * W
    data[:, 2:2 + W] = b
    data[:, 2 + W:2 + 2 * W] = g
    data[:, 2 + 2 * W:] = r
    with open(path, 'wb') as f:
        f.write(header)
        f.write(offsets.tobytes())
        f.write(data.tobytes())
