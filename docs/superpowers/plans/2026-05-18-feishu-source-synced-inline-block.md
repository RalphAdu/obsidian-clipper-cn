# 飞书 SOURCE_SYNCED + inline_block + IMAGE caption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让飞书 docx 中以下三类内容不再丢失：（1）SOURCE_SYNCED 同步块容器（block_type=49）内的所有内容；（2）文本流通过 `inline_block` element 引用的 FILE/IMAGE；（3）IMAGE block 的 `image.caption.content` 说明文字。

**Architecture:** 单文件改动（`src/utils/feishu-extractor.ts`），新增一个 fixture + 测试。引入 `RenderCtx` 把 `blockMap / headingNumbers / consumedInlineIds` 三件套打包传递；`renderTextElements` 加 `inline_block` 分支，将引用 block id 登记到 `consumedInlineIds` 防重复；`renderBlock` 入口检查 `consumedInlineIds` 早返回；`SOURCE_SYNCED` 与 `VIEW/QUOTE_CONTAINER` 同分支走 `renderBlockChildren`；`IMAGE` 加 `<figcaption>`；`resolveFeishuFiles` 双 pass 区分顶层（`feishu-file-block://`，包 `<p>📎`）与 inline（`feishu-file-inline://`，仅替换 `<a>`）两种 placeholder。

**Tech Stack:** TypeScript / Webpack / Vitest（已有的 `convertBlocksToHtml` 测试模式）

参考 spec：`docs/superpowers/specs/2026-05-18-feishu-source-synced-inline-block-design.md`

---

## 文件结构

| 路径 | 操作 | 责任 |
|---|---|---|
| `src/utils/feishu-extractor.ts` | 修改 | 所有 render 逻辑改动 |
| `src/utils/fixtures/feishu-sa5w-inline-block-source-synced.json` | 新建 | 单元/audit 测试 fixture（精简自真实飞书 doc Sa5Wdx0…） |
| `src/utils/feishu-extractor.test.ts` | 修改 | 单元测试（5 个新增 case） |
| `src/utils/feishu-extractor.audit.test.ts` | 修改 | audit bucket（完整 pipeline 校验） |

`background.ts`、`manifest.*.json`、上游 `../obsidian-clipper/` 均**不动**。

---

## Task 1: 准备 fixture

**Files:**
- Create: `src/utils/fixtures/feishu-sa5w-inline-block-source-synced.json`

- [ ] **Step 1: 创建 fixture 文件**

写入以下 JSON（这是从真实飞书 doc `Sa5Wdx0Naoq2AExhFx1cKFrUnXd` 拉到的 block tree 精简版 — 保留三类关键 block：SOURCE_SYNCED+IMAGE+caption / inline_block→FILE / 对照组顶层 VIEW→FILE，去除其余 .mp4 噪音）：

```json
[
  {
    "block_id": "page",
    "block_type": 1,
    "page": { "elements": [], "style": { "align": 1 } },
    "children": ["sync1", "text1", "view1"]
  },
  {
    "block_id": "sync1",
    "block_type": 49,
    "parent_id": "page",
    "source_synced": {
      "elements": [{ "text_run": { "content": "同步块", "text_element_style": {} } }],
      "align": 1
    },
    "children": ["img1"]
  },
  {
    "block_id": "img1",
    "block_type": 27,
    "parent_id": "sync1",
    "image": {
      "token": "GI3bbDFW9oUf1WxuiAdcTsIrn9e",
      "width": 246,
      "height": 27,
      "align": 2,
      "scale": 1,
      "caption": { "content": "EXE为更新和启动的主要组件。" }
    }
  },
  {
    "block_id": "text1",
    "block_type": 2,
    "parent_id": "page",
    "text": {
      "elements": [
        {
          "inline_block": {
            "block_id": "file1",
            "text_element_style": {
              "bold": false,
              "inline_code": false,
              "italic": false,
              "strikethrough": false,
              "underline": false
            }
          }
        }
      ],
      "style": { "align": 1, "folded": false }
    },
    "children": ["file1"]
  },
  {
    "block_id": "file1",
    "block_type": 23,
    "parent_id": "text1",
    "file": {
      "name": "测试连通多账号软件小工具.bat",
      "token": "X5STbwerko4oM8xZXHLcxceXnlh"
    }
  },
  {
    "block_id": "view1",
    "block_type": 33,
    "parent_id": "page",
    "view": { "view_type": 2 },
    "children": ["file2"]
  },
  {
    "block_id": "file2",
    "block_type": 23,
    "parent_id": "view1",
    "file": {
      "name": "1.软件使用方法.mp4",
      "token": "MP4TokenABCDEFGHIJKLMNOP"
    }
  }
]
```

