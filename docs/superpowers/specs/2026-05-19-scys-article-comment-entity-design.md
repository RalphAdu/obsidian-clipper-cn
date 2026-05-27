# scys 文章评论解码 `<e type="web">` 实体 设计文档

**日期**：2026-05-19
**目标**：scys.com `/articleDetail/xq_topic/{id}` 评论区里嵌入的 zsxq 风格 `<e type="web" href=... title=... />` self-closing 实体被 Defuddle/Markdown 链路丢弃，导致评论里指向外部资源（GitHub、文章等）的链接消失。本次让评论 render 复用 `preprocessScysEntityHtml` 已有的 `<e>` 解码逻辑，把实体转成可点击 `<a>` 标签，覆盖这一被遗漏的 path。

## 1. 问题定位

### 1.1 现象

用户裁剪 `https://scys.com/articleDetail/xq_topic/22255845818825821`，章节评论区里"有够好笑的"这条评论原文：

```
推荐大家装一个skill，上文pdf也是这个作者的理论：gstack GitHub: <e type="web" href="https%3A%2F%2Fgithub.com%2Fgarrytan%2Fgstack" title="GitHub%20-%20garrytan%2Fgstack%3A%20Use%20Garry%20Tan%27s%20exact%20Cl..." />
```

裁剪到 Obsidian 后，`<e ... />` 整体被吞，剩 `… gstack GitHub:` 没了后面的 GitHub 链接。

### 1.2 根因

`src/utils/scys-extractor.ts:788-796` `renderOneArticleCommentHtml`：

```ts
function renderOneArticleCommentHtml(c: ScysArticleComment): string {
    const header = formatScysArticleCommentHeader(c);
    const body = autolinkBareUrls(c.content ?? '') + renderCommentImages(c.images);
    ...
}
```

`c.content` 是 scys 服务端 render 的 HTML，里面**会**夹带 zsxq 原生的 `<e type="web" />` 实体（self-closing 非标 HTML），但：

- `autolinkBareUrls` 只把裸 `https://…` 文本包成 `<a>`，对 `<e>` 标签视而不见
- 下游 Defuddle/turndown 链路遇到未知 self-closing 标签直接吞

同一份 `<e type="web">` 解码逻辑早在 `preprocessScysEntityHtml`（line 809-825）里实现过，但只用于 legacy `articleContent` plain-text path，**评论 path 没复用**。

### 1.3 影响面

- **scys article 评论**：本次 22255845818825821 fixture 22 条评论中 1 条命中；用户实际反馈
- **scys article 主体 plain-text path**：已经走 `preprocessScysEntityHtml`，**不受影响**（本次 fixture articleContent 里 0 个 `<e>` 实体，覆盖路径稳定）
- **scys course / docx**：内容走 docBlocks → renderScysChapterContent，不接触 `<e>` 实体
- **scys course 章节评论**：用 `renderCommentBodyHtml`（line 464）走 blocks → HTML，不解析 server HTML 字段，本次问题不出现

### 1.4 其他 `<e>` 实体类型

zsxq 原生还有 `<e type="mention">`、`<e type="hashtag">` 等类型。本次 22 条评论里**只观察到 `type="web"`**。`preprocessScysEntityHtml` 现在也只解码 `web` 一种。YAGNI：保持只覆盖 `web`；其他类型若将来在 fixture 出现，按相同模式扩展。

### 1.5 评论 `images` 字段

`renderCommentImages` + `resolveScysImages` path 与本次问题正交（fixture 22255 评论里 1 条 images 字段 path 与已有 55188248 fixture 同形态，已被覆盖）。**不在本次设计范围**。

## 2. 设计

### 2.1 抽出共享 helper：`decodeScysWebEntities`

新增 `src/utils/scys-extractor.ts` 私有 helper（exported 供单元测试导入）：

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

### 2.2 `preprocessScysEntityHtml` 复用 helper（DRY，行为不变）

`src/utils/scys-extractor.ts:809-825` 现状把 `<e>` 解码内联在函数里。改造为：

```ts
export function preprocessScysEntityHtml(html: string): string {
    const out1 = decodeScysWebEntities(html);
    // 2. Paragraph-ize on blank lines; preserve inner single newlines as <br>.
    const paras = out1.split(/\n\n+/).map(s => s.trim()).filter(Boolean);
    return paras.map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('\n');
}
```

输出语义与现状逐字节一致——只是把 inline `<e>` regex 抽到 helper，paragraph-ize 部分保持。

### 2.3 `renderOneArticleCommentHtml` 调用 helper

`src/utils/scys-extractor.ts:788-796`：

