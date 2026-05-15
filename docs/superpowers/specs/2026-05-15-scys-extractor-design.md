# scys.com 课程页面专项提取器 设计文档

**日期**：2026-05-15
**目标**：在剪存 scys.com（生财有术）课程章节页面时，调用 scys 后端 API 拿到飞书 docx 原生 block 结构，复用现有 `feishu-extractor` 的 block→HTML 渲染管线，输出语义完整的 Markdown：标题层级正确、列表/表格/callout/代码块完整、图片 base64 内嵌且不依赖 24h 过期的 OSS 签名 URL。

## 1. 问题陈述

测试 URL：`https://scys.com/course/detail/172?chapterId=11408`

当前（无 scys 专项提取器，走通用 Defuddle 流水线）的保存结果与浏览器渲染存在以下差异：

| 类别 | 浏览器渲染 | 当前 md 输出 | 原因 |
|---|---|---|---|
| 标题层级（h4/h5/h6 共 14 个） | 「2. 积累能力的三个核心技能」「2.1 需求判断…」「2.1.1 用途…」「第一步：…」等正确为标题 | 全部降级为普通段落，整章只剩 2 个 h2 | Defuddle 不识别 `doc-heading-block` 自定义 class 的语义 |
| 章节标题丢失 | 「1. 什么是积累能力」存在 | 完全缺失（段落直接接其下正文） | 同上 |
| 列表（bullet 33 + ordered 10）| 完整有序/无序列表 | 数字独占一行、内容独占一段，未合并 | DOM 是 `<div>数字</div><div>内容</div>`，Defuddle 各自当段落 |
| 表格（table 4 + grid 4）| Markdown 表格 | 单元格拍扁成连续段落 | 同上 |
| Callout（💡/⚠️ × 4）| 视觉高亮提示框 | 仅保留 emoji + 普通段落，语义丢失 | — |
| 代码块（7 个）| 围栏代码 | （部分保留）| — |
| 图片（50 张）| OSS 签名 URL，浏览器登录态正常加载 | OSS 签名 URL 写入 md，**24h 后必然过期**；Obsidian 无 Referer/cookie 加载常 403 | 通用流水线不做图片下载 |
| frontmatter `title` | 章节标题「02. 积累能力：知识库系统」 | 错误抓取首页 og:title「用好 AI 跟上时代」 | Defuddle 抓 og:title 而非动态加载的 chapter 标题 |
| frontmatter `description` | （应为空或章节摘要）| 抓到首页 og:description「生财有术是…」与本章无关 | 同上 |

## 2. 设计概览

**关键发现**：scys 后端 API `GET /search/course/getChapterContent?course_id=...&chapter_id=...` 返回的就是**飞书 docx 开放平台原生 block 数组**——`block_type` 数字编号、`text/heading4/heading5/heading6/bullet/ordered/code/callout/quote_container/image/table/grid` 字段名与现有 `feishu-extractor.ts` 的 `FeishuBlock` 接口完全同构。

**核心思路**：写薄壳 `scys-extractor.ts`，仅做（1）触发判定 + URL 解析、（2）API 调用、（3）嵌套→扁平 block 结构适配、（4）图片下载，然后**完全复用** `feishu-extractor` 的 `convertBlocksToHtml` 渲染管线。

```
content.ts 触发裁剪
  ↓ isScysCourseUrl(url) === true
scys-extractor.extractScysStructuredContent(doc)
  ├─ parseScysUrl(url) → { courseId, chapterId }
  ├─ fetchScysChapter(courseId, chapterId)  // 同源 fetch /search/course/getChapterContent
  ├─ flattenScysBlocks(chapter.content)     // 嵌套 children_blocks → 扁平 + children: string[]
  ├─ convertBlocksToHtml(flatBlocks)        // ← 复用 feishu-extractor
  ├─ resolveScysImages(html)                // 三级 fallback：L1 content-script 同源 fetch / L2 background MAIN-world / L3 保留原 URL
  └─ return { title: chapter.title, author, content: html, wordCount }
  ↓ ScysStructuredContent
content.ts 合并到 extractedContent（与 feishuContent / bilibiliContent 同模式）
  ↓
template renderer → obsidian-note-creator → Obsidian
```

## 3. 详细设计

### 3.1 触发判定

```ts
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
```

非 chapterId 形态（如 `/course/detail/172` 无 query、`/AI` 等子页面）→ 返回 false → 通用 Defuddle 流水线处理，零干扰。

### 3.2 URL 解析

```ts
export function parseScysUrl(url: string): { courseId: number; chapterId: number } | null
```

提取 `course_id`（path 中数字）+ `chapter_id`（query 参数 `chapterId`）。