- [ ] **Step 2: 验证 JSON 可解析**

Run: `python3 -c "import json; print(len(json.load(open('src/utils/fixtures/feishu-sa5w-inline-block-source-synced.json'))))"`
Expected: `7`

- [ ] **Step 3: Commit**

```bash
git add src/utils/fixtures/feishu-sa5w-inline-block-source-synced.json
git commit -m "test(feishu): fixture — SOURCE_SYNCED + inline_block + IMAGE caption"
```

---

## Task 2: 扩展类型 + 引入 RenderCtx（无功能变更）

**Files:**
- Modify: `src/utils/feishu-extractor.ts` (interfaces near top, enum, all render function signatures)

**目标**：纯重构 + 类型扩展。不改任何渲染输出。现有所有测试必须依然全绿。

- [ ] **Step 1: 扩展 `FeishuTextBody.elements` 类型**

定位到 `interface FeishuTextBody`（约 line 44），把 `elements` 数组类型扩成：

```ts
interface FeishuTextBody {
  elements?: Array<{
    text_run?: FeishuTextRun;
    mention_user?: FeishuMentionUser;
    mention_doc?: { token?: string; title?: string; obj_type?: number; url?: string; text_element_style?: FeishuTextElement['text_element_style'] };
    equation?: { content?: string };
    inline_block?: { block_id: string; text_element_style?: FeishuTextElement['text_element_style'] };
  }>;
  style?: {
    align?: number;
    list?: { type?: string; indentLevel?: number; number?: number };
    quote?: boolean;
  };
}
```

- [ ] **Step 2: 扩展 `FeishuBlock` 接口**

加 `source_synced?` 字段；扩展 `image?` 字段加 `caption?`：

```ts
export interface FeishuBlock {
  // ... 既有字段保留 ...
  image?: { width?: number; height?: number; token?: string; caption?: { content?: string } };
  source_synced?: FeishuTextBody;
  // ... 其余字段保留 ...
}
```

- [ ] **Step 3: 加 `SOURCE_SYNCED: 49` 到 `FEISHU_BLOCK_TYPE` 枚举**

定位 `const FEISHU_BLOCK_TYPE` 对象（约 line 151），在结尾 `QUOTE_CONTAINER: 34,` 后面加：

```ts
const FEISHU_BLOCK_TYPE = {
  // ... 既有 ...
  QUOTE_CONTAINER: 34,
  SOURCE_SYNCED: 49,
} as const;
```

- [ ] **Step 4: 引入 `RenderCtx` 接口**

在 `convertBlocksToHtml` 上方（约 line 790 附近）加：

```ts
interface RenderCtx {
  blockMap: Map<string, FeishuBlock>;
  headingNumbers: Map<string, number>;
  consumedInlineIds: Set<string>;
}
```

- [ ] **Step 5: 改造所有 render 函数签名**

把以下函数签名中的 `(blockMap, headingNumbers, ...)` 全部统一替换为 `(ctx, ...)`，函数体内部把 `blockMap` 改为 `ctx.blockMap`、`headingNumbers` 改为 `ctx.headingNumbers`。涉及函数：

- `renderTextElements(elements, opts?)` → `renderTextElements(elements, ctx, opts?)`（ctx 作为第 2 个参数；现有 opts 后移至第 3 个）
- `renderBlock(block, blockMap, headingNumbers)` → `renderBlock(block, ctx)`
- `renderBlockChildren(block, blockMap, headingNumbers)` → `renderBlockChildren(block, ctx)`
- `renderChildren(childIds, blockMap, headingNumbers)` → `renderChildren(childIds, ctx)`
- `renderHeading(level, elements, _style, seqNumber?)` → `renderHeading(level, elements, _style, ctx, seqNumber?)`（注意 ctx 加在已有可选 `seqNumber` 之前）
- `renderListItem(block, blockMap, headingNumbers, appendHtml?)` → `renderListItem(block, ctx, appendHtml?)`
- `renderTodoItem(block, blockMap, headingNumbers, appendHtml?)` → `renderTodoItem(block, ctx, appendHtml?)`
- `collectListGroup(kind, childIds, startIdx, blockMap, headingNumbers)` → `collectListGroup(kind, childIds, startIdx, ctx)`
- `renderTable(block, blockMap, headingNumbers)` → `renderTable(block, ctx)`

