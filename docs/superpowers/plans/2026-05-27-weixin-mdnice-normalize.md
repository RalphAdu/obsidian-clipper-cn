# Weixin mdnice 模板正则化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 mp.weixin.qq.com 上 mdnice 编辑器排版的文章在采集后保留 markdown 语义（H1/H2/H3/strong/pre/footnote），同时朴素 mp.weixin 文章不退化。

**Architecture:** 在 `src/utils/weixin-helpers.ts` 新增 10 个 DOM normalize 函数（1 个总入口 `normalizeMdniceArticle` + 9 个 sub-helper），按依赖顺序调用。`src/content.ts:extractWeChatArticleContent` 在 `normalizePreBlockLineBreaks` 之前插一行 `normalizeMdniceArticle(articleClone)` 接线。不引入新 extractor。

**Tech Stack:** TypeScript + linkedom (单测 DOM) + vitest + Playwright (e2e) + Webpack。

**Spec:** [docs/superpowers/specs/2026-05-27-weixin-mdnice-normalization-design.md](../specs/2026-05-27-weixin-mdnice-normalization-design.md)

**Worktree:** `.claude/worktrees/weixin-mdnice-normalize` / branch `worktree-weixin-mdnice-normalize`

---

## File Structure

- **Modify** `src/utils/weixin-helpers.ts` — 加 10 个 normalize 函数（在文件末尾追加）
- **Modify** `src/utils/weixin-helpers.test.ts` — 加 7 个 `describe` block（每个新 helper 一个 + 总入口一个）
- **Modify** `src/content.ts:75` — 插一行 `normalizeMdniceArticle(articleClone)`
- **Create** `src/utils/fixtures/weixin-mdnice-HCBkgfIZ.html` — 从抓到的 hydrated.html 取的 `#js_content` 切片，作为单测 + e2e fixture（最简化版，~30KB）
- **Modify** `src/utils/weixin-extractor.e2e.test.ts` — 加 URL B（HCBkgfIZ）+ 硬断言

---

## Task 1: Fixture 准备 — 抽取 #js_content 切片

**Files:**
- Create: `src/utils/fixtures/weixin-mdnice-HCBkgfIZ.html`
- Source: `tmp/weixin-recon-71508/hydrated.html`（已存在，3.7MB；只取 `<html><head></head><body>{#js_content outerHTML}</body></html>`）

**目的**：单测要喂 DOM 片段；hydrated.html 太大不适合签入仓库。先抽出干净 fixture。

- [ ] **Step 1: Extract #js_content into fixture file**

  在 worktree 根目录跑：

  ```bash
  node --input-type=module -e "
  import { parseHTML } from 'linkedom';
  import fs from 'node:fs';
  const html = fs.readFileSync('tmp/weixin-recon-71508/hydrated.html', 'utf8');
  const decoded = html.replace(/\\\\x3c/g,'<').replace(/\\\\x3e/g,'>').replace(/\\\\x22/g,'\"').replace(/\\\\x26#39;/g,\"'\").replace(/\\\\x26amp;/g,'&').replace(/\\\\x26nbsp;/g,' ');
  const { document: d } = parseHTML(decoded);
  const root = d.querySelector('#js_content');
  if (!root) throw new Error('no #js_content');
  const out = '<!DOCTYPE html><html><head><title>weixin mdnice fixture HCBkgfIZ</title><meta name=\"source\" content=\"https://mp.weixin.qq.com/s/HCBkgfIZkL939cQR67quEg\"></head><body>' + root.outerHTML + '</body></html>';
  fs.writeFileSync('src/utils/fixtures/weixin-mdnice-HCBkgfIZ.html', out);
  console.log('wrote', out.length, 'bytes');
  "
  ```

  **注意**：`tmp/weixin-recon-71508/` 可能因为 worktree 切换/清理已不存在。如果不在，先在仓库根（不是 worktree）跑一次 `npx tsx tmp/weixin-recon-XXXX/recon.ts`（recon 脚本见 spec §1 引用）。或者按 audit-extractor-ship skill 在 worktree 里跑 e2e-clip-runner 重新抓。

- [ ] **Step 2: 验证 fixture 文件存在且非空**

  ```bash
  ls -la src/utils/fixtures/weixin-mdnice-HCBkgfIZ.html
  head -3 src/utils/fixtures/weixin-mdnice-HCBkgfIZ.html
  ```

  Expected: 文件存在，~30-200KB。

