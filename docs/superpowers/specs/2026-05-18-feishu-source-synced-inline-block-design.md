# 飞书 SOURCE_SYNCED 同步块 + inline_block 内联引用 + IMAGE caption 设计文档

**日期**：2026-05-18
**目标**：让飞书 docx 中以下三类内容不再丢失：
1. 装在"同步块"（SOURCE_SYNCED, `block_type=49`）容器内的任何内容
2. 通过文本流 `inline_block` element 内联引用的 block（最常见是 FILE 文件链接）
3. IMAGE block 的 `image.caption.content` 说明文字

参考文档：`https://my.feishu.cn/docx/Sa5Wdx0Naoq2AExhFx1cKFrUnXd`（含三类丢失场景的真实样本）

## 1. 问题陈述

裁剪上述文档到 Obsidian 后，三处内容凭空消失：

### 1.1 同步块内的截图与 caption 丢失（图 1）

文档中"多账号浏览器新版20252.exe"那张截图 + 下方说明文字"EXE为更新和启动的主要组件。"完全没出现在 Markdown 中。

API 实际结构：

```
SOURCE_SYNCED (type=49, block_id=IKDCdxia..)
└── IMAGE (type=27, block_id=YMczd77V..)
    image.token = GI3bbDFW...
    image.caption.content = "EXE为更新和启动的主要组件。"
```

当前 `feishu-extractor.ts` 的 `FEISHU_BLOCK_TYPE` 枚举与 `switch (block.block_type)` **完全没有 49**，落入 `default: return ''`，整个 SOURCE_SYNCED 子树被丢弃，连同里面的 IMAGE 也没机会被渲染。

附带：即使 IMAGE 被渲染到，现有渲染逻辑 `<figure><img src="feishu-image://${token}" …></figure>` **也从不消费 `image.caption.content`**，caption 文字永远丢失。

### 1.2 文本内联文件链接丢失（图 2）

文档中段落「测试连通多账号软件小工具.bat」是一个蓝色内联链接，前面带 `</>` 图标。

API 实际结构：

```
TEXT (type=2, block_id=Ei81dlI1..)
├── text.elements: [
│     { "inline_block": { "block_id": "MNGzdb0d.." } }
│   ]
└── children: ["MNGzdb0d.."]     // 同一 block_id 也作为 child 单独存在
    └── FILE (type=23, block_id=MNGzdb0d..)
        file.name = "测试连通多账号软件小工具.bat"
        file.token = "X5STbwerko..."
```

飞书"内联文件"的存储方式：
- 父 TEXT block 的 `elements` 数组里放一个 **`inline_block`** 类型 element，仅含一个 `block_id` 引用
- 真正的 FILE block 作为这个 TEXT block 的 **children** 单独存在（而非顶层 VIEW 容器的 child）

当前 `renderTextElements` 仅识别 `text_run / mention_user / mention_doc / equation` 四种 element，**完全不认 `inline_block`** → 该 element 输出 `''`，父 TEXT block 渲染为空段落。

进一步：当前 TEXT block 的 case 渲染逻辑 `<p>${renderTextElements(...)}</p>` **不递归到 children**，所以下挂的 FILE child 也从未被路由到 `case FILE` 分支处理 → 完全丢失。

## 2. 设计概览

三类问题各自对应一处局部改动，**全部集中在 `src/utils/feishu-extractor.ts` 一文件内**，不动 `background.ts`，不动 manifest。

```
SOURCE_SYNCED (49) 处理
    → 加入 FEISHU_BLOCK_TYPE 枚举
    → switch case 与 VIEW / QUOTE_CONTAINER 同分支：renderBlockChildren()
    → source_synced.elements 中的占位文字（飞书 API 返回的 "同步块" 三字 metadata）整体丢弃

inline_block element 处理
    → 在 renderTextElements 中加 inline_block 分支
    → 通过 blockMap 查目标 block，按目标 block_type 选择 inline HTML：
        - FILE  → <a href="feishu-file-block://${block_id}" data-filename="…">${name}</a>
                 （与现有 FILE case 输出完全一致，复用 resolveFeishuFiles 管线）
        - IMAGE → <img src="feishu-image://${token}" …>（不包 <figure>，inline 位置）
        - 其他  → [内联块 ${block_id前8位}] 占位
    → 同时把 block_id 加入 consumedInlineIds set，避免 children 遍历时重复渲染

IMAGE caption 渲染
    → image.caption.content 非空时，在 <figure> 内追加 <figcaption>${escapeHtml(content)}</figcaption>
```