每个函数体内所有出现的 `blockMap` / `headingNumbers` 标识符改为 `ctx.blockMap` / `ctx.headingNumbers`。

- [ ] **Step 6: 修改 `convertBlocksToHtml` 创建 ctx**

```ts
export function convertBlocksToHtml(blocks: FeishuBlock[], options?: { autoNumberHeadings?: boolean }): string {
  const blockMap = new Map<string, FeishuBlock>();
  for (const b of blocks) {
    blockMap.set(b.block_id, b);
  }

  const headingNumbers = new Map<string, number>();
  if (options?.autoNumberHeadings) {
    let h1Seq = 0;
    let h4Seq = 0;
    for (const b of blocks) {
      if (b.block_type === FEISHU_BLOCK_TYPE.HEADING1) {
        h1Seq += 1;
        headingNumbers.set(b.block_id, h1Seq);
      } else if (b.block_type === FEISHU_BLOCK_TYPE.HEADING2) {
        h4Seq = 0;
      } else if (b.block_type === FEISHU_BLOCK_TYPE.HEADING4) {
        h4Seq += 1;
        headingNumbers.set(b.block_id, h4Seq);
      }
    }
  }

  const ctx: RenderCtx = { blockMap, headingNumbers, consumedInlineIds: new Set() };

  const pageBlock = blocks.find(b => b.block_type === FEISHU_BLOCK_TYPE.PAGE);
  if (!pageBlock?.children?.length) {
    return blocks.filter(b => b.block_type !== FEISHU_BLOCK_TYPE.PAGE)
      .map(b => renderBlock(b, ctx))
      .join('');
  }

  return renderChildren(pageBlock.children, ctx);
}
```

- [ ] **Step 7: TypeScript 编译验证**

Run: `npx tsc --noEmit`
Expected: 无错误（如果有 `blockMap` / `headingNumbers` 漏改的引用，编译器会指出来 — 一并修正）

- [ ] **Step 8: 跑测试看 baseline 不退步**

Run: `npm test`
Expected: 所有现有测试通过（与重构前同样的 pass 数）

- [ ] **Step 9: Commit**

```bash
git add src/utils/feishu-extractor.ts
git commit -m "refactor(feishu): introduce RenderCtx; extend types for inline_block/source_synced/image.caption"
```

---

## Task 3: IMAGE caption 渲染（TDD）

**Files:**
- Modify: `src/utils/feishu-extractor.test.ts` (add new describe block)
- Modify: `src/utils/feishu-extractor.ts` (`case FEISHU_BLOCK_TYPE.IMAGE` 渲染逻辑，约 line 1142)

- [ ] **Step 1: 写失败测试**

在 `src/utils/feishu-extractor.test.ts` 末尾追加：

```ts
import sa5wFixture from './fixtures/feishu-sa5w-inline-block-source-synced.json';

describe('convertBlocksToHtml — IMAGE caption', () => {
  it('renders <figcaption> when image.caption.content is non-empty', () => {
    const html = convertBlocksToHtml(sa5wFixture as unknown as FeishuBlock[]);
    expect(html).toContain('<figcaption>EXE为更新和启动的主要组件。</figcaption>');
  });

  it('omits <figcaption> when caption.content is missing', () => {
    const blocks: FeishuBlock[] = [
      { block_id: 'p', block_type: 1, page: { elements: [] }, children: ['i'] },
      { block_id: 'i', block_type: 27, parent_id: 'p', image: { token: 'T1', width: 100, height: 50 } } as any,
    ];
    const html = convertBlocksToHtml(blocks);
    expect(html).not.toContain('<figcaption>');
    expect(html).toContain('feishu-image://T1');
  });
});
```

- [ ] **Step 2: 跑测试看失败**

Run: `npx vitest run src/utils/feishu-extractor.test.ts -t "IMAGE caption"`
Expected: 第一条 FAIL（`<figcaption>` 不存在），第二条可能 PASS（之前就不输出 figcaption）

- [ ] **Step 3: 修改 case IMAGE 渲染**

定位 `case FEISHU_BLOCK_TYPE.IMAGE:`（约 line 1142），替换为：

