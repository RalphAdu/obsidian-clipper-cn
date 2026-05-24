#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""
Build a side-by-side visual comparison grid: left column = browser ground-truth
screenshots, right column = Obsidian rendering screenshots. Used to manually
verify that Obsidian markdown rendering covers all content from the original page
(content coverage + ordering + visual fidelity for bold/quote/list/table).

Two columns of frames are aligned by index. When one side has more frames (it
usually does — browser viewport vs Obsidian viewport scale to different page
counts), the shorter side is padded with a gray "(no more)" placeholder.

Also emits a separate scaled `browser-fullpage.png` for end-to-end visual scan.

Usage:
  build-side-by-side-grid.py <browser-dir> <obsidian-dir> <out-prefix>

Outputs:
  <out-prefix>.png           — the side-by-side grid (or grid-01/02/... when paginated)
  <out-prefix>-fullpage.png  — copy of browser <browser-dir>/full-page.png (resized)
"""

import sys
import re
from pathlib import Path
from typing import Optional
from PIL import Image, ImageDraw, ImageFont
# image-heavy fullPage screenshots (e.g. scys article-A 10.6MB) exceed Pillow's
# default decompression-bomb safety check. We trust our own files; raise the limit.
Image.MAX_IMAGE_PIXELS = 500_000_000

if len(sys.argv) != 4:
    print("Usage: build-side-by-side-grid.py <browser-dir> <obsidian-dir> <out-prefix>", file=sys.stderr)
    sys.exit(2)

browser_dir = Path(sys.argv[1])
obsidian_dir = Path(sys.argv[2])
out_prefix = Path(sys.argv[3])

# Each cell: 560w × 315h (16:9 ratio at small size), 20px label band on top
CELL_W = 560
CELL_H = 315
LABEL_H = 24
GAP = 8
PAD = 20
MAX_ROWS_PER_GRID = 12   # tall pages → split into multiple grid images for easier review

def natural_key(p: Path):
    nums = re.findall(r'\d+', p.name)
    return tuple(int(n) for n in nums) if nums else (0,)

browser_frames = sorted([p for p in browser_dir.glob('scroll-*.png')], key=natural_key)
obsidian_frames = sorted([p for p in obsidian_dir.glob('scroll-*.png')], key=natural_key)

total_rows = max(len(browser_frames), len(obsidian_frames))
print(f"[grid] browser={len(browser_frames)} obsidian={len(obsidian_frames)} total_rows={total_rows}")

try:
    font = ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 14)
except (OSError, IOError):
    font = ImageFont.load_default()

def make_cell(img_path: Optional[Path], label: str) -> Image.Image:
    cell = Image.new('RGB', (CELL_W, LABEL_H + CELL_H), (240, 240, 240))
    draw = ImageDraw.Draw(cell)
    if img_path and img_path.exists():
        img = Image.open(img_path).convert('RGB')
        img.thumbnail((CELL_W, CELL_H), Image.LANCZOS)
        cell.paste(img, ((CELL_W - img.width) // 2, LABEL_H + (CELL_H - img.height) // 2))
    else:
        draw.rectangle([0, LABEL_H, CELL_W, LABEL_H + CELL_H], fill=(220, 220, 220))
        draw.text((CELL_W // 2 - 50, LABEL_H + CELL_H // 2 - 8), '(no more)', fill=(110, 110, 110), font=font)
    draw.rectangle([0, 0, CELL_W, LABEL_H], fill=(60, 60, 60))
    draw.text((6, 4), label, fill=(255, 255, 255), font=font)
    return cell

# Header row labels
header_h = 30
def make_header(text: str, w: int) -> Image.Image:
    img = Image.new('RGB', (w, header_h), (30, 80, 150))
    draw = ImageDraw.Draw(img)
    draw.text((10, 6), text, fill=(255, 255, 255), font=font)
    return img

# Paginate rows
num_grids = (total_rows + MAX_ROWS_PER_GRID - 1) // MAX_ROWS_PER_GRID

for grid_idx in range(num_grids):
    start = grid_idx * MAX_ROWS_PER_GRID
    end = min(start + MAX_ROWS_PER_GRID, total_rows)
    rows_this = end - start

    grid_w = PAD * 2 + CELL_W * 2 + GAP
    grid_h = PAD * 2 + header_h + (LABEL_H + CELL_H) * rows_this + GAP * (rows_this - 1) if rows_this > 0 else PAD * 2 + header_h
    grid = Image.new('RGB', (grid_w, grid_h), (255, 255, 255))

    grid.paste(make_header('🌐 Browser (ground truth)', CELL_W), (PAD, PAD))
    grid.paste(make_header('📝 Obsidian rendering', CELL_W), (PAD + CELL_W + GAP, PAD))

    for row in range(rows_this):
        i = start + row
        y = PAD + header_h + row * (LABEL_H + CELL_H + GAP)
        browser_img = browser_frames[i] if i < len(browser_frames) else None
        obsidian_img = obsidian_frames[i] if i < len(obsidian_frames) else None
        b_label = f'browser scroll-{i+1:03d}' if browser_img else f'browser scroll-{i+1:03d}  (none)'
        o_label = f'obsidian scroll-{i+1:03d}' if obsidian_img else f'obsidian scroll-{i+1:03d}  (none)'
        grid.paste(make_cell(browser_img, b_label), (PAD, y))
        grid.paste(make_cell(obsidian_img, o_label), (PAD + CELL_W + GAP, y))

    out_path = out_prefix.parent / (f"{out_prefix.name}-{grid_idx+1:02d}.png" if num_grids > 1 else f"{out_prefix.name}.png")
    grid.save(out_path, optimize=True)
    print(f"[grid] saved {out_path} ({out_path.stat().st_size} bytes) — rows {start+1}-{end}")

# Resized fullpage browser screenshot for end-to-end visual scan
fullpage = browser_dir / 'full-page.png'
if fullpage.exists():
    img = Image.open(fullpage).convert('RGB')
    target_w = 800
    if img.width > target_w:
        ratio = target_w / img.width
        img = img.resize((target_w, int(img.height * ratio)), Image.LANCZOS)
    out_full = out_prefix.parent / f'{out_prefix.name}-fullpage.png'
    img.save(out_full, optimize=True)
    print(f"[grid] saved {out_full} ({out_full.stat().st_size} bytes) — fullpage scaled to {target_w}w")
else:
    print(f"[grid] no full-page.png in {browser_dir} — skipping fullpage output", file=sys.stderr)