- [ ] **Step 3: Commit**

  ```bash
  git add src/utils/fixtures/weixin-mdnice-HCBkgfIZ.html
  git commit -m "test(weixin): add mdnice fixture from HCBkgfIZ article

  Used as DOM input for weixin-helpers unit tests covering 10 mdnice
  template patterns (chapter headings / sub headings / small headings /
  code blocks / image captions / section cards / inline bold /
  javascript: links / sup footnotes / Sources list).

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 2: 装饰类 normalize — javascriptLinks + sectionCards + smallHeadings

**Files:**
- Modify: `src/utils/weixin-helpers.ts`（追加 3 函数 + 共享 helper）
- Modify: `src/utils/weixin-helpers.test.ts`（追加 3 describe block）

这三个 normalize 都"删/降级"装饰元素，最简单先做。

### 2a. `normalizeMdniceJavascriptLinks` — 剥 `<a href="javascript:;">` 成纯文本

- [ ] **Step 1: 在 weixin-helpers.test.ts 末尾追加测试**

  ```ts
  import {
    extractWeChatPublishedFromDocument,
    normalizePreBlockLineBreaks,
    normalizeMdniceJavascriptLinks,
  } from './weixin-helpers';

  describe('normalizeMdniceJavascriptLinks', () => {
    it('replaces <a href="javascript:;"> with its text content', () => {
      const { document: doc } = parseHTML(
        '<html><body><p>before <a href="javascript:;">公众号监控脚本</a> after</p></body></html>'
      );
      normalizeMdniceJavascriptLinks(doc);
      expect(doc.body.innerHTML).toBe('<p>before 公众号监控脚本 after</p>');
    });

    it('also matches javascript:void(0) and other javascript: hrefs', () => {
      const { document: doc } = parseHTML(
        '<html><body><a href="javascript:void(0)">x</a></body></html>'
      );
      normalizeMdniceJavascriptLinks(doc);
      expect(doc.body.innerHTML).toBe('x');
    });

    it('does not touch normal http(s) links', () => {
      const { document: doc } = parseHTML(
        '<html><body><a href="https://example.com">link</a></body></html>'
      );
      normalizeMdniceJavascriptLinks(doc);
      expect(doc.querySelector('a')).not.toBeNull();
      expect(doc.querySelector('a')!.getAttribute('href')).toBe('https://example.com');
    });
  });
  ```

- [ ] **Step 2: 跑测试验证 fail**

  ```bash
  npx vitest run src/utils/weixin-helpers.test.ts
  ```

  Expected: 3 个 FAIL，错误信息 "normalizeMdniceJavascriptLinks is not exported"

- [ ] **Step 3: 在 weixin-helpers.ts 末尾追加实现**

  ```ts
  /**
   * Strip <a href="javascript:..."> elements down to their inner text.
   * mdnice editor uses these as in-page anchors (e.g.
   * `<a href="javascript:;">公众号监控脚本</a>`); turndown otherwise emits
   * `[公众号监控脚本](javascript:;)` which is useless in markdown.
   */
  export function normalizeMdniceJavascriptLinks(root: ParentNode): void {
    const anchors = root.querySelectorAll('a[href^="javascript:"]');
    anchors.forEach(a => {
      const ownerDoc = (a as any).ownerDocument;
      if (!ownerDoc) return;
      a.replaceWith(ownerDoc.createTextNode((a as any).textContent || ''));
    });
  }
  ```

- [ ] **Step 4: 跑测试验证 pass**

  ```bash
  npx vitest run src/utils/weixin-helpers.test.ts
  ```

  Expected: 6 个 `normalizeMdniceJavascriptLinks` 等已有测试全 PASS。

### 2b. `normalizeMdniceSectionCards` — 删顶部 meta card + 栏目 anchor

- [ ] **Step 5: 在 weixin-helpers.test.ts 追加 describe**

  ```ts
  import {
    // ... existing imports
    normalizeMdniceSectionCards,
  } from './weixin-helpers';

  describe('normalizeMdniceSectionCards', () => {
    it('removes Reading Time meta card at article top', () => {
      const { document: doc } = parseHTML(`
        <html><body>
          <section style="padding: 10px 12px; background-color: rgb(244, 244, 240); text-align: center;">
            <span><span>干货分享</span></span>
            <span>Reading Time</span><span>5 MINS</span>
          </section>
          <p>正文开始</p>
        </body></html>
      `);
      normalizeMdniceSectionCards(doc);
      expect(doc.querySelectorAll('section').length).toBe(0);
      expect(doc.body.textContent).not.toContain('Reading Time');
      expect(doc.body.textContent).toContain('正文开始');
    });

    it('removes uppercase anchor section (WECHAT_MONITOR / EXPORT_AND_SKILL pattern)', () => {
      const { document: doc } = parseHTML(`
        <html><body>
          <section>
            <span style="background-color:#ab59ff"></span>
            <span style="font-size:9px;letter-spacing:4px;text-transform:uppercase;color:#ab59ff">WECHAT_MONITOR</span>
          </section>
          <p>下一段</p>
        </body></html>
      `);
      normalizeMdniceSectionCards(doc);
      expect(doc.querySelectorAll('section').length).toBe(0);
      expect(doc.body.textContent).not.toContain('WECHAT_MONITOR');
    });

    it('does not touch normal sections without mdnice signatures', () => {
      const { document: doc } = parseHTML(`
        <html><body>
          <section><p>普通段落 in section</p></section>
        </body></html>
      `);
      normalizeMdniceSectionCards(doc);
      expect(doc.querySelectorAll('section').length).toBe(1);
    });
  });
  ```

- [ ] **Step 6: 跑测试验证 fail**

  ```bash
  npx vitest run src/utils/weixin-helpers.test.ts -t normalizeMdniceSectionCards
  ```

  Expected: 3 个 FAIL，`normalizeMdniceSectionCards is not exported`。

- [ ] **Step 7: 在 weixin-helpers.ts 追加实现 + 共享辅助**

  ```ts
  // ============================================================
  // mdnice template normalizers — shared utilities
  // ============================================================

  /**
   * Test if an element's inline style attribute matches all given regex
   * patterns. Single-element predicate used by the mdnice normalizers
   * below to detect template-encoded structures.
   */
  function styleMatchesAll(el: Element, patterns: RegExp[]): boolean {
    const style = el.getAttribute('style') || '';
    return patterns.every(p => p.test(style));
  }

  /**
   * Walk every descendant of root and call fn. We use a snapshot array so
   * fn is free to mutate the DOM (replaceWith / remove) without breaking
   * the live NodeList iteration.
   */
  function forEachDescendant(root: ParentNode, fn: (el: Element) => void): void {
    const arr: Element[] = [];
    const walker = (node: ParentNode) => {
      for (const child of Array.from(node.children || [])) {
        arr.push(child as Element);
        walker(child as ParentNode);
      }
    };
    walker(root);
    arr.forEach(fn);
  }

  /**
   * Remove two mdnice "section card" decorations:
   *
   *   1. Reading Time meta card at article top — `<section>` with
   *      `padding: 10px 12px` + `background-color: rgb(244, 244, 240)`.
   *      Contains author badge + reading time, pure decoration.
   *
   *   2. Column-divider anchor — `<section>` whose textContent is an
   *      all-uppercase identifier (WECHAT_MONITOR / EXPORT_AND_SKILL),
   *      rendered as small letter-spaced purple text. Used as a visual
   *      section divider in mdnice; markdown gets H1 from the chapter
   *      heading right below it, so the anchor is redundant.
   */
  export function normalizeMdniceSectionCards(root: ParentNode): void {
    forEachDescendant(root, el => {
      if (el.tagName !== 'SECTION') return;
      const style = el.getAttribute('style') || '';
      const text = (el.textContent || '').trim();

      // Pattern 1: Reading Time meta card.
      const isMetaCard =
        /padding:\s*10px\s*12px/.test(style) &&
        /background-color:\s*rgb\(\s*244,\s*244,\s*240\s*\)/.test(style) &&
        /Reading Time/i.test(text);
      // Pattern 2: column anchor (all-uppercase identifier, short).
      const isColumnAnchor =
        text.length > 0 && text.length < 40 && /^[A-Z][A-Z0-9_]+$/.test(text);

      if (isMetaCard || isColumnAnchor) {
        el.remove();
      }
    });
  }
  ```

- [ ] **Step 8: 跑测试验证 pass**

  Expected: `normalizeMdniceSectionCards` 3 个测试 PASS。

### 2c. `normalizeMdniceSmallHeadings` — `<p>` letter-spaced uppercase 紫色 → `<h3>`

- [ ] **Step 9: 在 weixin-helpers.test.ts 追加 describe**

  ```ts
  import {
    // ... existing
    normalizeMdniceSmallHeadings,
  } from './weixin-helpers';

  describe('normalizeMdniceSmallHeadings', () => {
    it('promotes mdnice small heading <p> to <h3>', () => {
      const { document: doc } = parseHTML(`
        <html><body>
          <p style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:#ab59ff;font-weight:700">流程闭环</p>
          <p style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#ab59ff;font-weight:700">Sources</p>
        </body></html>
      `);
      normalizeMdniceSmallHeadings(doc);
      const h3s = Array.from(doc.querySelectorAll('h3')).map(h => h.textContent);
      expect(h3s).toEqual(['流程闭环', 'Sources']);
      expect(doc.querySelectorAll('p').length).toBe(0);
    });

    it('does not touch ordinary <p> elements', () => {
      const { document: doc } = parseHTML(
        '<html><body><p style="font-size:16px;color:#1b1c1a">正文段落</p></body></html>'
      );
      normalizeMdniceSmallHeadings(doc);
      expect(doc.querySelectorAll('h3').length).toBe(0);
      expect(doc.querySelectorAll('p').length).toBe(1);
    });

    it('requires all 5 signature properties (font-size + letter-spacing + uppercase + purple + bold)', () => {
      // Missing color → should NOT convert.
      const { document: doc } = parseHTML(
        '<html><body><p style="font-size:10px;letter-spacing:3px;text-transform:uppercase;font-weight:700">noColor</p></body></html>'
      );
      normalizeMdniceSmallHeadings(doc);
      expect(doc.querySelectorAll('h3').length).toBe(0);
    });
  });
  ```

- [ ] **Step 10: 跑测试验证 fail**

  Expected: `normalizeMdniceSmallHeadings is not exported`。

- [ ] **Step 11: 在 weixin-helpers.ts 追加实现**

  ```ts
  /**
   * Promote mdnice "small heading" <p> elements (letter-spaced uppercase
   * purple text — used as section labels like "流程闭环" / "Sources") to
   * <h3>. Signature is all 5 inline-style properties matching simultaneously,
   * which is highly specific to mdnice's template; ordinary paragraphs do
   * not carry this combination.
   */
  export function normalizeMdniceSmallHeadings(root: ParentNode): void {
    const ps = root.querySelectorAll('p');
    ps.forEach(p => {
      const style = p.getAttribute('style') || '';
      const matches =
        /font-size:\s*(?:9|10|11|12)px/.test(style) &&
        /letter-spacing:\s*[23]px/.test(style) &&
        /text-transform:\s*uppercase/.test(style) &&
        /color:\s*#ab59ff/i.test(style) &&
        /font-weight:\s*(?:700|800|900|bold)/.test(style);
      if (!matches) return;
      const ownerDoc = (p as any).ownerDocument;
      if (!ownerDoc) return;
      const h3 = ownerDoc.createElement('h3');
      h3.textContent = (p.textContent || '').trim();
      p.replaceWith(h3);
    });
  }
  ```

- [ ] **Step 12: 跑测试验证 pass**

  Expected: 全 PASS。

- [ ] **Step 13: Commit**

  ```bash
  git add src/utils/weixin-helpers.ts src/utils/weixin-helpers.test.ts
  git commit -m "feat(weixin): normalize mdnice javascript: links + section cards + small headings

  Adds three mdnice template normalizers that run on the article DOM
  clone before turndown:
  - normalizeMdniceJavascriptLinks: <a href=\"javascript:;\">x</a> → x
  - normalizeMdniceSectionCards: Reading Time meta + column-anchor SECTION drops
  - normalizeMdniceSmallHeadings: <p>letter-spaced uppercase purple → <h3>

  Adds 9 unit tests in weixin-helpers.test.ts.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 3: 内容装饰 normalize — inlineBold + imageCaptions

**Files:**
- Modify: `src/utils/weixin-helpers.ts`
- Modify: `src/utils/weixin-helpers.test.ts`

### 3a. `normalizeMdniceInlineBold` — `<span display:inline font-weight:600+>` → `<strong>`

- [ ] **Step 1: 在 weixin-helpers.test.ts 追加 describe**

  ```ts
  import {
    // ... existing
    normalizeMdniceInlineBold,
  } from './weixin-helpers';

  describe('normalizeMdniceInlineBold', () => {
    it('wraps inline span with font-weight:600 in <strong>', () => {
      const { document: doc } = parseHTML(`
        <html><body>
          <p>普通文字 <span style="display:inline;color:#ab59ff;font-weight:600">重点强调</span> 又普通</p>
        </body></html>
      `);
      normalizeMdniceInlineBold(doc);
      expect(doc.querySelector('strong')?.textContent).toBe('重点强调');
    });

    it('also matches font-weight:bold / 700+', () => {
      const { document: doc } = parseHTML(
        '<html><body><span style="display:inline;font-weight:700">bold</span></body></html>'
      );
      normalizeMdniceInlineBold(doc);
      expect(doc.querySelector('strong')?.textContent).toBe('bold');
    });

    it('does not wrap spans inside <h1>/<h2>/<h3>', () => {
      const { document: doc } = parseHTML(
        '<html><body><h1><span style="display:inline;font-weight:600">in heading</span></h1></body></html>'
      );
      normalizeMdniceInlineBold(doc);
      expect(doc.querySelector('strong')).toBeNull();
    });

    it('does not touch spans without display:inline or with weight < 600', () => {
      const { document: doc } = parseHTML(
        '<html><body><span style="font-weight:500">light</span><span style="display:block;font-weight:700">block</span></body></html>'
      );
      normalizeMdniceInlineBold(doc);
      expect(doc.querySelector('strong')).toBeNull();
    });

    it('skips empty or single-char spans (likely decorations)', () => {
      const { document: doc } = parseHTML(
        '<html><body><span style="display:inline;font-weight:600">x</span></body></html>'
      );
      normalizeMdniceInlineBold(doc);
      expect(doc.querySelector('strong')).toBeNull();
    });
  });
  ```

