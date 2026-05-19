# scys article 评论 `<e type="web">` 实体解码 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** scys.com `/articleDetail/xq_topic/{id}` 评论 content 里的 `<e type="web" href=... title=... />` self-closing 实体被 Defuddle/Markdown 链路丢弃，导致评论里指向外部资源（GitHub、文章等）的链接消失。本次抽出共享 helper `decodeScysWebEntities`，让评论 render 复用 articleContent path 已实现的 `<e>` 解码逻辑。

**Architecture:** 重构 `preprocessScysEntityHtml` 内联的 `<e>` 解码为独立 helper；评论 render 函数 `renderOneArticleCommentHtml` 在 `autolinkBareUrls` 之前先调一次 helper。`preprocessScysEntityHtml` 字节级输出不变（regression 保护通过现有测试），评论 path 新增解码能力。

**Tech Stack:** TypeScript / Vitest / webextension。设计文档见 `docs/superpowers/specs/2026-05-19-scys-article-comment-entity-design.md`。

---

## File Structure

- **Modify:** `src/utils/scys-extractor.ts`（抽 helper + 调 helper，无新文件）
- **Modify:** `src/utils/scys-extractor.test.ts`（追加 helper 单元测试 + 评论 render 测试）
- **Create:** `src/utils/scys-article-comment-entity.integration.test.ts`（端到端：fixture → extractScysStructuredContent → 断言 HTML 含 `<a>`）
- **Already-staged Fixture:** `src/utils/fixtures/scys-article-22255845818825821-{detail,comments}.json`（已落盘）

---

## Task 1: 写 `decodeScysWebEntities` helper 单元测试（先 fail）

**Files:**
- Modify: `src/utils/scys-extractor.test.ts`（追加 describe block）

- [ ] **Step 1.1: 在 scys-extractor.test.ts 末尾追加 describe**

把以下 describe 追加到文件末尾（如果文件末尾没空行先补一个）：

```ts
import { decodeScysWebEntities } from './scys-extractor';

describe('decodeScysWebEntities', () => {
    it('decodes <e type="web"> with URL-encoded href and title', () => {
        const input = 'gstack <e type="web" href="https%3A%2F%2Fgithub.com%2Fgarrytan%2Fgstack" title="GitHub%20gstack" />';
        expect(decodeScysWebEntities(input)).toBe('gstack <a href="https://github.com/garrytan/gstack">GitHub gstack</a>');
    });

    it('falls back to href as anchor text when title is empty', () => {
        const input = '<e type="web" href="https%3A%2F%2Fa.com" title="" />';
        expect(decodeScysWebEntities(input)).toBe('<a href="https://a.com">https://a.com</a>');
    });

    it('leaves non-web <e> entity types untouched', () => {
        const input = '<e type="mention" uid="1" title="@x" />';
        expect(decodeScysWebEntities(input)).toBe('<e type="mention" uid="1" title="@x" />');
    });

    it('passes through HTML with no <e> entities unchanged', () => {
        const input = '<p>plain html</p>';
        expect(decodeScysWebEntities(input)).toBe('<p>plain html</p>');
    });
});
```

如果文件顶部已经 `import { ... } from './scys-extractor'`，把 `decodeScysWebEntities` 加到现有 import 里，**不要**重复 import 语句。

- [ ] **Step 1.2: 跑测试验证 fail**

```bash
npx vitest run src/utils/scys-extractor.test.ts -t "decodeScysWebEntities"
```

期望：4 个用例全 FAIL，错误信息含 `decodeScysWebEntities is not a function` 或 `is not exported`。

---

## Task 2: 写"评论实体解码" e2e 集成测试（先 fail）

**Files:**
- Create: `src/utils/scys-article-comment-entity.integration.test.ts`

- [ ] **Step 2.1: 创建集成测试文件**

```ts
// E2E test for the scys article comment <e type="web"> entity decoding fix
// (2026-05-19). Covers the full extractor path without requiring chrome runtime:
//
//   fixture topicDetail + pageTopicComment JSON
//   → extractScysStructuredContent (real production extractor with mocked fetch)
//   → assert returned HTML contains <a href="…"> for the GitHub link that
//     would otherwise be lost when Defuddle drops the <e /> self-closing tag.
//
// fixture: src/utils/fixtures/scys-article-22255845818825821-{detail,comments}.json
// captured 2026-05-19 from live API (pycookiecheat + chrome cookies).

import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractScysStructuredContent } from './scys-extractor';
import detailFixture from './fixtures/scys-article-22255845818825821-detail.json';
import commentsFixture from './fixtures/scys-article-22255845818825821-comments.json';

const ENTITY_ID = '22255845818825821';
const URL = `https://scys.com/articleDetail/xq_topic/${ENTITY_ID}`;

