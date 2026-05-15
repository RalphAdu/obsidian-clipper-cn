# scys.com 课程页面专项提取器 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 scys.com 课程章节页面（`https://scys.com/course/detail/{course_id}?chapterId={chapter_id}`）写专项提取器，调用 scys 后端 API 拿飞书 docx 原生 block 结构，复用现有 `feishu-extractor.ts` 的 block→HTML 渲染管线，同时抓取并渲染评论区，输出语义完整的 Markdown：标题层级正确、图片 base64 内嵌（永久离线）、评论以 Obsidian 原生 callout 呈现。

**Architecture:** 新建 `src/utils/scys-extractor.ts` 作为薄壳：URL 解析 → API 调用（章节内容 + 评论 + 课程元信息）→ 嵌套→扁平 block 适配（含 heading 层级 rewrite）→ 复用 `convertBlocksToHtml` → 图片 base64 三级 fallback → 评论 callout 渲染。`src/content.ts` 加 scys 分支与现有 feishu/bilibili 同模式。

**Tech Stack:** TypeScript / Vitest / 同源 fetch (`credentials: 'include'`) / `browser.scripting.executeScript` (L2 image fallback) / 现有 `convertBlocksToHtml` 引擎复用

**Spec:** [`docs/superpowers/specs/2026-05-15-scys-extractor-design.md`](../specs/2026-05-15-scys-extractor-design.md)

---

## File Structure

| 操作 | 路径 | 责任 |
|---|---|---|
| 新建 | `src/utils/scys-extractor.ts` | URL/API/适配/评论渲染主模块 |
| 新建 | `src/utils/scys-extractor.test.ts` | 单测，覆盖各子模块 |
| 新建 | `src/utils/fixtures/scys-chapter-11408.json` | 真实章节 API 响应 |
| 新建 | `src/utils/fixtures/scys-comments-11408.json` | 真实评论 API 响应（4 页合并） |
| 修改 | `src/content.ts` (line ~269) | 接入 scys 分支 |
| 修改 | `src/manifest.chrome.json` | `host_permissions` 添加 scys.com |
| 修改 | `src/manifest.firefox.json` | 同上 |
| 修改 | `src/manifest.safari.json` | 同上 |
| 修改 | `src/background.ts` | 新增 `fetchScysImage` action handler（L2 fallback） |

**复用（不修改）**：`src/utils/feishu-extractor.ts` 的 `convertBlocksToHtml` / `renderBlock` / `renderTextElements` / `FEISHU_BLOCK_TYPE` / `FeishuBlock` 接口

---

## Heading 层级映射决策

依 spec §4，正文最大标题与评论分区平级，统一为 H2（避免评论 H2 在视觉上比正文 H1 低一级，又避免正文 H4 比评论 H2 低）。在 `flattenScysBlocks` 适配阶段把 scys block_type 改写：

| scys block_type | 飞书枚举 | 改写为 | 现有 renderBlock 输出 |
|---|---|---|---|
| 6 (HEADING4) | HEADING4 | 4 (HEADING2) | `<h2>` |
| 7 (HEADING5) | HEADING5 | 5 (HEADING3) | `<h3>` |
| 8 (HEADING6) | HEADING6 | 6 (HEADING4) | `<h4>` |

其他 block_type 保持原值。chapter.title 不写入 content（只写入 frontmatter，详见 Task 9）。

---

## Task 0: 准备真实 API fixture

**Files:**
- Create: `src/utils/fixtures/scys-chapter-11408.json`
- Create: `src/utils/fixtures/scys-comments-11408.json`

- [ ] **Step 1: 在已登录 scys.com 的 Chrome 标签页 DevTools Console 执行以下脚本抓章节 fixture**

打开 `https://scys.com/course/detail/172?chapterId=11408`，等页面加载完成，DevTools Console 粘贴：

```js
fetch('/search/course/getChapterContent?course_id=172&chapter_id=11408', { credentials: 'include' })
  .then(r => r.json())
  .then(d => {
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'scys-chapter-11408.json';
    a.click();
  });
```

把下载的 JSON 移动到 `src/utils/fixtures/scys-chapter-11408.json`。

- [ ] **Step 2: 同方式抓 4 页评论合并为单一 fixture**

DevTools Console：

```js
Promise.all([1,2,3,4].map(p =>
  fetch(`/search/course/getCourseComments?course_id=172&chapter_id=11408&page=${p}&page_size=20&sort_by=most_likes`, { credentials: 'include' }).then(r => r.json())
)).then(pages => {
  const merged = {
    data: {
      total: pages[0]?.data?.total ?? 0,
      items: pages.flatMap(p => p?.data?.items ?? []),
      extra: { users: Array.from(new Map(pages.flatMap(p => p?.data?.extra?.users ?? []).map(u => [u.id, u])).values()) },
    },
    status: pages[0]?.status,
    _meta: { pageCount: pages.length, fetchedAt: new Date().toISOString() },
  };
  const blob = new Blob([JSON.stringify(merged, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'scys-comments-11408.json';
  a.click();
});
```

把下载的 JSON 移动到 `src/utils/fixtures/scys-comments-11408.json`。

- [ ] **Step 3: 验证 fixture 完整性**

Run:
```bash
jq '.data.chapter.content | length' src/utils/fixtures/scys-chapter-11408.json
jq '.data.items | length, .data.total, (.data.extra.users | length)' src/utils/fixtures/scys-comments-11408.json
```

Expected:
- chapter content blocks: 应为约 **399** 个（数字可能微小波动）
- comments items: 应为 **70**；total: **70**；users 数 >= 15

- [ ] **Step 4: Commit fixture**

```bash
git add -f src/utils/fixtures/scys-chapter-11408.json src/utils/fixtures/scys-comments-11408.json
git commit -m "test: add scys course chapter + comments API fixtures (course 172 / chapter 11408)"
```

---

## Task 1: URL 判定 & 解析

**Files:**
- Create: `src/utils/scys-extractor.ts`
- Create: `src/utils/scys-extractor.test.ts`

- [ ] **Step 1: 写失败测试**

`src/utils/scys-extractor.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { isScysCourseUrl, parseScysUrl } from './scys-extractor';

describe('isScysCourseUrl', () => {
  it('matches scys course detail URL with chapterId', () => {
    expect(isScysCourseUrl('https://scys.com/course/detail/172?chapterId=11408')).toBe(true);
  });
  it('rejects scys course URL without chapterId', () => {
    expect(isScysCourseUrl('https://scys.com/course/detail/172')).toBe(false);
  });
  it('rejects other scys paths', () => {
    expect(isScysCourseUrl('https://scys.com/AI')).toBe(false);
    expect(isScysCourseUrl('https://scys.com/search/user/center')).toBe(false);
  });
  it('rejects non-scys hosts', () => {
    expect(isScysCourseUrl('https://example.com/course/detail/172?chapterId=11408')).toBe(false);
  });
  it('rejects malformed URL', () => {
    expect(isScysCourseUrl('not a url')).toBe(false);
  });
});

describe('parseScysUrl', () => {
  it('extracts courseId and chapterId', () => {
    expect(parseScysUrl('https://scys.com/course/detail/172?chapterId=11408'))
      .toEqual({ courseId: 172, chapterId: 11408 });
  });
  it('returns null for invalid URL', () => {
    expect(parseScysUrl('https://scys.com/course/detail/172')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
npx vitest run src/utils/scys-extractor.test.ts
```