```ts
case FEISHU_BLOCK_TYPE.IMAGE: {
  const img = block.image;
  if (!img?.token) return '';
  const captionHtml = img.caption?.content
    ? `<figcaption>${escapeHtml(img.caption.content)}</figcaption>`
    : '';
  return `<figure><img src="feishu-image://${img.token}" alt="" width="${img.width || ''}" height="${img.height || ''}">${captionHtml}</figure>`;
}
```

- [ ] **Step 4: 跑测试看通过**

Run: `npx vitest run src/utils/feishu-extractor.test.ts -t "IMAGE caption"`
Expected: 两条 PASS

- [ ] **Step 5: 跑完整测试套件确保无退步**

Run: `npm test`
Expected: 全绿（但注意：fixture 引入的 SOURCE_SYNCED / inline_block 相关断言还没加；现有 IMAGE 测试可能因 figcaption 不存在而对 HTML 串严格匹配的情况触发，需要根据真实失败信息酌情调整测试断言宽松度 — 优先用 `.toContain` 而非完整字符串相等）

- [ ] **Step 6: Commit**

```bash
git add src/utils/feishu-extractor.ts src/utils/feishu-extractor.test.ts
git commit -m "feat(feishu): render <figcaption> for IMAGE blocks with caption"
```

---

## Task 4: SOURCE_SYNCED case（TDD）

**Files:**
- Modify: `src/utils/feishu-extractor.test.ts` (add test)
- Modify: `src/utils/feishu-extractor.ts` (add `case FEISHU_BLOCK_TYPE.SOURCE_SYNCED`)

- [ ] **Step 1: 写失败测试**

在 `src/utils/feishu-extractor.test.ts` 末尾追加：

```ts
describe('convertBlocksToHtml — SOURCE_SYNCED (block_type 49)', () => {
  it('renders children of source_synced block (sync container contents preserved)', () => {
    const html = convertBlocksToHtml(sa5wFixture as unknown as FeishuBlock[]);
    expect(html).toContain('feishu-image://GI3bbDFW9oUf1WxuiAdcTsIrn9e');
  });

  it('discards source_synced.elements metadata text "同步块"', () => {
    const html = convertBlocksToHtml(sa5wFixture as unknown as FeishuBlock[]);
    expect(html).not.toContain('同步块');
  });
});
```

- [ ] **Step 2: 跑测试看失败**

Run: `npx vitest run src/utils/feishu-extractor.test.ts -t "SOURCE_SYNCED"`
Expected: 第一条 FAIL（IMAGE token 不出现 — 因为 SOURCE_SYNCED 落入 default）

- [ ] **Step 3: 加 SOURCE_SYNCED case**

定位 `case FEISHU_BLOCK_TYPE.VIEW:` / `case FEISHU_BLOCK_TYPE.QUOTE_CONTAINER:` 那段（约 line 1177）。把 `SOURCE_SYNCED` 加入同一分支：

```ts
case FEISHU_BLOCK_TYPE.VIEW:
case FEISHU_BLOCK_TYPE.QUOTE_CONTAINER:
case FEISHU_BLOCK_TYPE.SOURCE_SYNCED: {
  return renderBlockChildren(block, ctx);
}
```

- [ ] **Step 4: 跑测试看通过**

Run: `npx vitest run src/utils/feishu-extractor.test.ts -t "SOURCE_SYNCED"`
Expected: 两条 PASS

- [ ] **Step 5: 跑完整测试套件**