describe('scys article comment <e type="web"> entity — e2e', () => {
    const originalFetch = global.fetch;
    afterEach(() => { global.fetch = originalFetch; });

    it('decodes <e> entity in comment content into <a> tag', async () => {
        // Mock fetch: route topicDetail → detail fixture, pageTopicComment → comments fixture pages.
        const commentPages = commentsFixture as any[];
        let commentPageIdx = 0;
        global.fetch = vi.fn(async (input: any, init?: any) => {
            const url = typeof input === 'string' ? input : input.url;
            if (url.includes('/homePage/topicDetail')) {
                return new Response(JSON.stringify(detailFixture), { status: 200 });
            }
            if (url.includes('/homePage/pageTopicComment')) {
                const page = commentPages[commentPageIdx++] ?? { data: { items: [], total: 0 } };
                return new Response(JSON.stringify(page), { status: 200 });
            }
            // Image L1 fetches — return empty so L2 path is skipped; we don't care
            // about base64 inlining in this test, only that the comment HTML carries
            // the <a> tag. resolveScysImages leaves unresolved tokens in place,
            // which is fine for the assertion below.
            return new Response('', { status: 404 });
        }) as any;

        // Minimal Document mock — extractScysStructuredContent only reads `doc.URL`.
        const doc = { URL } as unknown as Document;

        const result = await extractScysStructuredContent(doc);

        expect(result).not.toBeNull();
        const content = result!.content;
        // Positive assertion: GitHub URL is now a proper anchor.
        expect(content).toContain('<a href="https://github.com/garrytan/gstack">');
        // Negative assertion: the raw <e type="web" tag is gone (decoded away).
        expect(content).not.toMatch(/<e\s+type="web"/);
    });
});
```

- [ ] **Step 2.2: 跑测试验证 fail**

```bash
npx vitest run src/utils/scys-article-comment-entity.integration.test.ts
```

期望：1 个用例 FAIL，断言 `expect(content).toContain('<a href="https://github.com/garrytan/gstack">')` 失败（因为现在 `<e>` 实体没被解码就被 autolinkBareUrls 透传过去，下游会丢失）。

---

## Task 3: 实现 helper + 复用 + fix

**Files:**
- Modify: `src/utils/scys-extractor.ts`（3 处改动）

- [ ] **Step 3.1: 在 scys-extractor.ts 适当位置（紧贴 `preprocessScysEntityHtml` 之前）插入 helper**

定位：`preprocessScysEntityHtml` 函数定义之前（约 line 808 上方）。插入：

```ts
/**
 * Decode zsxq-style <e type="web" href="URL-encoded" title="URL-encoded" />
 * self-closing entities into clickable <a>. Used by both:
 *   - preprocessScysEntityHtml (legacy plain-text articleContent path)
 *   - renderOneArticleCommentHtml (article comment server-HTML path)
 *
 * Without this, Defuddle/turndown drops the non-standard self-closing tag
 * and the embedded URL disappears from the markdown output.
 *
 * Only handles type="web". Other zsxq entities (mention/hashtag) not yet
 * observed in scys fixtures; extend here when they appear.
 */
