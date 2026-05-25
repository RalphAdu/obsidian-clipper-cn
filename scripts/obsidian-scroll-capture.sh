#!/usr/bin/env bash
# Open a markdown file in Obsidian, scroll from top to bottom, screenshot at
# each Page Down step until the bottom is reached. Output:
# /tmp/obsidian-scroll-<ts>/
#
# Usage:
#   scripts/obsidian-scroll-capture.sh <vault-name> <relative-path> [max-pages]
#
# Bottom detection: the last `BOTTOM_RUN` (=3) consecutive frames are
# byte-identical, meaning Page Down stopped changing the viewport. Strict
# byte equality plus a 3-frame run avoids two common false positives:
#   1. a single transient frame that happens to byte-match (rare but real)
#   2. an empty viewport "plateau" mid-document where Page Down truly
#      advances but two adjacent frames are similar in size — strict
#      equality survives the size noise, but the run length of 3 catches
#      coincidences within the plateau.
# A `MIN_FRAMES` (=5) floor prevents bottom detection while the viewport is
# still painting after the initial Cmd+Home.
#
# Window targeting: when multiple vaults are open in Obsidian (each in its
# own window), `tell application "Obsidian" to activate` only guarantees
# the app is frontmost — it does not pick *which* window is focused. We
# have actually seen this fail in the wild: Page Down then goes to the
# wrong vault's window for the entire run and produces 44 byte-similar
# frames of an unrelated note. To prevent this, after activate we walk
# Obsidian's windows and `perform action AXRaise` on the first one whose
# title contains the markdown file basename (Obsidian titles are
# `<basename> - <vault> - Obsidian v1.x.x`). If no matching window appears
# within ~5s of polling we exit 6 — better to fail loudly than capture
# the wrong vault silently.
#
# Multi-display capture: even when the right window is raised, the
# default `screencapture -m` only captures the main display. If the
# target window sits on a secondary monitor the captured image shows
# whatever is on the main display instead (we hit this — captured the
# wrong vault for 34 frames). Solution: read the raised window's
# position+size via AppleScript and capture exactly that rect using
# `screencapture -R<x,y,w,h>`. `-R` uses *global* coordinates, so a
# window at x=1920 on a second display is captured correctly.
#
# View mode: Reading View is required for image-heavy markdown. base64
# images render as <img> inside Reading View (each occupies ~1 viewport),
# whereas in Editing/Live Preview they remain as raw base64 text strings
# that occupy thousands of source lines — Page Down then can't escape a
# given image block within `MAX_PAGES` and the loop hits a false-positive
# bottom on a plateau of identical "near-empty" frames. The script clicks
# the "阅读视图" menu item once after activating Obsidian, and clicks it
# again on exit to restore the original mode. This assumes the vault's
# default view is **Editing View** (the single toggle then flips to
# Reading View, and the restore toggle flips back). If the run is
# interrupted before the restore step, the next invocation starts with
# the vault in Reading View — the toggle then flips into Editing View and
# the first-frame size check catches it.
#
# max-pages defaults to 1000 (covers ~10MB image-heavy markdown in
# Reading View). Hitting the cap without touching bottom is treated as a
# failure (exit 1).

set -euo pipefail

VAULT="${1:?usage: $0 <vault-name> <relative-path> [max-pages]}"
FILE_PATH="${2:?usage: $0 <vault-name> <relative-path> [max-pages]}"
MAX_PAGES="${3:-1000}"
BOTTOM_RUN=3
MIN_FRAMES=5

VAULT_ROOT="$HOME/Documents/Obsidian /${VAULT}"
FULL_MD="${VAULT_ROOT}/${FILE_PATH}.md"
FILE_BASENAME=$(basename "$FILE_PATH")

if [ ! -f "$FULL_MD" ]; then
	echo "[ERROR] Markdown file not found: $FULL_MD" >&2
	exit 2
fi

