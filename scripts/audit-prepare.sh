#!/usr/bin/env bash
# scripts/audit-prepare.sh
#
# Prepare visual-audit artifacts for a single URL: browser screenshots +
# Obsidian screenshots + side-by-side grids. Idempotent — re-run skips
# steps whose outputs already exist.
#
# Usage:
#   scripts/audit-prepare.sh <vault> <md-rel-path> <url> --run-id <id> [--profile <pw-profile-dir>] [--scroll-selector <css>]
#
# Output structure (under /tmp/audit-<id>/<url-slug>/):
#   browser/scroll-NNN.png     (from browser-scroll-capture)
#   browser/full-page.png
#   obsidian/scroll-NN.png     (from obsidian-scroll-capture)
#   grids/sbs-NN.png           (from build-side-by-side-grid)
#   grids/sbs-fullpage.png
#
# Stdout (machine-parsable, last line):
#   AUDIT_PREPARE_OK url-slug=<slug> n_grids=<N> md_lines=<L> grid_dir=/tmp/audit-<id>/<slug>/grids
#
# Exit codes:
#   0  success (or all steps idempotent-skipped)
#   2  invalid arguments / Obsidian md not found / scripts missing
#   3  browser capture failed
#   4  obsidian capture failed
#   5  grid build failed

set -euo pipefail

usage() {
	echo "Usage: $0 <vault> <md-rel-path> <url> --run-id <id> [--profile <dir>] [--scroll-selector <css>]" >&2
	exit 2
}

[ $# -ge 4 ] || usage

VAULT="${1}"
MD_REL="${2}"
URL="${3}"
shift 3

RUN_ID=""
PROFILE=""
SCROLL_SEL=""
while [ $# -gt 0 ]; do
	case "$1" in
		--run-id) RUN_ID="$2"; shift 2 ;;
		--profile) PROFILE="$2"; shift 2 ;;
		--scroll-selector) SCROLL_SEL="$2"; shift 2 ;;
		*) echo "[FATAL] unknown flag: $1" >&2; usage ;;
	esac
done
[ -n "$RUN_ID" ] || usage

# url-slug: lowercase + non-alnum -> '-' + trim
URL_SLUG=$(echo "$URL" | tr '[:upper:]' '[:lower:]' | sed 's|^https\{0,1\}://||' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//')

ROOT="/tmp/audit-${RUN_ID}/${URL_SLUG}"
BROWSER_DIR="${ROOT}/browser"
OBSIDIAN_DIR="${ROOT}/obsidian"
GRIDS_DIR="${ROOT}/grids"
mkdir -p "$BROWSER_DIR" "$OBSIDIAN_DIR" "$GRIDS_DIR"

# Verify Obsidian md exists（spec §10 deviation：不自动 e2e-clip，要求用户先裁剪）
VAULT_ROOT="$HOME/Documents/Obsidian /${VAULT}"
MD_FULL="${VAULT_ROOT}/${MD_REL}.md"
[ -f "$MD_FULL" ] || { echo "[FATAL] Obsidian md not found: $MD_FULL — run e2e-clip-runner first to clip the URL" >&2; exit 2; }

MD_LINES=$(wc -l < "$MD_FULL" | tr -d ' ')

# Step 1: browser capture（idempotent）
if ls "$BROWSER_DIR"/scroll-*.png >/dev/null 2>&1; then
	echo "[skip] browser/ already populated ($(ls "$BROWSER_DIR"/scroll-*.png | wc -l | tr -d ' ') frames)"
else
	echo "==> browser-scroll-capture $URL → $BROWSER_DIR"
	PROFILE_ARG=()
	[ -n "$PROFILE" ] && PROFILE_ARG=(--profile "$PROFILE")
	SCROLL_ARG=()
	[ -n "$SCROLL_SEL" ] && SCROLL_ARG=(--scroll-selector "$SCROLL_SEL")
	# browser-scroll-capture 自己生成 /tmp/browser-scroll-<ts>/，我们之后 cp 过来
	npx tsx scripts/browser-scroll-capture.ts "$URL" ${PROFILE_ARG[@]+"${PROFILE_ARG[@]}"} ${SCROLL_ARG[@]+"${SCROLL_ARG[@]}"} 2>&1 | tee "/tmp/audit-${RUN_ID}-browser.log"
	# 找最新的 /tmp/browser-scroll-* 目录
	LATEST=$(ls -td /tmp/browser-scroll-* 2>/dev/null | head -1)
	[ -d "$LATEST" ] || { echo "[FATAL] browser-scroll-capture didn't produce output dir" >&2; exit 3; }
	cp "$LATEST"/*.png "$BROWSER_DIR/" 2>/dev/null || { echo "[FATAL] browser-scroll-capture produced no PNGs in $LATEST" >&2; exit 3; }
fi

# Step 2: obsidian capture（idempotent）
if ls "$OBSIDIAN_DIR"/scroll-*.png >/dev/null 2>&1; then
	echo "[skip] obsidian/ already populated ($(ls "$OBSIDIAN_DIR"/scroll-*.png | wc -l | tr -d ' ') frames)"
else
	echo "==> obsidian-scroll-capture $VAULT $MD_REL → $OBSIDIAN_DIR"
	# obsidian-scroll-capture 默认输出 /tmp/obsidian-scroll-<ts>/
	# N_PAGES heuristic：md 每 40 行截一张
	N_PAGES=$(( (MD_LINES + 39) / 40 ))
	[ $N_PAGES -lt 5 ] && N_PAGES=5
	[ $N_PAGES -gt 60 ] && N_PAGES=60
	scripts/obsidian-scroll-capture.sh "$VAULT" "$MD_REL" "$N_PAGES" 2>&1 | tee "/tmp/audit-${RUN_ID}-obsidian.log"
	LATEST=$(ls -td /tmp/obsidian-scroll-* 2>/dev/null | head -1)
	[ -d "$LATEST" ] || { echo "[FATAL] obsidian-scroll-capture didn't produce output dir" >&2; exit 4; }
	cp "$LATEST"/*.png "$OBSIDIAN_DIR/" 2>/dev/null || { echo "[FATAL] obsidian-scroll-capture produced no PNGs" >&2; exit 4; }
fi

# Step 3: sbs grid build（idempotent）
if ls "$GRIDS_DIR"/sbs-*.png >/dev/null 2>&1; then
	echo "[skip] grids/ already populated ($(ls "$GRIDS_DIR"/sbs-*.png 2>/dev/null | grep -v fullpage | wc -l | tr -d ' ') grids)"
else
	echo "==> build-side-by-side-grid $BROWSER_DIR $OBSIDIAN_DIR $GRIDS_DIR/sbs"
	scripts/build-side-by-side-grid.py "$BROWSER_DIR" "$OBSIDIAN_DIR" "$GRIDS_DIR/sbs" 2>&1 || { echo "[FATAL] grid build failed" >&2; exit 5; }
fi

N_GRIDS=$(ls "$GRIDS_DIR"/sbs-*.png 2>/dev/null | grep -v fullpage | wc -l | tr -d ' ')
echo ""
echo "AUDIT_PREPARE_OK url-slug=${URL_SLUG} n_grids=${N_GRIDS} md_lines=${MD_LINES} grid_dir=${GRIDS_DIR}"
