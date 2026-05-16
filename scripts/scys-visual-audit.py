#!/usr/bin/env python3
"""Headless visual audit: browser DOM dump vs Obsidian vault markdown."""
import json, re
from pathlib import Path
from collections import Counter

DOM_DUMP = Path('/tmp/scys-article-dom-dump.json')
VAULT_MD = Path('/Users/adu/Documents/Obsidian /Life/_cn-test/scys-article-55188248.md')

def expected_md_type(n):
    if n['hasImg'] and n['textLen'] < 5: return 'image'
    if n['isBullet']: return 'bullet'
    if n['isOrdered']: return 'ordered'
    if n.get('isSelfQuote') or n.get('isQuote'): return 'quote_container_item'
    fs = n['fontSize']; fw = n['fontWeight']; dh = n['docHeading']
    if fs >= 22: return 'h1'
    if fs >= 18 and fw >= 600: return 'h2'
    # Per-doc-heading-N expected level: scys article uses doc-heading-4/5/6 all
    # at 16px/600 visually, but signals hierarchy via the N number. Map each
    # N to a distinct markdown level: dh=4 → h3, dh=5 → h4, dh=6 → h5.
    # CAVEAT: scys lets authors put a bold-prefix into a heading block then
    # follow with non-bold prose ("**加入个人IP：**得到了..."). Inner spans
    # are mixed (hasBoldSpan but not allBold) — the visual is a paragraph
    # with an inline bold lead-in, NOT a heading. Expect bold_paragraph then.
    is_mixed = n.get('isMixedBold')
    tl = n.get('textLen', 0)
    if fs >= 16 and fw >= 600 and dh:
        if is_mixed: return 'bold_paragraph'
        # Long content in a heading block = scys author abused heading button
        # for bold-paragraph styling. Browser still renders at 16px/600 (whole
        # block bold). Visually this is a bold paragraph, NOT a heading.
        cutoff = {4: 50, 5: 30, 6: 30, 7: 0}.get(dh, 30)
        if tl >= cutoff: return 'bold_paragraph'
        if dh == 4: return 'h3'
        if dh == 5: return 'h4'
        if dh == 6: return 'h5'
        if dh == 7: return 'paragraph'
    if fs >= 16 and fw >= 600: return 'bold_paragraph'
    return 'paragraph'

def parse_markdown(md):
    body = re.sub(r'^---\n.*?\n---\n', '', md, flags=re.DOTALL)
    lines = body.split('\n')
    tokens = []
    for i, line in enumerate(lines, 1):
        if not line.strip(): continue
        in_bq = line.startswith('>')
        stripped = re.sub(r'^>+\s*', '', line)
        if not stripped.strip(): continue
        m = re.match(r'^(#{1,6})\s+(.+)$', stripped)
        if m:
            level = len(m.group(1)); content = m.group(2).strip()
            text = re.sub(r'\*+', '', content).strip()
            tokens.append({'type': f'h{level}', 'text': text, 'line': i, 'in_bq': in_bq, 'raw': line})
            continue
        m = re.match(r'^[-*+]\s+(.+)$', stripped)
        if m:
            tokens.append({'type': 'bullet', 'text': re.sub(r'\*+', '', m.group(1)).strip(), 'line': i, 'in_bq': in_bq, 'raw': line}); continue
        m = re.match(r'^\d+\.\s+(.+)$', stripped)
        if m:
            tokens.append({'type': 'ordered', 'text': re.sub(r'\*+', '', m.group(1)).strip(), 'line': i, 'in_bq': in_bq, 'raw': line}); continue
        m = re.match(r'^!\[.*?\]\(', stripped)
        if m:
            tokens.append({'type': 'image', 'text': '', 'line': i, 'in_bq': in_bq, 'raw': line}); continue
        text = re.sub(r'\*+', '', stripped).strip()
        is_bold_start = stripped.startswith('**')
        ttype = 'bold_paragraph' if (is_bold_start and stripped.count('**') >= 2 and stripped.find('**', 2) <= 30) else 'paragraph'
        tokens.append({'type': ttype, 'text': text, 'line': i, 'in_bq': in_bq, 'raw': line})
    return tokens