### 3.3 API 调用

```ts
async function fetchScysChapter(courseId: number, chapterId: number): Promise<ScysChapter | null>
async function fetchScysCourse(courseId: number): Promise<ScysCourse | null>  // 可选，用于 author/课程名
```

**执行上下文**：必须在 **content script 同源上下文** 运行（page-document world），因为 scys 会话 cookie 仅同源带；background script fetch 没有 cookie 会 401。

**实现**：直接 `fetch('/search/course/getChapterContent?...', { credentials: 'include' })`。

**失败兜底**：返回 `null`，外层 `extractScysStructuredContent` 也返回 `null`，content.ts 该值用 `??` 与 defuddled 兜底合并 → 等价当前行为。

### 3.4 Block 结构适配

**差异 1：嵌套 vs 扁平**

- 飞书原生 `fetchAllBlocks`：扁平数组，`block.children` 是 `string[]`（子 block id），靠 `blockMap` 查表
- scys API：嵌套 `block.children_blocks: Block[]`（内嵌完整子 block 对象）

```ts
function flattenScysBlocks(blocks: ScysBlock[]): FeishuBlock[] {
  const out: FeishuBlock[] = [];
  function walk(block: ScysBlock, parentId?: string) {
    const childIds = (block.children_blocks ?? []).map(c => c.block_id);
    const { children_blocks, ...rest } = block;
    out.push({ ...rest, parent_id: parentId, children: childIds });
    for (const child of block.children_blocks ?? []) walk(child, block.block_id);
  }
  for (const b of blocks) walk(b);
  return out;
}
```

适配后 `out` 直接喂给 `convertBlocksToHtml(out)`，渲染器以 `blockMap.get(childId)` 方式查找子节点，逻辑零修改。

**差异 2：图片字段**

- 飞书原生：`image.token`（再通过 `fetchFeishuImageDataUrl` 经 background→开放平台 API 换 URL）
- scys API：`image.file_url`（已是阿里云 OSS 直链）

在 flatten 阶段把 `file_url` 注入：

```ts
if (block.block_type === FEISHU_BLOCK_TYPE.IMAGE && block.image?.file_url) {
  // 注入到现有 image 渲染器能识别的占位符
  block.image = { ...block.image, token: `scys:${encodeURIComponent(block.image.file_url)}` };
}
```

然后在 `resolveScysImages` 中识别 `scys:` 前缀的 token，走 scys 下载路径而非飞书 API。

### 3.5 图片下载 — 三级 Fallback

目标：把每张图变成 `data:image/...;base64,...` 写入 markdown，**离线、永久、不依赖签名 URL**。

| 层级 | 上下文 | 操作 | 何时失败 |
|---|---|---|---|
| L1 | content script（与 scys.com 同源） | `fetch(file_url, {credentials:'include'})` → blob → `FileReader.readAsDataURL` | OSS 不返回 CORS 头时浏览器拒绝 fetch 读 body |
| L2 | background → `chrome.scripting.executeScript({ world: 'MAIN' })` 注入页面 runtime | 在页面环境内 fetch（与现有 `fetchFeishuImagesViaMainWorld` 同模式，避免 `__awaiter` 缺失，必须用 Promise 链而非 async/await） | OSS 完全拒绝任意 origin |
| L3 | — | 保留原 OSS URL | 与当前行为一致（24h 过期），不退化 |

`resolveScysImages(html)` 扫描 `<img>` 标签的 scys-prefixed token，按 L1→L2→L3 顺序尝试，结果用 base64 src 替换原标签。

### 3.6 manifest 权限

三份 manifest 的 `host_permissions` 添加：

```json
"https://scys.com/*"
```

**用途**：允许 background 用 `chrome.scripting.executeScript` 注入到 scys.com 页面（L2 图片下载路径需要）。注意：L1 路径的同源 fetch 在 content script 内运行，本身不需要 host_permissions（content script 受页面 CORS 管控，不受扩展权限管控）；但 content script 能注入到 scys.com 已由 manifest 的 `content_scripts.matches`（`<all_urls>`）覆盖，所以 L1 路径单看不需要追加权限。host_permissions 的必要性来自 L2 fallback 的 executeScript 注入。

OSS 域 `*.aliyuncs.com` 不需要加入 host_permissions：L2 的 MAIN-world fetch 在页面 runtime 跑，受页面 CORS 而非扩展权限管控——与现有 feishu 的 `*.feishucontent.com` 缺席同理。

### 3.7 元数据契约