Expected: FAIL with "Cannot find module './scys-extractor'"

- [ ] **Step 3: 实现 isScysCourseUrl + parseScysUrl**

`src/utils/scys-extractor.ts`（新文件）：

```ts
import { createLogger } from './logger';

const logger = createLogger('scys-extractor');

export function isScysCourseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'scys.com') return false;
    if (!/^\/course\/detail\/\d+/.test(parsed.pathname)) return false;
    return /^\d+$/.test(parsed.searchParams.get('chapterId') ?? '');
  } catch {
    return false;
  }
}

export function parseScysUrl(url: string): { courseId: number; chapterId: number } | null {
  try {
    const parsed = new URL(url);
    const pathMatch = parsed.pathname.match(/^\/course\/detail\/(\d+)/);
    const chapterIdStr = parsed.searchParams.get('chapterId');
    if (!pathMatch || !chapterIdStr || !/^\d+$/.test(chapterIdStr)) return null;
    return { courseId: parseInt(pathMatch[1], 10), chapterId: parseInt(chapterIdStr, 10) };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 跑测试验证通过**

```bash
npx vitest run src/utils/scys-extractor.test.ts
```

Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/utils/scys-extractor.ts src/utils/scys-extractor.test.ts
git commit -m "feat(scys): add URL detection and parsing for course detail pages"
```

---

## Task 2: Blocks 适配层（嵌套→扁平 + heading rewrite + image 注入）

**Files:**
- Modify: `src/utils/scys-extractor.ts`
- Modify: `src/utils/scys-extractor.test.ts`

- [ ] **Step 1: 写失败测试**

追加到 `scys-extractor.test.ts`：

```ts
import { flattenScysBlocks, ScysBlock } from './scys-extractor';

describe('flattenScysBlocks', () => {
  it('flattens nested children_blocks into parent.children id array', () => {
    const nested: ScysBlock[] = [{
      block_id: 'parent',
      block_type: 19,
      callout: { elements: [] },
      children_blocks: [
        { block_id: 'child1', block_type: 2, text: { elements: [] } },
        { block_id: 'child2', block_type: 2, text: { elements: [] } },
      ],
    }];
    const flat = flattenScysBlocks(nested);
    expect(flat.map(b => b.block_id)).toEqual(['parent', 'child1', 'child2']);
    expect(flat[0].children).toEqual(['child1', 'child2']);
    expect(flat[0]).not.toHaveProperty('children_blocks');
    expect(flat[1].parent_id).toBe('parent');
  });

  it('rewrites heading4 (block_type=6) to HEADING2 (block_type=4) with body remap', () => {
    const blocks: ScysBlock[] = [{
      block_id: 'h',
      block_type: 6,
      heading4: { elements: [{ text_run: { content: 'X' } }] },
    }];
    const flat = flattenScysBlocks(blocks);
    expect(flat[0].block_type).toBe(4);
    expect((flat[0] as any).heading2).toEqual({ elements: [{ text_run: { content: 'X' } }] });
    expect((flat[0] as any).heading4).toBeUndefined();
  });

  it('rewrites heading5 (7) → HEADING3 (5) and heading6 (8) → HEADING4 (6)', () => {
    const blocks: ScysBlock[] = [
      { block_id: 'a', block_type: 7, heading5: { elements: [{ text_run: { content: 'A' } }] } },
      { block_id: 'b', block_type: 8, heading6: { elements: [{ text_run: { content: 'B' } }] } },
    ];
    const flat = flattenScysBlocks(blocks);
    expect(flat[0].block_type).toBe(5);
    expect((flat[0] as any).heading3).toEqual({ elements: [{ text_run: { content: 'A' } }] });
    expect(flat[1].block_type).toBe(6);
    expect((flat[1] as any).heading4).toEqual({ elements: [{ text_run: { content: 'B' } }] });
  });

  it('injects scys: image token using file_url', () => {
    const blocks: ScysBlock[] = [{
      block_id: 'img1',
      block_type: 27,
      image: { width: 100, height: 50, file_url: 'https://sphere-sh.oss-cn-shanghai.aliyuncs.com/xx?sig=abc' },
    }];
    const flat = flattenScysBlocks(blocks);
    expect(flat[0].image?.token).toMatch(/^scys:/);
    expect(decodeURIComponent(flat[0].image!.token!.slice(5)))
      .toBe('https://sphere-sh.oss-cn-shanghai.aliyuncs.com/xx?sig=abc');
  });

  it('recurses into children_blocks for heading rewrite + image injection', () => {
    const blocks: ScysBlock[] = [{
      block_id: 'callout',
      block_type: 19,
      callout: { elements: [] },
      children_blocks: [{
        block_id: 'inner-img',
        block_type: 27,
        image: { file_url: 'https://x.y/z' },
      }],
    }];
    const flat = flattenScysBlocks(blocks);
    expect(flat).toHaveLength(2);
    const innerImg = flat.find(b => b.block_id === 'inner-img');
    expect(innerImg?.image?.token).toMatch(/^scys:/);
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
npx vitest run src/utils/scys-extractor.test.ts
```

Expected: FAIL with "flattenScysBlocks is not exported"

- [ ] **Step 3: 实现 ScysBlock 接口 + flattenScysBlocks**

追加到 `src/utils/scys-extractor.ts`：

```ts
import type { FeishuBlock } from './feishu-extractor';

export interface ScysBlock extends Omit<FeishuBlock, 'children'> {
  children_blocks?: ScysBlock[];
  // scys image block has file_url (signed OSS URL) instead of feishu's token
  image?: FeishuBlock['image'] & { file_url?: string };
}

const HEADING_REWRITE: Record<number, { newType: number; oldField: keyof ScysBlock; newField: string }> = {
  6: { newType: 4, oldField: 'heading4', newField: 'heading2' },
  7: { newType: 5, oldField: 'heading5', newField: 'heading3' },
  8: { newType: 6, oldField: 'heading6', newField: 'heading4' },
};

export function flattenScysBlocks(blocks: ScysBlock[]): FeishuBlock[] {
  const out: FeishuBlock[] = [];

  function walk(block: ScysBlock, parentId?: string): void {
    const childBlocks = block.children_blocks ?? [];
    const childIds = childBlocks.map(c => c.block_id);

    // Shallow copy without children_blocks
    const { children_blocks: _drop, ...rest } = block;
    const flat: any = { ...rest, parent_id: parentId, children: childIds.length ? childIds : undefined };

    // Heading rewrite (block_type 6/7/8 → 4/5/6, copy body to new field name)
    const rewrite = HEADING_REWRITE[flat.block_type];
    if (rewrite) {
      flat[rewrite.newField] = flat[rewrite.oldField];
      delete flat[rewrite.oldField];
      flat.block_type = rewrite.newType;
    }

    // Image: inject scys: prefixed token from file_url
    if (flat.block_type === 27 && flat.image?.file_url) {
      flat.image = { ...flat.image, token: `scys:${encodeURIComponent(flat.image.file_url)}` };
    }

    out.push(flat as FeishuBlock);
    for (const child of childBlocks) walk(child, block.block_id);
  }

  for (const b of blocks) walk(b);
  return out;
}
```