def norm(s):
    # Strip leading "5. " / "5、" style numbering (browser renders sequential
    # numbers in <li> text, but markdown ordered-list standard renumbers each
    # contiguous block from 1 — same content, different visible prefix).
    s = re.sub(r'^[•·]\s*', '', s)
    s = re.sub(r'^\d+[\.\、]\s*', '', s)
    return re.sub(r'[\s「」“”"\\:：，。、！？\)\(]+', '', s)[:50]

OK_MAP = {
    'h1': {'h1'},
    'h2': {'h2'},
    'h3': {'h3'},
    'h4': {'h4'},
    'h5': {'h5'},
    'h6': {'h6'},
    'paragraph': {'paragraph', 'bold_paragraph', 'bullet', 'ordered'},
    'bold_paragraph': {'bold_paragraph', 'paragraph'},
    'bullet': {'bullet'},
    'ordered': {'ordered'},
    'image': {'image'},
    'quote_container_item': {'paragraph', 'bold_paragraph', 'bullet', 'ordered', 'h3', 'h4', 'h5', 'h6'},
}

def main():
    dom = json.load(open(DOM_DUMP))
    md = open(VAULT_MD).read()
    tokens = parse_markdown(md)
    md_idx = {}
    for i, t in enumerate(tokens):
        k = norm(t['text'])
        if k: md_idx.setdefault(k, []).append((i, t))
    used = set(); diffs = []; missing = []
    cur = 0
    for d in dom:
        if d['hasImg'] and d['textLen'] < 5: continue
        k = norm(d['text'])
        if not k: continue
        cands = md_idx.get(k, [])
        chosen = None
        for ci, ct in cands:
            if ci >= cur and ci not in used:
                chosen = (ci, ct); break
        if chosen is None:
            for ci, ct in cands:
                if ci not in used:
                    chosen = (ci, ct); break
        if chosen is None:
            missing.append({'dom_idx': d['idx'], 'text': d['text'][:60]}); continue
        ci, ct = chosen; used.add(ci); cur = ci + 1
        exp = expected_md_type(d); act = ct['type']
        if act not in OK_MAP.get(exp, set()):
            diffs.append({'dom_idx': d['idx'], 'md_line': ct['line'],
                'expected': exp, 'actual': act,
                'fs': d['fontSize'], 'fw': d['fontWeight'], 'docH': d['docHeading'],
                'text': d['text'][:80], 'md_raw': ct['raw'][:100]})

    print(f'DOM nodes: {len(dom)}, MD tokens: {len(tokens)}')
    print(f'Mismatches: {len(diffs)}, Not-found-in-md: {len(missing)}')
    print()
    pairs = Counter((d['expected'], d['actual']) for d in diffs)
    print('=== Mismatch buckets ===')
    for (exp, act), cnt in sorted(pairs.items(), key=lambda x: -x[1]):
        print(f'  {exp:25s} -> {act:25s}: {cnt}')
    print()
    print('=== Examples (1 per bucket) ===')
    seen = set()
    for d in diffs:
        b = (d['expected'], d['actual'])
        if b in seen: continue
        seen.add(b)
        e = d['expected']; a = d['actual']; di = d['dom_idx']
        fs = d['fs']; fw = d['fw']; dh = d['docH']
        ml = d['md_line']; tx = d['text']; rw = d['md_raw']
        print(f'  [{e} -> {a}]  dom#{di}  fs={fs} fw={fw} docH={dh}')
        print(f'    text: {tx}')
        print(f'    md L{ml}: {rw}')
        print()
    if missing:
        print('=== Not found in markdown (first 5) ===')
        for m in missing[:5]:
            mi = m['dom_idx']; tx = m['text']
            print(f'  dom#{mi}: {tx}')

if __name__ == '__main__':
    main()
