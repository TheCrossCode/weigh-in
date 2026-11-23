"""Render the app icons as PNGs (no dependencies). Run: python tools/make_icons.py"""
import math, struct, zlib, pathlib

BG = (10, 10, 13)
FG = (200, 240, 60)
OUT = pathlib.Path(__file__).resolve().parent.parent / "icons"


def sdf(x, y):
    # Same shapes as icons/icon.svg, in 0..1 units: dial ring, needle, hub.
    cx = cy = 0.5
    d = math.hypot(x - cx, y - cy)
    ring = abs(d - 0.2793) - 0.0352
    ax, ay, bx, by = cx, cy, cx + 0.1406, cy - 0.1406
    t = max(0.0, min(1.0, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)))
    needle = math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay))) - 0.0303
    hub = d - 0.0508
    return min(ring, needle, hub)


def png(size, path):
    rows = bytearray()
    for j in range(size):
        rows.append(0)
        for i in range(size):
            s = sdf((i + 0.5) / size, (j + 0.5) / size) * size
            a = max(0.0, min(1.0, 0.5 - s))
            rows.extend(round(BG[k] + (FG[k] - BG[k]) * a) for k in range(3))

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    data = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
    data += chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b"")
    path.write_bytes(data)


OUT.mkdir(exist_ok=True)
for size, name in [(192, "icon-192.png"), (512, "icon-512.png"), (180, "apple-touch-icon.png")]:
    png(size, OUT / name)
    print("wrote", OUT / name)
