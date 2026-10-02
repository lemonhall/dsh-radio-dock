"""把 CDP 截下来的原图裁成 README 用的几张。

原图是 2561x1368（视口 1707x912 × devicePixelRatio 1.5）。右侧栏在 CSS 里从 x≈1140 开始，
换算到设备像素就是 x≈1710 —— 这个脚本就是按这个边界裁的。

    python docs/make-screenshots.py
"""
from PIL import Image
import os

SRC_FULL = r"E:\development\shot-list.png"   # 频道列表展开
SRC_ROAD = r"E:\development\shot-b.png"      # 车流经过
OUT_DIR = os.path.dirname(os.path.abspath(__file__))

# 右侧栏在设备像素里的范围（上边界避开标签栏）
PANEL_BOX = (1610, 56, 2561, 1368)


def save(image, name, width):
    ratio = width / image.width
    resized = image.resize((width, round(image.height * ratio)), Image.LANCZOS)
    path = os.path.join(OUT_DIR, name)
    resized.save(path, optimize=True)
    print(f"{name}  {resized.size[0]}x{resized.size[1]}  {os.path.getsize(path) // 1024} KB")


full = Image.open(SRC_FULL)
save(full, "screenshot-full.png", 1600)
save(full.crop(PANEL_BOX), "screenshot-radio.png", 760)
save(Image.open(SRC_ROAD).crop(PANEL_BOX), "screenshot-road.png", 760)