| 字段 | 来源 | 失败兜底 |
|---|---|---|
| `title` | `data.chapter.title` | `doc.title` |
| `author` | `getCourseDetail.course.author` 或讲师/课程主体 | 空字符串 |
| `content` | `convertBlocksToHtml + resolveScysImages` 后的 HTML | — |
| `wordCount` | 遍历所有 text block 的 `text_run.content` 拼接后 split 字数 | 0 |

返回到 `content.ts` 后，与 `bilibiliContent` / `feishuContent` 同模式合并到 `extractedContent`，让模板系统的 `{{title}}` / `{{author}}` / `{{content}}` 自动取到正确值。

**用户当前模板不需要改**——`{{title}}` 自动从首页 og:title「用好 AI 跟上时代」切换到章节标题「02. 积累能力：知识库系统」，文件名也随之更新。

### 3.8 评论区抓取与渲染

**API**：`GET /search/course/getCourseComments?course_id=...&chapter_id=...&page=N&page_size=20&sort_by=most_likes`

**返回结构**：
- `data.total`：评论总数（如本测试章节 70 条）
- `data.items[]`：评论数组，每条 `{id, user_id, title, content: ScysBlock[], comments: SubComment[], like_count, created_at, ...}`
- `data.extra.users[]`：本页涉及的用户列表 `{id, name, avatar, xq_group_number}`，需按 `user_id` 建查表
- `items[].comments`：嵌套子评论（回复）数组，结构同主评论；子评论的 `.comments` 字段可能继续嵌套（实测最深可达多层）

**抓取范围（用户选 β）**：分页全抓直到 `items.length === 0` 或累计达 `total`。20 条/页，70 条 = 约 4 次串行调用。**用户级映射表**跨页累积合并（每页 `extra.users` 增量合入查表）。

**嵌套回复（用户选 ω）**：完整递归保留所有层级的回复。`renderCommentTree(comment, depth)` 函数递归处理 `comment.comments`，每深一级 markdown 引用前缀多一个 `>`。

**评论 content 渲染**：`content` 字段是飞书 docx block 数组（与正文同结构，但每个 block 多了一个服务端预渲染的 `sc_html` 字段）。**统一走 `convertBlocksToHtml` 管线**（忽略 `sc_html`），保持渲染逻辑单一来源。评论内的图片走与正文相同的三级 fallback 下载。

**Markdown 输出（用户选 A — Obsidian 原生 callout）**：

```markdown
---

## 💬 章节评论（70 条）

> [!quote]+ **叁斤** · 9 ❤️ · 2026-05-10
> 评论正文 markdown（可能多段、含列表、含图片等）
>
> > **杨树亮** · 2 ❤️ · 2026-05-11
> > 一级回复正文
> >
> > > **Gaby🥳** · 2026-05-12
> > > 二级回复正文
>
> > **飞鱼** · 1 ❤️ · 2026-05-11
> > 另一条一级回复
```

格式约定：
- 评论分区作为正文后追加的 H1（与文章主体平级，markdown 中输出为 `## 💬 章节评论（X 条）` 即 h2，因为 chapter.title 不写入 content）
- 每条主评论用 `> [!quote]+ {user_name} · {N} ❤️ · {YYYY-MM-DD}` 起头（`+` 表示默认展开；点赞数为 0 时省略 ❤️ 段）
- 评论正文（callout body）使用每行前缀 `> `
- 一级回复在 callout body 内嵌套 `> > ` 二级引用，回复元信息行 `> > **{user_name}** · {点赞} · {日期}`
- 多级回复继续追加 `> ` 前缀
- 多层 callout body 间用空 callout 行（`>`）分隔以视觉分组

**用户名**：从 `data.extra.users` 查表得 `name` 字段。查表失败回退到 ``匿名#{user_id}` `。

**时间**：从 `created_at`（Unix 秒）格式化为 `YYYY-MM-DD`。

**点赞 0 时**：省略 `· N ❤️`。

**评论内图片**：评论 block 数组中 image block 的 `file_url` 与正文同处理。

### 3.9 接入点

`src/content.ts` 当前 line ~269 已有 `feishuContent` 分支，在其后平行加：

```ts
const scysContent = isScysCourseUrl(document.URL)
  ? await extractScysStructuredContent(document).catch((error) => {
      contentLogger.warn('Failed to extract scys structured content', { error: String(error) });
      return null;
    })
  : null;

// 合并：scys 优先级在 feishu 与 bilibili 之后均可（互斥域名，无冲突）
if (scysContent) {
  extractedContent.title = scysContent.title;
  extractedContent.author = scysContent.author;
  extractedContent.content = scysContent.content;  // 已含正文 + 评论区
  extractedContent.wordCount = String(scysContent.wordCount);
  extractedContent.description = '';  // 显式覆盖，避免首页 og:description 污染
}
```