## 3. 详细设计点

### 3.1 数据模型扩展

```ts
const FEISHU_BLOCK_TYPE = {
  ...,
  SOURCE_SYNCED: 49,  // 新增
} as const;

interface FeishuTextBody {
  elements?: Array<{
    text_run?: FeishuTextRun;
    mention_user?: FeishuMentionUser;
    mention_doc?: { ... };
    equation?: { content?: string };
    inline_block?: {   // 新增
      block_id: string;
      text_element_style?: FeishuTextElement['text_element_style'];
    };
  }>;
  ...
}

interface FeishuBlock {
  ...
  source_synced?: FeishuTextBody;  // 新增（与 callout/quote 同结构，但本次只用到 children）
  image?: {
    width?: number;
    height?: number;
    token?: string;
    caption?: { content?: string };  // 新增
  };
  ...
}
```

### 3.2 SOURCE_SYNCED case

```ts
case FEISHU_BLOCK_TYPE.SOURCE_SYNCED:
case FEISHU_BLOCK_TYPE.VIEW:
case FEISHU_BLOCK_TYPE.QUOTE_CONTAINER: {
  return renderBlockChildren(block, blockMap, headingNumbers, ctx);
}
```

`source_synced.elements`（API 里观察到只含 `text_run: { content: "同步块" }` 这种 metadata）**整体丢弃** — 它不是用户写入的内容，而是飞书结构自带的标识符。

REFERENCE_SYNCED (type=50, 同步块引用端) **不在本次范围**：本篇文档没出现，且解析它需要额外 fetch source 端 — 留待真实样本出现时再设计。

### 3.3 inline_block element 渲染

`renderTextElements` 签名扩展，接收 `ctx`：

```ts
interface RenderTextCtx {
  blockMap: Map<string, FeishuBlock>;
  consumedInlineIds: Set<string>;
}

function renderTextElements(
  elements: FeishuTextBody['elements'],
  ctx: RenderTextCtx,
  opts: RenderTextOptions = {}
): string {
  ...
  const rendered = elements.map((el) => {
    if (el.inline_block?.block_id) {
      return renderInlineBlock(el.inline_block.block_id, ctx);
    }
    if (el.equation?.content) { ... }
    if (el.mention_doc?.title) { ... }
    ...
  });
}

function renderInlineBlock(blockId: string, ctx: RenderTextCtx): string {
  const target = ctx.blockMap.get(blockId);
  if (!target) return '';
  ctx.consumedInlineIds.add(blockId);
  switch (target.block_type) {
    case FEISHU_BLOCK_TYPE.FILE: {
      const file = target.file;
      if (!file?.name) return '';
      // 使用 inline 专用 placeholder，resolve 阶段不包外层 <p>📎 …</p>
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

**inline placeholder scheme 与顶层 FILE 不同**（`feishu-file-inline://` vs `feishu-file-block://`）：
- 顶层 FILE 出现在自己独立的段落位置 → resolve 阶段包成 `<p>📎 <a …>…</a></p>` 给出独立行视觉
- inline FILE 已经在父 `<p>…</p>` 内部 → 若包外层 `<p>` 会造成非法 HTML 嵌套
- 因此 `resolveFeishuFiles` 需要识别两种 scheme 分别处理（见 3.7）

### 3.4 去重：consumedInlineIds

`renderBlock` 入口加一行：

```ts
function renderBlock(block, blockMap, headingNumbers, ctx) {
  if (ctx.consumedInlineIds.has(block.block_id)) return '';
  // ... 原有 switch
}
```

防止被 `inline_block` 渲染过的 FILE child 在父 TEXT 的 children 遍历中再次出现一个独立段落。

### 3.5 IMAGE caption

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

defuddle / turndown 会把 `<figcaption>` 转为图片下方的独立文本段落，在 Obsidian 中呈现为图片后的一行说明（符合 HTML5 语义）。

### 3.7 resolveFeishuFiles 扩展：两种 placeholder

