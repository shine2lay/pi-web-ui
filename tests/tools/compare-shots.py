#!/usr/bin/env python3
"""compare-shots: how much two sets of screenshots differ (desktop-look.mjs runs of two builds).

    python3 tests/tools/compare-shots.py <before dir> <after dir> [<diff dir>]

For each PNG in both folders: the share of pixels that differ, and the box around them. With a diff
folder, also writes an image per shot: the after shot, dimmed, with the changed pixels in red.
"""
import os
import sys

from PIL import Image, ImageChops

before, after = sys.argv[1], sys.argv[2]
diff_dir = sys.argv[3] if len(sys.argv) > 3 else None
if diff_dir:
    os.makedirs(diff_dir, exist_ok=True)

for name in sorted(os.listdir(before)):
    if not name.endswith(".png"):
        continue
    other = os.path.join(after, name)
    if not os.path.exists(other):
        print(f"{name}: missing in {after}")
        continue
    a = Image.open(os.path.join(before, name)).convert("RGB")
    b = Image.open(other).convert("RGB")
    if a.size != b.size:
        print(f"{name}: size {a.size} -> {b.size}")
        continue
    d = ImageChops.difference(a, b).convert("L").point(lambda v: 255 if v > 24 else 0)
    changed = sum(1 for v in d.getdata() if v)
    share = changed / (a.size[0] * a.size[1])
    print(f"{name}: {share * 100:.3f}% of pixels differ, box {d.getbbox()}")
    if diff_dir:
        dimmed = Image.blend(b, Image.new("RGB", b.size, (255, 255, 255)), 0.6)
        red = Image.new("RGB", b.size, (230, 0, 0))
        Image.composite(red, dimmed, d).save(os.path.join(diff_dir, name))