echo "==> 1. Opening Obsidian to: $FULL_MD"
ENC_FILE=$(python3 -c "import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe='/'))" "$FILE_PATH")
ENC_VAULT=$(python3 -c "import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))" "$VAULT")
open "obsidian://open?vault=${ENC_VAULT}&file=${ENC_FILE}"

# 10MB+ image-heavy markdown needs more than the previous 2.5s to hydrate
# before we start scrolling — a too-early Cmd+Home + Page Down would scroll
# a half-rendered view and the per-frame deltas become meaningless.
echo "==> 2. Waiting for markdown to hydrate (5s)"
sleep 5

echo "==> 3. Bring Obsidian to front + raise window containing '$FILE_BASENAME'"
osascript -e 'tell application "Obsidian" to activate' >/dev/null 2>&1 || true
sleep 0.6

# Raise the window whose title contains the file basename. Poll for up to
# ~5s because `obsidian://open` may take a moment to spawn the window.
RAISE_SCRIPT='on run argv
	set targetName to item 1 of argv
	tell application "System Events"
		tell process "Obsidian"
			repeat with w in windows
				if name of w contains targetName then
					perform action "AXRaise" of w
					set p to position of w
					set s to size of w
					return "raised:" & (item 1 of p as text) & "," & (item 2 of p as text) & "," & (item 1 of s as text) & "," & (item 2 of s as text) & ":" & (name of w)
				end if
			end repeat
		end tell
	end tell
	return "no-match"
end run'
RAISED=0
WIN_RECT=""
for attempt in 1 2 3 4 5 6 7 8 9 10; do
	RESULT=$(osascript -e "$RAISE_SCRIPT" "$FILE_BASENAME" 2>/dev/null || true)
	if [[ "$RESULT" == raised:* ]]; then
		# Strip "raised:" prefix, split off window name after ':'
		PAYLOAD="${RESULT#raised:}"
		WIN_RECT="${PAYLOAD%%:*}"
		WIN_NAME="${PAYLOAD#*:}"
		echo "  [raise] Found window: $WIN_NAME"
		echo "  [raise] Window rect (x,y,w,h): $WIN_RECT"
		RAISED=1
		break
	fi
	sleep 0.5
done
if [ "$RAISED" -eq 0 ]; then
	echo "[FAIL] Could not find Obsidian window with title containing '$FILE_BASENAME' after ~5s" >&2
	echo "[FAIL] Other vaults are likely open and obsidian:// did not open the file. Check Obsidian windows." >&2
	exit 6
fi
# Parse "x,y,w,h" — refuse zero w/h (means window minimized / off-screen).
WIN_X="${WIN_RECT%%,*}"; REST="${WIN_RECT#*,}"
WIN_Y="${REST%%,*}"; REST="${REST#*,}"
WIN_W="${REST%%,*}"; WIN_H="${REST#*,}"
if [ "$WIN_W" -lt 100 ] || [ "$WIN_H" -lt 100 ]; then
	echo "[FAIL] Window rect too small ($WIN_W x $WIN_H) — window minimized or off-screen?" >&2
	exit 6
fi
sleep 0.4

echo "==> 4. Switch to Reading View"
# Toggle "Reading View" — see header comment for the assumption about vault default.
osascript -e 'tell application "System Events" to tell process "Obsidian" to click menu item "阅读视图" of menu "View" of menu bar 1' >/dev/null 2>&1 || \
	echo "[WARN] Could not click 阅读视图 menu — Obsidian menu locale may differ. Mode unchanged." >&2
sleep 2
# Cmd+Home — scroll to top of note
osascript -e 'tell application "System Events" to key code 115 using {command down}' 2>/dev/null || true
sleep 1

OUT_DIR="/tmp/obsidian-scroll-$(date +%s)"
mkdir -p "$OUT_DIR"