现有正则只识别 `feishu-file-block://`。新增第二个 pass 处理 `feishu-file-inline://`：

```ts
function resolveFeishuFiles(html: string, sourceDocUrl: string): string {
  // Pass 1: 顶层 FILE block → <p>📎 <a>…</a></p>
  const topPattern = /<a href="feishu-file-block:\/\/([A-Za-z0-9_-]+)" data-filename="([^"]*)">([^<]*)<\/a>/g;
  let result = html.replace(topPattern, (_full, blockId, filename) => {
    const url = `${sourceDocUrl}#${blockId}`;
    return `<p>📎 <a href="${escapeHtml(url)}">${escapeHtml(filename)}</a></p>`;
  });

  // Pass 2: inline FILE → 仅替换 <a>，不包外层 <p>📎
  const inlinePattern = /<a href="feishu-file-inline:\/\/([A-Za-z0-9_-]+)" data-filename="([^"]*)">([^<]*)<\/a>/g;
  result = result.replace(inlinePattern, (_full, blockId, filename) => {
    const url = `${sourceDocUrl}#${blockId}`;
    return `<a href="${escapeHtml(url)}">${escapeHtml(filename)}</a>`;
  });

  return result;
}
```

两种 scheme **只在最终 HTML 中的视觉差异**：是否包 `<p>📎 …</p>` 外壳。锚点 URL 完全一致。

### 3.8 ctx 在调用栈中的传递

`extractFeishuStructuredContent` 顶层创建一个空的 `consumedInlineIds`，与 `blockMap` 一同打包为 `ctx`，向下穿透到：

- `renderBlock(block, blockMap, headingNumbers, ctx)`
- `renderBlockChildren(block, blockMap, headingNumbers, ctx)`
- `renderChildren(ids, blockMap, headingNumbers, ctx)`
- `renderTextElements(elements, ctx, opts)`
- `renderHeading(level, elements, style, seqNumber, ctx)`
- `renderTable(block, blockMap, headingNumbers, ctx)`（cell 内部也可能有 inline_block）

`headingNumbers` 已经是穿透的 Map，照同样的参数传递模式实现即可。

## 4. 文件改动清单

**修改：**
- `src/utils/feishu-extractor.ts`
  - 接口 `FeishuTextBody.elements` 加 `inline_block?: { block_id; text_element_style? }`
  - 接口 `FeishuBlock` 加 `source_synced?: FeishuTextBody`、`image.caption?: { content? }`
  - `FEISHU_BLOCK_TYPE` 加 `SOURCE_SYNCED: 49`
  - `renderTextElements` 加 `ctx` 参数 + `inline_block` 分支
  - 新增 `renderInlineBlock(blockId, ctx): string` helper
  - `renderBlock` 入口加 `consumedInlineIds.has` 早返回
  - `case SOURCE_SYNCED` 加入与 VIEW 同分支
  - `case IMAGE` 渲染 `<figcaption>` 当 caption 存在时
  - 所有 `renderTextElements / renderBlock / renderBlockChildren / renderChildren / renderHeading / renderTable` 调用点补 `ctx` 参数
  - `extractFeishuStructuredContent` 顶层创建 `ctx = { blockMap, consumedInlineIds: new Set() }`
  - `resolveFeishuFiles` 加第二个 pass 处理 `feishu-file-inline://` placeholder（仅替换 `<a>`，不包 `<p>📎`）

**新增：**
- `src/utils/fixtures/feishu-sa5w-inline-block-source-synced.json` —— 从 `Sa5Wdx0Naoq2AExhFx1cKFrUnXd` 拉到的 block tree 精简后的 fixture（保留三处关键 block：同步块+IMAGE caption、inline_block 引用 .bat、对照组顶层 VIEW 容器内的 .mp4 FILE，去除其余 .mp4 噪音）

**改动测试：**
- `src/utils/feishu-extractor.test.ts` —— 加 4 个新 test case（见第 5 节）
- `src/utils/feishu-extractor.audit.test.ts` —— 加 audit bucket，断言 SOURCE_SYNCED + inline_block 路径下的内容不丢失

**不修改：**
- `src/background.ts`
- `src/manifest.*.json`
- 上游（`../obsidian-clipper/`）