- [ ] **Step 2: 跑测试验证 fail**

- [ ] **Step 3: 在 weixin-helpers.ts 追加实现**

  ```ts
  /**
   * Wrap mdnice "inline emphasis" spans in <strong>. mdnice uses
   * `<span style="display:inline; color:#ab59ff; font-weight:600">...</span>`
   * to emphasize phrases (e.g. "标题、封面、发布时间、原文链接。"). turndown
   * has no rule for inline-CSS-encoded bold, so without this normalizer the
   * emphasis is silently lost in markdown.
   *
   * Constraints to avoid false positives:
   *   - Must be `display: inline` in inline style.
   *   - font-weight ≥ 600 (covers 600/700/800/900/bold/bolder).
   *   - textContent length ≥ 2 (single chars are usually decoration glyphs).
   *   - Not inside a heading element (heading already conveys emphasis).
   */
  export function normalizeMdniceInlineBold(root: ParentNode): void {
    const spans = root.querySelectorAll('span');
    spans.forEach(span => {
      const style = span.getAttribute('style') || '';
      if (!/display\s*:\s*inline\b/.test(style)) return;
      if (!/font-weight\s*:\s*(?:600|700|800|900|bold|bolder)\b/.test(style)) return;
      const text = (span.textContent || '').trim();
      if (text.length < 2) return;
      // Walk ancestors to check for heading containment.
      let cur: Element | null = span.parentElement;
      while (cur) {
        const t = cur.tagName;
        if (t === 'H1' || t === 'H2' || t === 'H3' || t === 'H4' || t === 'H5' || t === 'H6') return;
        cur = cur.parentElement;
      }
      const ownerDoc = (span as any).ownerDocument;
      if (!ownerDoc) return;
      const strong = ownerDoc.createElement('strong');
      strong.textContent = text;
      span.replaceWith(strong);
    });
  }
  ```

- [ ] **Step 4: 跑测试验证 pass**

### 3b. `normalizeMdniceImageCaptions` — 删 `<img alt="X">` 后紧邻的 caption 节点

- [ ] **Step 5: 在 weixin-helpers.test.ts 追加 describe**

  ```ts
  import {
    // ... existing
    normalizeMdniceImageCaptions,
  } from './weixin-helpers';

  describe('normalizeMdniceImageCaptions', () => {
    it('removes <section> caption that equals <img alt> exactly', () => {
      const { document: doc } = parseHTML(`
        <html><body>
          <img alt="信息过滤" src="https://example.com/x.png">
          <section>信息过滤</section>
        </body></html>
      `);
      normalizeMdniceImageCaptions(doc);
      expect(doc.querySelector('section')).toBeNull();
      expect(doc.querySelector('img')?.getAttribute('alt')).toBe('信息过滤');
    });

    it('removes <p> caption that equals alt with surrounding whitespace', () => {
      const { document: doc } = parseHTML(`
        <html><body>
          <img alt="信息卡片" src="https://example.com/y.png">
          <p>  信息卡片  </p>
        </body></html>
      `);
      normalizeMdniceImageCaptions(doc);
      expect(doc.querySelector('p')).toBeNull();
    });

    it('does NOT remove caption when text differs from alt', () => {
      const { document: doc } = parseHTML(`
        <html><body>
          <img alt="cover" src="https://example.com/z.png">
          <p>different caption</p>
        </body></html>
      `);
      normalizeMdniceImageCaptions(doc);
      expect(doc.querySelector('p')).not.toBeNull();
    });

    it('does NOT remove anything when alt is empty', () => {
      const { document: doc } = parseHTML(`
        <html><body>
          <img alt="" src="https://example.com/z.png">
          <p></p>
        </body></html>
      `);
      normalizeMdniceImageCaptions(doc);
      expect(doc.querySelectorAll('p').length).toBe(1);
    });

    it('skips text nodes between img and caption', () => {
      // Whitespace text node between img and caption section should not block matching.
      const { document: doc } = parseHTML(`
        <html><body>
          <img alt="测试" src="https://example.com/a.png">
          <section>测试</section>
        </body></html>
      `);
      normalizeMdniceImageCaptions(doc);
      expect(doc.querySelector('section')).toBeNull();
    });
  });
  ```

- [ ] **Step 6: 跑测试验证 fail**

- [ ] **Step 7: 在 weixin-helpers.ts 追加实现**

  ```ts
  /**
   * Remove duplicate image captions emitted by mdnice. Pattern:
   *
   *   <img alt="信息过滤" src="…">
   *   <section>信息过滤</section>   ← duplicate caption
   *
   * Without this normalizer the markdown becomes:
   *
   *   ![信息过滤](url)
   *   信息过滤
   *
   * with caption repeated twice (alt + standalone paragraph). After
   * normalization only `![信息过滤](url)` remains; markdown alt already
   * conveys the caption semantically.
   */
  export function normalizeMdniceImageCaptions(root: ParentNode): void {
    const imgs = root.querySelectorAll('img');
    imgs.forEach(img => {
      const alt = (img.getAttribute('alt') || '').trim();
      if (!alt) return;
      // Walk forward over whitespace-only nodes to find the next element.
      let next: Node | null = img.nextSibling;
      while (next && next.nodeType === 3 /* text */) {
        if ((next.textContent || '').trim() !== '') return;
        next = next.nextSibling;
      }
      if (!next || next.nodeType !== 1) return;
      const el = next as Element;
      if (el.tagName !== 'SECTION' && el.tagName !== 'P') return;
      const captionText = (el.textContent || '').trim();
      if (captionText !== alt) return;
      el.remove();
    });
  }
  ```

- [ ] **Step 8: 跑测试验证 pass**