Run: `npm test`
Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add src/utils/feishu-extractor.ts src/utils/feishu-extractor.test.ts
git commit -m "feat(feishu): render SOURCE_SYNCED (type=49) as transparent children container"
```

---

## Task 5: inline_block element 渲染（TDD）

**Files:**
- Modify: `src/utils/feishu-extractor.test.ts` (add test)
- Modify: `src/utils/feishu-extractor.ts` (`renderTextElements` add inline_block branch + new `renderInlineBlock` helper)

- [ ] **Step 1: 写失败测试（inline FILE）**

在 `src/utils/feishu-extractor.test.ts` 末尾追加：

```ts
describe('convertBlocksToHtml — inline_block element', () => {
  it('renders inline_block→FILE as <a feishu-file-inline://> placeholder inside parent paragraph', () => {
    const html = convertBlocksToHtml(sa5wFixture as unknown as FeishuBlock[]);
    expect(html).toContain('<a href="feishu-file-inline://file1" data-filename="测试连通多账号软件小工具.bat">测试连通多账号软件小工具.bat</a>');
  });

  it('renders inline_block→IMAGE as bare <img> (no <figure> wrapping in inline context)', () => {
    const blocks: FeishuBlock[] = [
      { block_id: 'p', block_type: 1, page: { elements: [] }, children: ['t', 'i'] } as any,
      { block_id: 't', block_type: 2, parent_id: 'p', text: { elements: [{ inline_block: { block_id: 'i' } }] } } as any,
      { block_id: 'i', block_type: 27, parent_id: 't', image: { token: 'INLINE_T', width: 50, height: 50 } } as any,
    ];
    const html = convertBlocksToHtml(blocks);
    expect(html).toContain('<img src="feishu-image://INLINE_T" alt="">');
    // inline IMAGE should NOT be wrapped in <figure> (that's for standalone IMAGE blocks)
    const figureCount = (html.match(/<figure>/g) || []).length;
    expect(figureCount).toBe(0);
  });

  it('renders unsupported inline_block target as "[内联块 xxxxxxxx]" placeholder', () => {
    const blocks: FeishuBlock[] = [
      { block_id: 'p', block_type: 1, page: { elements: [] }, children: ['t', 'u'] } as any,
      { block_id: 't', block_type: 2, parent_id: 'p', text: { elements: [{ inline_block: { block_id: 'u12345678abc' } }] } } as any,
      { block_id: 'u12345678abc', block_type: 99, parent_id: 't' } as any,
    ];
    const html = convertBlocksToHtml(blocks);
    expect(html).toContain('[内联块 u1234567]');
  });
});
```

- [ ] **Step 2: 跑测试看失败**

Run: `npx vitest run src/utils/feishu-extractor.test.ts -t "inline_block"`
Expected: 三条全 FAIL

- [ ] **Step 3: 添加 `renderInlineBlock` helper**

在 `renderTextElements` 函数定义**之前**（约 line 665 处）插入：

```ts
function renderInlineBlock(blockId: string, ctx: RenderCtx): string {
  const target = ctx.blockMap.get(blockId);
  if (!target) return '';
  ctx.consumedInlineIds.add(blockId);
  switch (target.block_type) {
    case FEISHU_BLOCK_TYPE.FILE: {
      const file = target.file;
      if (!file?.name) return '';
      return `<a href="feishu-file-inline://${target.block_id}" data-filename="${escapeHtml(file.name)}">${escapeHtml(file.name)}</a>`;
    }
    case FEISHU_BLOCK_TYPE.IMAGE: {
      const img = target.image;
      if (!img?.token) return '';
      return `<img src="feishu-image://${img.token}" alt="">`;
    }
    default:
      return `[内联块 ${blockId.slice(0, 8)}]`;
  }
}
```

- [ ] **Step 4: 在 `renderTextElements` 加 inline_block 分支**

定位 `renderTextElements` 函数体内的 `elements.map((el) => { ... })`（约 line 669）。在 `equation` 分支之前加：

```ts
const rendered = elements.map((el) => {
  if (el.inline_block?.block_id) {
    return renderInlineBlock(el.inline_block.block_id, ctx);
  }
  if (el.equation?.content) {
    return `<code>${escapeHtml(el.equation.content)}</code>`;
  }
  // ... 其余既有分支不变 ...
});
```

- [ ] **Step 5: 跑测试看通过**

Run: `npx vitest run src/utils/feishu-extractor.test.ts -t "inline_block"`
Expected: 三条全 PASS

- [ ] **Step 6: 跑完整测试套件**

Run: `npm test`
Expected: 全绿

- [ ] **Step 7: Commit**

```bash
git add src/utils/feishu-extractor.ts src/utils/feishu-extractor.test.ts
git commit -m "feat(feishu): render inline_block text element (FILE/IMAGE inline reference)"
```

---

## Task 6: 去重 — consumedInlineIds 早返回（TDD）

**Files:**
- Modify: `src/utils/feishu-extractor.test.ts` (add test)
- Modify: `src/utils/feishu-extractor.ts` (`renderBlock` 入口加早返回)

- [ ] **Step 1: 写失败测试**

在 `src/utils/feishu-extractor.test.ts` 内的 `describe('convertBlocksToHtml — inline_block element', ...)` 块中追加：

```ts
it('does not double-render: inline-consumed FILE child is skipped during children traversal', () => {
  const html = convertBlocksToHtml(sa5wFixture as unknown as FeishuBlock[]);
  // file1 should appear exactly once (inline), not twice (inline + as text1's child)
  const fileOneMatches = html.match(/测试连通多账号软件小工具\.bat/g) || [];
  expect(fileOneMatches.length).toBe(1);
});
```

- [ ] **Step 2: 跑测试看失败**

Run: `npx vitest run src/utils/feishu-extractor.test.ts -t "double-render"`
Expected: FAIL（FILE 出现 2 次 — 一次 inline 一次作为 text1 的 child）

注意：如果 TEXT block 的 children 在当前实现中**不被遍历**（看代码 `case TEXT: const inner = renderTextElements(...); return <p>${inner}</p>;` 不带 children），此测试可能意外 PASS。先跑看实际行为：
- 若 PASS：在 spec 描述层已经天然不重复，本 task 直接跳到 Step 5（仍补一个 early-return 防御性兜底）
- 若 FAIL：按下方继续

- [ ] **Step 3: 加 renderBlock 入口早返回**

定位 `function renderBlock(block, ctx)` 起始（约 line 1039 改造后）。在 `switch` 之前加：

```ts
function renderBlock(block: FeishuBlock, ctx: RenderCtx): string {
  if (ctx.consumedInlineIds.has(block.block_id)) {
    return '';
  }
  switch (block.block_type) {
    // ... 既有 cases ...
  }
}
```

**注意**：此早返回不仅防御 TEXT.children 情况，也覆盖未来 inline_block 引用对象出现在 list group followers / table cells / callout children 等任何被遍历位置的场景。

- [ ] **Step 4: 跑测试看通过**

Run: `npx vitest run src/utils/feishu-extractor.test.ts -t "double-render"`
Expected: PASS

- [ ] **Step 5: 跑完整测试套件**

Run: `npm test`
Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add src/utils/feishu-extractor.ts src/utils/feishu-extractor.test.ts
git commit -m "feat(feishu): skip blocks already consumed via inline_block reference"
```