## 4. 标题层级映射

scys docx 用 `heading4/5/6` 三级表达文档内层级（飞书 docx 习惯把 h1~h3 留给版式）。映射为：

| 来源 | 用途 | 输出 |
|---|---|---|
| `chapter.title`（API 顶层） | **仅写入 frontmatter `title` 字段**，不写入 content HTML | `title: "02. 积累能力：知识库系统"` |
| `block_type=6` (HEADING4) | content HTML | `<h1>` → markdown `# 2. 积累能力的三个核心技能` |
| `block_type=7` (HEADING5) | content HTML | `<h2>` → markdown `## 2.1 需求判断…` |
| `block_type=8` (HEADING6) | content HTML | `<h3>` → markdown `### 2.1.1 用途…` |

**避免重复**：chapter.title 不在 content HTML 中作为 h1 重复出现，否则用户笔记会同时有「frontmatter title」+「文件名（来自模板的 {{title}}）」+「正文 h1」三处重复同名标题。content 内最大标题从 HEADING4 起。

现有 `feishu-extractor.renderBlock` 中 HEADING1..9 → `<h1>..<h6>` 的 clamp 映射会让 block_type=6/7/8 输出 `<h1>/<h2>/<h3>`（HEADING1=block_type 3 → h1，HEADING4=block_type 6 → 应是 h4——这里需要确认渲染器实际映射规则，必要时在 scys-extractor 的 flatten 阶段把 block_type 偏移以输出期望层级）。

**实现时确认点**：检查 `feishu-extractor.renderBlock` 对 HEADING4/5/6 的实际输出层级。若它直接映射为 h4/h5/h6，则 scys 内容会从 h4 起步，layout 偏深。两种处理选项实现时择一：
- 选项 A（推荐）：在 flatten 适配阶段把 scys 的 block_type 6/7/8 改写为 3/4/5（HEADING1/2/3），让渲染器输出 h1/h2/h3
- 选项 B：保持 block_type 原样，接受 h4/h5/h6 输出，由用户模板/Obsidian 渲染处理

实现阶段先验证 feishu-extractor 当前实际行为再决定，记录在 implementation plan 里。

## 5. 测试策略

### 5.1 单元测试 — `src/utils/scys-extractor.test.ts`

- `isScysCourseUrl`：正例（含 chapterId）、反例（缺 chapterId / 域名错 / pathname 错）
- `parseScysUrl`：course_id + chapter_id 提取
- `flattenScysBlocks`：嵌套 → 扁平 + `children` 数组，使用合成 fixture
- **关键 fixture 测试**：保存当前真实 API 响应到 `src/utils/fixtures/scys-chapter-11408.json`，跑 `flattenScysBlocks → convertBlocksToHtml`，断言 HTML 输出片段（含所有 heading 层级、列表、表格、callout、代码块、图片占位）
- **评论 fixture 测试**：保存评论 API 真实响应到 `src/utils/fixtures/scys-comments-11408.json`（含主评论 + 嵌套回复），跑 `renderCommentTree` 输出 markdown，断言 callout 前缀正确（`> [!quote]+` / `> > ` / `> > > `）、用户名查表正确、日期格式正确
- `resolveScysImages`：mock fetch，断言 `scys:`-prefixed token 被替换为 base64
- 失败路径：API 抛错 → `extractScysStructuredContent` 返回 `null`；评论 API 单独失败时正文仍能返回

### 5.2 端到端自动化迭代回路

新建 `scripts/scys-clip-loop.sh`（仅本地用）。单轮迭代序列：

1. `npm run build:chrome` → `dist/`
2. dev `build-marker` 机制（commit `a04bc32`）自动重载扩展，无需手动
3. `claude-in-chrome navigate` 到测试 URL，等 DOM ready
4. 触发裁剪（首版手动按扩展图标，后续视情升级到 `chrome.commands` 快捷键）
5. 等待 Obsidian 协议写入文件
6. `Read` 生成的 md
7. 跑断言脚本对比浏览器 API 数据 vs md
8. 有差异 → 改 scys-extractor → 回 1；全 pass → 停

### 5.3 验收清单（停止迭代条件）

