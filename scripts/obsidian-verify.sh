#!/usr/bin/env bash
# Open a markdown file in Obsidian via URL scheme and verify it loaded.
# Then compare its rendered text against fixture/source ground truth.
#
# Usage:
#   scripts/obsidian-verify.sh <vault-name> <relative-path-in-vault> [fixture-json]
#
# Examples:
#   scripts/obsidian-verify.sh Life _cn-test/scys-docx-fullnote-test
#   scripts/obsidian-verify.sh Life _cn-test/scys-docx-fullnote-test src/utils/fixtures/scys-docx-QSn2dD.json
#
# Behaviour:
#   1. open obsidian://open?vault=...&file=... (uses macOS `open` — opens
#      Obsidian.app via system URL handler, no Chrome dependency)
#   2. Wait briefly + verify Obsidian.app is running
#   3. AppleScript: confirm Obsidian's front window title matches the file
#   4. Try `screencapture` of Obsidian's front window (requires Screen
#      Recording permission for terminal; falls back to silently skipping)
#   5. If fixture provided: diff text content via Python (already in repo)
#
# Test-only tooling: never bundled into the extension. Lives in scripts/.

set -euo pipefail

VAULT="${1:?usage: $0 <vault-name> <relative-path> [fixture]}"
FILE_PATH="${2:?usage: $0 <vault-name> <relative-path> [fixture]}"
FIXTURE="${3:-}"

# Resolve full path for sanity check.
VAULT_ROOT_GUESS="$HOME/Documents/Obsidian /${VAULT}"
FULL_MD="${VAULT_ROOT_GUESS}/${FILE_PATH}.md"

if [ ! -f "$FULL_MD" ]; then
	echo "[ERROR] Markdown file not found: $FULL_MD" >&2
	echo "        Check vault name ('$VAULT') and relative path ('$FILE_PATH')." >&2
	exit 2
fi

echo "==> 1. Opening Obsidian to: $FULL_MD"
# URL-encode path components individually (preserve / and leading underscore)
ENC_FILE=$(python3 -c "import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe='/'))" "$FILE_PATH")
ENC_VAULT=$(python3 -c "import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))" "$VAULT")
open "obsidian://open?vault=${ENC_VAULT}&file=${ENC_FILE}"

sleep 2.5

echo "==> 2. Verifying Obsidian.app is running"
if ! pgrep -f "Obsidian.app/Contents/MacOS/Obsidian" > /dev/null; then
	echo "[ERROR] Obsidian.app did not start (or already exited)." >&2
	exit 3
fi
echo "    OK — Obsidian PID: $(pgrep -f 'Obsidian.app/Contents/MacOS/Obsidian' | head -1)"

echo "==> 3. AppleScript: read front window title"
WINDOW_TITLE=$(osascript -e 'tell application "System Events" to tell process "Obsidian"
	if exists window 1 then
		return name of window 1
	else
		return "(no window)"
	end if
end tell' 2>/dev/null || echo "(osascript failed)")
echo "    Front window: $WINDOW_TITLE"

# Expected: window title contains file basename (Obsidian shows "<Note Name> - <Vault>")
BASENAME=$(basename "$FILE_PATH")
if echo "$WINDOW_TITLE" | grep -qF "$BASENAME"; then
	echo "    OK — window title contains '$BASENAME'"
else
	echo "    [WARN] window title does NOT contain '$BASENAME' (got: $WINDOW_TITLE)"
fi

echo "==> 4. Screenshot Obsidian window (best-effort)"
SHOT_PATH="/tmp/obsidian-verify-$(date +%s).png"
# Try without permission first — most env will fail silently.
if screencapture -x -o -l \
	"$(osascript -e 'tell application "System Events" to tell process "Obsidian"
		if exists window 1 then
			return id of window 1
		else
			return 0
		end if
	end tell' 2>/dev/null)" \
	"$SHOT_PATH" 2>/dev/null && [ -s "$SHOT_PATH" ]; then
	echo "    OK — screenshot saved: $SHOT_PATH ($(stat -f %z "$SHOT_PATH") bytes)"
else
	echo "    [SKIP] screencapture failed (likely needs Screen Recording permission for Terminal)"
	rm -f "$SHOT_PATH"
fi

if [ -n "$FIXTURE" ]; then
	echo "==> 5. Text-content diff: fixture vs Obsidian-rendered markdown"
	python3 <<PY_END
import json, re, sys

with open("$FIXTURE") as f:
    fix = json.load(f)
with open("$FULL_MD") as f:
    md = f.read()
md_body = re.sub(r'^---\n.*?\n---\n', '', md, flags=re.DOTALL)

def walk(o, out):
    if isinstance(o, dict):
        tr = o.get('text_run')
        if isinstance(tr, dict):
            c = tr.get('content', '')
            if c: out.append(c)
        for v in o.values(): walk(v, out)
    elif isinstance(o, list):
        for v in o: walk(v, out)

texts = []
walk(fix, texts)

def norm(s): return re.sub(r'\s+', '', s.replace('\\\\', ''))
md_norm = norm(md_body)

# Exclude doc title pieces (PAGE.elements)
page = next((b for b in fix if b.get('block_type') == 1), {})
title_pieces = ''.join(
    el.get('text_run', {}).get('content', '')
    for el in page.get('page', {}).get('elements', [])
    if isinstance(el, dict)
)

missing = []
for t in texts:
    s = t.strip()
    if len(s) < 8 or s in title_pieces: continue
    if norm(s) not in md_norm:
        missing.append(s)

# Count emojis
emojis_in_md = sum(md_body.count(e) for e in ['💡','🔍','🔎','⚠️','🔔','ℹ️','📌'])
expected_emojis = sum(
    1 for b in fix
    if b.get('block_type') == 19
    and ((b.get('callout') or {}).get('emoji_id') or
         ((b.get('callout') or {}).get('style') or {}).get('emoji_id'))
)
print(f'    Text fragments (≥8 chars, excl. doc title): missing in markdown = {len(missing)}')
if missing:
    for m in missing[:5]:
        print(f'      - {m!r}')
print(f'    Callout emojis: fixture has {expected_emojis}, markdown contains {emojis_in_md}')

if missing or emojis_in_md < expected_emojis:
    print('    [FAIL] content not fully consistent')
    sys.exit(1)
else:
    print('    [PASS] full text + emoji coverage')
PY_END
fi

echo ""
echo "✓ Done. Obsidian opened to: $FULL_MD"