---

## Task 7: resolveFeishuFiles 加 inline pass（TDD）

**Files:**
- Modify: `src/utils/feishu-extractor.test.ts` (add test)
- Modify: `src/utils/feishu-extractor.ts` (`resolveFeishuFiles` 函数，约 line 439)

- [ ] **Step 1: 把 `resolveFeishuFiles` 导出**

`resolveFeishuFiles` 当前是 module-private 的。为了单元测试，把签名前面加 `export`：

```ts
export function resolveFeishuFiles(html: string, sourceDocUrl: string): string {
  // ... 函数体保持不变 ...
}
```

定位方式：`grep -n "function resolveFeishuFiles" src/utils/feishu-extractor.ts`

- [ ] **Step 2: 在测试文件顶部 import 中补 resolveFeishuFiles**

修改 `src/utils/feishu-extractor.test.ts` 的 import：

```ts
import { convertBlocksToHtml, resolveFeishuFiles, type FeishuBlock } from './feishu-extractor';
```

- [ ] **Step 3: 写失败测试**

在 `src/utils/feishu-extractor.test.ts` 末尾追加：

```ts
describe('resolveFeishuFiles — inline vs top-level placeholders', () => {
  const docUrl = 'https://my.feishu.cn/docx/DOC1';

  it('top-level feishu-file-block:// → wraps in <p>📎 <a>…</a></p>', () => {
    const input = '<a href="feishu-file-block://BLK1" data-filename="x.pdf">x.pdf</a>';
    const out = resolveFeishuFiles(input, docUrl);
    expect(out).toContain('<p>📎 <a href="https://my.feishu.cn/docx/DOC1#BLK1">x.pdf</a></p>');
  });

  it('inline feishu-file-inline:// → bare <a>, no <p>📎 wrapping', () => {
    const input = '<p>see <a href="feishu-file-inline://BLK2" data-filename="y.bat">y.bat</a> please</p>';
    const out = resolveFeishuFiles(input, docUrl);
    expect(out).toContain('<a href="https://my.feishu.cn/docx/DOC1#BLK2">y.bat</a>');
    expect(out).not.toContain('📎');
    expect(out).toContain('<p>see ');
    expect(out).toContain(' please</p>');
  });

  it('handles both placeholder kinds in the same HTML', () => {
    const input = '<a href="feishu-file-block://A" data-filename="a.pdf">a.pdf</a><p>x <a href="feishu-file-inline://B" data-filename="b.bat">b.bat</a> y</p>';
    const out = resolveFeishuFiles(input, docUrl);
    expect(out).toContain('<p>📎 <a href="https://my.feishu.cn/docx/DOC1#A">a.pdf</a></p>');
    expect(out).toContain('<p>x <a href="https://my.feishu.cn/docx/DOC1#B">b.bat</a> y</p>');
  });
});
```