- [ ] **Step 9: Commit**

  ```bash
  git add src/utils/weixin-helpers.ts src/utils/weixin-helpers.test.ts
  git commit -m "feat(weixin): normalize mdnice inline bold + duplicate image captions

  - normalizeMdniceInlineBold: wrap <span display:inline font-weight≥600>
    in <strong>; skip headings + decoration single-char spans
  - normalizeMdniceImageCaptions: drop sibling <section>/<p> that just
    repeats the <img alt>; markdown alt already conveys caption

  Adds 10 unit tests.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 4: 章节标题 normalize — chapterHeadings + subHeadings

**Files:**
- Modify: `src/utils/weixin-helpers.ts`
- Modify: `src/utils/weixin-helpers.test.ts`

### 4a. `normalizeMdniceChapterHeadings` — 装饰大字 + 26px → `<h1>` + `<p><em>`

- [ ] **Step 1: 在 weixin-helpers.test.ts 追加 describe**

  ```ts
  import {
    // ... existing
    normalizeMdniceChapterHeadings,
  } from './weixin-helpers';

  describe('normalizeMdniceChapterHeadings', () => {
    it('converts mdnice chapter heading section to <h1> + <p><em> subtitle', () => {
      // Minimal real-structure fixture: outer section containing
      // (decoration big char) + (text block with 26px title + 17px italic subtitle)
      const { document: doc } = parseHTML(`
        <html><body>
          <section>
            <section style="font-size:0;line-height:0;white-space:nowrap;">
              <span style="font-size:120px;color:rgba(236,223,252,0.008);"><span leaf="">壹</span></span>
              <span style="display:inline-block;">
                <section style="font-size:26px;font-weight:700;color:#1b1c1a"><span leaf="">先采集</span></section>
                <section style="font-size:17px;font-style:italic;color:rgba(27,28,26,0.40)"><span leaf="">Inbox First</span></section>
              </span>
            </section>
          </section>
        </body></html>
      `);
      normalizeMdniceChapterHeadings(doc);
      expect(doc.querySelector('h1')?.textContent).toBe('先采集');
      expect(doc.querySelector('em')?.textContent).toBe('Inbox First');
      // The original outer <section> structure should be gone.
      expect(doc.body.textContent).not.toContain('壹');
    });

    it('emits only <h1> when subtitle section missing', () => {
      const { document: doc } = parseHTML(`
        <html><body>
          <section>
            <section style="font-size:0;">
              <span style="font-size:120px;color:rgba(236,223,252,0.008);"><span leaf="">贰</span></span>
              <span><section style="font-size:26px;font-weight:700"><span leaf="">怎么搭的</span></section></span>
            </section>
          </section>
        </body></html>
      `);
      normalizeMdniceChapterHeadings(doc);
      expect(doc.querySelector('h1')?.textContent).toBe('怎么搭的');
      expect(doc.querySelector('em')).toBeNull();
    });

    it('does not touch non-mdnice section without 120px decoration char', () => {
      const { document: doc } = parseHTML(`
        <html><body>
          <section>
            <p>普通段落</p>
            <p>另一个</p>
          </section>
        </body></html>
      `);
      normalizeMdniceChapterHeadings(doc);
      expect(doc.querySelector('h1')).toBeNull();
    });
  });
  ```

- [ ] **Step 2: 跑测试验证 fail**

- [ ] **Step 3: 在 weixin-helpers.ts 追加实现**

  ```ts
  /**
   * Convert mdnice "chapter heading" sections to <h1> + optional italic
   * subtitle <p><em>...</em></p>. The template encodes chapter title as:
   *
   *   <section>                             ← chapter container
   *     <span font-size:120px color:rgba(...0.008)>壹</span>   ← decoration
   *     <span>
   *       <section font-size:26px font-weight:700>先采集</section>
   *       <section font-size:17px font-style:italic>Inbox First</section>
   *     </span>
   *   </section>
   *
   * The decoration char (壹/贰/叁) is an enlarged ghost letter purely for
   * visual flair; markdown does not need it. We pivot off this decoration
   * span (font-size:120px + very-low-alpha color) as the unique signature.
   */
  export function normalizeMdniceChapterHeadings(root: ParentNode): void {
    forEachDescendant(root, el => {
      if (el.tagName !== 'SECTION') return;
      // Find the 120px decoration span anywhere in this section's descendants
      // (but stop if a nested chapter section is encountered — we want each
      // chapter container processed once).
      const deco = el.querySelector('span[style*="font-size:120px"]');
      if (!deco) return;
      const decoStyle = deco.getAttribute('style') || '';
      if (!/color:\s*rgba\(\s*\d+,\s*\d+,\s*\d+,\s*0?\.0\d/.test(decoStyle)) return;
      // The "text block" is the next sibling span containing the title sections.
      const block = deco.parentElement === el || deco.parentElement?.parentElement === el
        ? deco.nextElementSibling
        : deco.parentElement?.nextElementSibling;
      // Find 26px font-weight:700 section (title) and 17px italic section (subtitle).
      const candidates = el.querySelectorAll('section');
      let title: Element | null = null;
      let subtitle: Element | null = null;
      for (const sec of Array.from(candidates)) {
        const style = (sec as Element).getAttribute('style') || '';
        if (!title && /font-size:\s*26px/.test(style) && /font-weight:\s*700/.test(style)) {
          title = sec as Element;
        } else if (!subtitle && /font-size:\s*17px/.test(style) && /font-style:\s*italic/.test(style)) {
          subtitle = sec as Element;
        }
      }
      if (!title) return;
      const ownerDoc = (el as any).ownerDocument;
      if (!ownerDoc) return;
      const h1 = ownerDoc.createElement('h1');
      h1.textContent = (title.textContent || '').trim();
      const replacement = ownerDoc.createDocumentFragment();
      replacement.appendChild(h1);
      if (subtitle) {
        const p = ownerDoc.createElement('p');
        const em = ownerDoc.createElement('em');
        em.textContent = (subtitle.textContent || '').trim();
        p.appendChild(em);
        replacement.appendChild(p);
      }
      el.replaceWith(replacement);
    });
  }
  ```

- [ ] **Step 4: 跑测试验证 pass**

### 4b. `normalizeMdniceSubHeadings` — 紫色条 + 24px → `<h2>` + `<p><em>`

- [ ] **Step 5: 在 weixin-helpers.test.ts 追加 describe**

  ```ts
  import {
    // ... existing
    normalizeMdniceSubHeadings,
  } from './weixin-helpers';

  describe('normalizeMdniceSubHeadings', () => {
    it('converts mdnice sub-heading section to <h2> + <p><em> Node_ID', () => {
      const { document: doc } = parseHTML(`
        <html><body>
          <section>
            <section style="font-size:0;white-space:nowrap;">
              <span style="display:inline-block;width:12px;margin-right:12px;">
                <span style="background-color:#caa1ff;width:3px;"><span leaf="">&nbsp;</span></span>
                <span style="background-color:#ab59ff;width:3px;"><span leaf="">&nbsp;</span></span>
              </span>
              <span style="display:inline-block;">
                <section style="font-size:24px;font-weight:700;color:#1b1c1a"><span leaf="">监听更新</span></section>
                <section style="font-size:10px;letter-spacing:3px;text-transform:uppercase;color:rgba(171,89,255,0.72)"><span leaf="">Node_ID: trigger</span></section>
              </span>
            </section>
          </section>
        </body></html>
      `);
      normalizeMdniceSubHeadings(doc);
      expect(doc.querySelector('h2')?.textContent).toBe('监听更新');
      expect(doc.querySelector('em')?.textContent).toBe('Node_ID: trigger');
    });

    it('emits only <h2> when subtitle missing', () => {
      const { document: doc } = parseHTML(`
        <html><body>
          <section>
            <span><span style="background-color:#ab59ff;width:3px;"><span leaf="">&nbsp;</span></span></span>
            <span><section style="font-size:24px;font-weight:700"><span leaf="">后筛选</span></section></span>
          </section>
        </body></html>
      `);
      normalizeMdniceSubHeadings(doc);
      expect(doc.querySelector('h2')?.textContent).toBe('后筛选');
      expect(doc.querySelector('em')).toBeNull();
    });

    it('does NOT touch chapter heading (font-size:26px) — chapterHeadings handles those', () => {
      const { document: doc } = parseHTML(`
        <html><body>
          <section>
            <span><section style="font-size:26px;font-weight:700"><span leaf="">先采集</span></section></span>
          </section>
        </body></html>
      `);
      normalizeMdniceSubHeadings(doc);
      expect(doc.querySelector('h2')).toBeNull();
    });
  });
  ```

- [ ] **Step 6: 跑测试验证 fail**

- [ ] **Step 7: 在 weixin-helpers.ts 追加实现**

  ```ts
  /**
   * Convert mdnice "sub-heading" sections to <h2> + optional <p><em>
   * subtitle ("Node_ID: trigger" style). Template:
   *
   *   <section>
   *     <span>...purple bar decorations (background-color:#ab59ff width:3px)...</span>
   *     <span>
   *       <section font-size:24px font-weight:700>监听更新</section>
   *       <section font-size:10px letter-spacing:3px uppercase color:rgba(171,89,255,*)>Node_ID: trigger</section>
   *     </span>
   *   </section>
   *
   * Pivot signature is the purple bar `background-color:#ab59ff` with
   * width≤3px decoration, paired with a 24px+700 sibling section.
   */
  export function normalizeMdniceSubHeadings(root: ParentNode): void {
    forEachDescendant(root, el => {
      if (el.tagName !== 'SECTION') return;
      // Purple bar decoration: any span with background-color:#ab59ff (any case) and width:3px or smaller.
      const bar = el.querySelector('span[style*="#ab59ff"], span[style*="#AB59FF"]');
      if (!bar) return;
      const barStyle = bar.getAttribute('style') || '';
      if (!/width:\s*[123]px/.test(barStyle)) return;
      // Find 24px font-weight:700 section.
      const sections = el.querySelectorAll('section');
      let title: Element | null = null;
      let subtitle: Element | null = null;
      for (const sec of Array.from(sections)) {
        const style = (sec as Element).getAttribute('style') || '';
        if (!title && /font-size:\s*24px/.test(style) && /font-weight:\s*700/.test(style)) {
          title = sec as Element;
        } else if (!subtitle && /font-size:\s*10px/.test(style) && /letter-spacing:\s*3px/.test(style)) {
          subtitle = sec as Element;
        }
      }
      if (!title) return;
      const ownerDoc = (el as any).ownerDocument;
      if (!ownerDoc) return;
      const h2 = ownerDoc.createElement('h2');
      h2.textContent = (title.textContent || '').trim();
      const replacement = ownerDoc.createDocumentFragment();
      replacement.appendChild(h2);
      if (subtitle) {
        const p = ownerDoc.createElement('p');
        const em = ownerDoc.createElement('em');
        em.textContent = (subtitle.textContent || '').trim();
        p.appendChild(em);
        replacement.appendChild(p);
      }
      el.replaceWith(replacement);
    });
  }
  ```

- [ ] **Step 8: 跑测试验证 pass**

- [ ] **Step 9: Commit**

  ```bash
  git add src/utils/weixin-helpers.ts src/utils/weixin-helpers.test.ts
  git commit -m "feat(weixin): normalize mdnice chapter + sub headings to h1/h2 + italic subtitle

  Detects mdnice's inline-CSS-encoded heading templates (decoration big
  char + 26px title / purple bar + 24px title) and rewrites them as
  semantic <h1>/<h2> followed by <p><em>subtitle</em></p>.

  Adds 6 unit tests covering happy path, missing subtitle, and
  non-mdnice section safety.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 5: 代码块 normalize — `normalizeMdniceCodeBlocks`

**Files:**
- Modify: `src/utils/weixin-helpers.ts`
- Modify: `src/utils/weixin-helpers.test.ts`

### 5a. 识别 mdnice 伪代码块容器 → `<pre><code>`

