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

Two columns are aligned by **markdown-line anchor** (audit-via-subagents v3):
each frame's sibling .txt (visible textContent / OCR transcript) is fuzzy-matched
to a markdown line via longest-common-substring (threshold 8 chars) to obtain a
[start, end] line range. Grid row i maps to md line
  target = (i + 0.5) / total_rows × total_md_lines
and both sides pick the frame whose anchor brackets that line. base64-image-
heavy frames (no usable text) inherit the previous anchor naturally — this
replaces the old frame-index proportional alignment which drifted L↔R
systematically on image-dense articles.

Also emits a separate scaled `browser-fullpage.png` for end-to-end visual scan.

Usage:
  build-side-by-side-grid.py <browser-dir> <obsidian-dir> <out-prefix> <md-path>

Outputs:
  <out-prefix>.png           — the side-by-side grid (or grid-01/02/... when paginated)
  <out-prefix>-fullpage.png  — copy of browser <browser-dir>/full-page.png (resized)
"""

import sys
import re
from difflib import SequenceMatcher
from pathlib import Path
from typing import Optional
from PIL import Image, ImageDraw, ImageFont
# image-heavy fullPage screenshots (e.g. scys article-A 10.6MB) exceed Pillow's
# default decompression-bomb safety check. We trust our own files; raise the limit.
Image.MAX_IMAGE_PIXELS = 500_000_000


def build_markdown_lines(md_path):
    """Read md, strip frontmatter, return [(line_no, text), ...] for non-empty lines."""
    body = re.sub(r'^---\n.*?\n---\n', '', open(md_path).read(), flags=re.DOTALL)
    return [(i, line.strip()) for i, line in enumerate(body.split('\n'), 1) if line.strip()]

def longest_common_substring(s1: str, s2: str) -> int:
    """Length of longest common contiguous substring.

    Uses difflib.SequenceMatcher (C-implemented in CPython) for ~10-100x speedup
    over pure Python DP. Previously hit 22 min runtime on 1231 md_lines × 183
    frames during v3 Task 6 validation.
    """
    if not s1 or not s2:
        return 0
    return SequenceMatcher(None, s1, s2).find_longest_match(0, len(s1), 0, len(s2)).size

def has_strong_overlap(head: str, line: str, min_chars: int = 8) -> bool:
    """Fast substring prefilter — skip lines that can't possibly score ≥ min_chars
    in LCS. Checks if any 8-char window from head[:50] appears verbatim in line.
    """
    if len(head) < min_chars or len(line) < min_chars:
        return False
    scan_len = min(len(head), 50)
    for i in range(scan_len - min_chars + 1):
        if head[i:i+min_chars] in line:
            return True
    return False

def frame_anchor_from_text(text: str, md_lines, prev_anchor, avg_line_len: float):
    """Map a frame's visible text to a markdown line range [start, end].

    Returns prev_anchor (fallback) if text is empty / too short / fuzzy match weak.
    base64-image-heavy frames inherit prev anchor naturally (no usable text).

    Perf: single-pass max + reused SequenceMatcher + has_strong_overlap prefilter
    (avoid invoking C SequenceMatcher on lines without an 8-char common substring).
    """
    if not text or len(text.strip()) < 20:
        return prev_anchor
    head = text.strip()[:200]
    if not md_lines:
        return prev_anchor
    best_line = None
    best_score = 0
    sm = SequenceMatcher(None, head, '')
    head_len = len(head)
    for ln in md_lines:
        line_text = ln[1]
        if not has_strong_overlap(head, line_text, 8):
            continue
        sm.set_seq2(line_text)
        score = sm.find_longest_match(0, head_len, 0, len(line_text)).size
        if score > best_score:
            best_score = score
            best_line = ln
    if best_line is None or best_score < 8:
        return prev_anchor
    start = best_line[0]
    span = max(1, int(len(text) / max(1, avg_line_len)))
    return (start, start + span)

def frame_anchor(frame_txt_path, md_lines, prev_anchor, avg_line_len: float):
    """File wrapper around frame_anchor_from_text. Missing/unreadable file → fallback."""
    if not frame_txt_path.exists():
        return prev_anchor
    try:
        text = frame_txt_path.read_text(encoding='utf-8')
    except Exception:
        return prev_anchor
    return frame_anchor_from_text(text, md_lines, prev_anchor, avg_line_len)

def compute_anchors(frames, md_lines, avg_line_len: float):
    """For each frame path, compute its md anchor (inheriting prev for fallback)."""
    anchors = []
    prev = (1, 1)
    for f in frames:
        txt = f.with_suffix('.txt')
        anchor = frame_anchor(txt, md_lines, prev, avg_line_len)
        anchors.append(anchor)
        prev = anchor
    return anchors

def find_frame_at_line(anchors, target_line: int) -> int:
    """Find frame index whose [start, end] anchor brackets target_line.

    If no exact bracket, return the frame whose anchor.start is closest to target.
    """
    for i, (s, e) in enumerate(anchors):
        if s <= target_line <= e:
            return i
    return min(range(len(anchors)), key=lambda i: abs(anchors[i][0] - target_line))


if '--self-test' in sys.argv:
    md_lines_fx = [
        (1, '做个自我介绍'),
        (2, '大家好我是天堂地狱'),
        (3, '加入生财 8 年'),
        (4, '前言'),
        (5, '这个月借用了一次微咨询的机会咨询了下亦仁'),
    ]
    avg = sum(len(l[1]) for l in md_lines_fx) / len(md_lines_fx)
    # case 1: frame head 含 md line 2 → anchor 落 (2, 2+span)
    # 文本须 ≥ 20 char 才过 short-text 闸口 (frame_anchor_from_text 的 noise guard)
    a = frame_anchor_from_text('大家好我是天堂地狱，生财编号 677，今天给大家分享一下', md_lines_fx, (1, 1), avg)
    assert a[0] == 2, f'case1 expected anchor start=2, got {a}'
    # case 2: 空 / 短文本 → inherit prev
    assert frame_anchor_from_text('', md_lines_fx, (3, 5), avg) == (3, 5), 'case2 empty failed'
    assert frame_anchor_from_text('xx', md_lines_fx, (3, 5), avg) == (3, 5), 'case2 short failed'
    # case 3: 弱 match (< 8 字符共同) → inherit
    assert frame_anchor_from_text('abcdefg short text here', md_lines_fx, (3, 5), avg) == (3, 5), 'case3 weak match failed'
    # case 4: span 估算合理性 — 长 text 应给出 span > 1
    # 用 md_line 5 的文本作 head（必命中），后接长尾使 len(text) 远超 avg_line_len → span 必 > 1
    long_text = '这个月借用了一次微咨询的机会咨询了下亦仁' + '后续内容补充延伸说明各种各样的话题' * 10
    span_anchor = frame_anchor_from_text(long_text, md_lines_fx, (1, 1), avg)
    assert span_anchor[1] > span_anchor[0], f'case4 span empty: {span_anchor}'
    # case 5: find_frame_at_line 找正确 frame
    anchors_fx = [(1, 2), (3, 5), (6, 8)]
    assert find_frame_at_line(anchors_fx, 4) == 1, 'case5 mid-anchor failed'
    assert find_frame_at_line(anchors_fx, 7) == 2, 'case5 last anchor failed'
    # case 6: target 超出最后 anchor → 取最近
    assert find_frame_at_line(anchors_fx, 100) in (0, 1, 2), 'case6 fallback failed'
    # case 7: longest_common_substring 基础正确性
    assert longest_common_substring('abcde', 'xbcdy') == 3, 'case7 LCS failed'
    assert longest_common_substring('我是天堂地狱', '我是天堂地狱生财编号') == 6, 'case7 中文 LCS failed'
    print('self-test PASS (7 cases)')
    sys.exit(0)

if len(sys.argv) != 5:
    print("Usage: build-side-by-side-grid.py <browser-dir> <obsidian-dir> <out-prefix> <md-path>", file=sys.stderr)
    sys.exit(2)

browser_dir = Path(sys.argv[1])
obsidian_dir = Path(sys.argv[2])
out_prefix = Path(sys.argv[3])
md_path = Path(sys.argv[4])

# Build md line index + cumulative anchor data
md_lines = build_markdown_lines(md_path)
avg_line_len = sum(len(l[1]) for l in md_lines) / max(1, len(md_lines))
print(f"[grid] md lines: {len(md_lines)} (avg {avg_line_len:.1f} chars/line)")

# Each cell: 1120w × 630h (16:9 ratio at 2x size), 24px label band on top.
# Bigger cells → text in screenshots stays readable when Claude vision rescales
# the whole grid to its 1568×1568 token budget. At 560×315 (the previous size)
# single-character heights collapsed to ~5px which made bold/italic/alt
# verification impossible — see audit-via-subagents v1 retrospective.
CELL_W = 1120
CELL_H = 630
LABEL_H = 24
GAP = 8
PAD = 20
MAX_ROWS_PER_GRID = 6   # halved from 12 to keep grid total height ~unchanged after the 2x cell bump

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

# Compute md-line anchors per frame (sibling .txt fuzzy match) — once for all grid pages.
browser_anchors = compute_anchors(browser_frames, md_lines, avg_line_len)
obsidian_anchors = compute_anchors(obsidian_frames, md_lines, avg_line_len)
total_md_lines = len(md_lines)
b_anchored = sum(1 for a in browser_anchors if a != (1, 1))
o_anchored = sum(1 for a in obsidian_anchors if a != (1, 1))
print(f"[grid] anchored frames: browser={b_anchored}/{len(browser_anchors)}, obsidian={o_anchored}/{len(obsidian_anchors)}")

for grid_idx in range(num_grids):
    start = grid_idx * MAX_ROWS_PER_GRID
    end = min(start + MAX_ROWS_PER_GRID, total_rows)
    rows_this = end - start

    grid_w = PAD * 2 + CELL_W * 2 + GAP
    grid_h = PAD * 2 + header_h + (LABEL_H + CELL_H) * rows_this + GAP * (rows_this - 1) if rows_this > 0 else PAD * 2 + header_h
    grid = Image.new('RGB', (grid_w, grid_h), (255, 255, 255))

    grid.paste(make_header('🌐 Browser (ground truth)', CELL_W), (PAD, PAD))
    grid.paste(make_header('📝 Obsidian rendering', CELL_W), (PAD + CELL_W + GAP, PAD))

    # Markdown-line-anchored alignment: each row i maps to a target md line
    # (i+0.5)/total_rows * total_md_lines; both sides pick the frame whose
    # anchor [start,end] brackets that line. base64-image-heavy frames (no
    # usable text) inherit prev anchor naturally — no more L↔R systematic
    # drift on image-dense articles.
    n_browser = len(browser_frames)
    n_obsidian = len(obsidian_frames)
    for row in range(rows_this):
        i = start + row
        y = PAD + header_h + row * (LABEL_H + CELL_H + GAP)
        if total_rows == 0 or total_md_lines == 0:
            b_idx = o_idx = 0
        else:
            target_line = int((i + 0.5) / total_rows * total_md_lines)
            b_idx = find_frame_at_line(browser_anchors, target_line) if browser_anchors else 0
            o_idx = find_frame_at_line(obsidian_anchors, target_line) if obsidian_anchors else 0
        browser_img = browser_frames[b_idx] if b_idx < n_browser else None
        obsidian_img = obsidian_frames[o_idx] if o_idx < n_obsidian else None
        b_label = f'browser scroll-{b_idx+1:03d}' if browser_img else f'browser  (none)'
        o_label = f'obsidian scroll-{o_idx+1:03d}' if obsidian_img else f'obsidian  (none)'
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
