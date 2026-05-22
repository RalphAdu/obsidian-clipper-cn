#!/usr/bin/env bash
# Open a markdown file in Obsidian, scroll from top to bottom Page Down N
# times, screenshot at each step. Output: /tmp/obsidian-scroll-<timestamp>/
#
# Usage:
#   scripts/obsidian-scroll-capture.sh <vault-name> <relative-path> [num-pages]
#
# Default num-pages = 25 (enough for ~1000-line markdown in standard window).

set -euo pipefail

VAULT="${1:?usage: $0 <vault-name> <relative-path> [num-pages]}"
FILE_PATH="${2:?usage: $0 <vault-name> <relative-path> [num-pages]}"
NUM_PAGES="${3:-25}"

VAULT_ROOT="$HOME/Documents/Obsidian /${VAULT}"
FULL_MD="${VAULT_ROOT}/${FILE_PATH}.md"

if [ ! -f "$FULL_MD" ]; then
	echo "[ERROR] Markdown file not found: $FULL_MD" >&2
	exit 2
fi

echo "==> 1. Opening Obsidian to: $FULL_MD"
ENC_FILE=$(python3 -c "import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe='/'))" "$FILE_PATH")
ENC_VAULT=$(python3 -c "import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))" "$VAULT")
open "obsidian://open?vault=${ENC_VAULT}&file=${ENC_FILE}"
sleep 2.5

echo "==> 2. Bring Obsidian to front + scroll to top"
osascript -e 'tell application "Obsidian" to activate' >/dev/null 2>&1 || true
sleep 0.8
# Cmd+Home — scroll to top of note
osascript -e 'tell application "System Events" to key code 115 using {command down}' 2>/dev/null || true
sleep 0.6

OUT_DIR="/tmp/obsidian-scroll-$(date +%s)"
mkdir -p "$OUT_DIR"

echo "==> 3. Capturing $NUM_PAGES screens (Page Down between each)"
for i in $(seq -f "%02g" 1 $NUM_PAGES); do
	SHOT="$OUT_DIR/scroll-${i}.png"
	screencapture -x -m -o "$SHOT" 2>/dev/null
	if [ -s "$SHOT" ]; then
		echo "  ${i}. $SHOT ($(stat -f %z "$SHOT") bytes)"
	else
		echo "  ${i}. [FAIL] screencapture empty (needs Screen Recording permission?)"
		rm -f "$SHOT"
	fi
	# Page Down — key code 121
	osascript -e 'tell application "System Events" to key code 121' 2>/dev/null || true
	sleep 0.5
done

echo ""
echo "==> Done. $NUM_PAGES screenshots in: $OUT_DIR"
echo "==> First/last sanity:"
ls -la "$OUT_DIR" | head -3
ls -la "$OUT_DIR" | tail -3