- [ ] **Step 1: 在 weixin-helpers.test.ts 追加 describe**

  ```ts
  import {
    // ... existing
    normalizeMdniceCodeBlocks,
  } from './weixin-helpers';

  describe('normalizeMdniceCodeBlocks', () => {
    it('converts mdnice terminal-style pseudo code block to <pre><code class="language-text">', () => {
      const { document: doc } = parseHTML(`
        <html><body>
          <section>
            <section style="padding:20px 0 24px;">
              <span style="display:inline-block;font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:#ab59ff;font-weight:700"><span leaf="">terminal</span></span>
              <span style="display:inline-block;font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:#ab59ff;font-weight:700"><span leaf="">TEXT</span></span>
              <section><span leaf="">1. 首先登录平台</span></section>
              <section><span leaf="">2. 然后获取对应的 API 密钥</span></section>
              <section><span leaf="">3. 把密钥交给 HermesAgent</span></section>
            </section>
          </section>
        </body></html>
      `);
      normalizeMdniceCodeBlocks(doc);
      const pre = doc.querySelector('pre');
      expect(pre).not.toBeNull();
      const code = pre!.querySelector('code');
      expect(code?.getAttribute('class')).toBe('language-text');
      expect(code?.textContent).toBe('1. 首先登录平台\n2. 然后获取对应的 API 密钥\n3. 把密钥交给 HermesAgent');
    });

    it('uses lang badge when it is a recognizable language (e.g. python, javascript)', () => {
      const { document: doc } = parseHTML(`
        <html><body>
          <section>
            <section>
              <span style="font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:#ab59ff;font-weight:700"><span leaf="">script.py</span></span>
              <span style="font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:#ab59ff;font-weight:700"><span leaf="">PYTHON</span></span>
              <section><span leaf="">print('hi')</span></section>
            </section>
          </section>
        </body></html>
      `);
      normalizeMdniceCodeBlocks(doc);
      expect(doc.querySelector('code')?.getAttribute('class')).toBe('language-python');
    });

    it('handles file-name lang badge (kebab-case dot ext like wechat-mp-monitor)', () => {
      const { document: doc } = parseHTML(`
        <html><body>
          <section>
            <section>
              <span style="font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:#ab59ff;font-weight:700"><span leaf="">wechat-mp-monitor</span></span>
              <span style="font-size:10px;letter-spacing:1.2px;text-transform:uppercase;color:#ab59ff;font-weight:700"><span leaf="">TEXT</span></span>
              <section><span leaf="">wechat-mp-monitor/</span></section>
              <section><span leaf="">├── SKILL.md</span></section>
            </section>
          </section>
        </body></html>
      `);
      normalizeMdniceCodeBlocks(doc);
      const code = doc.querySelector('code');
      expect(code?.getAttribute('class')).toBe('language-text');
      expect(code?.textContent).toContain('├── SKILL.md');
    });

    it('does NOT touch sections without lang badge', () => {
      const { document: doc } = parseHTML(`
        <html><body>
          <section>
            <p>just a paragraph in a section</p>
          </section>
        </body></html>
      `);
      normalizeMdniceCodeBlocks(doc);
      expect(doc.querySelector('pre')).toBeNull();
    });
  });
  ```

- [ ] **Step 2: 跑测试验证 fail**

- [ ] **Step 3: 在 weixin-helpers.ts 追加实现**

  ```ts
  // Lang badges that look like an explicit code language (case-insensitive).
  const KNOWN_LANGS = new Set([
    'bash', 'shell', 'sh', 'zsh',
    'js', 'javascript', 'ts', 'typescript', 'json',
    'python', 'py',
    'go', 'rust', 'java', 'kotlin',
    'html', 'css', 'xml', 'yaml', 'yml', 'toml',
    'sql', 'c', 'cpp', 'csharp',
    'php', 'ruby', 'swift',
    'markdown', 'md',
  ]);

  /**
   * Match mdnice's "lang badge" span: small uppercase letter-spaced purple
   * text inside the code-block header. We use these tight constraints
   * (font-size:10px + letter-spacing:1.2px + uppercase + #ab59ff +
   * font-weight≥700) because the same purple appears throughout mdnice
   * decoration and we must not catch non-code badges.
   */
  function isMdniceLangBadge(el: Element): boolean {
    const style = el.getAttribute('style') || '';
    return (
      /font-size:\s*10px/.test(style) &&
      /letter-spacing:\s*1\.2px/.test(style) &&
      /text-transform:\s*uppercase/.test(style) &&
      /color:\s*#ab59ff/i.test(style) &&
      /font-weight:\s*(?:700|800|900|bold)/.test(style)
    );
  }

  /**
   * Convert mdnice "pseudo code block" containers into <pre><code>. The
   * template uses a header row of 1-2 purple uppercase badges (file name +
   * lang, or just lang) followed by per-line <section> elements rendered
   * in a monospace-ish look.
   *
   * Strategy:
   *   1. Find the deepest <section> that contains a lang badge but has no
   *      nested section also containing a lang badge — that's the code
   *      block container.
   *   2. Collect all lang badges; pick the last one's text as candidate
   *      lang. If it's in KNOWN_LANGS use it; otherwise fall back to "text".
   *   3. Collect all <section> children that are NOT badge containers and
   *      treat their textContent as one code line. Join with "\n".
   *   4. Replace the container with <pre><code class="language-X">…</code></pre>.
   */
  export function normalizeMdniceCodeBlocks(root: ParentNode): void {
    // Use snapshot — mutation invalidates live queries.
    const allSections = Array.from(root.querySelectorAll('section'));
    // Find candidate code containers: sections containing ≥1 lang badge
    // whose parent section does NOT also contain a lang badge (deepest).
    for (const sec of allSections) {
      const badges = Array.from(sec.querySelectorAll('span')).filter(s => isMdniceLangBadge(s as Element)) as Element[];
      if (badges.length === 0) continue;
      // Check nested-section guard: if any descendant <section> also has
      // a badge, skip (we'll process the inner one).
      const inner = Array.from(sec.querySelectorAll('section')).some(child => {
        if (child === sec) return false;
        return Array.from((child as Element).querySelectorAll('span')).some(s => isMdniceLangBadge(s as Element));
      });
      if (inner) continue;

      // lang detection: take last badge's text, lowercase.
      const langRaw = (badges[badges.length - 1].textContent || '').trim().toLowerCase();
      const lang = KNOWN_LANGS.has(langRaw) ? langRaw : 'text';

      // Collect code line sections — direct or nested <section> children
      // whose textContent is NOT just the badge labels.
      const badgeTexts = new Set(badges.map(b => (b.textContent || '').trim()));
      const lineSections = Array.from(sec.querySelectorAll('section')).filter(s => {
        const t = ((s as Element).textContent || '').trim();
        if (!t) return false;
        if (badgeTexts.has(t)) return false;
        // Skip if it WRAPS a badge (nested badge container).
        if (Array.from((s as Element).querySelectorAll('span')).some(x => isMdniceLangBadge(x as Element))) return false;
        return true;
      });
      // Deduplicate: a code line may appear in multiple `<section>` nestings
      // (mdnice often wraps each line in an extra `<section>`). Pick the
      // innermost — sections whose children include OTHER `<section>` are
      // wrappers, not leaf lines.
      const leafLines = lineSections.filter(s => {
        const childSecs = Array.from((s as Element).children).filter(c => (c as Element).tagName === 'SECTION');
        return childSecs.length === 0;
      });

      if (leafLines.length === 0) continue;
      const codeText = leafLines.map(s => ((s as Element).textContent || '').trim()).join('\n');

      const ownerDoc = (sec as any).ownerDocument;
      if (!ownerDoc) continue;
      const pre = ownerDoc.createElement('pre');
      const code = ownerDoc.createElement('code');
      code.setAttribute('class', `language-${lang}`);
      code.textContent = codeText;
      pre.appendChild(code);
      sec.replaceWith(pre);
    }
  }
  ```

- [ ] **Step 4: 跑测试验证 pass**

  Expected: 4 个 `normalizeMdniceCodeBlocks` 测试 PASS。

- [ ] **Step 5: Commit**

  ```bash
  git add src/utils/weixin-helpers.ts src/utils/weixin-helpers.test.ts
  git commit -m "feat(weixin): normalize mdnice pseudo code blocks to <pre><code>

  Detects mdnice's terminal-style code containers (purple uppercase
  letter-spaced lang badges + per-line <section> children) and rewrites
  them as semantic <pre><code class=\"language-X\"> blocks.

  Lang detection: last badge text lowercased; if in KNOWN_LANGS set
  use as lang fence, else fall back to 'text'. Lines are collected from
  leaf <section> children (skipping wrapper sections) and joined with
  newlines.

  Adds 4 unit tests covering happy path, known-lang, file-name fallback,
  and non-code section safety.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 6: 注脚 normalize — `normalizeMdniceFootnotes`

**Files:**
- Modify: `src/utils/weixin-helpers.ts`
- Modify: `src/utils/weixin-helpers.test.ts`

最复杂的 normalize — 处理 mdnice 的 sup 标记 + Sources 列表两阶段。产物 markdown 期望：

```
正文里有引用 [^1]，文末有：

