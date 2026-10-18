#!/usr/bin/env python3
"""生成扩展图标：红底圆角方块 + 两条白色字幕条（纯标准库，无需 Pillow）。"""
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "icons"


def rounded_rect_alpha(x, y, w, h, r, cx, cy):
    """点 (cx, cy) 是否落在圆角矩形内（返回 0..1 覆盖率，简单按内部/外部判定）。"""
    if cx < x or cx > x + w or cy < y or cy > y + h:
        return 0.0
    # 四个角的圆
    for ox, oy in ((x + r, y + r), (x + w - r, y + r), (x + r, y + h - r), (x + w - r, y + h - r)):
        if (cx < x + r or cx > x + w - r) and (cy < y + r or cy > y + h - r):
            if (cx - ox) ** 2 + (cy - oy) ** 2 > r * r:
                return 0.0
    return 1.0


def make(size):
    r = size * 0.22
    bar_r = size * 0.06
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            px, py = x + 0.5, y + 0.5  # 像素中心
            a = rounded_rect_alpha(0, 0, size - 1, size - 1, r, px, py)
            if a == 0:
                row += b"\x00\x00\x00\x00"
                continue
            r_, g_, b_ = 0xE5, 0x30, 0x30  # YouTube 红
            # 两条白色字幕条
            bw = size * 0.62
            bh = size * 0.10
            bx = (size - bw) / 2
            for by in (size * 0.40, size * 0.58):
                if rounded_rect_alpha(bx, by, bw, bh, bar_r, px, py):
                    r_, g_, b_ = 0xFF, 0xFF, 0xFF
            row += bytes((r_, g_, b_, 255))
        rows.append(bytes(row))
    raw = b"".join(b"\x00" + r for r in rows)
    return png(size, size, raw)


def png(w, h, raw):
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for s in (16, 48, 128):
        p = OUT / f"icon{s}.png"
        p.write_bytes(make(s))
        print("wrote", p)


if __name__ == "__main__":
    main()