export function decodeScysWebEntities(html: string): string {
    const safeDecode = (s: string) => {
        try { return decodeURIComponent(s); } catch { return s; }
    };
    return html.replace(
        /<e\s+type="web"\s+href="([^"]*)"\s+title="([^"]*)"\s*\/?>/g,
        (_m, hrefEnc, titleEnc) => {
            const href = safeDecode(hrefEnc);
            const title = safeDecode(titleEnc) || href;
            return `<a href="${href}">${title}</a>`;
        }
    );
}
```

- [ ] **Step 3.2: `preprocessScysEntityHtml` 改为复用 helper**

替换现有函数体（line ~809-825）：

```ts
// Convert scys "plain-text articleContent" (no <p>/<div>) into proper HTML:
//   1. <e type="web" href="URL-encoded" title="URL-encoded" />  →  <a href="…">…</a>
//   2. Split on blank lines (\n\n+) into paragraphs; inner single \n → <br>.
// Without this defuddle treats the whole blob as one paragraph since there's
// no block-level structure to anchor on.
export function preprocessScysEntityHtml(html: string): string {
    // 1. Decode <e type="web"> via shared helper (also used by comment render).
    const out1 = decodeScysWebEntities(html);
    // 2. Paragraph-ize on blank lines; preserve inner single newlines as <br>.
    const paras = out1.split(/\n\n+/).map(s => s.trim()).filter(Boolean);
    return paras.map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('\n');
}
```

行为字节级等价于现状（regex / safeDecode / output 形态全部继承自 helper）。

- [ ] **Step 3.3: `renderOneArticleCommentHtml` 调 helper（fix 主题）**

定位 `renderOneArticleCommentHtml`（line ~788-796），替换为：

```ts
function renderOneArticleCommentHtml(c: ScysArticleComment): string {
    const header = formatScysArticleCommentHeader(c);
    // scys server-renders comment content as HTML and may embed zsxq-style
    // <e type="web" /> entities. Decode entities first so Defuddle doesn't
    // drop the self-closing tag, then autolink any remaining bare URLs.
    const decoded = decodeScysWebEntities(c.content ?? '');
    const body = autolinkBareUrls(decoded) + renderCommentImages(c.images);
    const replies = Array.isArray(c.replies) ? c.replies : [];
    const repliesHtml = replies.map(renderOneArticleCommentHtml).join('');
    return `<blockquote>${header}${body}${repliesHtml}</blockquote>`;
}
```

- [ ] **Step 3.4: 跑 Task 1 + Task 2 测试，验证全部 pass**

```bash
npx vitest run src/utils/scys-extractor.test.ts -t "decodeScysWebEntities"
npx vitest run src/utils/scys-article-comment-entity.integration.test.ts
```

期望：5 个用例全 PASS（4 个 helper 单元测试 + 1 个 e2e）。

---

## Task 4: 跑完整测试套件验证零 regression

- [ ] **Step 4.1: 跑全部 scys 相关测试**

```bash
npx vitest run src/utils/scys-extractor.test.ts src/utils/scys-published.integration.test.ts src/utils/scys-article-comment-entity.integration.test.ts
```

期望：全部 PASS，无新失败。

- [ ] **Step 4.2: 跑整个测试套件**

```bash
npm test
```

期望：所有原本 pass 的测试继续 pass，无 regression。

---

## Task 5: build + rsync 到 hot-reload dist

按 feedback memory「feature 完成后必做 build + rsync，hot reload 自动生效」。

- [ ] **Step 5.1: build chrome 生产产物**

```bash
npm run build:chrome
```

期望：webpack 成功输出到 `dist/`。`builds/*.zip` 可能也会生成。

- [ ] **Step 5.2: 验证 dist/ 是最新**

```bash
ls -la dist/content.js dist/background.js | head -5
```

dist 文件 mtime 应该是刚才 build 出来的时间。chrome 扩展 manifest v3 的 hot reload 自动 pick up（参见 chrome.alarms reload pattern）。

---

## Task 6: 提交并 push

- [ ] **Step 6.1: stage 所有改动**

```bash
git add -f \
    docs/superpowers/specs/2026-05-19-scys-article-comment-entity-design.md \
    docs/superpowers/plans/2026-05-19-scys-article-comment-entity.md \
    src/utils/fixtures/scys-article-22255845818825821-detail.json \
    src/utils/fixtures/scys-article-22255845818825821-comments.json \
    src/utils/scys-extractor.ts \
    src/utils/scys-extractor.test.ts \
    src/utils/scys-article-comment-entity.integration.test.ts
git status --short
```

注意：**不要** stage `package-lock.json`（先前就有未解的合并冲突，与本次无关）。

- [ ] **Step 6.2: 创建多个独立 commits（按 superpower commit 风格）**

按现有 commit 风格分批：

```bash
# fixture 落档
git add -f src/utils/fixtures/scys-article-22255845818825821-detail.json src/utils/fixtures/scys-article-22255845818825821-comments.json
git commit -m "test(scys): fixture — article 22255845818825821 (e-entity in comment)"

# spec
git add -f docs/superpowers/specs/2026-05-19-scys-article-comment-entity-design.md
git commit -m "docs(scys): spec — article comment <e type='web'> entity decoding"

# plan
git add -f docs/superpowers/plans/2026-05-19-scys-article-comment-entity.md
git commit -m "docs(scys): plan — article comment <e type='web'> entity decoding"

# helper + tests + fix
git add src/utils/scys-extractor.ts src/utils/scys-extractor.test.ts src/utils/scys-article-comment-entity.integration.test.ts
git commit -m "feat(scys): decode <e type='web'> entities in article comments

renderOneArticleCommentHtml was passing comment content through
autolinkBareUrls only, which left zsxq-style <e type=\"web\" href=...
title=... /> self-closing entities for Defuddle to drop. Lifted the
existing <e>-decoding from preprocessScysEntityHtml into a shared
decodeScysWebEntities helper and call it in the comment path."
```

- [ ] **Step 6.3: push 到 adu remote**

```bash
git push adu main
```

期望：fast-forward push 成功。**不要** push 到 origin（按 user collab norms：禁止 push origin）。

---

## Self-Review checklist

- [x] Spec 各 section 都有对应 task（helper / preprocessScysEntityHtml 复用 / renderOneArticleCommentHtml 修复 / 单元测试 / 集成测试 / build / commit）
- [x] 无 placeholder（每步代码块完整给出）
- [x] 类型一致（helper signature `decodeScysWebEntities(html: string): string` 在每个 task 一致）
- [x] 测试先行（Task 1/2 写 fail 测试，Task 3 才写实现）
- [x] DRY（helper 抽出，不复制 regex）
- [x] YAGNI（只解码 `web` 类型，不扩展未在 fixture 出现的 mention/hashtag）

---

## 验收（user-facing）

执行完所有 task 后向用户报告：

> **修复完成。** scys 文章评论里的 `<e type="web">` 实体现在会被解码成可点击链接。本次提交 4 个 commit（fixture / spec / plan / 实现）。
>
> **请验收**：在浏览器打开 `https://scys.com/articleDetail/xq_topic/22255845818825821`，点裁剪扩展，检查保存到 Obsidian 的笔记里"💬 评论"区"有够好笑的"那条 → 期望看到 `[GitHub - garrytan/gstack: ...](https://github.com/garrytan/gstack)` 这条链接。