echo "==> 5. Capturing screens (Page Down between each, auto-stop at bottom, max=$MAX_PAGES, run=$BOTTOM_RUN, min=$MIN_FRAMES)"
echo "    capture rect: -R${WIN_X},${WIN_Y},${WIN_W},${WIN_H} (global coords, multi-display safe)"

# `RUN` counts consecutive identical-to-previous frames. When RUN reaches
# `BOTTOM_RUN - 1`, the current frame is part of a run of `BOTTOM_RUN`
# identical frames and we declare bottom.
RUN=0
PREV=""
HIT_BOTTOM=0
FINAL_I=0
FIRST_SIZE=0
i=1
while [ "$i" -le "$MAX_PAGES" ]; do
	IDX=$(printf "%03d" "$i")
	SHOT="$OUT_DIR/scroll-${IDX}.png"
	# -R uses global coordinates and works for windows on any display.
	screencapture -x -R"${WIN_X},${WIN_Y},${WIN_W},${WIN_H}" -o "$SHOT" 2>/dev/null
	if [ ! -s "$SHOT" ]; then
		echo "  ${IDX}. [FAIL] screencapture empty (needs Screen Recording permission?)" >&2
		rm -f "$SHOT"
		exit 3
	fi
	SIZE=$(stat -f %z "$SHOT")
	if [ "$i" -eq 1 ]; then
		FIRST_SIZE=$SIZE
	fi
	# Bottom detection: identical to previous? Bump RUN; otherwise reset.
	if [ -n "$PREV" ] && cmp -s "$PREV" "$SHOT"; then
		RUN=$((RUN + 1))
	else
		RUN=0
	fi
	if [ "$i" -ge "$MIN_FRAMES" ] && [ "$RUN" -ge "$((BOTTOM_RUN - 1))" ]; then
		echo "  ${IDX}. $SHOT ($SIZE bytes) [BOTTOM — run of ${BOTTOM_RUN} identical frames]"
		HIT_BOTTOM=1
		FINAL_I=$i
		break
	fi
	echo "  ${IDX}. $SHOT ($SIZE bytes)"
	osascript -e 'tell application "System Events" to key code 121' 2>/dev/null || true
	sleep 0.5
	PREV="$SHOT"
	FINAL_I=$i
	i=$((i + 1))
done

echo ""

# Sanity: a first frame under ~150KB is almost certainly a black/blank
# viewport (e.g. Obsidian was in source mode showing nothing, or the file
# failed to open). Flag it so the human can decide whether the run is
# trustworthy.
if [ "$FIRST_SIZE" -lt 150000 ]; then
	echo "[WARN] First frame is only ${FIRST_SIZE} bytes — likely the viewport was blank when capture started" >&2
	echo "[WARN] If the vault default view is Reading View, the menu toggle flipped it to Editing View." >&2
	echo "[WARN] Re-toggle manually (Cmd+E) and re-run, or change vault default view to Editing." >&2
fi

# Restore mode: toggle the "阅读视图" menu one more time. If we entered
# Reading View at the start (by toggling from Editing View), this brings
# us back to Editing View so the next invocation starts from the same
# known state.
osascript -e 'tell application "System Events" to tell process "Obsidian" to click menu item "阅读视图" of menu "View" of menu bar 1' >/dev/null 2>&1 || true

if [ "$HIT_BOTTOM" -eq 1 ]; then
	echo "==> Done. Touched bottom at frame $FINAL_I. Output: $OUT_DIR"
	ls "$OUT_DIR" | wc -l | awk '{ printf "==> Frames captured: %s\n", $1 }'
	exit 0
else
	echo "[FAIL] Hit MAX_PAGES=$MAX_PAGES without touching bottom" >&2
	echo "[FAIL] Last 3 frames retained for inspection:" >&2
	ls -la "$OUT_DIR" | tail -3 >&2
	echo "[FAIL] Re-run with a higher max-pages or inspect output dir: $OUT_DIR" >&2
	exit 1
fi
