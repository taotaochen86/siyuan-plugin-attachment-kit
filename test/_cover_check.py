# -*- coding: utf-8 -*-
"""按集市详情页 background-size:cover + center 的规则，模拟多种容器比例下的裁切"""
from PIL import Image, ImageDraw, ImageFont
import sys

src = "../preview.png"
im = Image.open(src).convert("RGB")
W, H = im.size
ratios = [1.40, 1.50, 1.70, 2.08, 2.60]
CW = 560                      # 每格容器宽
pad, top = 16, 34
tiles = []
for r in ratios:
    ch = int(round(CW / r))
    s = max(CW / W, ch / H)          # cover
    nw, nh = int(round(W * s)), int(round(H * s))
    big = im.resize((nw, nh), Image.LANCZOS)
    left = (nw - CW) // 2
    up = (nh - ch) // 2
    cut = big.crop((left, up, left + CW, up + ch))
    # 画安全框线（仅参考，不写进成品）
    tiles.append((r, ch, cut, left, up, nw, nh))

cols = 3
rows = (len(tiles) + cols - 1) // cols
cellh = max(t[1] for t in tiles) + top
sheet = Image.new("RGB", (cols * (CW + pad) + pad, rows * (cellh + pad) + pad), "#20242b")
d = ImageDraw.Draw(sheet)
try:
    f = ImageFont.truetype("C:/Windows/Fonts/msyh.ttc", 18)
except Exception:
    f = ImageFont.load_default()
for i, (r, ch, cut, left, up, nw, nh) in enumerate(tiles):
    cx = pad + (i % cols) * (CW + pad)
    cy = pad + (i // cols) * (cellh + pad) + top
    sheet.paste(cut, (cx, cy))
    d.text((cx, cy - 26), f"容器比例 {r}  容器 {CW}x{ch}  左右裁 {left}px 上下裁 {up}px", fill="#e8eef7", font=f)
    d.rectangle([cx, cy, cx + CW - 1, cy + ch - 1], outline="#4a5464")
sheet.save("_cover_matrix.png")
print("saved _cover_matrix.png", sheet.size)