- [ ] **Step 4: 跑测试看失败**

Run: `npx vitest run src/utils/feishu-extractor.test.ts -t "resolveFeishuFiles"`
Expected: inline 相关两条 FAIL（inline placeholder 当前未识别，会被原样保留）；top-level 那条 PASS（既有行为）

- [ ] **Step 5: 改造 resolveFeishuFiles 加第二个 pass**

替换 `resolveFeishuFiles` 函数体（约 line 439–462）为：

```ts
export function resolveFeishuFiles(html: string, sourceDocUrl: string): string {
  // Pass 1: top-level FILE block placeholder → <p>📎 <a>…</a></p>
  const topPattern = /<a href="feishu-file-block:\/\/([A-Za-z0-9_-]+)" data-filename="([^"]*)">([^<]*)<\/a>/g;
  let result = html.replace(topPattern, (_full, blockId, filename) => {
    const url = `${sourceDocUrl}#${blockId}`;
    return `<p>📎 <a href="${escapeHtml(url)}">${escapeHtml(filename)}</a></p>`;
  });

  // Pass 2: inline FILE placeholder → bare <a>…</a> (no <p>📎 wrap; sits inside existing <p>)
  const inlinePattern = /<a href="feishu-file-inline:\/\/([A-Za-z0-9_-]+)" data-filename="([^"]*)">([^<]*)<\/a>/g;
  result = result.replace(inlinePattern, (_full, blockId, filename) => {
    const url = `${sourceDocUrl}#${blockId}`;
    return `<a href="${escapeHtml(url)}">${escapeHtml(filename)}</a>`;
  });

  return result;
}
```

- [ ] **Step 6: 跑测试看通过**

Run: `npx vitest run src/utils/feishu-extractor.test.ts -t "resolveFeishuFiles"`
Expected: 三条 PASS

- [ ] **Step 7: 跑完整测试套件**

Run: `npm test`
Expected: 全绿

- [ ] **Step 8: Commit**

```bash
git add src/utils/feishu-extractor.ts src/utils/feishu-extractor.test.ts
git commit -m "feat(feishu): resolveFeishuFiles handles feishu-file-inline:// placeholder"
```

---

## Task 8: audit 测试 — 全 pipeline 不丢内容

**Files:**
- Modify: `src/utils/feishu-extractor.audit.test.ts` (add audit bucket)

- [ ] **Step 1: 检查 audit 测试现有结构**

Run: `head -80 src/utils/feishu-extractor.audit.test.ts`
观察现有 `describe` / `it` 的结构和 fixture 加载方式，模仿其格式。

- [ ] **Step 2: 添加 audit bucket**

在 `src/utils/feishu-extractor.audit.test.ts` 末尾追加（如该文件已有 fixture import 习惯，参考现有用法添加 import）：

```ts
import sa5wFixture from './fixtures/feishu-sa5w-inline-block-source-synced.json';