[^1]: wechat-article-exporter — https://github.com/wechat-article/wechat-article-exporter
[^2]: wechat-article-exporter-api — https://down.mptext.top/dashboard/api
```

- [ ] **Step 1: 在 weixin-helpers.test.ts 追加 describe**

  ```ts
  import {
    // ... existing
    normalizeMdniceFootnotes,
  } from './weixin-helpers';

  describe('normalizeMdniceFootnotes', () => {
    it('rewrites inline <sup>[N]</sup> markers to text "[^N]"', () => {
      const { document: doc } = parseHTML(`
        <html><body>
          <p>正文 <sup style="font-size:11px;color:#ab59ff;font-weight:700"><span leaf="">[1]</span></sup> 继续</p>
        </body></html>
      `);
      normalizeMdniceFootnotes(doc);
      expect(doc.body.textContent).toContain('[^1]');
      expect(doc.body.textContent).not.toContain('[1]');
      expect(doc.querySelector('sup')).toBeNull();
    });

    it('collects Sources block into footnote definitions appended at body end', () => {
      const { document: doc } = parseHTML(`
        <html><body>
          <p>正文 <sup><span leaf="">[1]</span></sup> 引用一</p>
          <p>正文 <sup><span leaf="">[2]</span></sup> 引用二</p>
          <p style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#ab59ff;font-weight:700"><span leaf="">Sources</span></p>
          <p>
            <span style="padding:0 6px;border-radius:6px"><span leaf="">[1]</span></span>
            <span leaf="">wechat-article-exporter</span>
          </p>
          <p>
            <span leaf="">https://github.com/wechat-article/wechat-article-exporter</span>
          </p>
          <p>
            <span style="padding:0 6px;border-radius:6px"><span leaf="">[2]</span></span>
            <span leaf="">wechat-article-exporter-api</span>
          </p>
          <p>
            <span leaf="">https://down.mptext.top/dashboard/api</span>
          </p>
        </body></html>
      `);
      normalizeMdniceFootnotes(doc);
      // Sources block + footnote items should be removed.
      expect(doc.body.textContent).not.toContain('Sources');
      // Original [1] badge boxes gone.
      const badges = doc.querySelectorAll('span[style*="padding:0 6px"]');
      expect(badges.length).toBe(0);
      // A trailing <div data-mdnice-footnotes> should hold the definitions.
      const fnDiv = doc.querySelector('div[data-mdnice-footnotes]');
      expect(fnDiv).not.toBeNull();
      const txt = fnDiv!.textContent || '';
      expect(txt).toContain('[^1]: wechat-article-exporter — https://github.com/wechat-article/wechat-article-exporter');
      expect(txt).toContain('[^2]: wechat-article-exporter-api — https://down.mptext.top/dashboard/api');
    });

    it('is a no-op when no <sup> and no Sources block', () => {
      const { document: doc } = parseHTML(
        '<html><body><p>normal paragraph</p></body></html>'
      );
      normalizeMdniceFootnotes(doc);
      expect(doc.body.innerHTML).toContain('<p>normal paragraph</p>');
      expect(doc.querySelector('div[data-mdnice-footnotes]')).toBeNull();
    });
  });
  ```

- [ ] **Step 2: 跑测试验证 fail**

- [ ] **Step 3: 在 weixin-helpers.ts 追加实现**

  ```ts
  /**
   * Rewrite mdnice footnote markup so it survives turndown as standard
   * markdown footnotes (`[^N]` inline + `[^N]: …` definitions).
   *
   * Two stages:
   *
   *   Stage 1 — inline markers. `<sup>` elements containing text like
   *     "[N]" are replaced with a text node "[^N]". The brackets must
   *     pass through turndown unescaped; we rely on the upstream caller
   *     to NOT escape `[^…]` (turndown by default doesn't).
   *
   *   Stage 2 — Sources block. Locate a small-heading-style <p> whose
   *     text equals "Sources" (or its lowercase variant). After it,
   *     mdnice emits one <p> per footnote — first <p> has a rounded badge
   *     `[N]` span + title, next <p> has the URL. We pair them by [N]
   *     number and emit `[^N]: title — url` lines into a trailing
   *     `<div data-mdnice-footnotes>`.
   *
   * After this normalizer, turndown produces:
   *
   *     正文 [^1] 引用一
   *
   *     [^1]: wechat-article-exporter — https://github.com/.../exporter
   *
   * which Obsidian renders as a proper footnote with backlinks.
   */
  export function normalizeMdniceFootnotes(root: ParentNode): void {
    const ownerDoc =
      (root as any).ownerDocument ||
      ((root as any).nodeType === 9 ? (root as Document) : null);
    if (!ownerDoc) return;

    // ---- Stage 1: <sup>[N]</sup> → text "[^N]" ----
    const sups = root.querySelectorAll('sup');
    sups.forEach(sup => {
      const text = (sup.textContent || '').trim();
      const m = text.match(/^\[(\d+)\]$/);
      if (!m) return;
      sup.replaceWith(ownerDoc.createTextNode(`[^${m[1]}]`));
    });

    // ---- Stage 2: locate Sources block + collect footnotes ----
    const allP = Array.from(root.querySelectorAll('p'));
    const sourcesIdx = allP.findIndex(p => {
      const style = p.getAttribute('style') || '';
      const text = (p.textContent || '').trim().toLowerCase();
      if (text !== 'sources') return false;
      // Must look like small heading (font-size:11px + letter-spacing + uppercase + #ab59ff).
      return /font-size:\s*1[01]px/.test(style) && /color:\s*#ab59ff/i.test(style);
    });
    if (sourcesIdx < 0) return;

    // Walk forward collecting (number, title) and (url) pairs.
    type Foot = { num: string; title: string; url: string };
    const collected: Foot[] = [];
    let current: Partial<Foot> | null = null;
    for (let i = sourcesIdx + 1; i < allP.length; i++) {
      const p = allP[i];
      // Skip if this <p> has the small-heading style (next section started).
      const style = p.getAttribute('style') || '';
      if (/text-transform:\s*uppercase/.test(style) && /letter-spacing/.test(style)) break;

      // Look for badge span "[N]" with rounded-pill style.
      const badge = Array.from(p.querySelectorAll('span')).find(s => {
        const sStyle = (s as Element).getAttribute('style') || '';
        const sText = ((s as Element).textContent || '').trim();
        return /padding:\s*0\s*6px/.test(sStyle) && /^\[\d+\]$/.test(sText);
      }) as Element | undefined;

      if (badge) {
        // Push previous if complete.
        if (current && current.num && current.title && current.url) {
          collected.push(current as Foot);
        }
        const num = (badge.textContent || '').trim().match(/\d+/)?.[0] || '';
        // Title = paragraph text MINUS the badge text.
        const fullText = (p.textContent || '').trim();
        const title = fullText.replace(/\[\d+\]/, '').trim();
        current = { num, title, url: '' };
      } else if (current) {
        // Treat this <p> as URL if it starts with http.
        const text = (p.textContent || '').trim();
        if (/^https?:\/\//i.test(text)) {
          current.url = text;
        }
      }
    }
    if (current && current.num && current.title && current.url) {
      collected.push(current as Foot);
    }
    if (collected.length === 0) return;

    // Remove the Sources <p> and all <p>s from sourcesIdx onward that we consumed.
    // For safety, we remove every <p> from sourcesIdx to the last collected <p>.
    // Simpler: remove Sources <p> + any subsequent <p> that contains either a
    // pill-badge or a bare http URL.
    const sourcesP = allP[sourcesIdx];
    sourcesP.remove();
    for (let i = sourcesIdx + 1; i < allP.length; i++) {
      const p = allP[i];
      const style = p.getAttribute('style') || '';
      if (/text-transform:\s*uppercase/.test(style) && /letter-spacing/.test(style)) break;
      const hasBadge = Array.from(p.querySelectorAll('span')).some(s => {
        const sStyle = (s as Element).getAttribute('style') || '';
        return /padding:\s*0\s*6px/.test(sStyle);
      });
      const text = (p.textContent || '').trim();
      const isUrl = /^https?:\/\//i.test(text);
      if (hasBadge || isUrl) p.remove();
    }

    // Append footnote definitions container at the end of body (or root).
    const target =
      (root as any).body ||
      (root as Element).querySelector?.('body') ||
      root;
    const div = ownerDoc.createElement('div');
    div.setAttribute('data-mdnice-footnotes', 'true');
    // Each footnote on its own paragraph so turndown emits a blank line between.
    for (const f of collected) {
      const p = ownerDoc.createElement('p');
      p.textContent = `[^${f.num}]: ${f.title} — ${f.url}`;
      div.appendChild(p);
    }
    (target as Element).appendChild(div);
  }
  ```

- [ ] **Step 4: 跑测试验证 pass**

  Expected: 3 个 `normalizeMdniceFootnotes` 测试 PASS。

- [ ] **Step 5: Commit**

  ```bash
  git add src/utils/weixin-helpers.ts src/utils/weixin-helpers.test.ts
  git commit -m "feat(weixin): normalize mdnice footnotes (sup markers + Sources list)

  Two-stage rewrite:
    1. <sup>[N]</sup> inline markers → text node \"[^N]\" so turndown
       outputs the standard markdown footnote ref.
    2. mdnice 'Sources' small-heading + following <p> pairs (badge+title,
       url) → trailing <div data-mdnice-footnotes> with one <p> per
       footnote definition formatted as '[^N]: title — url'.

  Obsidian renders the result with backlinks.

  Adds 3 unit tests covering inline rewrite, full Sources collection,
  and no-op safety.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 7: 总入口 `normalizeMdniceArticle` + content.ts 接线

**Files:**
- Modify: `src/utils/weixin-helpers.ts`（追加总入口 + 导出）
- Modify: `src/content.ts:75`（接线）
- Modify: `src/utils/weixin-helpers.test.ts`（追加 1 个集成测试）