- [ ] frontmatter `title` = "02. 积累能力：知识库系统"
- [ ] 所有 14 个 docx-heading block 在 md 中是 `## / ### / ####` 中正确层级
- [ ] 33 个 bullet + 10 个 ordered + 1 个嵌套 ordered 全部成为 markdown 列表项
- [ ] 4 个 table block 为 markdown 表格（含表头分隔行）
- [ ] 4 个 callout block 为 `> [!tip]` / `> [!warning]`
- [ ] 7 个 code block 为围栏代码块
- [ ] 4 个 quote_container 为 `> ` 引用
- [ ] 50 个 image 全部为 `data:image/...;base64,...` 内嵌
- [ ] 4 个 grid 块按 grid_column 转换（或合理降级）
- [ ] 浏览器纯文本与 md 纯文本字符差距 < 2%（仅正文段，不含评论）
- [ ] 评论区以 `## 💬 章节评论（70 条）` H2 起头
- [ ] 70 条主评论全部抓取（多页累积合并 `extra.users` 表）
- [ ] 嵌套回复保留所有层级（`> > ` / `> > > ` ...），实测含 8 条回复的主评论展开完整
- [ ] 每条评论 callout 行含 user_name + 点赞数（>0 时）+ 日期

## 6. 文件清单

| 操作 | 路径 |
|---|---|
| 新建 | `src/utils/scys-extractor.ts` |
| 新建 | `src/utils/scys-extractor.test.ts` |
| 新建 | `src/utils/fixtures/scys-chapter-11408.json` |
| 新建 | `src/utils/fixtures/scys-comments-11408.json` |
| 修改 | `src/content.ts`（line ~269 附近加 scys 分支） |
| 修改 | `src/manifest.chrome.json` |
| 修改 | `src/manifest.firefox.json` |
| 修改 | `src/manifest.safari.json` |
| 修改 | `src/background.ts`（新增 `fetchScysImageAsBase64` action handler 作为 L2） |
| 新建 | `scripts/scys-clip-loop.sh` |

## 7. 实现顺序（5 步交付）

1. **基础骨架**：`isScysCourseUrl` / `parseScysUrl` / `fetchScysChapter` / `flattenScysBlocks` + 单测 pass
2. **HTML 输出**：接 `convertBlocksToHtml`，fixture 测试覆盖所有 block 类型（不含图片）pass
3. **图片下载 L1**：content-script 同源 fetch 路径
4. **评论区抓取与渲染**：`fetchScysComments`（分页累积）、`renderCommentTree`（递归 callout 嵌套）+ fixture 单测 pass
5. **接入流水线**：`content.ts` 加 scys 分支，dev build，手动跑一次保存到 Obsidian，肉眼初看
6. **自动化迭代闭环**：跑 §5.3 的验收清单直至全 pass；过程中发现图片 L1 跨域被拦再补 L2

## 8. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| scys 改 API 路径或字段名 | 提取失败 | API 失败回退 Defuddle，不退化于当前行为；warn 日志 |
| OSS 跨域 fetch 被拦 | 图片留 URL（仍 24h 过期）| L1→L2→L3 三级 fallback；L3 = 当前行为 |
| 未登录访问 | API 401 | 返回 null，回退 Defuddle |
| scys 出现新 block_type | 该 block 渲染空 | 现有 `renderBlock` default 分支已 fall-through，不崩；warn 日志 |
| Safari/Firefox 行为差异 | 跨浏览器构建失败 | 最后一步统一跑 `npm test` + `npm run build` |
| 误触发于非课程页面 | 干扰 scys.com 其他子页 | `isScysCourseUrl` 严格匹配 `/course/detail/\d+` + chapterId 数字 |
| 评论 API 401/失败 | 评论区缺失 | 评论抓取与正文解耦：评论失败不阻断正文返回，content 末尾省略评论区 |
| 评论数极多（如 >500）| 多页串行 API 调用慢，笔记巨大 | 串行 + 进度日志；实测 70 条耗时可接受。本 spec 不限制条数，未来若需可加 setting |
| 用户隐私（公开评论包含真实用户名）| 笔记落地后用户名留存 | 评论与原页面公开可见一致，未引入新隐私面；用户掌控笔记后续分享 |

**回滚**：提取器是新增模块，未触动通用 Defuddle 路径。回滚 = 删除 `content.ts` 中新增的 import + scys 分支（约 8 行），或在 `isScysCourseUrl` 永远 return false。零侵入。

## 9. 非目标（YAGNI 边界）

- ❌ 视频播放器内容抓取（scys 课程含视频，但本任务聚焦正文）
- ❌ 课程章节侧边栏导航（非当前 chapter 的核心内容）
- ❌ 评论的点赞用户头像列表（`latest_like_users`，与笔记内容无关）
- ❌ 评论的回复点赞数差异化呈现（统一 `· N ❤️` 即可）
- ❌ 课程购买/学习进度页面（与裁剪无关）
- ❌ 通用化到其他飞书 docx 嵌入式站点（用户明确选范围 A：仅 scys.com）