## 5. 测试

### 5.1 静态验证

```bash
npx tsc --noEmit                # 无新错误
npm test                         # 现有 baseline + 新增 cases 全绿
npm run build:chrome             # 成功
```

### 5.2 单元测试（新增）

1. **SOURCE_SYNCED → IMAGE 渲染**：fixture 中的同步块在结果 HTML 中包含 `feishu-image://GI3bbDFW9oUf1WxuiAdcTsIrn9e`
2. **IMAGE caption 渲染**：结果 HTML 中包含 `<figcaption>EXE为更新和启动的主要组件。</figcaption>`
3. **inline_block → FILE 渲染 + resolve**：
   - 渲染阶段（resolve 前）：HTML 中包含 `<a href="feishu-file-inline://MNGzdb0d…" data-filename="测试连通多账号软件小工具.bat">…</a>`
   - resolve 阶段后：HTML 中包含 `<a href="https://…/Sa5Wdx0N…#MNGzdb0d…">测试连通多账号软件小工具.bat</a>`，且**不被多余 `<p>📎` 包裹**（即不破坏父段落）
4. **顶层 FILE 渲染保持现有行为**：fixture 中作为对照组的 .mp4（在顶层 VIEW 容器内）resolve 后仍是 `<p>📎 <a …>…</a></p>` 形式
5. **去重**：被 inline 引用的 FILE (block_id=MNGzdb0d..) 在结果 HTML 中**只出现一次**，不会作为独立段落再次出现

### 5.3 audit 测试

在 `feishu-extractor.audit.test.ts` 加一个 bucket：用该 fixture 跑完整 pipeline，断言：
- 红框 1 的截图 token 与 caption 文字都进入了 HTML
- 红框 2 的 .bat 文件名出现 in HTML
- 没有出现 `[内联块 ` 占位（即 inline 目标 block 必须被识别）

### 5.4 手测（Chrome）

- [ ] 用 `npm run dev:chrome`，扩展加载 `dist/`
- [ ] 打开 `https://my.feishu.cn/docx/Sa5Wdx0Naoq2AExhFx1cKFrUnXd`
- [ ] 触发裁剪，确认：
  - "多账号浏览器新版20252.exe" 那张截图在 Obsidian 中可见
  - "EXE为更新和启动的主要组件。" 的 caption 文字出现在截图下方
  - "测试连通多账号软件小工具.bat" 作为一个可点击链接出现
  - 链接点击后跳转到 `…/Sa5Wdx0Naoq2AExhFx1cKFrUnXd#MNGzdb0dNoL8DRx67c1crPjLnxb`，飞书 docx 滚动到附件位置
- [ ] 回归：纯文本飞书文档 / 含图片飞书文档 / 含顶层 VIEW 容器的 .mp4 文件文档（如 scys-docx-QSn2dD.json 那类）行为不变

## 6. 风险与回滚

### 风险

1. **`ctx` 参数穿透涉及多函数签名变更** → 编译期可发现遗漏；TS 编译能兜底
2. **inline_block 出现在 list / heading / table cell 内** → 已统一走 `renderTextElements`，调用点补 ctx 即可，无需特殊处理
3. **REFERENCE_SYNCED (type=50) 仍落 default** → 本次明确不做；现有 `default: return ''` 行为不变，后续真实样本出现时再扩展
4. **同步块的 `source_synced.elements` 占位文字"同步块"未来变化** → 既然丢弃，对未来变化免疫

### 回滚

- 单文件主体改动 + 一个 fixture + 测试改动，回滚简单：`git revert <commit>`
- 文档改动单独 commit，可独立回滚

## 7. 范围之外

- **FILE block 真实下载 / base64 内嵌**：维持现状"`feishu-file-block://` → 飞书原 doc URL + #block_id 锚点"占位策略（2026-05-14-f5 那份 spec 设计的下载方案本次不重启）
- **REFERENCE_SYNCED (type=50) 解引用**：等真实样本
- **inline_block 引用 CALLOUT / TABLE 等复杂 block**：YAGNI；现有 `[内联块 …]` 占位足以暴露未来案例

---

**预计实施**：1.5–2 hr（实施 + 测试）+ 30 min（手测 + audit）= ~2.5 hr