- [ ] **Step 1: 在 weixin-helpers.test.ts 末尾追加集成测试**

  ```ts
  import {
    // ... existing
    normalizeMdniceArticle,
  } from './weixin-helpers';

  describe('normalizeMdniceArticle (integration)', () => {
    it('runs all 9 sub-normalizers in the right order on the real fixture', () => {
      const fixturePath = join(__dirname, 'fixtures', 'weixin-mdnice-HCBkgfIZ.html');
      const html = readFileSync(fixturePath, 'utf-8');
      const { document: doc } = parseHTML(html);
      const root = doc.querySelector('#js_content');
      expect(root, 'fixture should contain #js_content').not.toBeNull();
      normalizeMdniceArticle(root!);

      // After normalization the article DOM should expose semantic structure:
      // - At least 2 <h1> (chapters: 先采集, 怎么搭的).
      expect(root!.querySelectorAll('h1').length).toBeGreaterThanOrEqual(2);
      // - At least 5 <h2> (sub-headings: 监听更新, 后筛选, 沉淀到笔记里, 先解决采集这一步, 封装成了一个 Skill).
      expect(root!.querySelectorAll('h2').length).toBeGreaterThanOrEqual(5);
      // - At least 2 <h3> (small headings: 流程闭环, Sources — but Sources may be consumed by footnotes).
      expect(root!.querySelectorAll('h3').length).toBeGreaterThanOrEqual(1);
      // - At least 2 <pre><code> blocks (terminal step list + directory tree).
      expect(root!.querySelectorAll('pre code').length).toBeGreaterThanOrEqual(2);
      // - At least 1 <strong> (inline emphasis like '标题、封面、…').
      expect(root!.querySelectorAll('strong').length).toBeGreaterThanOrEqual(1);
      // - Footnote container appended.
      expect(root!.querySelector('div[data-mdnice-footnotes]')).not.toBeNull();
      // - No leftover javascript: links.
      expect(root!.querySelector('a[href^="javascript:"]')).toBeNull();
      // - No leftover Reading Time meta (was deleted by sectionCards).
      expect((root!.textContent || '')).not.toContain('Reading Time');
      // - No leftover column anchor (WECHAT_MONITOR / EXPORT_AND_SKILL).
      expect((root!.textContent || '')).not.toContain('WECHAT_MONITOR');
      expect((root!.textContent || '')).not.toContain('EXPORT_AND_SKILL');
    });
  });
  ```

- [ ] **Step 2: 跑测试验证 fail**

  Expected: FAIL `normalizeMdniceArticle is not exported`。

- [ ] **Step 3: 在 weixin-helpers.ts 追加总入口**

  ```ts
  /**
   * One-shot entry point that runs all mdnice sub-normalizers in
   * dependency order. Call this on a cloned article DOM before turndown.
   *
   * Order rationale:
   *   1. javascriptLinks — strip first, so code-block lang badges /
   *      heading subtitles don't contain dangling <a> elements.
   *   2. sectionCards — delete decoration cards (Reading Time meta +
   *      column anchors) so they don't pollute later heading detection.
   *   3. chapterHeadings, subHeadings — promote to <h1>/<h2>.
   *   4. footnotes — must run BEFORE smallHeadings, because it looks for
   *      a raw <p>Sources</p> small-heading <p> as anchor.
   *   5. smallHeadings — promote remaining small-heading <p>s to <h3>.
   *   6. codeBlocks — convert pseudo code-block sections to <pre><code>.
   *   7. imageCaptions — last image-related step, so DOM siblings of
   *      <img> are stable.
   *   8. inlineBold — last, so headings are already <h1>/<h2>/<h3> and
   *      we can correctly skip spans inside headings.
   */
  export function normalizeMdniceArticle(root: ParentNode): void {
    normalizeMdniceJavascriptLinks(root);
    normalizeMdniceSectionCards(root);
    normalizeMdniceChapterHeadings(root);
    normalizeMdniceSubHeadings(root);
    normalizeMdniceFootnotes(root);
    normalizeMdniceSmallHeadings(root);
    normalizeMdniceCodeBlocks(root);
    normalizeMdniceImageCaptions(root);
    normalizeMdniceInlineBold(root);
  }
  ```

- [ ] **Step 4: 接线到 content.ts**

  在 `src/content.ts:66 extractWeChatArticleContent` 函数中，把第 75 行（`normalizePreBlockLineBreaks(articleClone);`）改为先调 mdnice normalizer：

  ```ts
  function extractWeChatArticleContent(doc: Document): string | null {
    const article = doc.querySelector('#js_content');
    if (!article) {
      return null;
    }

    const articleClone = article.cloneNode(true) as HTMLElement;
    normalizeImageSources(articleClone as unknown as Document);
    articleClone.querySelectorAll('script, style').forEach(el => el.remove());
    normalizeMdniceArticle(articleClone);          // ← NEW
    normalizePreBlockLineBreaks(articleClone);
    return articleClone.outerHTML;
  }
  ```

  同时更新文件顶部 import（line 18）：

  ```ts
  import {
    extractWeChatPublishedFromDocument,
    normalizePreBlockLineBreaks,
    normalizeMdniceArticle,                        // ← NEW
  } from './utils/weixin-helpers';
  ```

- [ ] **Step 5: 跑全量测试验证 pass**

  ```bash
  npm test 2>&1 | tail -5
  ```

  Expected: 901 + 新增测试数（≥35 个新 unit test）— 全 PASS（除 3 个 template-integration pre-existing fail）。