```ts
function renderOneArticleCommentHtml(c: ScysArticleComment): string {
    const header = formatScysArticleCommentHeader(c);
    // scys server-renders comment content as HTML and may embed zsxq-style
    // <e type="web" /> entities. Decode entities first, then autolink any
    // remaining bare URLs.
    const decoded = decodeScysWebEntities(c.content ?? '');
    const body = autolinkBareUrls(decoded) + renderCommentImages(c.images);
    const replies = Array.isArray(c.replies) ? c.replies : [];
    const repliesHtml = replies.map(renderOneArticleCommentHtml).join('');
    return `<blockquote>${header}${body}${repliesHtml}</blockquote>`;
}
```

**顺序**：先 `decodeScysWebEntities`（产出 `<a href="…">title</a>`），再 `autolinkBareUrls`（处理评论文本里**裸**的 `https://…`）。`autolinkBareUrls` 已实现 anchor 内文本不再 wrap 的 idempotency，两步组合不冲突。

## 3. 测试

### 3.1 单元测试：`decodeScysWebEntities`

`src/utils/scys-extractor.test.ts` 新增：

| 用例 | 输入 | 期望输出 |
|---|---|---|
| 标准 `<e>` 实体 | `gstack <e type="web" href="https%3A%2F%2Fgithub.com%2Fgarrytan%2Fgstack" title="GitHub%20gstack" />` | `gstack <a href="https://github.com/garrytan/gstack">GitHub gstack</a>` |
| 空 title 回退到 href | `<e type="web" href="https%3A%2F%2Fa.com" title="" />` | `<a href="https://a.com">https://a.com</a>` |
| 非 `web` 类型不处理 | `<e type="mention" uid="1" title="@x" />` | （原样保留，下游会被 Defuddle 吞但本 helper 不动） |
| 无 `<e>` 输入直通 | `<p>plain html</p>` | `<p>plain html</p>` |

### 3.2 评论 render 集成测试

新增测试：用 `src/utils/fixtures/scys-article-22255845818825821-comments.json` 的真实数据，调 `renderScysArticleComments`，断言输出 HTML 含 `<a href="https://github.com/garrytan/gstack">…</a>`，且 GitHub URL 没丢。

### 3.3 回归：`preprocessScysEntityHtml`

`src/utils/scys-extractor.test.ts` 已有的 `preprocessScysEntityHtml` 测试**全部继续 pass**（重构等价性保证）。

### 3.4 现有 fixture 回归

- `scys-article-55188248-comments.json`（评论无 `<e>`）输出不变
- `scys-article-418444442181248-comments.json` 输出不变
- `scys-article-2852488814854211-comments.json` 输出不变

### 3.5 e2e 集成测试

`_scys-article-write-vault.test.ts`（memory 里提到的 vault dump 测试）当前仓库不存在；vault 里的 `_cn-test/scys-article-*.md` 是用户手动点扩展裁剪出来的真实产物，不是 vitest 自动写入。

本次改用**纯 vitest 集成测试**（不依赖 vault / 不依赖 chrome MCP）：

新增 `src/utils/scys-article-comment-entity.integration.test.ts`：
1. mock `global.fetch` 让 `topicDetail` / `pageTopicComment` 返回 22255 fixture 数据
2. 调 `extractScysStructuredContent(new JSDOM(...).window.document)`（or mock Document）
3. 断言返回的 `content` 字段含 HTML 片段 `<a href="https://github.com/garrytan/gstack">`
4. 兜底断言 `c.content` 原文里的 `<e type="web"` 不再出现在最终 HTML 里（实体已被解码）

不跑 visual-audit：本次 fix 不影响主体 articleContent 渲染（确认 fixture 里主体 0 个 `<e>` 实体），评论变化是新增 `<a>` 标签、行内一处差异——单元测试和集成测试已足够覆盖。

## 4. 验收清单

- [ ] `decodeScysWebEntities` 单元测试 4 个用例全 pass
- [ ] `renderScysArticleComments` 用 22255 fixture，输出含 `https://github.com/garrytan/gstack` 链接
- [ ] `preprocessScysEntityHtml` 现有测试 0 个 regress
- [ ] 三组现有 fixture 评论输出 0 个 regress
- [ ] 集成测试通过：22255 fixture 渲染 HTML 含 `<a href="https://github.com/garrytan/gstack">`
- [ ] `npm run build:chrome` 通过，`dist/` 被 rsync 到 hot-reload path

## 5. 不在范围

- 其他 `<e>` 类型（mention/hashtag/image）：fixture 未见，YAGNI
- 评论 `images` 字段图片渲染：已正常工作
- scys 主体 articleContent 已有 path 行为变更：本次仅重构 helper，**字节级等价**