describe('audit — Sa5W… (SOURCE_SYNCED + inline_block + IMAGE caption)', () => {
  const docUrl = 'https://my.feishu.cn/docx/Sa5Wdx0Naoq2AExhFx1cKFrUnXd';

  it('full pipeline preserves all three previously-lost content kinds', () => {
    const rawHtml = convertBlocksToHtml(sa5wFixture as unknown as FeishuBlock[]);
    const finalHtml = resolveFeishuFiles(rawHtml, docUrl);

    // (1) SOURCE_SYNCED container's IMAGE survived
    expect(finalHtml).toContain('feishu-image://GI3bbDFW9oUf1WxuiAdcTsIrn9e');

    // (2) IMAGE caption surfaced
    expect(finalHtml).toContain('<figcaption>EXE为更新和启动的主要组件。</figcaption>');

    // (3) inline_block → FILE resolved to anchor link inside parent <p>
    expect(finalHtml).toContain(`<a href="${docUrl}#file1">测试连通多账号软件小工具.bat</a>`);
    // …and that anchor is NOT wrapped in a stray <p>📎
    expect(finalHtml).not.toMatch(/<p>📎 <a[^>]*>测试连通多账号软件小工具\.bat<\/a><\/p>/);

    // (4) Top-level VIEW→FILE (.mp4 control group) still renders with <p>📎 wrap
    expect(finalHtml).toContain(`<p>📎 <a href="${docUrl}#file2">1.软件使用方法.mp4</a></p>`);

    // (5) No unknown-block fallback marker (means all referenced inline targets resolved)
    expect(finalHtml).not.toContain('[内联块');
  });
});
```

import 块如果之前没有 `resolveFeishuFiles`，补：

```ts
import { convertBlocksToHtml, resolveFeishuFiles, type FeishuBlock } from './feishu-extractor';
```

- [ ] **Step 3: 跑 audit 测试**

Run: `npx vitest run src/utils/feishu-extractor.audit.test.ts -t "Sa5W"`
Expected: PASS

- [ ] **Step 4: 跑完整测试套件**

Run: `npm test`
Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add src/utils/feishu-extractor.audit.test.ts
git commit -m "test(feishu): audit — Sa5W doc end-to-end (SOURCE_SYNCED + inline_block + caption)"
```

---

## Task 9: 静态验证 + 构建

**Files:** 无（命令验证）

- [ ] **Step 1: TypeScript 编译**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 2: 全量测试**

Run: `npm test`
Expected: 全部通过；与改动前 baseline 对比，pass 数应增加 8–10（新增 cases）

- [ ] **Step 3: Chrome 生产构建**

Run: `npm run build:chrome`
Expected: 成功输出到 `dist/`

- [ ] **Step 4: 无 commit**（仅验证）

---

## Task 10: 手测（Chrome 扩展验证）

**Files:** 无（人工验证）

- [ ] **Step 1: 启动 dev watch**

Run: `npm run dev:chrome`（前台运行 / 后台均可）

- [ ] **Step 2: 在 Chrome 中加载扩展并打开目标文档**

URL：`https://my.feishu.cn/docx/Sa5Wdx0Naoq2AExhFx1cKFrUnXd`

- [ ] **Step 3: 触发裁剪，复制裁剪结果检查**

确认 Markdown 中包含：

- 「多账号浏览器新版20252.exe」那张截图（飞书截图本体，对应 `image.token=GI3bb…`）
- 「EXE为更新和启动的主要组件。」（应渲染为图片下方的一行文字 — 来自 `<figcaption>`）
- 「测试连通多账号软件小工具.bat」作为一个 Markdown 链接（点击会跳到 `…/Sa5Wdx0…#file1` 即真实的 `MNGzdb0d…` block id）

注意：fixture 中我们用 `file1` 作 block_id 是为了测试可读；真实文档的 `.bat` 文件 block_id 是 `MNGzdb0dNoL8DRx67c1crPjLnxb` — 在手测中会看到完整 id。

- [ ] **Step 4: 回归检查 — 其他飞书文档**

至少跑一个不含同步块/inline_block 的飞书文档，确认原有行为不变（纯文本 / 含图片 / 含 .mp4 顶层 VIEW FILE 链接）。

- [ ] **Step 5: 如有问题 → 反馈给主流程，不 commit**

- [ ] **Step 6: 如全部通过 → 通报完工**

不需要额外 commit；前序 commits 已是完整变更集。

---

## 验收清单（summary）

实施完成时，仓库状态应满足：

- [x] `src/utils/feishu-extractor.ts` 类型/枚举/render 函数已按 spec 扩展
- [x] `src/utils/fixtures/feishu-sa5w-inline-block-source-synced.json` 已存在并 7 个 block
- [x] `src/utils/feishu-extractor.test.ts` 新增 ≥7 个测试 case，全绿
- [x] `src/utils/feishu-extractor.audit.test.ts` 新增 `audit — Sa5W…` bucket，全绿
- [x] `npx tsc --noEmit` 无错
- [x] `npm test` 全绿（pass 数比 baseline 多 8–10）
- [x] `npm run build:chrome` 成功
- [x] 手测：上面 Task 10 三项内容在 Obsidian 中可见

总计预计 7 个 commit（1 fixture + 1 refactor + 5 feature/test pairs + 1 audit），约 2.5 小时。