- [ ] **Step 4: 跑测试验证通过**

```bash
npx vitest run src/utils/scys-extractor.test.ts
```

Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add src/utils/scys-extractor.ts src/utils/scys-extractor.test.ts
git commit -m "feat(scys): add block adapter (nested→flat, heading rewrite, image token injection)"
```

---

## Task 3: 章节正文渲染端到端（接 convertBlocksToHtml，含真实 fixture）

**Files:**
- Modify: `src/utils/scys-extractor.ts`
- Modify: `src/utils/scys-extractor.test.ts`

- [ ] **Step 1: 写失败测试（使用真实 fixture）**

追加到 `scys-extractor.test.ts`：

```ts
import fixtureChapter from './fixtures/scys-chapter-11408.json';
import { renderScysChapterContent } from './scys-extractor';

describe('renderScysChapterContent (real fixture)', () => {
  const blocks = (fixtureChapter as any).data.chapter.content;

  it('produces HTML containing all chapter h2 headings', () => {
    const html = renderScysChapterContent(blocks);
    // From spec §3.1: 6 heading4 blocks in this chapter
    expect(html).toContain('<h2>0. 本章概要</h2>');
    expect(html).toContain('<h2>1. 什么是积累能力</h2>');
    expect(html).toContain('<h2>2. 积累能力的三个核心技能</h2>');
  });

  it('produces h3 for HEADING5 (e.g. "2.1 需求判断...")', () => {
    const html = renderScysChapterContent(blocks);
    expect(html).toMatch(/<h3>2\.1\s*需求判断/);
  });

  it('produces h4 for HEADING6 (e.g. "2.1.1 用途...")', () => {
    const html = renderScysChapterContent(blocks);
    expect(html).toMatch(/<h4>2\.1\.1\s*用途/);
  });

  it('renders bullet list block as <ul>', () => {
    const html = renderScysChapterContent(blocks);
    expect(html).toMatch(/<ul>[\s\S]*<li>/);
  });

  it('renders ordered list block as <ol>', () => {
    const html = renderScysChapterContent(blocks);
    expect(html).toMatch(/<ol>[\s\S]*<li>/);
  });

  it('renders callout block as blockquote.feishu-callout', () => {
    const html = renderScysChapterContent(blocks);
    expect(html).toContain('class="feishu-callout"');
  });

  it('renders code block as <pre><code>', () => {
    const html = renderScysChapterContent(blocks);
    expect(html).toMatch(/<pre><code>/);
  });

  it('renders table block', () => {
    const html = renderScysChapterContent(blocks);
    expect(html).toMatch(/<table[\s>]/);
  });

  it('keeps image placeholders with scys: prefixed src for later resolution', () => {
    const html = renderScysChapterContent(blocks);
    expect(html).toMatch(/<img src="feishu-image:\/\/scys:[^"]+"/);
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
npx vitest run src/utils/scys-extractor.test.ts
```

Expected: FAIL with "renderScysChapterContent is not exported"

- [ ] **Step 3: 实现 renderScysChapterContent**

追加到 `src/utils/scys-extractor.ts`：

```ts
// Re-import convertBlocksToHtml from feishu-extractor — but it's not exported.
// Add an export there OR re-implement here. Choice: re-export from feishu-extractor.
```

先回到 `src/utils/feishu-extractor.ts`，在文件末尾确保 `convertBlocksToHtml` 是导出的：

```ts
// In src/utils/feishu-extractor.ts: change line 608 from
//   function convertBlocksToHtml(blocks: FeishuBlock[]): string {
// to
//   export function convertBlocksToHtml(blocks: FeishuBlock[]): string {
```

然后回 `scys-extractor.ts`：

```ts
import { convertBlocksToHtml } from './feishu-extractor';

export function renderScysChapterContent(scysBlocks: ScysBlock[]): string {
  const flat = flattenScysBlocks(scysBlocks);
  return convertBlocksToHtml(flat);
}
```

- [ ] **Step 4: 跑测试验证通过**

```bash
npx vitest run src/utils/scys-extractor.test.ts
```

Expected: PASS (21 tests)

如果某条 fixture-based 断言失败（比如真实 fixture 中没有 code block），删该断言而不是 hack 它——fixture 是 source of truth。

- [ ] **Step 5: 验证现有 feishu 测试未被破坏**

```bash
npx vitest run src/utils/feishu-extractor.test.ts
```

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/utils/scys-extractor.ts src/utils/scys-extractor.test.ts src/utils/feishu-extractor.ts
git commit -m "feat(scys): render chapter content via reused convertBlocksToHtml

Export feishu-extractor's convertBlocksToHtml and reuse it from scys-extractor.
Fixture-based test asserts all chapter block types render correctly."
```

---

## Task 4: 图片下载 L1（content-script 同源 fetch）

**Files:**
- Modify: `src/utils/scys-extractor.ts`
- Modify: `src/utils/scys-extractor.test.ts`

- [ ] **Step 1: 写失败测试（mock fetch）**

追加到 `scys-extractor.test.ts`：

```ts
import { resolveScysImages } from './scys-extractor';

describe('resolveScysImages (L1 same-origin fetch)', () => {
  const originalFetch = global.fetch;

  afterEach(() => { global.fetch = originalFetch; });

  it('replaces scys: token with base64 data URL on success', async () => {
    const png1x1 = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'Content-Type': 'image/png' }),
      blob: () => Promise.resolve(new Blob([png1x1], { type: 'image/png' })),
    } as any);
    const html = '<img src="feishu-image://scys:https%3A%2F%2Fexample.com%2Fa.png">';
    const resolved = await resolveScysImages(html);
    expect(resolved).toMatch(/<img src="data:image\/png;base64,[A-Za-z0-9+/=]+">/);
    expect(resolved).not.toContain('feishu-image://scys:');
  });

  it('leaves token in place if fetch fails', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false } as any);
    const html = '<img src="feishu-image://scys:https%3A%2F%2Fexample.com%2Fa.png">';
    const resolved = await resolveScysImages(html);
    expect(resolved).toContain('feishu-image://scys:');
  });

  it('handles multiple images independently', async () => {
    let n = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      n++;
      return Promise.resolve({
        ok: n === 1,
        headers: new Headers({ 'Content-Type': 'image/png' }),
        blob: () => Promise.resolve(new Blob([new Uint8Array([n])], { type: 'image/png' })),
      });
    });
    const html =
      '<img src="feishu-image://scys:https%3A%2F%2Fa">' +
      '<img src="feishu-image://scys:https%3A%2F%2Fb">';
    const resolved = await resolveScysImages(html);
    // First resolved, second left as placeholder
    expect((resolved.match(/data:image/g) || []).length).toBe(1);
    expect((resolved.match(/feishu-image:\/\/scys:/g) || []).length).toBe(1);
  });
});
```

需要 vitest 的 `vi` 和 `afterEach`，确保 import 行存在：

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
```

- [ ] **Step 2: 跑测试验证失败**

```bash
npx vitest run src/utils/scys-extractor.test.ts
```

Expected: FAIL with "resolveScysImages is not exported"

- [ ] **Step 3: 实现 resolveScysImages（L1）**

追加到 `src/utils/scys-extractor.ts`：

```ts
async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function fetchScysImageL1(scysToken: string): Promise<string | null> {
  const fileUrl = decodeURIComponent(scysToken.replace(/^scys:/, ''));
  try {
    const res = await fetch(fileUrl, { credentials: 'include' });
    if (!res.ok) {
      logger.warn(`[scys-img L1] HTTP ${res.status} for ${fileUrl.slice(0, 80)}...`);
      return null;
    }
    const blob = await res.blob();
    return await blobToDataUrl(blob);
  } catch (err) {
    logger.warn(`[scys-img L1] fetch error: ${String(err)}`);
    return null;
  }
}

export async function resolveScysImages(html: string): Promise<string> {
  const tokenPattern = /feishu-image:\/\/(scys:[^"'\s>]+)/g;
  const tokens = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(html)) !== null) {
    tokens.add(match[1]);
  }
  if (tokens.size === 0) return html;

  const replacements = new Map<string, string>();
  await Promise.all(
    Array.from(tokens).map(async (token) => {
      const dataUrl = await fetchScysImageL1(token);
      if (dataUrl) replacements.set(token, dataUrl);
    })
  );

  let resolved = html;
  for (const [token, dataUrl] of replacements) {
    resolved = resolved.split(`feishu-image://${token}`).join(dataUrl);
  }
  return resolved;
}
```

- [ ] **Step 4: 跑测试验证通过**

```bash
npx vitest run src/utils/scys-extractor.test.ts
```

Expected: PASS (24 tests)

- [ ] **Step 5: Commit**

```bash
git add src/utils/scys-extractor.ts src/utils/scys-extractor.test.ts
git commit -m "feat(scys): add image L1 fallback (content-script same-origin fetch → base64)"
```

---

## Task 5: API 调用（fetchScysChapter / fetchScysComments / fetchScysCourse）

**Files:**
- Modify: `src/utils/scys-extractor.ts`
- Modify: `src/utils/scys-extractor.test.ts`

- [ ] **Step 1: 写失败测试**

追加到 `scys-extractor.test.ts`：

```ts
import { fetchScysChapter, fetchScysComments } from './scys-extractor';

describe('fetchScysChapter', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('hits /search/course/getChapterContent with credentials and returns chapter object', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { chapter: { id: 11408, title: 'X', content: [] } } }),
    } as any);
    const result = await fetchScysChapter(172, 11408);
    expect(global.fetch).toHaveBeenCalledWith(
      '/search/course/getChapterContent?course_id=172&chapter_id=11408',
      { credentials: 'include' }
    );
    expect(result).toEqual({ id: 11408, title: 'X', content: [] });
  });

  it('returns null on HTTP error', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 } as any);
    expect(await fetchScysChapter(172, 11408)).toBeNull();
  });

  it('returns null on missing data.chapter', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: {} }),
    } as any);
    expect(await fetchScysChapter(172, 11408)).toBeNull();
  });
});