- [ ] **Step 6: Commit**

  ```bash
  git add src/utils/weixin-helpers.ts src/utils/weixin-helpers.test.ts src/content.ts
  git commit -m "feat(weixin): wire normalizeMdniceArticle into extractWeChatArticleContent

  Adds the one-shot normalizeMdniceArticle entry point that runs all 9
  sub-normalizers in dependency order:
    javascriptLinks → sectionCards → chapterHeadings → subHeadings
    → footnotes → smallHeadings → codeBlocks → imageCaptions → inlineBold

  Wired into src/content.ts:extractWeChatArticleContent, immediately
  before normalizePreBlockLineBreaks, so mdnice template DOM is rewritten
  to semantic <h1>/<h2>/<h3>/<pre>/<strong>/[^N] before turndown runs.

  Plus an integration unit test using the real HCBkgfIZ fixture.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 8: E2E 扩展 — 加 HCBkgfIZ URL 并行测

**Files:**
- Modify: `src/utils/weixin-extractor.e2e.test.ts`

- [ ] **Step 1: 重构现有 e2e 文件为多 URL 矩阵**

  把现有 `src/utils/weixin-extractor.e2e.test.ts` 整体替换为：

  ```ts
  // src/utils/weixin-extractor.e2e.test.ts
  //
  // True end-to-end test: real chrome + dist/ extension + real network +
  // real extractor + real markdown generation. Asserts the produced .md
  // matches what hydration-time DOM ground truth implies.
  //
  // Excluded from `npm test` by vitest.config.ts; run via `npm run test:e2e`.

  import { describe, it, expect, beforeAll } from 'vitest';
  import { parseHTML } from 'linkedom';
  import { runRealClip, type ClipResult } from '../../scripts/e2e-clip-runner';
  import { auditWeixinClip, formatReport } from '../../scripts/weixin-visual-audit';

  // URL A — plain mp.weixin article (no mdnice editor decoration).
  // Regression guarantee: existing audit must keep passing after mdnice
  // normalizers are added.
  const URL_PLAIN = 'https://mp.weixin.qq.com/s/SPLTD-hFAsyYAA7V1lU8OA';
  // URL B — mdnice editor template article. New target of this spec.
  const URL_MDNICE = 'https://mp.weixin.qq.com/s/HCBkgfIZkL939cQR67quEg';

  describe('weixin e2e — plain article (regression, URL_PLAIN)', () => {
    let clip: ClipResult;

    beforeAll(async () => {
      clip = await runRealClip(URL_PLAIN, {
        wait: '#publish_time',
        timeout: 90_000,
      });
    }, 180_000);

    it('clip succeeded (markdown + hydratedHtml non-empty)', () => {
      expect(clip.markdown.length).toBeGreaterThan(1000);
      expect(clip.hydratedHtml.length).toBeGreaterThan(10_000);
      console.log(`[e2e-plain] clip ${clip.durationMs}ms md ${clip.markdown.length}B`);
    });

    it('frontmatter published matches DOM #publish_time text', () => {
      const { document } = parseHTML(clip.hydratedHtml);
      const text = document.querySelector('#publish_time')?.textContent?.trim() ?? '';
      const m = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
      const expected = m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
      expect(expected).toBeTruthy();
      expect(clip.markdown).toMatch(new RegExp(`^published: ${expected}$`, 'm'));
    });

    it('body contains PARA folder structure verbatim', () => {
      for (const folder of ['Vault/', '1-Projects/', '2-Areas/', '3-Resources/', '4-Archives/']) {
        expect(clip.markdown).toContain(folder);
      }
      expect(clip.markdown).toContain('├── 1-Projects/');
    });

    it('no backslash-escaped backtick leakage in markdown', () => {
      expect(clip.markdown).not.toMatch(/\\`/);
    });

    it('no leftover <span> in markdown body', () => {
      expect(clip.markdown).not.toMatch(/<span/);
    });

    it('full content audit: every visible block in #js_content appears in markdown (0 mismatch)', () => {
      const report = auditWeixinClip(clip.hydratedHtml, clip.markdown);
      console.log(formatReport(report));
      expect(report.mismatches, `${report.mismatches.length} blocks missing in markdown`).toHaveLength(0);
    });
  });

  describe('weixin e2e — mdnice article (URL_MDNICE)', () => {
    let clip: ClipResult;

    beforeAll(async () => {
      clip = await runRealClip(URL_MDNICE, {
        wait: '#publish_time',
        timeout: 90_000,
      });
    }, 180_000);

    it('clip succeeded (markdown + hydratedHtml non-empty)', () => {
      expect(clip.markdown.length).toBeGreaterThan(2000);
      expect(clip.hydratedHtml.length).toBeGreaterThan(10_000);
      console.log(`[e2e-mdnice] clip ${clip.durationMs}ms md ${clip.markdown.length}B`);
    });

    it('frontmatter has published date', () => {
      expect(clip.markdown).toMatch(/^published: \d{4}-\d{2}-\d{2}$/m);
    });

    it('chapter headings rendered as H1 (先采集 / 怎么搭的)', () => {
      expect(clip.markdown).toMatch(/^# 先采集\s*$/m);
      expect(clip.markdown).toMatch(/^# 怎么搭的\s*$/m);
    });

    it('sub-headings rendered as H2 (监听更新 / 后筛选 / 沉淀到笔记里 / 先解决采集这一步 / 封装成了一个 Skill)', () => {
      for (const t of ['监听更新', '后筛选', '沉淀到笔记里', '先解决采集这一步', '封装成了一个 Skill']) {
        expect(clip.markdown, `expected H2 "${t}"`).toMatch(new RegExp(`^## ${t}\\s*$`, 'm'));
      }
    });

    it('small heading 流程闭环 rendered as H3', () => {
      expect(clip.markdown).toMatch(/^### 流程闭环\s*$/m);
    });

    it('inline bold "标题、封面、发布时间、原文链接。" rendered as **strong**', () => {
      expect(clip.markdown).toContain('**标题、封面、发布时间、原文链接。**');
    });

    it('decoration removed: no Reading Time, no WECHAT_MONITOR, no EXPORT_AND_SKILL, no javascript:;', () => {
      expect(clip.markdown).not.toContain('Reading Time');
      expect(clip.markdown).not.toContain('WECHAT_MONITOR');
      expect(clip.markdown).not.toContain('EXPORT_AND_SKILL');
      expect(clip.markdown).not.toContain('javascript:;');
    });

    it('no inline <sup> HTML leakage', () => {
      expect(clip.markdown).not.toMatch(/<sup\b/);
    });

    it('at least 2 fenced code blocks (terminal step list + directory tree)', () => {
      const fences = (clip.markdown.match(/^```/gm) || []).length;
      expect(fences, 'should have ≥4 fence markers (2 blocks × 2 fences each)').toBeGreaterThanOrEqual(4);
    });

    it('no duplicate image caption (alt-equal section/p)', () => {
      // For each image alt text, check it does NOT appear as a standalone
      // paragraph immediately after the image.
      const imgPattern = /!\[([^\]]+)\]\([^)]+\)\n\n([^\n]+)\n/g;
      let m: RegExpExecArray | null;
      while ((m = imgPattern.exec(clip.markdown)) !== null) {
        expect(m[2].trim(), `image alt "${m[1]}" should not have duplicate caption "${m[2].trim()}"`).not.toBe(m[1].trim());
      }
    });

    it('contains markdown footnote definitions [^1]: ... and [^2]: ...', () => {
      expect(clip.markdown).toMatch(/^\[\^1\]:\s+wechat-article-exporter\s+—\s+https?:\/\//m);
      expect(clip.markdown).toMatch(/^\[\^2\]:\s+wechat-article-exporter-api\s+—\s+https?:\/\//m);
    });
  });
  ```

- [ ] **Step 2: Commit (still won't run e2e — need dist/ build first)**

  ```bash
  git add src/utils/weixin-extractor.e2e.test.ts
  git commit -m "test(weixin): e2e — add mdnice URL HCBkgfIZ + 8 mdnice-specific assertions

  Splits weixin-extractor.e2e.test.ts into two describes:
   - URL_PLAIN: existing SPLTD-hF regression suite (unchanged behaviour)
   - URL_MDNICE: new HCBkgfIZ suite with 8 assertions covering H1/H2/H3,
     inline bold, decoration removal, sup absence, fenced code blocks,
     caption deduplication, and [^N] footnote definitions.

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 9: Build + E2E + 修任何 fail

**Files:** N/A — build + verify only

- [ ] **Step 1: Build chrome (also creates dist/ used by e2e)**

  ```bash
  npm run build:chrome 2>&1 | tail -15
  ```

  Expected: webpack 输出 "✔ Built …"，无 error；`dist/build-marker.txt` 时间戳更新。

- [ ] **Step 2: 跑 e2e（双 URL 并行）**

  ```bash
  npm run test:e2e 2>&1 | tail -40
  ```

  Expected: 两个 describe block 全 PASS。若 URL_MDNICE 某些断言 fail：

  - 查看 fail 的 assertion → 回到对应 normalize helper 修单测/实现
  - **不要**在 e2e 测试里加 try/catch 或宽容化断言绕过；e2e 是 ship gate，必须真 PASS

- [ ] **Step 3: 修任何 fail（迭代直到全 PASS）**

  如果 fail：
  - 重跑只跑 URL_MDNICE 加快迭代：`npx vitest run --config vitest.e2e.config.ts src/utils/weixin-extractor.e2e.test.ts -t mdnice`
  - 在 normalizeMdnice* 函数中调试（添加 console.log 跑单测排查；记得修完删 log）

- [ ] **Step 4: Commit fixes (if any)**

  Any fixes commit message format:

  ```bash
  git commit -m "fix(weixin): <specific issue> in normalizeMdnice<Helper>

  <root cause + fix description>

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
  ```

---

## Task 10: Ship — 手动 clip + visual audit + checklist

**Files:** N/A — manual verification + ship lock workflow

按 memory `feedback_feature_ship_workflow.md`：worktree build → 抢锁 + rsync → 报验收 → 阿杜回"通过"才合 main + push + 释锁。

- [ ] **Step 1: 准备 ship checklist 草稿**

  按 spec §5 模板填写所有 T5-1..4 项目。

- [ ] **Step 2: T5-2 — 跑 unit + e2e 测试，保存输出尾**

  ```bash
  npm test 2>&1 | tail -3 > /tmp/weixin-mdnice-unit-tail.txt
  npm run test:e2e 2>&1 | tail -8 > /tmp/weixin-mdnice-e2e-tail.txt
  ```

  两个文件内容贴入 ship 消息的 T5-2 块。

- [ ] **Step 3: T5-4 — 视觉 audit via audit-extractor-ship skill**

  按 [[reference_audit_extractor_ship]] 调用 audit-extractor-ship skill：

  ```
  URL = https://mp.weixin.qq.com/s/HCBkgfIZkL939cQR67quEg
  extractor = weixin
  ```

  期望产物 REPORT.md 10 项 checklist 都满足；贴入 T5-4。

- [ ] **Step 4: 抢锁 + rsync dist/ → 主仓 dist/**

  按 memory `feedback_ship_lock_mechanism.md` 流程：
  - 主 session 抢 `.ship-lock.json` O_EXCL
  - rsync worktree dist/ 三浏览器目录到主仓
  - 准备 ship 消息（含 T5-1..4 checklist）报阿杜

- [ ] **Step 5: T5-3 — 阿杜手动 clip URL_MDNICE 在 Chrome 装的主仓 dist/**

  ship 消息里请阿杜：
  1. Chrome 加载主仓 `dist/`
  2. 打开 `https://mp.weixin.qq.com/s/HCBkgfIZkL939cQR67quEg`
  3. 触发 Obsidian Clipper，保存到 vault
  4. 在 Obsidian.app 打开 markdown，截图发回

  我等阿杜回 "通过" 才往下走 merge + push + 释锁。

- [ ] **Step 6: 阿杜回"通过" → 合并 worktree → push → 释锁 → 清理**

  按 memory `feedback_post_acceptance_cleanup.md`：

  ```bash
  # 主 session 里：
  cd /Users/adu/Workspace/github/obsidian-clipper/obsidian-clipper-cn
  git checkout main
  git merge worktree-weixin-mdnice-normalize --no-ff
  git push adu main      # 注意：只 push adu，不 push origin（memory 限制）
  # 清理 worktree
  git worktree remove .claude/worktrees/weixin-mdnice-normalize
  git branch -d worktree-weixin-mdnice-normalize
  rm .ship-lock.json
  # 更新 BACKLOG §2/§6/§7 + memory（按 [[feedback_post_acceptance_cleanup]] 流程）
  ```

  报"收尾完毕"。

---

## Self-Review Checklist

- ✅ Spec §2 列的 10 类痛点（A-K，无 J→10 个）每类都有对应 task：
  - A (chapter heading) → Task 4a
  - B (sub heading) → Task 4b
  - C (code block) → Task 5
  - D (image caption) → Task 3b
  - E (column anchor) → Task 2b（与 I 合并）
  - F (sup footnote inline) → Task 6
  - G (Sources list) → Task 6
  - H (javascript: link) → Task 2a
  - I (top meta card) → Task 2b（与 E 合并）
  - J (inline bold) → Task 3a
  - K (small heading) → Task 2c

- ✅ Spec §3.2.10 调用顺序 → Task 7 总入口实现完全对应

- ✅ Spec §3.3 测试策略：
  - 单测每 helper → Task 2-6 各自完成
  - e2e 双 URL 并行 → Task 8

- ✅ Spec §3.4 视觉 audit → Task 10 Step 3

- ✅ Spec §5 ship checklist 模板 → Task 10 整体覆盖

- ✅ 无 placeholder：每 step 完整代码 / 完整命令 / 完整 expected output

- ✅ 类型一致性：
  - `normalizeMdniceArticle(root: ParentNode): void` ↔ 所有 sub-helper 同签名
  - `KNOWN_LANGS: Set<string>` 仅在 Task 5 内部
  - 所有 helper 都 `export function ...(root: ParentNode): void`
