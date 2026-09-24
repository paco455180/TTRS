#!/usr/bin/env python3
"""產生 PWA 圖示：紅底、白色心形 + 心電圖線條 + 「CPR」字樣。"""
from PIL import Image, ImageDraw, ImageFont
import math, os

OUT = os.path.join(os.path.dirname(__file__), '..', 'icons')
os.makedirs(OUT, exist_ok=True)
RED = (198, 40, 40)
WHITE = (255, 255, 255)


def heart_points(cx, cy, r, n=200):
    pts = []
    for i in range(n):
        t = 2 * math.pi * i / n
        x = 16 * math.sin(t) ** 3
        y = 13 * math.cos(t) - 5 * math.cos(2 * t) - 2 * math.cos(3 * t) - math.cos(4 * t)
        pts.append((cx + x * r / 17, cy - y * r / 17))
    return pts


def draw_icon(size, maskable=False):
    img = Image.new('RGBA', (size, size), RED if maskable else (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = size * (0.18 if maskable else 0.06)
    if not maskable:
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=size * 0.22, fill=RED)
    cx, cy = size / 2, size * 0.40
    r = (size - 2 * pad) * 0.36
    d.polygon(heart_points(cx, cy, r), fill=WHITE)
    # 心電圖線
    w = size * 0.012
    y0 = cy + size * 0.02
    seg = [(-0.34, 0), (-0.16, 0), (-0.10, -0.12), (-0.04, 0.16), (0.02, -0.24), (0.08, 0.08), (0.14, 0), (0.34, 0)]
    pts = [(cx + x * size, y0 + y * size) for x, y in seg]
    d.line(pts, fill=RED, width=max(2, int(w * 2)), joint='curve')
    # 文字
    try:
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', int(size * 0.17))
    except Exception:
        font = ImageFont.load_default()
    text = 'CPR'
    bbox = d.textbbox((0, 0), text, font=font)
    tw = bbox[2] - bbox[0]
    d.text((cx - tw / 2, size * 0.70), text, font=font, fill=WHITE)
    return img


draw_icon(192).save(os.path.join(OUT, 'icon-192.png'))
draw_icon(512).save(os.path.join(OUT, 'icon-512.png'))
draw_icon(512, maskable=True).save(os.path.join(OUT, 'maskable-512.png'))
draw_icon(180, maskable=True).save(os.path.join(OUT, 'apple-touch-icon.png'))
print('icons written to', os.path.abspath(OUT))