describe('fetchScysComments', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  it('paginates until total reached, merging items and users', async () => {
    const pages = [
      { data: { total: 25, items: Array(20).fill(null).map((_, i) => ({ id: i, user_id: i, content: [], comments: null, like_count: 0, created_at: 0 })), extra: { users: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] } } },
      { data: { total: 25, items: Array(5).fill(null).map((_, i) => ({ id: 20 + i, user_id: 20 + i, content: [], comments: null, like_count: 0, created_at: 0 })), extra: { users: [{ id: 2, name: 'B' }, { id: 3, name: 'C' }] } } },
    ];
    let n = 0;
    global.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve(pages[n++]) } as any)
    );
    const result = await fetchScysComments(172, 11408);
    expect(result?.items).toHaveLength(25);
    expect(result?.users.size).toBe(3);
    expect(result?.users.get(2)?.name).toBe('B');
    expect(result?.total).toBe(25);
  });

  it('stops if page returns empty items even before total reached (safety)', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { total: 100, items: [], extra: { users: [] } } }),
    } as any);
    const result = await fetchScysComments(172, 11408);
    expect(result?.items).toHaveLength(0);
  });

  it('returns null on first-page fetch error (caller decides whether to skip comments)', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false } as any);
    expect(await fetchScysComments(172, 11408)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
npx vitest run src/utils/scys-extractor.test.ts
```

Expected: FAIL with "fetchScysChapter is not exported"

- [ ] **Step 3: 实现 API 调用**

追加到 `src/utils/scys-extractor.ts`：

```ts
export interface ScysChapter {
  id: number;
  title: string;
  content: ScysBlock[];
}

export interface ScysComment {
  id: number;
  user_id: number;
  title?: string;
  content: ScysBlock[];
  comments?: ScysComment[] | null;
  like_count: number;
  created_at: number;
}

export interface ScysUser { id: number; name: string; avatar?: string }

export interface ScysCommentsResult {
  total: number;
  items: ScysComment[];
  users: Map<number, ScysUser>;
}

export async function fetchScysChapter(courseId: number, chapterId: number): Promise<ScysChapter | null> {
  try {
    const res = await fetch(
      `/search/course/getChapterContent?course_id=${courseId}&chapter_id=${chapterId}`,
      { credentials: 'include' }
    );
    if (!res.ok) {
      logger.warn(`[chapter] HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    const chapter = json?.data?.chapter;
    if (!chapter || !Array.isArray(chapter.content)) return null;
    return chapter as ScysChapter;
  } catch (err) {
    logger.warn(`[chapter] fetch error: ${String(err)}`);
    return null;
  }
}

export async function fetchScysComments(courseId: number, chapterId: number): Promise<ScysCommentsResult | null> {
  const pageSize = 20;
  const items: ScysComment[] = [];
  const users = new Map<number, ScysUser>();
  let total = 0;
  let page = 1;

  while (true) {
    let json: any;
    try {
      const res = await fetch(
        `/search/course/getCourseComments?course_id=${courseId}&chapter_id=${chapterId}&page=${page}&page_size=${pageSize}&sort_by=most_likes`,
        { credentials: 'include' }
      );
      if (!res.ok) {
        if (page === 1) return null;
        break;
      }
      json = await res.json();
    } catch (err) {
      logger.warn(`[comments page=${page}] fetch error: ${String(err)}`);
      if (page === 1) return null;
      break;
    }

    const data = json?.data;
    if (!data) {
      if (page === 1) return null;
      break;
    }
    total = data.total ?? total;
    const pageItems: ScysComment[] = Array.isArray(data.items) ? data.items : [];
    items.push(...pageItems);
    for (const u of data.extra?.users ?? []) {
      if (u?.id) users.set(u.id, { id: u.id, name: u.name, avatar: u.avatar });
    }
    if (pageItems.length === 0) break;
    if (items.length >= total) break;
    page++;
    // Safety cap
    if (page > 50) {
      logger.warn(`[comments] page cap reached at 50, breaking`);
      break;
    }
  }
  return { total, items, users };
}

export async function fetchScysCourse(courseId: number): Promise<{ title?: string; author?: string } | null> {
  try {
    const res = await fetch(`/search/course/getCourseDetail?course_id=${courseId}`, { credentials: 'include' });
    if (!res.ok) return null;
    const json = await res.json();
    const course = json?.data?.course ?? json?.data;
    if (!course) return null;
    return {
      title: course.title || course.name,
      author: course.author || course.teacher_name || course.creator_name,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 跑测试验证通过**

```bash
npx vitest run src/utils/scys-extractor.test.ts
```

Expected: PASS (30 tests)

- [ ] **Step 5: Commit**

```bash
git add src/utils/scys-extractor.ts src/utils/scys-extractor.test.ts
git commit -m "feat(scys): add API calls for chapter, comments (paginated) and course meta"
```

---

## Task 6: 评论 markdown 渲染（callout + 嵌套回复）

**Files:**
- Modify: `src/utils/scys-extractor.ts`
- Modify: `src/utils/scys-extractor.test.ts`

- [ ] **Step 1: 写失败测试**

追加到 `scys-extractor.test.ts`：

```ts
import { renderScysComments, formatScysCommentHeader } from './scys-extractor';

describe('formatScysCommentHeader', () => {
  it('formats with user, likes>0, and date', () => {
    const users = new Map([[1, { id: 1, name: '叁斤' }]]);
    expect(formatScysCommentHeader({ user_id: 1, like_count: 9, created_at: 1715000000 } as any, users))
      .toBe('**叁斤** · 9 ❤️ · 2024-05-06');
  });
  it('omits ❤️ segment when like_count is 0', () => {
    const users = new Map([[1, { id: 1, name: '叁斤' }]]);
    expect(formatScysCommentHeader({ user_id: 1, like_count: 0, created_at: 1715000000 } as any, users))
      .toBe('**叁斤** · 2024-05-06');
  });
  it('falls back to anonymous when user not in map', () => {
    expect(formatScysCommentHeader({ user_id: 999, like_count: 0, created_at: 1715000000 } as any, new Map()))
      .toBe('**匿名#999** · 2024-05-06');
  });
});

describe('renderScysComments', () => {
  const baseUsers = new Map([
    [1, { id: 1, name: '叁斤' }],
    [2, { id: 2, name: '杨树亮' }],
    [3, { id: 3, name: 'Gaby' }],
  ]);
  const mkComment = (id: number, userId: number, likes: number, createdAt: number, content: ScysBlock[], replies?: ScysComment[]): ScysComment => ({
    id, user_id: userId, like_count: likes, created_at: createdAt, content, comments: replies ?? null,
  });
  const textBlock = (s: string): ScysBlock => ({ block_id: `t${Math.random()}`, block_type: 2, text: { elements: [{ text_run: { content: s } }] } });

  it('renders empty section when no items', () => {
    expect(renderScysComments({ total: 0, items: [], users: baseUsers }).trim()).toBe('');
  });

  it('renders H2 header and one main comment with body', () => {
    const result: ScysCommentsResult = {
      total: 1, users: baseUsers,
      items: [mkComment(1, 1, 9, 1715000000, [textBlock('hello world')])],
    };
    const md = renderScysComments(result);
    expect(md).toContain('## 💬 章节评论（1 条）');
    expect(md).toContain('> [!quote]+ **叁斤** · 9 ❤️ · 2024-05-06');
    expect(md).toContain('> hello world');
  });

  it('renders nested replies with > > prefix and triple-nested with > > >', () => {
    const lvl3 = mkComment(3, 3, 0, 1715000000, [textBlock('深嵌套')]);
    const lvl2 = mkComment(2, 2, 2, 1715000000, [textBlock('一级回复')], [lvl3]);
    const top = mkComment(1, 1, 9, 1715000000, [textBlock('主评论')], [lvl2]);
    const md = renderScysComments({ total: 1, items: [top], users: baseUsers });
    expect(md).toMatch(/^> \[!quote\]\+/m);
    expect(md).toContain('> 主评论');
    expect(md).toContain('> > **杨树亮** · 2 ❤️');
    expect(md).toContain('> > 一级回复');
    expect(md).toContain('> > > **Gaby**');
    expect(md).toContain('> > > 深嵌套');
  });

  it('uses total in header even when items < total (e.g. pagination edge)', () => {
    const result: ScysCommentsResult = {
      total: 70, users: baseUsers,
      items: [mkComment(1, 1, 0, 1715000000, [textBlock('x')])],
    };
    expect(renderScysComments(result)).toContain('## 💬 章节评论（70 条）');
  });
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
npx vitest run src/utils/scys-extractor.test.ts
```

Expected: FAIL with "renderScysComments is not exported"

- [ ] **Step 3: 实现评论渲染**

追加到 `src/utils/scys-extractor.ts`：

```ts
function formatScysDate(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function formatScysCommentHeader(comment: ScysComment, users: Map<number, ScysUser>): string {
  const user = users.get(comment.user_id);
  const name = user?.name ?? `匿名#${comment.user_id}`;
  const date = formatScysDate(comment.created_at);
  const likes = comment.like_count > 0 ? ` · ${comment.like_count} ❤️` : '';
  return `**${name}**${likes} · ${date}`;
}

function htmlToMdSafe(html: string): string {
  // Comment content is small; basic HTML → plaintext markdown bridge.
  // Use the same pipeline as chapter (convertBlocksToHtml outputs <p>/<ul>/<ol>/<strong>/<em>/<a>/etc).
  // For the comment section we need lines prefixed with `> `. The simplest robust approach:
  // 1) Strip <p> wrappers (replace open with '' and close with '\n')
  // 2) Convert <strong> → **, <em> → *, <a href="X">Y</a> → [Y](X)
  // 3) Convert <ul><li>x</li></ul> → "- x\n", <ol><li>x</li></ol> → "1. x\n"
  // 4) Strip remaining HTML tags
  let s = html;
  s = s.replace(/<\/p>\s*<p>/g, '\n\n');
  s = s.replace(/<p>/g, '').replace(/<\/p>/g, '\n');
  s = s.replace(/<strong>([\s\S]*?)<\/strong>/g, '**$1**');
  s = s.replace(/<em>([\s\S]*?)<\/em>/g, '*$1*');
  s = s.replace(/<code>([\s\S]*?)<\/code>/g, '`$1`');
  s = s.replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, '[$2]($1)');
  s = s.replace(/<li>([\s\S]*?)<\/li>/g, '- $1\n');
  s = s.replace(/<\/?(ul|ol)>/g, '');
  s = s.replace(/<br\s*\/?>/g, '\n');
  s = s.replace(/<[^>]+>/g, ''); // strip remaining tags
  s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
  return s.trim();
}

function prefixLines(text: string, prefix: string): string {
  return text.split('\n').map(line => line ? `${prefix} ${line}` : prefix.trimEnd()).join('\n');
}

function renderOneComment(comment: ScysComment, users: Map<number, ScysUser>, depth: number): string {
  const prefix = '>'.repeat(depth + 1);
  const headerLine = depth === 0
    ? `${prefix} [!quote]+ ${formatScysCommentHeader(comment, users)}`
    : `${prefix} ${formatScysCommentHeader(comment, users)}`;
  const bodyHtml = convertBlocksToHtml(flattenScysBlocks(comment.content ?? []));
  const bodyMd = htmlToMdSafe(bodyHtml);
  const bodyPrefixed = bodyMd ? prefixLines(bodyMd, prefix) : '';

  const parts: string[] = [headerLine];
  if (bodyPrefixed) parts.push(bodyPrefixed);

  const replies = Array.isArray(comment.comments) ? comment.comments : [];
  for (const reply of replies) {
    parts.push(prefix); // empty quote line as separator
    parts.push(renderOneComment(reply, users, depth + 1));
  }
  return parts.join('\n');
}

export function renderScysComments(result: ScysCommentsResult): string {
  if (!result.items.length) return '';
  const header = `## 💬 章节评论（${result.total} 条）`;
  const body = result.items.map(item => renderOneComment(item, result.users, 0)).join('\n\n');
  return `\n\n---\n\n${header}\n\n${body}\n`;
}
```

- [ ] **Step 4: 跑测试验证通过**

```bash
npx vitest run src/utils/scys-extractor.test.ts
```

Expected: PASS (36 tests)

- [ ] **Step 5: 加 fixture 测试（真实评论数据）**

追加到 `scys-extractor.test.ts`：

```ts
import fixtureComments from './fixtures/scys-comments-11408.json';

describe('renderScysComments (real fixture)', () => {
  const fix = fixtureComments as any;
  const users = new Map<number, ScysUser>();
  for (const u of fix.data.extra.users) users.set(u.id, u);
  const result: ScysCommentsResult = {
    total: fix.data.total,
    items: fix.data.items,
    users,
  };

  it('renders header with 70 total comments', () => {
    expect(renderScysComments(result)).toContain('## 💬 章节评论（70 条）');
  });

  it('includes at least one reply nested with > > prefix', () => {
    const md = renderScysComments(result);
    expect(md).toMatch(/^> >\s+\*\*/m);
  });

  it('shows ❤️ for at least one main comment (likes > 0)', () => {
    const md = renderScysComments(result);
    expect(md).toMatch(/❤️/);
  });
});
```

```bash
npx vitest run src/utils/scys-extractor.test.ts
```

Expected: PASS (39 tests)

- [ ] **Step 6: Commit**

```bash
git add src/utils/scys-extractor.ts src/utils/scys-extractor.test.ts
git commit -m "feat(scys): render comments as nested Obsidian callouts"
```

---

## Task 7: 主入口 extractScysStructuredContent

**Files:**
- Modify: `src/utils/scys-extractor.ts`

- [ ] **Step 1: 实现主入口**

追加到 `src/utils/scys-extractor.ts`：

```ts
export interface ScysStructuredContent {
  title: string;
  author: string;
  content: string;
  wordCount: number;
}

function countWordsFromBlocks(blocks: FeishuBlock[]): number {
  let n = 0;
  for (const b of blocks) {
    const body =
      b.text || (b as any).heading1 || (b as any).heading2 || (b as any).heading3 ||
      (b as any).heading4 || (b as any).heading5 || (b as any).heading6 ||
      b.bullet || b.ordered || b.code || b.quote || b.callout;
    if (!body?.elements) continue;
    for (const el of body.elements) {
      const c = el.text_run?.content || '';
      n += c.length;
    }
  }
  return n;
}

export async function extractScysStructuredContent(doc: Document): Promise<ScysStructuredContent | null> {
  if (!isScysCourseUrl(doc.URL)) return null;
  const parsed = parseScysUrl(doc.URL);
  if (!parsed) return null;

  const chapter = await fetchScysChapter(parsed.courseId, parsed.chapterId);
  if (!chapter) {
    logger.warn(`Chapter fetch failed for course=${parsed.courseId} chapter=${parsed.chapterId}`);
    return null;
  }

  // Render chapter body (HTML, with feishu-image://scys: placeholders)
  let html = renderScysChapterContent(chapter.content);
  // L1 image resolution
  html = await resolveScysImages(html);

  // Fetch comments + course meta in parallel; both optional
  const [commentsResult, courseMeta] = await Promise.all([
    fetchScysComments(parsed.courseId, parsed.chapterId),
    fetchScysCourse(parsed.courseId),
  ]);

  // Comments markdown (already resolves its own images via flattenScysBlocks + resolveScysImages? — no, comments use raw HTML inside callouts; image inside comments will keep scys: placeholder. To resolve, run resolveScysImages on the rendered comments HTML before htmlToMdSafe.)
  // We need a tweak: inside renderOneComment, after convertBlocksToHtml, await resolveScysImages.
  // (Implementation note: renderScysComments needs to be async if it resolves images inline. Refactor below.)

  let commentsMd = '';
  if (commentsResult && commentsResult.items.length) {
    // Re-render comments asynchronously to resolve inline images
    commentsMd = await renderScysCommentsAsync(commentsResult);
  }

  const flatBlocks = flattenScysBlocks(chapter.content);
  const wordCount = countWordsFromBlocks(flatBlocks);

  return {
    title: chapter.title,
    author: courseMeta?.author || '',
    content: html + commentsMd,
    wordCount,
  };
}
```

- [ ] **Step 2: 把 renderScysComments 重构为 async (resolveScysImages 内部已 async)**

替换 Task 6 实现中的 `renderOneComment` / `renderScysComments`：

```ts
async function renderOneCommentAsync(comment: ScysComment, users: Map<number, ScysUser>, depth: number): Promise<string> {
  const prefix = '>'.repeat(depth + 1);
  const headerLine = depth === 0
    ? `${prefix} [!quote]+ ${formatScysCommentHeader(comment, users)}`
    : `${prefix} ${formatScysCommentHeader(comment, users)}`;
  let bodyHtml = convertBlocksToHtml(flattenScysBlocks(comment.content ?? []));
  bodyHtml = await resolveScysImages(bodyHtml);
  const bodyMd = htmlToMdSafe(bodyHtml);
  const bodyPrefixed = bodyMd ? prefixLines(bodyMd, prefix) : '';

  const parts: string[] = [headerLine];
  if (bodyPrefixed) parts.push(bodyPrefixed);

  const replies = Array.isArray(comment.comments) ? comment.comments : [];
  for (const reply of replies) {
    parts.push(prefix);
    parts.push(await renderOneCommentAsync(reply, users, depth + 1));
  }
  return parts.join('\n');
}

export async function renderScysCommentsAsync(result: ScysCommentsResult): Promise<string> {
  if (!result.items.length) return '';
  const header = `## 💬 章节评论（${result.total} 条）`;
  const bodies = await Promise.all(result.items.map(item => renderOneCommentAsync(item, result.users, 0)));
  return `\n\n---\n\n${header}\n\n${bodies.join('\n\n')}\n`;
}

// Keep sync version for unit tests that don't need image resolution
export function renderScysComments(result: ScysCommentsResult): string {
  if (!result.items.length) return '';
  const header = `## 💬 章节评论（${result.total} 条）`;
  const body = result.items.map(item => renderOneComment(item, result.users, 0)).join('\n\n');
  return `\n\n---\n\n${header}\n\n${body}\n`;
}
```

- [ ] **Step 3: 跑全部单测验证**

```bash
npx vitest run src/utils/scys-extractor.test.ts
```

Expected: PASS (39 tests)

- [ ] **Step 4: Commit**

```bash
git add src/utils/scys-extractor.ts
git commit -m "feat(scys): add async main entry extractScysStructuredContent

Orchestrates chapter fetch, image resolution, comments fetch, and course meta.
Adds async comment renderer that resolves inline images."
```

---

## Task 8: 接入 content.ts

**Files:**
- Modify: `src/content.ts`

- [ ] **Step 1: 加 import**

`src/content.ts` 顶部 import 区，紧挨现有 feishu import：

```ts
import { extractFeishuStructuredContent, isFeishuDocUrl } from './utils/feishu-extractor';
import { extractScysStructuredContent, isScysCourseUrl } from './utils/scys-extractor';
```

- [ ] **Step 2: 加 scys 分支**

在 `src/content.ts` line ~274（feishuContent 之后、`const extractedContent` 之前）插入：

```ts
const scysContent = isScysCourseUrl(document.URL)
  ? await extractScysStructuredContent(document).catch((error) => {
      contentLogger.warn('Failed to extract scys structured content', { error: String(error) });
      return null;
    })
  : null;
```

- [ ] **Step 3: 加合并逻辑**

在 `if (bilibiliContent) { ... }` 块之后、`const parser = new DOMParser();` 之前插入：

```ts
if (scysContent) {
  extractedContent.title = scysContent.title;
  extractedContent.author = scysContent.author;
  extractedContent.content = scysContent.content;
  extractedContent.wordCount = String(scysContent.wordCount);
  extractedContent.description = '';
}
```

- [ ] **Step 4: TypeScript 类型检查**

```bash
npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 5: 跑全部测试**

```bash
npm test
```

Expected: all PASS (含现有 feishu / bilibili / scys 等)

- [ ] **Step 6: Commit**

```bash
git add src/content.ts
git commit -m "feat(scys): wire scys-extractor into content.ts extraction flow"
```

---

## Task 9: Manifest host_permissions

**Files:**
- Modify: `src/manifest.chrome.json`
- Modify: `src/manifest.firefox.json`
- Modify: `src/manifest.safari.json`

- [ ] **Step 1: 找 chrome manifest 中现有 host_permissions**

```bash
grep -nE '"host_permissions"|feishu' src/manifest.chrome.json
```

记下 `host_permissions` 数组位置和现有条目。

- [ ] **Step 2: 添加 scys.com 条目到三份 manifest**

在 `src/manifest.chrome.json`、`src/manifest.firefox.json`、`src/manifest.safari.json` 的 `host_permissions` 数组中追加：

```json
"https://scys.com/*"
```

确保 JSON 数组语法正确（前一个元素后加逗号）。

- [ ] **Step 3: 验证三个 manifest 都包含 scys.com**

```bash
grep -l "scys.com" src/manifest.chrome.json src/manifest.firefox.json src/manifest.safari.json
```

Expected: 三个文件名全列出

- [ ] **Step 4: 构建验证**

```bash
npm run build:chrome 2>&1 | tail -20
```

Expected: build success（无 manifest 校验错误）

- [ ] **Step 5: Commit**

```bash
git add src/manifest.chrome.json src/manifest.firefox.json src/manifest.safari.json
git commit -m "feat(scys): add scys.com to host_permissions across all manifests"
```

---

## Task 10: 图片 L2 fallback（background MAIN-world fetch）

> **可选 Task**：仅在 Task 12 端到端测试中发现 L1 同源 fetch 因 OSS CORS 被拒时执行。若 L1 全部成功，本 Task 跳过。

**Files:**
- Modify: `src/background.ts`
- Modify: `src/utils/scys-extractor.ts`

- [ ] **Step 1: 在 background.ts 加 fetchScysImagesViaMainWorld action handler**

参照 `src/background.ts:776-885` 的 `fetchFeishuImagesViaMainWorld` 模式，新增：

```ts
if (typedRequest.action === 'fetchScysImagesViaMainWorld') {
  const tabId = sender.tab?.id;
  if (!tabId) { sendResponse({ success: false, error: 'No tab ID' }); return true; }
  const urls = (typedRequest as any).urls as string[];
  if (!Array.isArray(urls) || urls.length === 0) {
    sendResponse({ success: false, error: 'Missing urls' });
    return true;
  }
  chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (urls: string[]) => {
      const results: Record<string, string> = {};
      // IMPORTANT: Promise chains only, no async/await (no __awaiter in MAIN world injection)
      const fetchOne = function(url: string): Promise<void> {
        return fetch(url, { credentials: 'include' }).then(function(res: Response) {
          if (!res.ok) return;
          const mime = (res.headers.get('Content-Type') || 'image/png').split(';')[0].trim();
          return res.arrayBuffer().then(function(buf: ArrayBuffer) {
            const bytes = new Uint8Array(buf);
            let bin = '';
            for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
            results[url] = 'data:' + mime + ';base64,' + btoa(bin);
          });
        }).catch(function() { /* ignore */ });
      };
      return urls.reduce(function(chain: Promise<void>, u: string) {
        return chain.then(function() { return fetchOne(u); });
      }, Promise.resolve()).then(function() {
        return { success: true as const, results };
      });
    },
    args: [urls],
  }, (injection: any) => {
    const out = injection?.[0]?.result;
    if (out?.success) sendResponse(out);
    else sendResponse({ success: false, error: 'executeScript no result' });
  });
  return true;
}
```

同步在 line ~1257 的 action 白名单数组中加 `'fetchScysImagesViaMainWorld'`。

- [ ] **Step 2: 在 scys-extractor 中加 L2 调用**

修改 `resolveScysImages` 函数，加 L2 fallback：

```ts
export async function resolveScysImages(html: string): Promise<string> {
  const tokenPattern = /feishu-image:\/\/(scys:[^"'\s>]+)/g;
  const tokens = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(html)) !== null) tokens.add(match[1]);
  if (tokens.size === 0) return html;

  const replacements = new Map<string, string>();

  // L1: same-origin fetch in content-script
  await Promise.all(Array.from(tokens).map(async (token) => {
    const dataUrl = await fetchScysImageL1(token);
    if (dataUrl) replacements.set(token, dataUrl);
  }));

  // L2: for unresolved, ask background to run MAIN-world fetch
  const unresolved = Array.from(tokens).filter(t => !replacements.has(t));
  if (unresolved.length > 0 && typeof browser !== 'undefined') {
    const urls = unresolved.map(t => decodeURIComponent(t.replace(/^scys:/, '')));
    try {
      const resp = await browser.runtime.sendMessage({
        action: 'fetchScysImagesViaMainWorld',
        urls,
      }) as { success?: boolean; results?: Record<string, string> };
      if (resp?.success && resp.results) {
        for (const token of unresolved) {
          const url = decodeURIComponent(token.replace(/^scys:/, ''));
          if (resp.results[url]) replacements.set(token, resp.results[url]);
        }
      }
    } catch (err) {
      logger.warn(`[scys-img L2] error: ${String(err)}`);
    }
  }

  let resolved = html;
  for (const [token, dataUrl] of replacements) {
    resolved = resolved.split(`feishu-image://${token}`).join(dataUrl);
  }
  return resolved;
}
```

需要在 scys-extractor.ts 顶部加 `import browser from 'webextension-polyfill';` 如果尚未导入。

- [ ] **Step 3: 跑现有单测验证 L1 路径仍通过**

```bash
npx vitest run src/utils/scys-extractor.test.ts
```

Expected: PASS（L2 的 browser.runtime.sendMessage 在 vitest 环境下 typeof browser !== 'undefined' 可能为 true 但被 mock；若失败补 mock）

- [ ] **Step 4: Commit**

```bash
git add src/background.ts src/utils/scys-extractor.ts
git commit -m "feat(scys): add image L2 fallback via background MAIN-world fetch"
```

---

## Task 11: 端到端验收闭环

**Files:**（仅手动验证 + 产出最终修复 commit）

- [ ] **Step 1: dev build 并装扩展**

```bash
npm run dev:chrome
```

Chrome `chrome://extensions/` → 加载已解压扩展 → 选 `dev/` 目录。

(若已加载，按"重新加载"按钮，或等 build-marker 自动触发。)

- [ ] **Step 2: 触发裁剪**

打开 `https://scys.com/course/detail/172?chapterId=11408`，登录后等正文加载，点击扩展图标 → 用默认模板保存到 Obsidian。

- [ ] **Step 3: 读取保存的 md 并跑验收清单**

```bash
ls -t "/Users/adu/Documents/Obsidian /Life/Clippings/"*.md | head -1
```

取最新 .md，用以下 grep 命令逐条验证（替换 `<file>` 为最新文件路径）：

```bash
file="<file>"
echo "==== title ===="
head -5 "$file" | grep -E '^title:'

echo "==== headings ===="
echo "Expected h2 count >= 6 (chapter headings rewritten):"
grep -cE '^## ' "$file"
echo "Expected h3 count >= 5:"
grep -cE '^### ' "$file"
echo "Expected h4 count >= 3:"
grep -cE '^#### ' "$file"

echo "==== specific headings ===="
grep -E '^## (0|1|2)\. ' "$file"

echo "==== images ===="
echo "Expected: base64 images embedded (>= 50):"
grep -cE 'data:image/[a-z]+;base64,' "$file"
echo "Expected: NO oss signed URLs left:"
grep -cE 'sphere-sh\.oss-cn-shanghai\.aliyuncs\.com' "$file"

echo "==== lists ===="
echo "Expected: ordered list items (>= 10):"
grep -cE '^[0-9]+\. ' "$file"
echo "Expected: bullet list items (>= 33):"
grep -cE '^- ' "$file"

echo "==== tables ===="
echo "Expected table separator rows (>= 4):"
grep -cE '^\|.*\|.*\|$' "$file"

echo "==== callouts ===="
echo "Expected: body 4 callout blocks render as plain blockquotes (current feishu-extractor behavior)."
echo "Comment-section quote callouts (one per main comment):"
grep -cE '> \[!quote\]\+' "$file"
echo "Body callout blockquotes (lines starting with > but not [!quote]):"
grep -cE '^> [^[]' "$file" | head -1

echo "==== comments section ===="
echo "Expected H2 comments header:"
grep -E '^## 💬 章节评论' "$file"
echo "Expected nested replies (> > prefix):"
grep -cE '^> > \*\*' "$file"
```

- [ ] **Step 4: 对照 spec §5.3 验收清单逐条勾选**

记录每条 pass/fail。若有 fail：

- **图片仍是 OSS URL（L1 失败）**：执行 Task 10（图片 L2 fallback）
- **某 block 类型未渲染**：检查 feishu-extractor.renderBlock 是否处理该 type，必要时在 scys-extractor 加 fallback
- **评论嵌套层级错误**：检查 renderOneCommentAsync 的 depth 参数传递

修复后回 Step 2 重新触发裁剪。

- [ ] **Step 5: 通过全部验收后，commit 任何修复**

```bash
git add -A
git status  # 确认无意外文件
git commit -m "fix(scys): {根据实际修复填}"
```

- [ ] **Step 6: 跑全量构建确保跨浏览器没有 regression**

```bash
npm run build 2>&1 | tail -30
```

Expected: chrome/firefox/safari 三个 build 全部 success。

- [ ] **Step 7: 跑全部单测**

```bash
npm test
```

Expected: all PASS

- [ ] **Step 8: 最终 commit（如需）**

```bash
git status
# 若有未 commit 的修改：
git add -A
git commit -m "chore(scys): finalize end-to-end acceptance"
```

---

## Spec-Plan Deltas（自审记录）

1. **正文 callout 不输出 Obsidian callout 语法**：spec §5.3 验收清单第 5 条「4 个 callout block 为 `> [!tip]` / `> [!warning]`」**未在本 plan 中实现**。原因：现有 `feishu-extractor.renderBlock` 把 CALLOUT 输出为 `<blockquote class="feishu-callout">`，turndown 后是普通 `> ` 引用。改造它会污染飞书提取行为。务实取舍：正文 callout 保留为普通 blockquote，评论区每条主评论的 `> [!quote]+` callout 已满足"评论可识别"的核心需求。Task 11 验收清单据此调整。

2. **评论里 `htmlToMdSafe` 简易实现**：把 `<ol><li>` 转为 `- ` 而非 `1. `（unordered 替代 ordered）。评论里复杂列表罕见，YAGNI。实际验收发现问题再扩展。

## 后续改进（不在本计划范围内）

- 评论分页 progress logging（实测 70 条 4 页约 1-2 秒；200+ 条章节体验可能差）
- 评论 fetch 失败时在 markdown 末尾加 `> [!warning] 评论加载失败` 标记，而非静默省略
- 把 `htmlToMdSafe` 统一替换为 turndown（需重构 content.ts 入口以让评论也走主流水线）
- 改造 feishu-extractor CALLOUT 输出 `data-callout-type` 属性 + turndown 规则识别 → Obsidian `[!tip]` 语法（解决 Spec-Plan Delta #1，需评估对飞书提取的兼容性）
