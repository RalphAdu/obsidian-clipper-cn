# cn fork Backlog — 冷启动手册

> **本文档用途**：让一个**完全没上下文的新会话 AI** 也能快速上手继续工作。
> 包含项目背景、开发基础设施、关键认知、踩过的坑、待办 feature。
> 每条 feature 都标了"为什么这么做 / 已知什么不行 / 推荐怎么做"。

**最后更新**：2026-05-17
**最新 commit 基线**：`0949660`（zsxq q&a author = 答主而非提问者）/ `c5efe22`（articles.zsxq.com SSR article extractor）/ `3c37532`（zsxq published frontmatter）

---

## 目录

- [0. 项目背景](#0-项目背景)
- [1. 开发基础设施速查](#1-开发基础设施速查)
- [2. 关键认知（避免重复踩坑）](#2-关键认知避免重复踩坑)
- [3. 用户偏好 / 协作约定](#3-用户偏好--协作约定)
- [4. 文件 / 代码位置速查](#4-文件--代码位置速查)
- [5. 待清理基础设施](#5-待清理基础设施)
- [6. 待实施 Feature 详单](#6-待实施-feature-详单)
- [7. 代码内 TODO 注释](#7-代码内-todo-注释)
- [8. 操作 / 工作流类待办](#8-操作--工作流类待办)
- [9. 跨仓库（上游同步）](#9-跨仓库上游同步)
- [10. 优先级建议](#10-优先级建议)

---

## 0. 项目背景

### 仓库结构

工作目录 `/Users/adu/Workspace/github/obsidian-clipper/` 含两个并列 git 仓库：

| 目录 | 仓库 | 角色 |
|------|------|------|
| `obsidian-clipper/` | 上游 `obsidianmd/obsidian-clipper` | 参考、对比、回拉上游 |
| `obsidian-clipper-cn/` | Fork `nextcaicai/obsidian-clipper-cn` | **主要开发目标** |

**绝大多数工作在 `obsidian-clipper-cn/` 中**。

### cn fork 相对上游的增强

- **飞书文档完整提取**（`src/utils/feishu-extractor.ts`）—— 走飞书 OpenAPI，避开上游用 defuddle 通用 DOM 解析的 incomplete content 问题
- **Bilibili 视频提取**（`src/utils/bilibili-extractor.ts` + `bilibili-playback-tracker.ts`）—— 简介/章节/字幕/时间戳跳转/Reader Mode 嵌入播放器
- **scys.com 提取**（`src/utils/scys-extractor.ts` + `src/scys-docx-patch.js`）—— 生财有术站点的两类页面：
  - **课程章节** `scys.com/course/detail/{id}?chapterId=X`：scys 后端直接返回飞书 docx 原生 block 结构，复用 `convertBlocksToHtml` 渲染；评论区分页全抓 + HTML 嵌套 blockquote；图片 base64 内嵌（背景 fetch 绕 OSS CORS）
  - **Standalone docx** `scys.com/view/docx/{token}`：scys 客户端 AES 解密静态 JSON 文件 — 通过 manifest `content_scripts.world:'MAIN', run_at:'document_start'` 注入的 patch script 包装 `JSON.parse`，嗅探飞书 block 数组（递归找深 4 层）+ localStorage 桥接到 content-script，复用同一渲染管线
- **微信公众号文章图片保留**（content.ts 内联逻辑）
- **扩展 ID / 名称为 `obsidian-web-clipper-cn`**（避免与官方扩展碰撞）

### 当前 cn 最新合并的上游版本

- 上游 main HEAD `776d083`（版本 1.5.1）
- cn 已合并到此，含 Highlighter 2.0、Highlights Viewer、Reader 重构等
- 完整 merge 设计 + 实施记录见 `docs/superpowers/specs/2026-05-14-merge-upstream-design.md` + plan

---

## 1. 开发基础设施速查

### 1.1 Hot-reload via `chrome.alarms`

**实现**：`src/background.ts` 中 `chrome.alarms` 每 3 秒 fetch `chrome.runtime.getURL('build-marker.txt')`，对比 `chrome.storage.session` 中存的上次值，变化则 `chrome.runtime.reload()`。

**Webpack 写 marker**：`webpack.config.js` 中 inline plugin `BuildMarkerPlugin`，每次 build emit 含时间戳的 `build-marker.txt`。

**生效条件**：
- 用户首次 reload extension（让新 background.js 含 alarms 代码生效）
- 之后 `npm run build:chrome` → cn 自动 reload（service worker 在 idle 时也会被 alarm 唤醒，`setInterval` 不可靠）
- **content.ts 不会自动重新注入到已开 tab**——需要 navigate / reload tab 才会注入新 content.js

**permission**：`alarms` 已加到三个 manifest（chrome / firefox / safari）

**重要**：用 `chrome.alarms` 而非 `setInterval`（后者 MV3 service worker idle 后停）。

### 1.2 Page-world test bridge

**位置**：`src/content.ts` 末尾 ~50 行

**功能**：监听 page world 的 `window.postMessage({ type: '__obsidianClipperTestExtract__', testId, uploadUrl? })`，触发后跑一遍 `extractFeishuStructuredContent` + `defuddle.createMarkdownContent`，结果写 `localStorage` + 可选 POST 到 `uploadUrl`。

**限制**：只在 `feishu.cn` / `larksuite.com` origin 响应（`location.hostname` 正则）。

**用法**（chrome MCP javascript_tool）：
```javascript
// 1. trigger
const testId = 'x-' + Date.now();
localStorage.setItem('__obsidianClipperTestResult__:' + testId, '');
window.postMessage({ type: '__obsidianClipperTestExtract__', testId, uploadUrl: 'http://127.0.0.1:17923/' }, location.origin);

// 2. 等几秒后 poll localStorage
const raw = localStorage.getItem('__obsidianClipperTestResult__:' + testId);
const r = JSON.parse(raw);
// r 含 status / title / contentLength / markdownLength / markdownTail / contains* / ...
```

**也设了**：`document.documentElement.setAttribute('data-cn-clipper-build', Date.now())` —— 让 page world JS 探测 content.js 是否真注入。

### 1.3 HTTP receiver 落地大 markdown

**脚本**：`scripts/recv-server.py`（已沉淀进项目；曾在 /tmp 临时维护，2026-05-16 挪入仓库以便版本化 + 跨机复用）

**用法**（仅传端口，按请求 `?path=` 落盘）：
```bash
pkill -f recv-server.py 2>/dev/null
nohup python3 scripts/recv-server.py 17923 > /tmp/recv.log 2>&1 < /dev/null &
disown
```

```bash
# bridge / 任意 client 调用：
curl -X POST "http://127.0.0.1:17923/save?path=/Users/adu/Documents/Obsidian /Life/_cn-test/x.md" -d @body
```

**特性**：
- **多次接收**（不再 single-shot shutdown，方便迭代连发多次 POST）
- **支持 `?path=<绝对路径>` 请求参数**（按 client 指定落盘；缺省退化到 `/tmp/feishu-out.md`）
- **CORS + Chrome PNA 头**：`Access-Control-Allow-Private-Network: true` —— HTTPS 页面（scys.com 等）的 content-script `fetch` 到 `http://127.0.0.1` 必须有此头，否则被 Chrome 拒绝并报 `TypeError: Failed to fetch`（参见 §2.13）

**为什么需要**：chrome MCP `javascript_tool` 返回值有大小限制（约几 KB），>100KB markdown 走不出来。HTTP POST 突破这个限制。

**为什么沉淀到项目而非 /tmp**：本质上是 dev tool（与 `scripts/obsidian-verify.sh` 同类），不会打包进扩展。版本化 + fresh clone 即用。/tmp 只放 runtime log（`/tmp/recv.log`）。

### 1.4 Obsidian vault 路径速查

```bash
cat "$HOME/Library/Application Support/obsidian/obsidian.json" | python3 -c "
import json, sys
for vid, info in json.load(sys.stdin).get('vaults', {}).items():
    print(f'{vid}  {info.get(\"path\")}')
"
```

用户当前 vaults（路径前缀含**空格**，引用时要 quote）：
- `Life`：`/Users/adu/Documents/Obsidian /Life`（默认 vault）
- `Work@Galaxy`：`/Users/adu/Documents/Obsidian /Work@Galaxy`
- `adu_pi`：`/Users/adu/Documents/Obsidian /adu_pi`

### 1.5 自动打开 Obsidian 验证

```bash
open "obsidian://open?vault=Life&file=_cn-test/feishu-pdf-test"
```

**完整 macOS 原生 e2e 脚本**：`scripts/obsidian-verify.sh` —— 调起 Obsidian + AppleScript 校验窗口标题 + screencapture 截图 + Python 文本/emoji diff。**不依赖 Chrome**，纯系统能力。

```bash
scripts/obsidian-verify.sh Life _cn-test/scys-docx-fullnote-test src/utils/fixtures/scys-docx-QSn2dD.json
```

**权限前提**（一次性配置，系统偏好 → 隐私与安全）：
- **辅助功能（Accessibility）**：允许 Terminal / Claude Code 进程模拟 `osascript` 控制 → 否则窗口标题读取失败、键盘模拟失效
- **屏幕录制（Screen Recording）**：允许 Terminal → 否则 `screencapture -x` 输出空文件

**Electron 应用的 AX 限制（坑）**：Obsidian (Electron) **不**通过 System Events 暴露 `id of window 1` —— `screencapture -l <id>` 必失败 (-1728 error)。所以 step 4 改用 `screencapture -x -m` 全主显示屏截图（前置 `activate` 让 Obsidian 在前景）。

**视觉对比环节**：脚本截图保存到 `/tmp/obsidian-verify-<ts>.png`。可与 chrome MCP 截图（`computer.screenshot`）做并排目视比对，或写 Python pixel/perceptual diff。详见 §1.12。

### 1.6 飞书 OpenAPI 凭证

**位置**：`docs/superpowers/feishu.md`（**git-ignored**，本地有效；新 clone 仓库需手动放入此路径）

**用法**（拿 tenant token + 调 API）：
```bash
TOKEN=$(curl -s -X POST 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' \
  -H 'Content-Type: application/json' \
  -d '{"app_id":"<id>","app_secret":"<secret>"}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['tenant_access_token'])")
curl -s "https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=<wiki_token>" \
  -H "Authorization: Bearer $TOKEN"
```

**绝不**把凭证写入 git tracked 文件 / commit / docs（用户私有信息）。

### 1.7 page world fetch 与 CORS

**飞书页面（feishu.cn）的 page world JS 不能直接 fetch `open.feishu.cn`** —— 被 CORS 阻塞。

要绕开：
- 用 Bash + curl（不受 CORS 限制）
- 或通过 cn extension 的 `fetchFeishuApi` message（background script 不受 CORS，有 host_permissions）

### 1.8 三种 fetch 上下文 CORS 行为对比（scys 实施教训）

| 上下文 | 受 CORS 限制？ | 带 page cookie？ | 用途 |
|---|---|---|---|
| content-script fetch（page-document world） | **是**（受目标域 CORS 头限制） | 是（同 origin） | 需要 page session cookie 的同源 API（如 scys `/search/course/...`） |
| `chrome.scripting.executeScript({world:'MAIN'})` 内 fetch | **是**（与 content-script 等价） | 是 | 飞书 imageManager API 调用（页面内 runtime 函数） |
| background script fetch | **否**（凭 manifest `host_permissions` 绕过 CORS） | 否（扩展 origin） | 跨域资源下载，无需 cookie 的资源 |

**关键教训**：scys 实施时假设 MAIN-world fetch 能绕 CORS（错误），实际仍受目标域 CORS 头限制。OSS 图片必须走 background fetch + 在 `host_permissions` 加目标域。

### 1.9 Markdown 渲染自动化验收（替代肉眼目视）

每轮 bridge 测试后，把保存的 .md 渲染为 HTML 再程序化校验，等价于"目视检查"但完全自动：

```bash
# 1. md → html
python3 -c "
import markdown_it
md = markdown_it.MarkdownIt('gfm-like', {'html': False, 'linkify': False})
with open('input.md') as f: body = md.render(f.read())
with open('output.html','w') as f: f.write('<html><body>'+body+'</body></html>')
"

# 2. HTML 结构化校验（Python html.parser）：
#   - 数 h2/h3/h4/blockquote/table/tr/li 等标签
#   - 提取 H2/H3/H4 文本对照预期
#   - 检查 blockquote 最大嵌套深度
#   - 扫破损 \[!quote\] 转义残留
# 3. 图片 binary 校验：
#   - 逐张 base64 decode
#   - magic bytes 比对（PNG=\x89PNG / JPEG=\xff\xd8 / GIF=GIF8 / WEBP=RIFF...WEBP）
#   - 检测 declared MIME ↔ actual format 不一致
```

**为什么不直接 chrome MCP 加载 HTML 看**：
- chrome MCP `navigate` 自动 prepend `https://`，无法跳 `file://`
- 即使能跳，需要 chrome 真渲染 + javascript_tool 检查 layout — 太重
- 解析 HTML 比解析 markdown 更稳：marked/markdown-it 已正确处理 markdown 语法的边缘情况

**为什么不直接 grep .md**：
- 行级 grep 漏掉嵌套结构（blockquote 深度、断行的 callout）
- HTML 标签计数与 markdown 标记数量不一定 1:1
- 图片 base64 校验必须 decode，grep 看不出来

`docs/superpowers/specs/2026-05-15-scys-extractor-design.md` §5.3 验收清单 + Task 11 Step 8 给出过 grep 简版；这一套 HTML 解析 + magic bytes 是升级版。**适合所有提取器的端到端验收**（feishu / bilibili / scys / 未来新增）。

### 1.10 Page-world test bridge 升级：popup 路径模拟（commit `7eefd56`）

**问题**：原 bridge（`src/content.ts:615-` 的 `__obsidianClipperTestExtract__` 监听）只走「`extractor.content (HTML)` → `defuddleMod.createMarkdownContent` → POST」，**没经过 `popup → initializePageContent → buildVariables`**。结果 popup 路径上的 dict-overlay bug（详见 §2.10）在 bridge 测试中完全看不见，只有 user 真实裁剪到 Obsidian 才暴露。

**修复**：bridge 增加 popup 路径模拟段：

```ts
const sharedMod = await import('./utils/shared');
const simulatedVars = sharedMod.buildVariables({
  title: result?.title || '',
  content: markdown,        // ← post-createMarkdownContent
  contentHtml: content,     // ← original HTML
  extractedContent: {},     // ← mirror content.ts main flow (empty for now)
  // ... other standard params
});
const popupMarkdown = simulatedVars['{{content}}'];
const popupMatchesBridge = popupMarkdown === markdown;
```

`popupMatchesBridge: true` 表示两条路径输出一致（OK）；`false` 表示 buildVariables 有 dict-overlay 覆盖了 markdown（bug 信号）。Receiver POST 用 `popupMarkdown`（**canonical 输出**，即 user 在 Obsidian 中实际看到的内容）。

**未来扩展**：如果某条 extractor 分支真的需要往 `extractedContent` 写自定义键（如 bilibili 的 `transcript`），bridge 模拟也要 mirror 那段填充——否则会假阴性。

### 1.11 Markdown 后处理：unescape turndown 转义（commit `43a7ed8`）

**位置**：`src/utils/markdown-post-process.ts` —— 单一职责模块，单 regex pass。

**接入点**：所有 `createMarkdownContent(...)` 调用必须用 `postProcessExtractorMarkdown(...)` 包一层。当前 4 个 call sites：
- `src/utils/content-extractor.ts:152/160/162`（popup 主路径，含 `selectedMarkdown` / `markdownBody` / `highlights` 三处）
- `src/content.ts:641`（test bridge）

**当前职责**：解 turndown 对 `[!type]` 的转义（`\[!tip\]` → `[!tip]`），让 Obsidian reading-view 识别为 callout（参见 §2.11）。

**未来扩展**：若发现 turndown 还对其它字符做"无脑"转义破坏 Obsidian 语法，集中加在这里——而非分散到各 extractor。**新 extractor 出 markdown 时记得调一次**。

### 1.12 视觉对比 / 截图迭代工作流（scys docx callout 修复验证）

**目标**：在浏览器和 Obsidian 间做视觉一致性 diff，**不依赖肉眼用户**。

**流程**：
1. **浏览器侧截图**（chrome MCP）：
   ```
   mcp__claude-in-chrome__computer({ action: 'screenshot', tabId, save_to_disk: true })
   ```
   返回 imageId（也写盘）；可用 Read 工具读图视觉检查。
2. **Obsidian 侧截图**（macOS 原生）：
   ```bash
   osascript -e 'tell application "Obsidian" to activate'
   screencapture -x -m -o /tmp/obs.png   # 主显示屏
   ```
3. **同步可见区域**：用 `osascript` 模拟 PageDown/PageUp / `Cmd+F` 搜索定位到同一文档片段。Obsidian Reading-view 切换：**中文版 command palette 找不到英文 "Reading mode"**——直接用 `Cmd+E` 切换 edit/preview。
4. **目视比对**：分别 Read 两张图，对照结构（标题层级、callout box 颜色、emoji、列表层级、表格、图片）。
5. **如有差异 → 改 extractor → 重新触发 bridge → 再截图比对**，循环到一致。

**结构化文本 diff（互补）**：§1.9 的 fixture text_run vs markdown body 走机器 diff，**对文字 100% 覆盖**；视觉 diff 抓**渲染结构/颜色/图标**类问题。两者结合 = 文本 + 视觉双重保证。

**改进项**：用 Python ImageHash / pixelmatch 自动 perceptual diff，输出差异块坐标 + 截图标注。当前未实施——目视检查已足够发现 §2.11/§6.11 这类结构性问题，YAGNI。

---

## 2. 关键认知（避免重复踩坑）

### 2.1 defuddle 0.18 行为

- **保留 `<a href="data:application/pdf;base64,...">filename</a>`** —— 转 markdown 为 `[filename](data:application/pdf;base64,...)` ✓
- **escape 字面 `==` 字符** —— 写成 `\==`（无法直接用 `==text==` 作为 markdown 高亮语法注入）
- **alphanumeric 占位符**（如 `HLMARKSTART9F2A`）在 defuddle 转换链中**有时丢失**（具体原因未深查，可能与 markdown 重排有关）
- `<details>` / `<summary>` HTML 标签 defuddle 保留
- Element 级 `<mark>` 包整段（如 `<h2><mark>X</mark></h2>`）→ defuddle 输出 `## ==X==`
- 段内 `<mark>` 包文字（如 `<p>...<mark>X</mark>...</p>`）→ defuddle **剥除 mark，留纯文字**

### 2.2 飞书 OpenAPI 局限

| 能力 | 公开 OpenAPI 支持 |
|------|-------------------|
| docx blocks 列表 | ✓ `/docx/v1/documents/{token}/blocks` |
| 媒体下载（图片/PDF） | ✓ `/drive/v1/medias/{file_token}/download` |
| Sheet 单元格值 | ✓ `/sheets/v2/spreadsheets/{token}/values_batch_get?ranges={sheet_id}` |
| **Sheet 单元格 style（粗体等）** | ✗ `/style` 和 `/v3/cells` 都 404 |
| 飞书附件独立 URL（如 `/file/{token}`） | ✗ 直接访问"此文档不存在"，必须 wiki/doc 上下文 |
| HEAD `/medias/{token}/download` | ✗ 飞书拒绝 HEAD（404），用 GET |

### 2.3 飞书 wiki ↔ docx token 关系

- wiki URL 是 `https://{tenant}.feishu.cn/wiki/{wiki_node_token}`
- 实际文档（docx）token 不同：要通过 `/wiki/v2/spaces/get_node?token={wiki_node_token}` 拿 `obj_token` (= docx document_id)
- 然后用 `obj_token` 调 `/docx/v1/documents/{obj_token}/blocks`
- cn 在 `src/utils/feishu-extractor.ts:420+` 已封装此流程

### 2.4 飞书 docx block 类型常量（cn enum）

```typescript
PAGE: 1, TEXT: 2, HEADING1-9: 3-11, BULLET: 12, ORDERED: 13,
CODE: 14, QUOTE: 15, TODO: 17, CALLOUT: 19, CHAT_CARD: 20,
DIAGRAM: 21, DIVIDER: 22, FILE: 23, GRID: 24, GRID_COLUMN: 25,
IFRAME: 26, IMAGE: 27, WIDGET: 28, MINDNOTE: 29, SHEET: 30,
TABLE: 31, TABLE_CELL: 32, VIEW: 33, QUOTE_CONTAINER: 34
```

**关键发现**：
- **VIEW (33) 是容器**——飞书"附件"和"内嵌文档"都用 VIEW 包裹真实 FILE/DOC 子块。cn 之前 default `return ''` 导致 FILE 完全丢失，已在 `9f4776c` 修复（VIEW + QUOTE_CONTAINER 递归 children）
- **SHEET (30) 是内嵌表格**，token 格式 `{spreadsheet_token}_{sheet_id}`（下划线分割，取**最后一个**下划线作 separator）
- TABLE (31) 是 docx 内建表格（与 SHEET 不同），cn 已支持
- **scys 自定义 block_type=5001**：scys 评论 content 用这个非飞书原生类型，带 `sc_html.content`（服务端预渲染 HTML）。`convertBlocksToHtml.renderBlock` 不识别该类型，要在 scys 适配层提前 dispatch（参见 `scys-extractor.renderCommentBodyHtml`）

### 2.4.1 第三方系统嵌入飞书 docx 的常见特征

scys 实施观察到的"飞书 docx 嵌入式渲染"模式（其他类似站点可能也用同款）：

| 特征 | 取值/含义 |
|---|---|
| DOM 容器 | `.feishu-doc-content` + `.vc-doc-item[data-block-id]` |
| 后端 API | 直接返回飞书 docx 原生 block 数组（`block_type` 数字编号一致） |
| 嵌套表达 | `children_blocks: Block[]`（内嵌完整对象），**与飞书原生 API 用 `children: string[]` 引用不同**，需在适配层把嵌套→扁平 + 收集 children id |
| 图片 token | `image.token` 是 feishu-style 但**不能用 feishu OpenAPI 解析**（scys 没暴露飞书 token），需配合 `file_url`（OSS 签名直链）才能下载 |
| 第三方扩展字段 | API 偶尔附加非飞书字段（如 scys 的 `sc_html`, `meta.course_comment`），适配层要识别 |
| 时间字段 | scys 用 ISO 8601 字符串，**不是** unix 整数（飞书 OpenAPI 用 unix 秒）—— 字段同名 `created_at`，类型不同，易踩 |

### 2.5 飞书附件没有独立 URL

**错误尝试**：`https://{tenant}.feishu.cn/file/{file_token}`
- title 显示文件名（飞书 SPA 客户端先设 title 再 fetch）
- body 实际显示 "此文档不存在"
- **不能用这个 URL**

**正确方式**：`{source_doc_url}#{block_id}` —— 飞书 SPA reader 滚动到 anchor block
- 例：`https://shejiriji.feishu.cn/wiki/{wiki_token}#{file_block_id}`
- 飞书打开 doc，自动滚动到 file block 位置（含 PDF inline preview）
- 已在 `f947779` 实施

### 2.6 Chrome 扩展能力边界

- ✗ 不能直接写本地任意路径（`chrome.downloads.download` 只接受 chrome 默认下载目录的**相对子路径**）
- ✗ chrome MCP 不能 navigate 到 `chrome://*` 或 `chrome-extension://*`（会被前置 `https://`）
- ✗ macOS AppleScript JavaScript exec 默认禁用，要用户手动开启（多次实测启用失败）
- ✗ chrome 安装 webstore 扩展在中国大陆受限
- ✗ macOS `screencapture -x` 受屏幕录制权限阻挡（用户没开权限给 Terminal）
- ✓ chrome MV3 service worker 可用 `chrome.alarms` 保持唤醒
- ✓ content script 可在 page world 注入 `data-*` 属性（page world JS 可读）
- ✓ content script `localStorage` 与 page world 共享 origin

### 2.7 Chrome 扩展 reload 触发方式

- **手动**：chrome://extensions → cn 卡片 ↻ 按钮（不能自动化）
- **自动**（已部署）：cn 自身轮询 build-marker.txt，发现变化调 chrome.runtime.reload()
- **彻底**（影响所有 tab）：Cmd+Q Chrome → 重启（unpacked extension 启动时自动重读 dist）
- **不能**：chrome MCP 不能直接 reload extension

**输出目录约定（2026-05-16 固化）**：dev 与 build 都输出到 `dist*/`，扩展恒定加载 `dist/`（chrome）/`dist_firefox/`/`dist_safari/`。**不再有 `dev/` 目录**。

历史教训（scys 实施时）：早期 dev 输出 `dev/`、build 输出 `dist/`，chrome 加载哪个都可能。结果反复"代码改了 watch 写 dev/ 而扩展加载 dist/，chrome.alarms 找不到 marker 变化、不 reload"。已在 `webpack.config.js` 中固化 `getOutputDir` 不再区分 mode：

```js
const getOutputDir = () => isFirefox ? 'dist_firefox' : (isSafari ? 'dist_safari' : 'dist');
```

dev mode 写 sourcemap 到 dist/，prod mode 覆盖并 minify。每次切换 mode 自然覆盖。`.gitignore` 仍保留 `dev/` `dev_firefox/` `dev_safari/` ignore 条目作 future-proof（如果将来又改回来不会误 commit）。

### 2.10 `extractedContent` dict 覆盖 `{{content}}` footgun（commit `4d74412` 修复）

**根因**：`src/utils/shared.ts:69-73` 的 `buildVariables` 函数在赋完 `{{title}}` `{{content}}` 等 standard 变量后，会**继续遍历 `extractedContent` 字典**把每个 key 写成 `{{key}}` 变量——**覆盖了之前赋的同名 standard 变量**：

```ts
// In buildVariables:
variables['{{content}}'] = (params.content || '').trim();  // markdown body
// ...
if (params.extractedContent) {
  for (const [key, value] of Object.entries(params.extractedContent)) {
    variables[`{{${key}}}`] = value;  // ← extractedContent.content overwrites!
  }
}
```

scys-extractor 早期实施时 `content.ts:296-302` 写了 `extractedContent.content = scysContent.content`（HTML），导致 popup 路径 `{{content}}` 最终是 raw HTML，user Obsidian 看到原始标签。

**bilibili 分支**写 `extractedContent.transcript / chapters / bvid` 等专属键，**不与 standard 变量冲突**，所以从未触发此 bug。

**修复**：删 scys 那 6 行赋值——scys 的 title/content/author 已经通过 `ContentResponse` cascade（`content.ts:352-369`）→ `initializePageContent` → `buildVariables` params 通过正常路径设置 standard 变量。

**回归测试**：`src/utils/shared.test.ts` 加了一组测试文档化此 footgun（commit `67cb1ad`）。Bridge popup 路径模拟（§1.10）也作为 e2e 防御层。

**未来 extractor 写 `extractedContent` 时的红线**：
- ✗ 不要写 standard 键名（`content` / `title` / `author` / `description` / `url` / `image` / `favicon` / `published` / `site` / `language` / `words` / `domain` / `contentHtml` / `selection` / `selectionHtml` / `fullHtml` / `noteName` / `date` / `time` / `highlights`）
- ✓ 自定义专属键（如 bilibili 的 `transcript` / `bvid` / `cid`）安全
- 通用 standard 字段应通过 `ContentResponse` cascade 在 `content.ts:352-369` 设置

**根本修复（未实施，参见 §6.10）**：让 `buildVariables` 主动跳过 standard reserved keys，从结构上禁止此类覆盖。

### 2.9 webpack 缓存与"代码改了没编译"

webpack 5 watch + ts-loader 偶尔出现：源文件 mtime 改了，但 webpack 报 `cached modules`，新代码没 emit。两种触发因素：
1. **缓存目录陈旧**：`rm -rf node_modules/.cache dist/` 强制全量重建
2. **mtime 精度问题**：某些文件系统 mtime 不变（rare on APFS, more common on NFS）— `touch src/xxx.ts` 显式 bump

scys 实施时这两种都遇到过。**症状**：bridge 输出与改前完全一致（长度同、内容同），但 dist/content.js 通过 grep 已含新 string literal。
**rule-of-thumb**：连续 2 轮端到端测试输出**完全相同**就立即怀疑是缓存问题，先 `du -h dist/content.js` 看时间戳。

### 2.11 Turndown 转义 `[` `]` 会破坏 Obsidian `[!callout]` 语法

**症状**：feishu-extractor 在 callout 标题行输出 `<p>[!tip] 💡 查看顺序</p>`，期望 turndown 后变成 `> [!tip] 💡 查看顺序`，Obsidian Reading-view 识别为 callout colored box。**实际**输出 `> \[!tip\] 💡 查看顺序`——backslash escape 来自 turndown 的 link-detection rule（`[` 后面可能是 link / footnote / reference，所以保守 escape）。**Obsidian callout 解析器要求字面 `[!type]`**，遇 `\[` 当普通字符，退化成灰色 quote。

**根因**：`defuddle/full` 的 `createMarkdownContent` 内部 new TurndownService，没有暴露 `escape` 配置 hook。我们没法在 turndown 实例上挂 rule（要 fork defuddle）。

**修复路径（已采）**：在 createMarkdownContent 输出后做 post-process —— `postProcessExtractorMarkdown` 用 regex 把 `\\\[!(\w+)\\\]` 还原为 `[!$1]`。沉淀到 §1.11。

**坑面**：`1.`/`2.` 这类数字前缀在 callout body 也会被 turndown 转义成 `1\.`（避免与 list 语法冲突）。**Obsidian Reading-view 仍能正常显示成 "1."**（backslash 仅影响 markdown 解析、不影响显示），故无需另外 unescape；但 grep 时要小心 `^> \[!` 这种 pattern 在 Obsidian 文件里命中 0 次（用 `^> \[!` 实际字符）。

**结论**：每次在 extractor 输出"有 markdown 语义的特殊语法"（callout / mathjax / dataview 等），都要假设 turndown 会乱 escape，**post-process 必备**。

### 2.12 webpack 动态 `import()` 的 publicPath 陷阱

**症状**：在 `src/content.ts` 中写 `await import('./utils/markdown-post-process')`，运行时报：
```
ChunkLoadError: Loading chunk src_utils_markdown-post-process_ts failed.
(error: https://search01.shengcaiyoushu.com/test/assets/js/src_utils_markdown-post-process_ts.js)
```

**根因**：webpack 把动态 import 切成独立 chunk。content-script 的 `__webpack_public_path__` 默认是空串，所以 chunk URL 是相对于**当前页面 origin**（如 `scys.com`），不是扩展 origin（`chrome-extension://...`）。页面侧不存在这个 JS 文件，所以加载失败。

**注**：同文件早期 `await import('defuddle/full')` 能成功——因为 defuddle/full 被打到主 chunk 里（多个 entry 都 import 它，webpack splitChunks 提到 vendors，与 content.js 同目录），不是独立懒加载 chunk。

**修复**：在 content-script 里**用静态 import**，而非 `await import()`。静态 import 全部编进 `content.js` 主 bundle，无运行时 chunk fetch。

```ts
// ✓ Correct
import { postProcessExtractorMarkdown } from './utils/markdown-post-process';

// ✗ Wrong (跨 origin 加载失败)
const mod = await import('./utils/markdown-post-process');
```

**替代修复**：设置 webpack `output.publicPath = chrome.runtime.getURL('')`，让所有动态 chunk URL 落到扩展 origin。但 cn 现状是多 entry + content/background/popup 各自独立——publicPath 全局设置会牵连其他 entry，YAGNI。

**rule-of-thumb**：content-script 内一律静态 import；只在 popup / settings 这类有自己 HTML/CSS 加载链路的 entry 用动态 import。

### 2.13 Chrome Private Network Access（PNA）：HTTPS → `http://127.0.0.1`

**症状**：scys.com (HTTPS) 内的 content-script `fetch('http://127.0.0.1:17923/save', ...)` 报 `TypeError: Failed to fetch`，server 端 access log 显示**完全没收到请求**。

**根因**：Chrome 96+ 启用 PNA，公网 origin（public address space）发往私网（127.0.0.1 / 局域网）请求要做 preflight，**preflight 必须带 `Access-Control-Request-Private-Network: true` 且响应必须有 `Access-Control-Allow-Private-Network: true`**。否则浏览器**静默 reject**（content-script 看到 fetch reject，但 server 完全没流量）。

**修复**：在 receiver（`/tmp/recv_server.py`）的所有响应中加：
```python
self.send_header('Access-Control-Allow-Private-Network', 'true')
```

同时 OPTIONS preflight 也要返回 204 + 同头（已在 §1.3 新 server 实现）。

**替代修复**：走 background script 的 `chrome.runtime.sendMessage` → 让 background 来 fetch。`host_permissions` 包含 `http://*/*` 时 background fetch 绕过 PNA。但需要拷 markdown payload 走 message bus，content-script ↔ background 有大小限制（~64MB 理论，实操几 MB 后开始延迟显著）。**保留 fetch+PNA 头是最简方案**。

**rule-of-thumb**：任何 HTTPS 站 fetch 本地 127.0.0.1 / 10.x.x.x / 192.168.x.x → 收到 `Failed to fetch` 而 server 无日志 → 99% 是 PNA。

### 2.8 cn extension ID（chrome）

从 manifest 的 `key` 字段计算（已固定）：
```
emjmdeaegbnlmhieedkmlajpbkpacgok
```

计算方式（如需重算）：
```python
import hashlib, base64, json
with open('src/manifest.chrome.json') as f:
    key_b64 = json.load(f)['key']
sha = hashlib.sha256(base64.b64decode(key_b64)).hexdigest()[:32]
print(''.join(chr(ord('a') + int(c, 16)) for c in sha))
```

### 2.14 新 extractor spec 阶段：3 维 fixture 覆盖 checklist

来自 zsxq 实施期间 G/H/I 三次回归暴露的同一根因——**spec 阶段对"接口形态多样性"的低估**。**任何新 extractor 立项前**，spec 必须明确列出 3 个维度的真实样本覆盖：

| 维度 | 来源 | 最低样本数 | 验收方式 | 未达标后果 |
|---|---|---|---|---|
| **真实样本数** | 附录 G（zsxq topic 1 → topic 2 暴露 5 bug）| ≥ 2，不同作者/时间/内容形态 | 端到端跑通 | 单 URL 假设过窄 |
| **URL host 覆盖** | 附录 H（articles.zsxq.com vs wx.zsxq.com）| 站点所有可能内容页 host | grep 站点"复制链接/分享/卡片"出口 | 某 host 的元数据丢失 |
| **type 枚举值覆盖** | 附录 I（zsxq talk vs q&a author 错位）| 每个 type 字段值至少 1 个真实样本 | **业务字段断言**（"q&a 的 author 应等于 answer.owner.name"）不是只测渲染连通 | 按 type 分支的字段选择逻辑 untested |

**辅助 audit**（同样要在 spec 阶段做）：
- `grep -oE '<标签 type="[^"]+"'` 列出该站点 inline 标签的所有 unique type（zsxq 的 `<e>` / 飞书的 block_type / 等），确保 spec 覆盖到全集
- 探一次该站 API 的所有可能 path（DevTools Network 看 SPA 自身 XHR）—— 比照 spec 假设的 endpoint 是否真实存在

**例外**：如果某 type / host 无法获得真实 URL 样本，spec 必须**显式标注 `untested-in-real-data`**，并把该分支的字段映射作为推测保留——**禁止合成 mock 单测冒充覆盖**。合成 mock 只能验证渲染管线连通，不能替代真实数据上的业务字段断言。

**与现有规则的关系**：
- §1.10（bridge popup-path simulation） 防的是路径分歧
- §1.12（视觉对比工作流） 防的是渲染层差异
- §2.14（本节） 防的是接口形态盲点 —— **更上游，spec 阶段就堵漏**

---

## 3. 用户偏好 / 协作约定

- **语言**：中文（包含技术解释、报告）
- **风格**：紧凑、信息密度高，避免冗余
- **不要轻易停下来澄清** — 用户偏好我"基于合理假设直接推进"，但若问题真分支大（如方案 A/B/C 选择）才停
- **小心 destructive 操作** — `git reset --hard`、`git push --force`、`rm -rf` 等必须明确授权
- **可主动 commit** — 完成一段独立工作后可直接 commit（不需要每次问）。commit message 要清楚说明做了什么 + 为什么。**不要 amend 已有 commit**，总是新 commit。
- **可主动 push 到 `adu` remote**（`RalphAdu/obsidian-clipper-cn`）— commit 完成后可直接 `git push adu main`。**仅 `adu`**，不可 push 到 `origin`（nextcaicai）。
- **完整的自动化测试** — 用户对 chrome MCP + bridge + HTTP receiver 三件套熟悉，验证过来回（端到端比手测可信）
- **brainstorming 流程** — 大改动用 `superpowers:brainstorming` 走 spec → plan → 实施 → 自动测试

---

## 4. 文件 / 代码位置速查

### cn 核心文件

| 文件 | 用途 |
|------|------|
| `src/background.ts` | Service worker：消息路由、飞书 / Bilibili / WeChat API 桥接、hot-reload、declarativeNetRequest |
| `src/content.ts` | Content script：注入页面、消息接收、page-world test bridge、cn 增强入口 |
| `src/core/popup.ts` | 扩展 popup 入口（复用 cn 提取流程后调 defuddle） |
| `src/core/reader-view.ts` | 上游 Reader 重构入口（cn 在内部加了 Bilibili 集成） |
| `src/utils/feishu-extractor.ts` | 飞书提取核心：OpenAPI 调用、block 渲染、resolveImages/Files/Sheets |
| `src/utils/bilibili-extractor.ts` | Bilibili 视频提取 |
| `src/utils/scys-extractor.ts` | scys.com 课程 + standalone docx 提取，复用 `convertBlocksToHtml` |
| `src/scys-docx-patch.js` | MAIN-world plain JS IIFE，注入到 `scys.com/view/docx/*`，包装 `JSON.parse` 嗅探解密后的飞书 block 数组 |
| `src/utils/content-extractor.ts` | popup 端：拿到 content 后用 defuddle 转 markdown |
| `src/utils/reader.ts` | Reader Mode 逻辑（cn 在其中加 Bilibili 播放器集成，**不再 inline base64** for PDF） |

### 飞书提取关键函数（`src/utils/feishu-extractor.ts`）

| 函数 | 行号附近 | 用途 |
|------|----------|------|
| `extractFeishuStructuredContent` | 880+ | 入口：解析 URL → fetch blocks → 渲染 HTML → resolve images/sheets/files |
| `convertBlocksToHtml` (`export`) | 606 | blocks 转 HTML（PAGE 起递归）。**scys 复用此函数** |
| `renderChildren` | 622 | 递归子块，特别处理 BULLET/ORDERED/TODO 合并 list |
| `renderBlock` | 688 | 单块按 type switch 渲染 |
| `fetchFeishuApi` | 154 | 消息桥：调 background `fetchFeishuApi` |
| `resolveFeishuImages` | 443 | 图片 token → data: URL（含 cookie-based MainWorld fallback） |
| `resolveFeishuSheets` | (P0 已加) | sheet token → HTML 表格（并发 fetch） |
| `resolveFeishuFiles` | 418 | file token → `wiki_url#block_id` 跳转链接（B 方案） |

### scys 提取关键函数（`src/utils/scys-extractor.ts`）

| 函数 | 用途 |
|------|------|
| `isScysCourseUrl(url)` | URL 检测：`scys.com/course/detail/\d+?chapterId=\d+` |
| `parseScysUrl(url)` | 提取 `{courseId, chapterId}` |
| `isScysDocxUrl(url)` | URL 检测：`scys.com/view/docx/{token}`（与 course 互斥） |
| `parseScysDocxUrl(url)` | 提取 `{token}` |
| `flattenScysBlocks(blocks)` | scys 嵌套 `children_blocks` → 飞书原生扁平 + `children: string[]` + heading 层级 rewrite（h4/h5/h6→h2/h3/h4）+ image scys: token 注入 |
| `renderScysChapterContent(blocks)` | 章节渲染入口（合成 PAGE block 防止 `convertBlocksToHtml` 走 fallback 导致嵌套块双重渲染） |
| `resolveScysImages(html)` | 图片 base64 化：L1 content-script 同源 fetch → L2 background fetch（凭 host_permissions 绕 CORS）→ L3 保留原 URL |
| `fetchScysChapter` / `fetchScysComments` / `fetchScysCourse` | 同源 API 调用，`credentials: 'include'` 带 page session cookie |
| `renderScysCommentsAsync` | 评论渲染为 HTML（**不是 markdown**——避免下游 defuddle 把 `[!quote]` 当文本 escape） |
| `extractScysStructuredContent(doc)` | 主入口 router：分发到 `extractScysCourseChapter` 或 `extractScysDocxStandalone` |
| `extractScysCourseChapter(doc)` | course 路径：API 调用 + 渲染 |
| `extractScysDocxStandalone(doc)` | docx 路径：读 localStorage `__cnScysDocxBlocks`（patch 写入）+ 渲染 |

### scys docx MAIN-world patch（`src/scys-docx-patch.js`）

| 行为 | 说明 |
|------|------|
| 注入时机 | manifest `content_scripts.run_at:'document_start', world:'MAIN'`，scys.com/view/docx/* |
| 包装 `JSON.parse` | 透明 wrapper（始终返回 original 结果），不影响 scys page 行为 |
| `findFeishuBlockArray` | 递归找飞书 block 数组（深度 4 + 抽样 first 3 元素 + 检测 `block_id:string + block_type:number`） |
| 嗅到后写 `localStorage['__cnScysDocxBlocks']` | 保留 largest-length 快照（scys 可能多次 parse） |
| `<html data-cn-scys-docx-blocks="N">` | debug marker，content-script 端可同步读取捕获状态 |

### 关键 commit 范围

```
02251b2 docs: add Backlog of pending features / TODOs / cleanup items
7a19a10 feat: render embedded Feishu sheets as Markdown tables          ← SHEET P0
c0cdb60 docs: add Feishu SHEET block rendering spec
f947779 fix: Feishu file link uses parent doc URL + block_id anchor    ← PDF 最终修复
56ad99e fix: Feishu file link points to /file/{token} viewer (错误尝试)
04fa0fd refactor: emit Feishu file blocks as plain link to source doc   ← PDF B 方案
9f4776c fix: render Feishu VIEW container so embedded FILE attachments  ← VIEW 修复（关键）
a04bc32 feat: auto-reload extension on rebuild via build-marker polling ← hot-reload 基础设施
9d0e0be chore: merge upstream obsidianmd/obsidian-clipper main (1.5.1)  ← 上游合并 merge commit
```

---

## 5. 待清理基础设施

### 5.1 临时测试文件

**位置**：`/Users/adu/Documents/Obsidian /Life/_cn-test/`
**含**：`feishu-pdf-test.md`、`feishu-sheet-test.md`、`scys-test.md`（自动化测试输出）

**清理**：
```bash
rm -rf "/Users/adu/Documents/Obsidian /Life/_cn-test"
```

**处理决策**：用户验证完整功能后随时清理。

---

### 5.2 Page-world test bridge

**位置**：`src/content.ts` 末尾，从 "Page-world visible marker for debugging" 到文件末尾 `})();`（约 60 行）

**安全考量**：
- 攻击者需先攻破飞书页面（XSS / 第三方 widget）才能触发
- 攻击者可触发 cn 提取 → 通过 `uploadUrl` POST 到攻击者服务器
- 风险等级：低，但是多余的 attack surface

**三个处理选项**：

**A. 直接删** — 生产代码最干净
- 删除 `data-cn-clipper-build` setAttribute 行
- 删除整个 `window.addEventListener('message', async (event) => {...})` 块
- 后续自动化测试要重新加（每次都重写挺烦）

**B. 保留 + uploadUrl origin 限制为 localhost / 127.0.0.1**（推荐）
- 改 bridge 处理逻辑：
```typescript
if (data.uploadUrl && typeof data.uploadUrl === 'string') {
    const u = new URL(data.uploadUrl);
    const isLocal = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
    if (!isLocal) {
        logger.warn('uploadUrl must be localhost; ignored');
    } else {
        try { await fetch(data.uploadUrl, { method: 'POST', body: markdown }); } catch {}
    }
}
```
- 攻击者即使触发 extraction 也只能写到本地，无法外传
- 保留自动化测试能力

**C. 完整保留** — 自动化测试用得最爽，attack surface 同上

**决策**：未拍板（用户决定）

---

### 5.3 `data-cn-clipper-build` 属性

**位置**：`src/content.ts:589-591`
**功能**：page world 可见的注入时间戳，用于 chrome MCP 验证 content.js 是否真注入到 tab

**保留 / 删除**：无害，建议保留（对调试有用）

---

## 6. 待实施 Feature 详单

### 6.1 F1 重做：段内高亮 `<mark>` → Obsidian `==text==`

**来源**：Phase 10 手测 Q3 — 用户在 Wikipedia 高亮 5+ 段，markdown 输出只有 H2 标题位置含 `==`，段内全部丢失

**用户需求**：让所有高亮（element 级 + text 级）在 Obsidian 中以 `==text==` 形式呈现

**已尝试方案 + 失败原因**：

| 尝试 | 位置 | 失败原因 |
|------|------|----------|
| 改 `wrapTextWithMark` 用 `insertNode('==')` | `src/utils/dom-utils.ts:99` | 改错位置（cn 实际走 `processInlineContent` 路径） |
| 改 `processInlineContent` 用 `insertNode('==')` | `src/utils/content-extractor.ts:408` | defuddle 0.18 把 `==` escape 成 `\==` |
| 改用 `HLMARKSTART9F2A` 占位符 + markdown 后处理 replace | 同上 + content-extractor.ts:160 | 占位符在 defuddle 转换中丢失（具体原因未深查），且引发飞书 regression |

**已 rollback** 到原状（commit `c7dc58a` 之前的状态没问题）。

**未来重做思路**：

**思路 A**：放弃在 HTML 阶段动 highlight，改在 `obsidian-note-creator.ts`（最末阶段）做 markdown 字符串后处理：
1. 拿到 highlights 数组（含 `content` 字段的原文）+ 最终 markdown 字符串
2. 对每个 text 高亮：
   ```typescript
   const escapedText = highlight.content.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
   markdown = markdown.replace(new RegExp(escapedText), `==${highlight.content}==`);
   ```
3. 注意：
   - 同一文字多次出现要按 startOffset 选择特定一次
   - 高亮跨多 inline 元素时原文要 normalize 空白
   - 已在 `<mark>` 内的（如 H2）不重复处理

**思路 B**：fork defuddle，patch 它对 `==` 的 escape 行为 → 维护成本高

**风险点**：
- markdown 中已有 `==` 字面字符（罕见 markdown 源文）会被误改
- 高亮内容中含特殊字符（如 `]` `)`）的 escape

**估时**：3-4 hr（含 chrome MCP 端到端测试）

**验证方式**：
- 用 cn 在 Wikipedia 测试页（如 `Obsidian (software)` 页面）做多种高亮（element + text + 跨标签）
- chrome MCP bridge 抓 markdown，断言含 `==文字==` 形式
- 在 Obsidian 中目视确认高亮渲染

**状态**：未启动

---

### 6.2 F2：普通页面选中即弹悬浮工具栏

**来源**：Phase 10 手测 C.1 — 用户报告"普通页面选中文字没悬浮工具栏，但 reader mode 有"

**已查证 root cause**：上游 Highlighter 2.0（PR #797）设计为"先调 `toggleHighlighterMenu(true)` 激活高亮模式才会监听 mouseup/touchend"，普通页面没有自动激活逻辑。

**关键代码**：
- `src/utils/highlighter.ts:241` `toggleHighlighterMenu(isActive)` —— 激活/关闭整套
- 激活副作用：addClass `obsidian-highlighter-active`、监听 mouseup/touch/keydown、**`disableLinkClicks()` 禁用所有 `<a>` 点击**、`createHighlighterMenu()`
- Reader 模式：`src/utils/reader.ts:2468` 自动调 `toggleHighlighterMenu(true)` + 行 2835 再加 `selectionchange` 监听

**三个备选方案**：

**A. 加 setting `selectionToolbarDefault`，默认 false，开启后 content.ts init 调激活** — **用户已 reject**（链接被禁副作用不可接受）

**B. 修改 `toggleHighlighterMenu` 加 `keepLinksActive: boolean` 参数** —— 改核心函数风险中

**C. 复用 reader 模式的"浮动按钮"机制**（推荐）：
- 参考 `src/utils/reader.ts:2818-2846` —— reader 自己注册 mouseup/keyup/selectionchange + 创建浮动按钮
- 在 `src/content.ts` 复制这套机制（独立组件，不改 highlighter.ts）
- 选中文字 → 显示一个浮动按钮（小高亮图标） → 用户点 → 调 `toggleHighlighterMenu(true)` + `handleTextSelection(selection)` → 立即高亮 + 立即关闭模式（避免禁用链接）

**估时**：方案 C 约 2-3 hr

**状态**：未启动

---

### 6.3 F3：vault 配置 UX 改善

**来源**：Phase 10 手测 D —— 用户报告 popup 顶部没显示 vault 下拉，调查发现 chrome storage 中 `vaults: []`（空数组）

**已查证**：cn 代码逻辑正确（`updateVaultDropdown` 在 `vaults.length > 0` 时显示），问题是**用户没在 settings 里配置 vault**。Chrome 扩展沙箱**无法自动检测** Obsidian app 内的 vault 列表（macOS sandbox 限制）。

**改进方向**：
- 在 settings General 区加更明显的"vault 必须手动添加"说明 + 引导文字
- 加 "测试 vault 名" 按钮（点击调 `obsidian://open?vault=X` 试探，失败则 toast 提示）
- README.md 中文版加配置截图

**代码位置**：
- Settings UI：`src/managers/general-settings.ts`
- vault 存储：`browser.storage.sync` 中 `vaults: string[]`（顶层字段）

**估时**：1-2 hr

**状态**：未启动

---

### 6.4 F4：Highlights Viewer 加 "在原页面打开 + 滚动到高亮"

**来源**：Phase 10 手测 C.1 —— 用户报告"Highlights Viewer 中点击高亮没跳到原文位置"

**已查证 root cause**：上游 `src/core/highlights.ts:1210` `createHighlightItem` 只给每条高亮挂 copy / delete 按钮，**没设计"打开源页面 + 滚到位置"功能**。

**改进设计**：
1. 在 `createHighlightItem` 中给 item 加新按钮 "在源页面打开"
2. 点击 → `browser.tabs.create({ url: pageUrl + '#cn-highlight-' + entries[0].data.id })`
3. cn content.ts 新增 hash 监听器：URL 含 `#cn-highlight-{id}` 时，定位对应高亮 DOM → 滚动 + 闪烁强调

**关键代码位置**：
- `src/core/highlights.ts:1210-1271` `createHighlightItem` — 加按钮
- `src/content.ts` 加 hash 监听器
- `src/utils/highlighter.ts` 找现成"按 id 定位高亮 DOM"工具函数（可能已有）

**风险**：
- pageUrl 含查询字符串时拼 `#cn-highlight-{id}` 要小心位置
- hash 在 SPA 中可能被覆盖

**估时**：2-3 hr（含 chrome MCP 自动测试）

**验证方式**：高亮一段文字 → 关闭 tab → 在 highlights viewer 点新按钮 → 应该开 tab + 跳到高亮位置 + 闪烁

**状态**：未启动

---

### 6.5 飞书 SHEET P1：保留 cell 粗体 / 颜色

**来源**：用户报告"飞书表格里有些文本是粗体，cn 保存丢失"

**P0 状态**：已实施（`7a19a10`），表格文本完整渲染（chrome MCP 验证 92 行 / 12 表无遗漏）

**P1 阻塞**：飞书公开 OpenAPI **不暴露 cell style**：
- `/sheets/v2/spreadsheets/{token}/style?ranges=...` → 404
- `/sheets/v3/spreadsheets/{token}/sheets/{sheet_id}/cells` → 404

**实现 P1 唯一可行路径**：cookie-based MainWorld（参考 `fetchFeishuImagesViaMainWorld`）

**实施步骤**：
1. **Reverse-engineer 飞书 web client 的 sheet style API**：
   - 用 chrome MCP navigate 到一个 spreadsheet URL（如 `https://duomiyang.feishu.cn/sheets/DTLmsQUbyh8AJ3tfXawcZ0sanah`）
   - 在 DevTools / chrome MCP `read_network_requests` 监听飞书 web client 发的 XHR/fetch
   - 找含 cell style / font / bold 的 response，记下 API path
2. 在 `src/background.ts` 加 `fetchFeishuSheetStyleViaMainWorld` 函数（参考 `fetchFeishuImagesViaMainWorld:850+`）
3. `feishu-extractor.ts:fetchFeishuSheetData` 同时调 background image-style + sheet API：拿 values + bold mask
4. `renderSheetAsHtmlTable` 用 `<strong>` 包 bold cells

**关键约束**：
- 飞书 internal API 可能随时改 → 加 try/catch 降级到 P0 行为
- API 可能用 WebSocket / 复杂初始化 → 这条路可能走不通

**估时**：探索 1-3 hr（不确定上限）

**状态**：P0 完成，P1 deferred（用户选了"不深入"）

---

### 6.6 飞书附件本地保存（D 方案的"完美版"）

**来源**：用户提过想"PDF 在 Obsidian 中真正可下载查看 + Export to PDF 时附件可点击"

**已上线**：B 方案（`f947779`）—— 用 `wiki_url#block_id` 跳转，简洁、不污染 md，但用户脱离飞书登录态后无法访问

**未实施候选**：

**方案 D 简化版（chrome.downloads + symlink）**：
- cn 加 `downloads` permission
- 改 `fetchFeishuFileAsBase64` 走 `chrome.downloads.download({filename: 'cn-clipper/{vault}/{filename}'})` 下载到 `~/Downloads/cn-clipper/{vault}/{filename}`
- markdown 输出：`📎 [文件名.pdf](wiki_url#block_id) ![[文件名.pdf]]`
- 用户**一次性** symlink：`ln -s ~/Downloads/cn-clipper/Life ~/Documents/Obsidian\ /Life/cn-attachments`
- 估时 ~2 hr

**方案 N（Native Messaging Host）**：
- 写 macOS native helper（Python/Node）注册 `chrome.runtime.connectNative('cn_clipper_helper')`
- helper 写到任意路径（vault attachments 绝对路径）
- cn settings 加每个 vault 的 attachments 路径配置
- 估时 6-8 hr + 安装文档

**方案 4（Obsidian companion plugin）**：
- 写一个 Obsidian plugin 接收 `obsidian://cn-clipper-attachment?vault=X&path=Y&base64=Z` URL
- plugin 解码 base64 写到 vault 内任意路径
- cn extension 通过 URL scheme 触发
- 估时 8-12 hr

**状态**：所有进阶方案未启动，B 方案是当前实施

---

### 6.7 ~~scys-extractor 收尾：callout 视觉区分~~（**已完成 2026-05-16**，commit `43a7ed8`）

详见 §6.11 — 已实施。

---

### 6.8 scys-extractor 抽通用化：飞书 docx 嵌入式渲染站点 framework

**来源**：scys 探明的"第三方系统嵌入飞书 docx"模式（§2.4.1）很可能适用于其他类似站点。

**进展（2026-05-16 docx view 实施后）**：scys 内部已经有 **两种数据交付模式**：
- **Pattern A — 后端返回明文**（course 路径）：`/search/course/getChapterContent` 直接返回飞书 block 数组
- **Pattern B — 客户端解密**（docx view 路径）：加密 JSON + scys 客户端 AES 解密 + JSON.parse → patch 嗅探

两种模式在同一 extractor 内通过 URL router 分发；下游渲染管线（`flattenScysBlocks + convertBlocksToHtml + resolveScysImages`）完全复用。

**当前**：`scys-extractor.ts` 是 site-specific（hardcoded URL pattern + API endpoint），但 URL router 已经支持两类页面。

**重构候选（如果遇到第三方）**：抽出 `embedded-feishu-docx-adapter.ts`，提供：
- `flattenEmbeddedFeishuBlocks(blocks, options)` — 嵌套→扁平 + heading rewrite + 自定义 block_type dispatcher
- `resolveEmbeddedImages(html, fetchStrategy)` — 三级 fallback 模板
- `renderEmbeddedComments(items, options)` — HTML 嵌套 blockquote 渲染
- `installDecryptInterceptor(options)` — MAIN-world JSON.parse 包装器，配置 block 数组识别策略

scys-extractor 变成薄壳，只配置 URL 模式 + 数据获取方式（明文 API or 加密静态 JSON）+ 站点特化 block 类型（如 scys 评论的 type=5001 sc_html）。新增同类站点（如知识星球、得到等）成本大幅降低。

**前提**：至少遇到第三个同类站点，再决定是否重构（YAGNI）。现在 scys 内部 2 个 path 共享代码已经够用。

**状态**：观察中，未启动

---

### 6.9 scys-extractor follow-up — 重命名 `fetchScysImagesViaMainWorld` action

**来源**：scys 实施期间 L2 fallback 从"MainWorld fetch"改为"background fetch"，action 名字保留 `ViaMainWorld` 后缀，但已与实际逻辑不符。

**改动**：
- 重命名为 `fetchScysImagesViaBackground`（或简洁版 `fetchScysImages`）
- 同步改 `src/background.ts` handler + `src/utils/scys-extractor.ts` 调用方
- 估时 5 min

**状态**：trivial 命名清理，下次顺手做

---

### 6.10 buildVariables 防御性 reserved-keys（根本修复 §2.10 footgun）

**来源**：§2.10 详述的 `extractedContent` 字典覆盖 `{{content}}` footgun，2026-05-16 在 scys docx view 实施时暴露并已在 caller-side fix。但**根本修复在 `buildVariables` 内部**——拒绝 dict 中覆盖 standard 键名。

**改动**（`src/utils/shared.ts:69-73`）：

```ts
// Reserved keys that map to canonical params — extractedContent must NOT override.
const RESERVED_TEMPLATE_KEYS = new Set([
  'content', 'title', 'author', 'description', 'url', 'image', 'favicon',
  'published', 'site', 'language', 'words', 'domain', 'contentHtml',
  'selection', 'selectionHtml', 'fullHtml', 'noteName', 'date', 'time',
  'highlights',
]);

if (params.extractedContent) {
  for (const [key, value] of Object.entries(params.extractedContent)) {
    if (RESERVED_TEMPLATE_KEYS.has(key)) {
      logger.warn(`[buildVariables] extractedContent key "${key}" ignored — reserved for canonical params`);
      continue;
    }
    variables[`{{${key}}}`] = value;
  }
}
```

**收益**：
- 任何 extractor 再不能意外覆盖 standard variables（fail-loud via warn）
- 现有 bilibili `transcript/bvid/cid` 等非保留键不受影响
- 编辑代码时 misclick 写 `extractedContent.content` 立即在 console 看到 warning + 不生效

**估时**：30 分钟（含测试 + warn log message + 复跑全套 e2e）

**为何未立即实施**：caller-side fix (`4d74412`) + bridge popup-path 验证 (`7eefd56`) 已经足够阻止 regression。这是 defense-in-depth，等真有第二次 footgun 触发或定期重构时一并做（YAGNI 优先），但**强烈推荐做**——成本低、收益是结构性安全。

**状态**：未启动，已记录改动方案

---

### 6.13 ~~scys article 第 2/3 种 body 编码 fallback~~（**已完成 2026-05-16/17**，commit `f207f73` + `8f8e427`）

scys article (`xq_topic`) 后端按帖子写作时间和编辑器返回**三种 body 编码**之一：

| 形态 | 字段 | 标志 | 例子 |
|---|---|---|---|
| 1. 飞书 blocks | `topicDTO.docBlocks` | `Array.isArray && len>0` | 55188248 (2025-11) |
| 2. Quill ql-editor HTML | `topicDTO.articleContent` | 含 `<p>` / `<div class="ql-editor">` | 418444442181248 (2021-06) |
| 3. 纯文本 + scys 实体 | `topicDTO.articleContent` | **无** `<p\|div\|ol\|ul\|h\d>` tag；段落用 `\n\n` 分；外链是 `<e type="web" href="URL编码" title="URL编码" />` | 2852488814854211 (2025-05) |

**实施**：

- `ScysArticleDetail` 加可选 `articleHtml`，`fetchScysArticleDetail` 检查 docBlocks/articleContent 任一即返回非空
- `extractScysArticleStandalone` 三分支：
  - 形态 1：现有 docBlocks → `renderScysChapterContent` 路径
  - 形态 2：直接 inline，rewrite `<img src>` 到 scys: token、strip ql-editor 外层
  - 形态 3：先跑 `preprocessScysEntityHtml`（`\n\n` → `<p>`，单 `\n` → `<br>`，`<e>` → `<a>`），再走形态 2 剩余 pipeline
- 未见过的 `<e>` type（mention / image / topic-ref 等）目前留原标签 — 见 §7 TODO

**Why**：单 URL pattern 多 body 形态是 scys 历史包袱（编辑器换代 + 多种内容来源）。每发现一种新形态都重写少量代码 + 加一个 fixture-level 回归测试。

---

### 6.14 ~~zsxq (知识星球) topic 提取~~（**已完成 2026-05-17**，commit `4e179f5` → `3c37532`）

`wx.zsxq.com/group/{gid}/topic/{tid}` 全流程支持，13 commits，60 unit tests + fixture-level 回归。

**实现的能力**：

| 能力 | 体现 |
|---|---|
| URL 检测 / 路由 | `isZsxqTopicUrl` / `isZsxqArticleUrl` / `parseZsxqUrl` |
| API 调用（同源 fetch） | `fetchZsxqTopic` (`/v2/topics/{id}/info`) / `fetchZsxqAllComments` 分页 |
| 跨域 SPA 时序 retry（3× 800/1600ms） | `fetchZsxqTopic` + `fetchCommentsWithRetry`（content-script 首次跨 origin fetch 偶发 `succeeded:false`，sleep 后第 2/3 次正常） |
| inline `<e>` 标签解析 | `parseZsxqInlineText` 支持 hashtag / mention / emoji / web / text_bold / text_italic；用 `\x01...\x03` control-char sentinel 让链接通过 escapeHtml → turndown 链路不被转义 |
| Topic body 渲染（type 分支） | talk / q&a / task / solution；**只渲染 talk.text + 文章链接卡片 🔗**，不展开 articles.zsxq.com 全文（mirror page 而非 augment） |
| 评论嵌套渲染 | API 返回已是 `replied_comments[]` 嵌套结构（depth 2），直接 walk；HTML `<blockquote>` 嵌套 → turndown 转 `> > ` |
| 图片三级 fallback | L1 content-script / L2 background fetch (host_permissions) / L3 raw URL；**用 `large` (800x q75) 而非 `original` (q100) 防巨笔记** |
| Title 来源策略 | `talk.article.title` > `topic.title` > 首个 `<e type="text_bold">` decoded > talk.text 前 40 字 |
| Author 来源 | `body.owner.name` |
| Published 来源 | `topic.create_time` (ISO8601) → `YYYY-MM-DD` |
| Page-world test bridge 接入 | content.ts dispatch + origin 白名单 + ContentResponse cascade 含 published |

**验证**：两个真实 topic 全过

| Topic | Title | Author | Published | Size | 内嵌图片数 |
|---|---|---|---|---|---|
| `/topic/185414442218552` | 《人均GMV50W…》 | 鹏哥 | 2022-02-22 | 10.5 KB | 0 |
| `/topic/14588214414288282` | 生财 5 年从 "差生" 逆袭… | 刘智行 | 2025-10-31 | 343 KB | 3 |

**回退记录（学到的反模式）**：

- ❌ 第一版抓 `articles.zsxq.com` 全文内嵌（用户："原页面就一个链接，别展开"）→ 撤销 commit `143d9e5`
- ❌ 第一版图片用 `original` (q100)：3 张截图产生 17 MB 笔记，Obsidian 拒开 → 改 `large` commit `23010c1`
- ❌ 第一版 `<e type="text_bold">` 直接 strip：丢失正文 4 个粗体段标题 → 改 `<strong>` HTML 输出 commit `23010c1`
- ❌ 第一版 web `<e>` 标签输出 markdown `[t](u)`：turndown 转义为 `\[t\](u)` 字面字符 → 改 sentinel HTML → `<a>` commit `23010c1`

详见**附录 G**。

---

### 6.15 ~~articles.zsxq.com 专栏文章 SSR 页面提取~~（**已完成 2026-05-17**，commit `c5efe22`）

**触发**：用户裁剪 `https://articles.zsxq.com/id_j31pruhtakqc.html` 时发现 frontmatter `published` 空——这个 URL **host 是 `articles.zsxq.com`**，旧 `isZsxqArticleUrl` 只匹配 wx.zsxq.com，所以走通用 Defuddle，抓不到 `#article-date` 这种站点专属 DOM。

**实施**：zsxq-extractor 内部新增第三种 dispatch kind `articles-html`，**直接 DOM 提取**（无 API 调用）：

| 字段 | DOM 选择器 |
|---|---|
| title | `document.title` |
| author | `.author-info .nick-name` |
| published | `#article-date` 文本 `"2026年05月01日 21:02"` → `YYYY-MM-DD`（新增 `parseChineseArticleDate`） |
| content | `.ql-editor` outerHTML（img src 重写到 zsxq token） |

**触发判定**：新增 `isZsxqArticlesHtmlUrl(url)`（host=articles.zsxq.com + path=`/id_{token}.html`）。`parseZsxqUrl` 返回 `kind: 'articles-html'`。content.ts dispatch + page-world bridge origin regex 都扩展。

**特点**：articles.zsxq.com 是 SSR HTML（**不是** SPA），不需要 fetch / retry / sentinel —— 30 行代码 + 1 commit 解决。SPA-vs-SSR 决定了提取范式繁简差距巨大。

**验证**：测试 URL 正确产出 `title="2026.4月记录"` / `author="释老毛"` / `published=2026-05-01` / 3 张 base64 图。

详见**附录 H**。

---

### 6.12 ~~scys article (xq_topic) 提取~~（**已完成 2026-05-16**，commit `5720539` → `5812d62`）

**实施方案**：URL pattern `scys.com/articleDetail/{type}/{id}`（首个 type 是 `xq_topic`，知识星球 topic 镜像）。后端 API 反向工程：

- `POST /shengcai-web/client/homePage/topicDetail` — `topicDTO.docBlocks` 是标准 feishu 块（541 个），复用 `convertBlocksToHtml`
- `POST /shengcai-web/client/homePage/pageTopicComment` — 分页累加，本帖 11 页 × 20 = 101 主评论 + 161 嵌套回复

article 数据**特殊性**（与 course/docx 不同）：

1. **HEADING 等级低一级**：article 用 `block_type=5` 作章节大字（course/docx 是 6）。article-specific `HEADING_REWRITE`：5→H2、6→H3、7→H4、8→H5；`HEADING7 (=9)` cutoff=0 强制 demote 为段落（浏览器渲染 12px/400）
2. **作者把 heading 按钮当 bold-paragraph 用**：长 prose 落进 block_type=7/8（"加入个人IP，形成个人专属提示词：..." 89 字）。`HEADING_PARAGRAPH_LEN_THRESHOLD` 长度阈值 demote，配 `forceBoldOnDemote` 让 markdown 整段 `**…**` 匹配浏览器 16px/600 CSS 整段加粗
3. **评论 DTO 与 course/docx 不同**：`content` 是 server-rendered HTML（不是 blocks），`replies[]` 嵌套，`images` 字段是逗号分隔 URL；评论里 URL 也需要 autolink 包 `<a>`
4. **FILE block (block_type=23)**：scys video/zip 附件无独立 URL，把 feishu-extractor 默认的 `feishu-file-block://` 占位符重写成 `📎 [filename](article_url#block_id)`（不然 defuddle 直接丢）
5. **renderTextElements 共用增强**：
   - 自动 link 处理：`text_run` 无 `link.url` 时把 content 里的 bare URL 包成 `<a>`（scys 把 URL 当纯字符串 + CJK 标点紧邻让 GFM autolink 失效）
   - heading 内 skipBold：H 标签自带粗体，再嵌 `<strong>` 出 `## **二、…**` 噪音 + 破坏 `**` 配对
   - 相邻 `<strong>` 合并：避免 `**aa****bb**` 字面 `****` 残留

**audit 工具**：`scripts/scys-visual-audit.py`（commit `04b04e9`）— chrome MCP dump 浏览器 vc-doc-item DOM (fontSize/fontWeight/class/textAlign/colors) + Python 按文本前缀对齐 markdown token + 反推视觉等价（h1/h2/.../paragraph/bold_paragraph/bullet/...）。**全程不开 Obsidian、不抢用户焦点**，是补充 `scripts/obsidian-verify.sh` 视觉对比的"全文穷举"层。

**取舍（已知 markdown 限制，未来不再追修）**：

- **text_color (red emphasis)**：标准 markdown 无 color 原语；`<span style="color">` 被 turndown strip。本次试过 `[[SCYS-COLOR-N]]` placeholder + post-process → HTML inline，用户明确"不要 HTML"，撤销。
- **center / right text-align**：标准 markdown 无 align；`<div align>` 同理被 strip。同上 placeholder 方案被撤销。
- **ordered list 编号**：浏览器跨 `<ol>` 累计编号（5/6/7/...），markdown 标准每段独立从 1。markdown 标准行为，接受。

**测试覆盖**：165 unit tests（含 11 类 fixture-level 回归 + 5 个 markdown-post-process placeholder 还原 → 后已撤销）。

---

### 6.11 ~~评论 / 正文 callout 类型标记保留~~（**已完成 2026-05-16**，commit `43a7ed8`）

**实施方案**：
1. `feishu-extractor.ts` 加 `FEISHU_EMOJI_TO_CALLOUT_TYPE` 映射（bulb→tip, mag_right→info, warning→warning, …）
2. CALLOUT case 直接生成 `<p>[!${type}] ${emoji} ${title}</p>` 作为 callout 第一段；不依赖 turndown 自定义 rule（更轻量，飞书 + scys 共用）
3. scys docx 形态特殊（`callout.elements=null` + 首个 heading child 是视觉标题）—— 把首个 heading 提升为 callout title line
4. `markdown-post-process.ts` 解 turndown 对 `\[!type\]` 的转义（参见 §1.11 / §2.11）

**端到端验证**：scys docx `QSn2dD` 的 7 个 callouts（1 × bulb + 6 × mag_right）全部渲染为 Obsidian 绿色 `[!tip]` / `[!info]` colored boxes，视觉与 feishu 浏览器原生 callout 一致。

**未来扩展**：
- 飞书 callout `style.background_color` → Obsidian foldable callout suffix `[!tip]-` / `[!tip]+`（折叠态）
- 段内 background_color span → Obsidian `==highlight==`（与 §6.1 高亮重做合并）

---

## 7. 代码内 TODO 注释

| 文件:行 | 内容 | 优先级 |
|---------|------|--------|
| `src/core/highlights.ts:1278` | `wrapOrphanListItems` 永远包 `<ul>`，stored `<li>` 来自 `<ol>` 编号丢失 — 修需要在 highlight 存储时记录父 list 类型 | 中 |
| `src/utils/highlighter-overlays.ts:143` | overlay 算法 O(N × rects)，>50 高亮的页面有性能问题 | 低 |
| `src/utils/filters/title.ts:1` | title 过滤器考虑多语言 case 转换 | 低 |
| `src/utils/scys-extractor.ts:preprocessScysEntityHtml` | 只处理了 `<e type="web">`；遇到 `<e type="mention\|image\|topic-ref\|...">` 留原标签 — 实际看到再扩展（加 fixture + 加 case 分支） | 中-低 |
| `src/utils/scys-extractor.ts:extractScysArticleStandalone` | article body 已知 3 种形态（docBlocks / Quill HTML / plain-text+`<e>`），未来若发现第 4 种（如 markdown 字符串、XML、JSON-AST 等）需要再加分支 | 取决于实际发现 |
| `scripts/scys-visual-audit.py` | 硬编码 `/tmp/scys-article-dom-dump.json` + 单 vault md 路径；改 CLI 参数 + 多 fixture 批量跑能作为 CI 回归 | 低 |
| `src/utils/zsxq-extractor.ts:parseZsxqInlineText` | 当前覆盖 hashtag/mention/emoji/web/text_bold/text_italic；未来可能遇到 text_color / text_strike / image / topic-ref / mention-link 等新 `<e>` type — 实际看到再扩展，spec 阶段抓 fixture 时主动留意 | 中-低 |
| `src/utils/zsxq-extractor.ts:extractZsxqStructuredContent` | `kind === 'article'`（`wx.zsxq.com/group/{gid}/article/{aid}`）当前 return null，退化到 Defuddle 兜底；专栏文章 URL 提取未实施 — 抓到一个真实 article URL 后再开 plan。注：`kind === 'articles-html'` (host=articles.zsxq.com) 已在 commit `c5efe22` 实施 | 低 |
| `src/utils/zsxq-extractor.ts:fetchZsxqAllComments` | 评论 image 字段（fixture 都不含）若实际遇到，需要走 `resolveZsxqImages` pipeline；当前 `renderCommentBody` 已渲染 `<img>` 占位符，端到端未验证 | 低 |
| `src/utils/zsxq-extractor.ts:fetchZsxqArticleHtml` + `background.ts:fetchZsxqArticleHtml` | 保留为未使用的 background handler（topic 路径已不再 fetch article HTML）；如 §6.14 提到的 `article` URL 提取启动可直接复用 | 极低（保留即可） |

---

## 8. 操作 / 工作流类待办

### 8.1 git remotes 与 push 配置

**当前三个 remote**：

| Remote | URL | 角色 |
|--------|-----|------|
| `adu` | `git@github.com:RalphAdu/obsidian-clipper-cn.git` | **用户自己的 fork**，push 默认目标，`main` 已 `-u` 跟踪 `adu/main` |
| `origin` | `git@github.com:nextcaicai/obsidian-clipper-cn.git` | nextcaicai 的 fork（用户最初 clone 的源），**只读跟踪**（无 push 权限）|
| `upstream` | `git@github.com:obsidianmd/obsidian-clipper.git` | 上游飞书官方（cn fork 的最初分叉点）|

**fork 链条**：
```
obsidianmd/obsidian-clipper  ← 官方上游
        ↓ fork
nextcaicai/obsidian-clipper-cn  ← cn fork（加飞书/Bilibili/WeChat 增强）
        ↓ fork
RalphAdu/obsidian-clipper-cn   ← 用户自己的 fork（在 nextcaicai 基础上继续加工）
```

**默认行为**：
- `git push` / `git pull` 走 `adu`（已 `-u` 跟踪）
- 不需要每次指定 remote

**同步 nextcaicai 上游更新**：
```bash
git fetch origin
git log --oneline ..origin/main | wc -l   # 看新增 commit 数
git merge origin/main                      # 或 git rebase origin/main
git push adu main                          # 推到自己 fork
```

**同步飞书官方上游**：参考 §9.1，走 `upstream` remote + merge 流程。

**最近一次 push**：commit `2169327..8955071`（42 commits）—— 本次会话所有 merge + feature + cleanup 工作

**禁止操作（未经明确授权）**：
- `git push --force` 到 `adu/main`（强制覆盖远端历史，需用户明示）
- 推 `nextcaicai/origin`（无权限，会 403）
- `git reset --hard` / 任何 destructive history 改写

**默认允许**：完成独立工作单元后直接 `git commit` + `git push adu main`，无需逐条问用户。

### 8.2 测试基线 3 个 known failures

```
template-integration.test.ts > edge-cases
template-integration.test.ts > minimal
template-integration.test.ts > youtube
```

**原因**：
- `youtube`：测试硬编码 `-08:00` 时区，本机 `+08:00`（Asia/Shanghai）
- `edge-cases` / `minimal`：jsdom 序列化把内容包 `<body>` + cn 的 `normalizeImageSources` 与之交互产生差异

**不是 merge 引入**，cn 主线既存。

**修复**：
- `youtube`：在 `vitest.config.ts` 加 `globalSetup` 设 `process.env.TZ = 'America/Los_Angeles'`
- `edge-cases`/`minimal`：更新 fixture expected 文件匹配新行为

**估时**：30 min

### 8.3 文档更新

- `README.md` / `README_EN.md` 飞书章节补充 SHEET 表格支持说明（现状："只支持 docx 文字 + 图片"过时了）
- 添加 BACKLOG.md 入口链接到 docs 顶层

---

## 9. 跨仓库（上游同步）

### 9.1 定期合上游

- 当前 cn 已合到上游 `776d083`（1.5.1）
- 建议每 N 周拉一次上游：
  ```bash
  cd /Users/adu/Workspace/github/obsidian-clipper/obsidian-clipper-cn
  git fetch upstream
  git log --oneline ..upstream/main | wc -l   # 看上游新增 commit 数
  ```
- 超过 ~10 个 commit 时启动 merge 流程（参考 `docs/superpowers/specs/2026-05-14-merge-upstream-design.md`）

### 9.2 cn 增强上游化（候选）

- `src/utils/logger.ts` — merge 时与上游差异已调和
- `src/utils/string-utils.ts` — 可考虑 PR
- 飞书 / Bilibili / WeChat 提取器：上游维护者明确说放到 Defuddle 库，cn fork 独立维护

---

## 10. 优先级建议

按推荐顺序（实际工作可调整）：

1. **清理 + 决策 bridge**（5-10 min）—— 删 `_cn-test/` + 拍板 bridge 处理（A/B/C）
2. **F4 Highlights Viewer 跳源**（2-3 hr）—— 用户已反馈的 UX 痛点，独立模块风险低
3. **F3 vault UX 改善**（1-2 hr）—— 简单 UI 改进
4. **修 baseline 3 个 known failing tests**（30 min）—— 让 CI 干净
5. **F2 方案 C 浮动按钮**（2-3 hr）—— 用户反复提的高频需求
6. **F1 重做（markdown 后处理路线）**（3-4 hr）—— 用户高感知，但 defuddle escape 历史包袱要小心
7. **飞书 SHEET P1 bold**（探索性 1-3 hr）—— 取决于飞书 internal API reverse-engineer 可行性
8. **飞书附件本地保存（D/N/4）**（2-12 hr）—— 取决于方案
9. **定期合上游**（看积累量）
10. **文档 / Push 远端**（用户决定时机）

---

## 附录：如何在新会话中快速接续

新会话的 AI 应该这样开局：

1. **读这个 BACKLOG.md**（你正在读）
2. **查 git log**：
   ```bash
   git log --oneline -20
   ```
3. **看最近 spec/plan**：
   ```bash
   ls -lt docs/superpowers/specs/ | head
   ls -lt docs/superpowers/plans/ | head
   ```
4. **如要继续某 feature，读对应 spec**：
   - `docs/superpowers/specs/2026-05-14-merge-upstream-design.md`（上游合并设计）
   - `docs/superpowers/specs/2026-05-14-f1-mark-to-equals-design.md`（F1 已弃方案，作反例参考）
   - `docs/superpowers/specs/2026-05-14-f5-feishu-file-download-design.md`（PDF 附件）
   - `docs/superpowers/specs/2026-05-15-feishu-sheet-rendering-design.md`（SHEET 表格）
   - `docs/superpowers/specs/2026-05-15-scys-extractor-design.md` + `plans/2026-05-15-scys-extractor.md`（scys 课程页面）
   - `docs/superpowers/specs/2026-05-16-scys-docx-extractor-design.md` + `plans/2026-05-16-scys-docx-extractor.md`（scys standalone docx，最近完成）
5. **如要自动化测试**：参考第 1 节"开发基础设施速查"重启 receiver + 用 page-world bridge
6. **如要拉新上游 commit**：参考第 9 节

---

## 附录 B：scys-extractor 实施反思（2026-05-16）

scys.com 课程页面提取器从 brainstorm 到端到端验收通过约 4 小时，22 个 commits。沉淀的教训和可借鉴的模式：

### 做对的事情

1. **先抓真实 API fixture 再写代码**：Task 0 抓了 scys API 返回的 JSON 落到 `src/utils/fixtures/`，所有单测基于 fixture（不是合成数据）。多次 catch 了"接口实际形态 vs spec 假设"的偏差（`file_url` 实际是顶层字段 not nested in image，`created_at` 是 ISO 字符串 not unix，评论 content 是 `block_type=5001` not feishu 原生）。**没有真实 fixture 这些都要到 Task 11 端到端才暴露**，调试成本高很多。
2. **复用现有渲染管线**：scys 后端"碰巧"返回飞书 docx 原生 block，让我们能复用 `convertBlocksToHtml`。这省了 ~80% block 渲染代码，且使飞书提取器的 bug 修复自动惠及 scys。即使后端结构不同，也应**优先考虑写薄适配层把数据转换到现有管线**而不是另写一套。
3. **Subagent-Driven Development**：每个 task 派新 subagent 实施 + 两个 reviewer（spec compliance + code quality）。主上下文不被实现细节淹没，subagent 输出可控。22 commits 中约 1/3 是 reviewer 提出的修复——值得。
4. **自动化端到端循环**：webpack watch + chrome.alarms reload + page-world bridge + HTTP receiver + Python HTML parser 五件套，单轮 ~15 秒。比手测可信也比手测快。

### 走过的弯路

1. **MAIN-world fetch 假设**：spec 设计 L2 fallback 用 `executeScript world: 'MAIN'`，假设这能绕 CORS。**实际仍受目标域 CORS 头限制**。Task 11 测试发现 58 张图全失败才察觉，要回到 spec 修方案。**教训**：CORS 行为按"上下文 origin"分类（content-script = page origin / MAIN world = 同 page origin / background = extension origin），只有 background fetch 凭 host_permissions 真正绕过 CORS。已记入 §1.8。
2. **dev/ vs dist/ 加载路径混乱**：扩展加载哪个目录决定 `chrome.alarms` poll 哪个 marker。**我反复 watch dev/ 而用户加载 dist/，反复"代码改了 chrome 没反应"**。**已彻底固化约定（2026-05-16）**：`webpack.config.js` 中 dev 与 build 统一输出 `dist*/`，扩展恒定加载 `dist/`，不再有此坑。详见 §2.7。
3. **webpack 缓存假阴性**：偶尔 webpack 报 `cached`，源代码已改但 emit 文件未更新。`touch` 或 `rm -rf dev/ node_modules/.cache` 强制重建。已记入 §2.9。
4. **content 字段格式假设**：scys-extractor 早期一次性输出 HTML + markdown 混合到 content 字段，下游 defuddle 把 markdown 字符当 HTML 文本节点 escape，整段评论 squash 成一行。**教训**：cn 现有约定 `content` 字段是 HTML，所有提取器必须遵守；要在 markdown 里嵌入特殊语法（如 Obsidian callout `[!quote]+`）必须重新设计管线，不能边角偷工。最终 scys 接受妥协：评论用 HTML blockquote（失去 callout 类型）。
5. **CDP eval 30 秒超时**：bridge 触发 + poll 写在同一个 javascript_tool 调用里，bridge 跑 30+ 秒（多张 image fetch）时会触发 CDP 超时。**修复**：拆成两次 javascript_tool 调用——trigger 一次（立即返回 testId），等几秒后单独 poll localStorage。

### 可借鉴的模式（未来类似 feature 实施时复用）

1. **专项提取器骨架**（参考 scys/feishu/bilibili 三个 extractor 的共同 shape）：
   - `isXxxUrl(url)` URL 检测
   - `parseXxxUrl(url)` 提取关键参数
   - `fetchXxxData(...)` API 调用（same-origin 用 `credentials: 'include'`；跨域用 background fetch）
   - `flattenXxxBlocks(...)` 适配层（结构转换，不做渲染）
   - 复用 `convertBlocksToHtml` 或自己 render 出 HTML
   - `resolveXxxImages(html)` 图片 base64 化
   - `extractXxxStructuredContent(doc)` 主入口，返回 `ScysStructuredContent` 形态

2. **L1/L2/L3 图片下载 fallback** 标准模式（按 CORS 限制递增）：
   - L1: content-script 同源 fetch（带 page cookie，但受目标域 CORS 限制）
   - L2: background fetch（凭 host_permissions 绕 CORS，但没有 page cookie）
   - L3: 保留原 URL（兜底，等价当前行为）
   - **关键**：必须给目标域 host_permissions，否则 L2 也跨域被拒

3. **第三方 docx 嵌入识别**（§2.4.1）：DOM 含 `.feishu-doc-content` + `.vc-doc-item[data-block-id]` 高概率是飞书 docx 嵌入式渲染。API 返回大概率是飞书 block 形态。

4. **HTML 结构化验收**（§1.9）：md → HTML（markdown-it）→ Python HTMLParser 解析 → magic bytes 校验。比 grep .md 更可靠。`scripts/scys-clip-loop.sh`（plan §11）的 grep 简版只覆盖 60% 缺陷，HTML 解析覆盖 95%。

5. **HTTP receiver + bridge** 是 scys/feishu/bilibili 共用的端到端基础设施。新增 extractor 时**不要重复造**，扩展 `src/content.ts` page-world bridge 的 origin 白名单 + URL 路由分发即可（参考 commit `ca0b17f`）。

### 仍可改进的地方（未列入 §6 feature 因 YAGNI）

- spec 阶段对"image MIME server-side 不可信"没预见到（servers return wrong Content-Type），导致 Task 11 末轮才补 magic-byte detection。下次 spec 检查 image 处理时把"binary 自检"作为默认。
- bridge 同步/异步 API 拆分得有点繁（sync `renderScysComments` 只为单测保留，prod 用 async 版）。如果 vitest 能 mock fetch 进 async 路径，sync 版可删。

### 跨仓库（上游同步）影响

scys-extractor 是 cn fork 独有 feature，**不计划上游化**（scys.com 是中文小众站点）。但 §1.8/§1.9 总结的 CORS 上下文表 + HTML 结构化验收模式是通用的，未来如果上游讨论扩展 hot-reload / e2e 测试基础设施，可以贡献。

---

## 附录 C：scys docx view 实施反思（2026-05-16）

接续附录 B（scys course）之后，scys 又新增 standalone docx (`/view/docx/{token}`) 路径。期间踩了几个新坑、暴露 1 个长期潜伏的 footgun，并升级了自动化基础设施。

### 做对的事情

1. **先 probe 数据形态再写代码**：通过 `chrome.scripting.javascript_tool` 真实访问目标 URL，发现 docx 不走 course API（`/info` 不返回 content），正文在加密静态 JSON。这避免了照 course 模式写完发现根本拿不到数据的浪费。
2. **选 D6 而非脆弱方案**：探明 scys 客户端解密后，brainstorming 阶段直接放弃 A (DOM scraping，有虚拟化风险) / B (逆向 AES，scys 改 key 即崩) / C (hook fetch，仍需解密)。选 D6（MAIN-world JSON.parse 包装）—— 不依赖解密算法、不依赖 DOM、不需要 reload tab、用户无感。
3. **URL router 抽象**：把 `extractScysStructuredContent` 改造为薄 URL router，分发到 `extractScysCourseChapter` / `extractScysDocxStandalone`。两条 path 共享 80%+ 渲染管线代码。新增同站点 path 成本极低。
4. **Subagent-Driven 6 task 实施**：5 个代码 task 全部 subagent 完成 + 双 review；Task 6 端到端我自己执行（chrome MCP 自动化）。22 次 dispatches 中 ~5 处由 reviewer 提出修复，质量门槛守住。

### 走过的弯路

1. **MAIN-world patch 没拦到飞书 block 数组**：spec 假设 scys 解密结果是顶层 array (`Array<{block_id, block_type}>`)，实测是 object wrapped (`{...: {content: [...]}}`)。Task 6 端到端立即暴露（`capturedBlockCount: 0`）→ fix commit `d225dba` 加 `findFeishuBlockArray` 递归深 4 层。**教训**：spec 关于数据形态的假设要在 Task 0 fixture 阶段就验证，不能拖到 Task 6。
2. **🔥 dict-overlay footgun**：scys course 实施时（commit `43e51dc`）顺手写了 `extractedContent.content = scysContent.content`(HTML)，意图是给 template 用。**但 `buildVariables` 的实现会用这个 dict 覆盖之前从 markdownBody 设置的 `{{content}}` 变量**——结果 popup 路径输出 raw HTML，bridge 路径却是 markdown，**3 个月内 user 没立即察觉**。这次 docx view 实施同样写法，user 在 Obsidian 中看到 raw HTML 标签才上报。**教训**：
   - 测试基础设施有盲区——bridge 走自己的路，没经过 popup → buildVariables，无法捕获此类 dict-overlay bug
   - cn / 上游 `shared.ts:buildVariables` 的"extractedContent 字典对 standard variables 优先"是个 implicit footgun，至今没文档化
   - **本次修复 4 行代码 + 2 commits 但教训巨大**：每条主流程的代码改动都要追问"是否同时被 user 实际路径用到？模拟流程能否在 bridge / e2e 中覆盖？"
3. **chrome MCP extension 在 dev reload 时短暂断开**：webpack rebuild → chrome.alarms reload cn extension → claude-in-chrome MCP extension 偶尔也跟着断（可能 chrome 重启 service worker 子系统）。需要等 10-15 秒或重启 chrome 才能恢复。**教训**：dev iteration 流程要预留这种 transient downtime；不要 hammer reconnect。

### 可借鉴的模式（沉淀进基础设施）

1. **MAIN-world content_scripts 注入模式（§1.8 + §2.1）**：当需要在 page JS 运行前 hook 全局 API（如 JSON.parse / fetch / XMLHttpRequest），manifest 静态声明 `content_scripts.run_at:'document_start', world:'MAIN'` + plain JS IIFE + CopyWebpackPlugin 直接复制。**避免 webpack runtime / TS / polyfill 重量级 overhead**。Chrome 111+ / Firefox 128+ / Safari 18.2+ 原生支持。
2. **localStorage 跨 world 桥接**：MAIN world ↔ ISOLATED content-script 通信。同 origin 共享 localStorage 是最简单的 pull 模式（content-script 也可读 `<html data-cn-...>` 同步 marker，看是否已捕获）。
3. **Bridge popup-path simulation（§1.10）**：让 e2e bridge 不只走 createMarkdownContent，还要模拟 popup → buildVariables → `{{content}}` 完整路径，**用 `popupMatchesBridge` flag 暴露差异**。这是 differential testing — 两条本应等价的路径输出不一致即 bug 信号。**未来所有 extractor 实施都按这个标准验收**。
4. **同一 scys 站点的两种数据交付（pattern A / B）共用渲染管线**：`scys-extractor.ts` 内部 URL router 分发到 course / docx 两条 path，但 `flattenScysBlocks / convertBlocksToHtml / resolveScysImages` 完全复用。**未来同类站点（知识星球、得到等）按此 router pattern 直接扩展**。
5. **递归 + 限深 + 抽样的"宽容嗅探"模式**：`findFeishuBlockArray(value, depth)` 演示了如何在不知道 wrapping 结构的情况下嗅探目标数据 —— 递归找数组 + 深度限制（防止 pathological JSON）+ 抽样校验（O(1) per check）。该模式适合所有"page 用自定义 wrapper 包了我们要的数据"的场景。

### 总结性观察

- **scys docx 实施 commits 量**：8（Task 1-5 各 1 + Task 6 fix 1 + popup-path bug fix 1 + bridge upgrade 1）
- **从 spec → e2e 验证通过**：约 5 小时
- **发现的长期潜伏 bug**：1（dict-overlay 影响所有 scys course 历史裁剪，user 之前可能没意识到 HTML 渲染问题）
- **沉淀进 BACKLOG 的新 section**：4（§1.10 / §2.10 / §6.10 / §6.11）

每次 extractor 实施都暴露 1-2 个基础设施盲区。本次的 dict-overlay 类似 spec § course extractor "三种 fetch 上下文 CORS 行为" — 一旦记入 BACKLOG，未来人/我自己都能从此 fast-path 避免重蹈覆辙。

## 附录 D：Obsidian 视觉对比 / callout 修复迭代反思（2026-05-16）

接续附录 C（scys docx view）。前者完成"文本完整性"e2e（fixture text_run 0 missing + emoji count 一致），但用户提出更高标准：**比对 Obsidian Reading-view 渲染与浏览器渲染的视觉一致性，迭代到一致**。本次迭代修复了 4 个视觉差异，并暴露 3 个工具链问题。

### 做对的事情

1. **承认"文本 PASS ≠ 视觉一致"**：之前的 fixture text_run diff 是文本级覆盖度，但 callout 灰色 blockquote vs 浏览器绿色 box 是 **结构性渲染差异**，文本 diff 完全测不到。**视觉对比工作流（§1.12）是必要互补**——chrome MCP 截图 + macOS `screencapture` + 两边对照。
2. **修改后立刻端到端验证**：每改一处 callout 渲染，重 build → reload → re-trigger bridge → 视觉对比 4 步在 1 分钟内完成；diff 不一致立即定位代码。**不积压 4 个改动一起测**，每改一处单独 verify。
3. **3 个工具链问题"顺手修了"而非绕过**：
   - `recv_server.py` single-shot → multi-shot + PNA 头（§1.3 升级，将来不踩同坑）
   - `obsidian-verify.sh` AX window-id failure → `screencapture -x -m` 全屏（§1.5 沉淀 Electron AX 限制）
   - webpack 动态 import 跨 origin chunk → 静态 import（§2.12 新认知）
4. **新增 1 个 util + 4 处 call site 接入**：`markdown-post-process.ts` 用单 regex 解 turndown 转义；4 处 `createMarkdownContent` 调用集中包一层（popup main path + bridge）。**职责单一、易于扩展**。

### 走过的弯路

1. **第一次改 callout 没考虑 turndown 转义**：直接在 feishu-extractor 输出 `[!tip]`，期望 turndown 透传 → 实际 `\[!tip\]`。**教训**：每次让 extractor 输出 markdown 语义化字符（`[`/`]`/`==`/`$$`/`>` 等），都要先在 unit test 跑一遍 HTML→markdown 确认。
2. **第一次 bridge 调用用 `postUrl` 不是 `uploadUrl`**：bridge 期望 `data.uploadUrl`，我看错参数名。**教训**：bridge handler 接受参数名要在 §1.2 / §1.10 速查里写死。
3. **以为 uploadedTo: null 是 server 死了，实际是 PNA 拒绝**：浪费时间 restart receiver。**教训**：bridge handler 的 `try/catch` 把 fetch 错误吞掉了——已经把 `uploadError` 字段暴露到 result，下次出问题立即知道是 CORS / PNA / 路径错。
4. **scoll Obsidian 找 callout 用 Cmd+Home 不灵**：Obsidian Reading-view 中 Cmd+Home 不滚到顶。**教训**：osascript `tell System Events to key code 116`（PageUp）多次更稳；Cmd+F 搜索定位也行，注意中文版命令名（**Reading mode 找不到**——用 Cmd+E）。

### 可借鉴的模式（沉淀进基础设施）

1. **`postProcessExtractorMarkdown` 集中后处理**（§1.11）：所有 markdown 生成路径**必经此函数**，避免散落 regex / 分支处理。未来类似 turndown 转义引发的 Obsidian 语法破坏，全部加在此处。
2. **视觉对比迭代循环**（§1.12）：浏览器 chrome MCP screenshot + Obsidian macOS screencapture + 我自己 Read 两图视觉 diff → 修代码 → 重新验证。**不需要肉眼用户、不需要 OCR/pixel diff**——me-as-vision 已足够发现 callout 颜色/icon/标题位置类问题。
3. **HTTP receiver multi-shot + PNA + path query**（§1.3 升级）：将来其它 e2e 都直接用同一个 receiver，无需为每次测试重启。
4. **Electron AX 限制速查**（§1.5）：Obsidian/Cursor/VSCode 等 Electron 应用都不暴露 `id of window 1`——以后不要反复尝试 `screencapture -l`。
5. **PNA + content-script fetch 速查**（§2.13）：HTTPS → 127.0.0.1 fetch 静默失败，第一反应应该是查 PNA 头。

### 仍可改进的地方（未列入 §6 feature 因 YAGNI）

1. **Python perceptual diff 截图比对**：当前两张图我自己 Read 视觉对比，主观但够用。可以加 pixelmatch / ImageHash 自动报"两图哪些区域差异最大"——只有未来视觉差异变得 subtle、目视不可靠时再上。
2. **callout 折叠态保留**（feishu `style.background_color` → Obsidian `[!tip]-` / `[!tip]+`）：当前 type 映射保留 emoji 关联，但折叠态信息丢失。低优先级。
3. **段内 background_color highlight → `==text==`**：feishu 内联高亮（红色背景文字）当前转 `<code>` 或纯文字。Obsidian 有 `==highlight==`，可加 turndown rule。与 §6.1 重做合并。

### 总结性观察

- **视觉对比迭代 commits 量**：2（emoji 修 `5a3d2e3` + callout 类型 `43a7ed8`）
- **从用户提需求 → e2e + 视觉一致**：约 1.5 小时（已有附录 C 基础设施）
- **新沉淀进 BACKLOG**：6 section（§1.3 升级 / §1.5 升级 / §1.11 / §1.12 / §2.11 / §2.12 / §2.13）+ §6.7/§6.11 标记完成 + 本附录
- **基础设施小成本升级**：3 处（receiver / verify script / webpack 静态 import 约束）

每次质量门提高一次（fixture text_run → 视觉一致），都会暴露之前没注意的渲染细节。**视觉对比循环现在是 feishu/scys 类 extractor 的新基线验收**——不再"文本 PASS 就算完成"。

---

## 附录 E：scys article (xq_topic) 实施 + 全文视觉穷举反思（2026-05-16）

接续附录 D。前者建立"打开 Obsidian 视觉对比"工作流，本附录把它推到"全文穷举对比"——用 headless 反推 audit 工具枚举每个浏览器视觉单元的期望 markdown 类型，循环修复直至 0 mismatch。共 6 个 commit，覆盖 12 类视觉差异，沉淀新工具 `scripts/scys-visual-audit.py`。

### 做对的事情

1. **每个差异都先做反向工程再修**：API 反推（topicDetail/pageTopicComment 字段名靠 patch fetch + 看真实 page 发请求拿到）、文档行为反推（heading 长度 cutoff、bold-on-heading 冗余、`**` 字面残留根因都通过 grep fixture + 浏览器 DOM 对比定位）。**不靠猜测改一行试一次**。
2. **headless 反推 audit 工具沉淀进 repo**：`scripts/scys-visual-audit.py` 输入 chrome MCP dump 的 vc-doc-item JSON + vault markdown，按文本前缀对齐 + 反推 expected token type + 报 mismatch 桶。**全程不开 Obsidian、不抢用户焦点**，是补充 §1.12 视觉对比的"全文扫荡"层。以后任何 scys 改动都能一键复检。
3. **brainstorm skill 用对了 2 处**：方案选择（headless 反推 vs 副屏 Obsidian vs 静态 HTML）和审计范围（穷举 vs 增量 vs 重写）—— 选项画清楚 + 推荐 + 让用户拍板，避免单方向走死。
4. **承认+复盘漏检**：用户每次指出"是否真用 Mac Obsidian 对比"/"是否完整全文"/"为什么没发现 X 差异"，**先承认没做到 + 分析为什么漏 + 设计补救**，而不是辩解。本次 4 次承认 → 4 次方案升级。

### 走过的弯路

1. **第一轮只字符 diff 当视觉一致**：跑 vitest dump → grep markdown 内容存在 → 报 PASS。**漏掉了 markdown 链接是否可点击、blockquote 容器是否丢失、heading 是否被误升级等渲染层差异**。教训写入 commit `b560794` message："char-level diff is not enough — visual semantics must be diffed in Obsidian.app via screenshot."
2. **`<div align>` / `<span style="color">` HTML inline 路线被用户拒**：投入 commit `016e2a3` 加 `[[SCYS-COLOR-N]]` placeholder + post-process 还原为 HTML inline。用户明确"标准 markdown 不要 HTML"，撤销 commit `5812d62`。**教训**：碰到 markdown 无法表达的视觉信号（color/align）时**先问用户偏好**，不要默认包 HTML —— turndown 也会 strip 大部分 inline 样式，链路又长又脆，性价比低。
3. **用户裁剪和我 dump 不同步**：vault md 通过 vitest 直接 import `.ts` 源 → 立刻反映最新代码。**chrome 扩展加载的是 `dist/content.js` 编译产物**，没 `npm run build:chrome` + reload extension，用户裁剪到的还是旧代码。每改源都要 build + 提示用户 reload。
4. **DOM 抓信号设计不全**：第一版 dump 只 fontSize/fontWeight/class，漏了 textAlign / colors / 多元素 bold ratio / inline code / link / blockquote-ancestor。第二轮才补齐。**教训**：DOM dump 字段清单要**穷举设计**（heading/list/text/quote/callout/grid/table/image/link/code/color/align/background-color/italic/underline/strikethrough），缺一个维度就漏一类差异。
5. **audit alignment 算法简单 normalize 漏 token**：ordered list 浏览器是 sequential 5/6/7，markdown 是各自从 1，norm 后字串不一样 → 36+ 个 false negative "not-found"。补 strip leading number / bullet prefix 后降到 0。**教训**：浏览器→markdown 对齐要**先归一化所有可能的 list prefix 差异**。
6. **bold-on-heading 引发 `**` 字面残留**：源数据 heading 内 text_run.bold=true 让 renderTextElements 包 `<strong>`，markdown 出 `## **二、…**`；相邻 `<strong>` 转 markdown 是 `**aa****bb**` 中间 `****` 字面 4 星。修复：HEADING render 时 skipBold + 相邻 `<strong>` 合并成单个。

### 可借鉴的模式（沉淀进基础设施）

1. **`scripts/scys-visual-audit.py`**（commit `04b04e9`）：浏览器 DOM JSON + vault markdown → 反推 expected → 列 mismatch。未来 scys-extractor 任何改动一键复检。**不抢用户焦点**是关键设计目标（chrome MCP captureVisibleTab 不需要前台 Chrome；Python audit 跑终端；不用打开 Obsidian）。
2. **`renderTextElements` 加 `RenderTextOptions`**（commit `016e2a3`）：`skipBold`、`forceBoldOnDemote` 等 context-aware 渲染参数。**未来类似"H 标签自带视觉 vs inline 标签语义"冲突直接走此模式**——extractor 调用方传 context，renderer 决定是否包内联标签。
3. **per-type cutoff + per-type rewrite 表**（commit `edf2480` → `04b04e9`）：`HEADING_PARAGRAPH_LEN_THRESHOLD` / `HEADING_REWRITE_DEFAULT/ARTICLE`。article/course/docx 同一渲染管线但**不同数据来源 → 不同 mapping 表**，通过 `FlattenOptions` 传入。
4. **placeholder 绕 turndown strip**（试过但撤销，方法本身有效）：`[[SCYS-XXX]]` 不被 turndown 解析为 markdown 任何语法 → 完整保留到 post-process → 还原为目标 HTML。**未来真需要绕过 turndown 的场景可复用此模式**（仅当用户明确接受 HTML 输出时）。

### 仍可改进的地方（未列入 §6 feature）

1. **ordered list 跨段累计编号**：浏览器 sequential，markdown 各自从 1。HTML `<ol start="N">` 能解但 turndown 不一定保留 start 属性。低优先级，标准 markdown 就这样。
2. **scys article video block 真 URL**：FILE block (block_type=23) 当前只能 anchor 回 article URL；scys 视频实际播放 URL（CDN）没暴露。无解，scys 限制。
3. **更通用的 audit**：当前 `scripts/scys-visual-audit.py` hardcoded `/tmp/scys-article-dom-dump.json` + 单 vault md。改成 CLI 参数 + 多 fixture 批量跑，作为 CI 回归。低优先级，本地用足够。
4. **dev-cycle reminder**：源码改了忘 build → 用户裁剪看到旧版本。考虑写 git pre-commit hook 检查 src/ 改了但 dist/ 没动时警告。Hack 性强，先靠 reference memory（见下）。

### 总结性观察

- **本次 commits**：6（5720539 实现 → b560794 autolink → edf2480 heading demote → 04b04e9 article rewrite + FILE + audit → 016e2a3 HTML inline → 5812d62 撤销 HTML）
- **从用户提需求 → 0 mismatch + 真 Obsidian 视觉对齐**：约 6 小时（多次反复 + 视觉门提高）
- **新沉淀进 BACKLOG**：§6.12 完成标记 + 本附录 + §7（ordered list 编号）
- **新工具进 repo**：`scripts/scys-visual-audit.py`
- **质量门进一步上升**：附录 D 是"两图视觉肉眼对比"，附录 E 是"全文穷举反推每个视觉单元的期望 markdown 类型 → 报 mismatch 桶"。**未来 extractor 改动如果涉及 1000+ 段文本，肉眼对比不可靠，必须走 headless audit**。
- **dev cycle 同步**：源码 → `npm run build:chrome` → chrome `chrome://extensions` reload 扩展 → 页面 reload → 裁剪 — **每一步都需要**，否则用户看到的还是旧代码。

---

## 附录 F：scys article extractor 整体回顾（2026-05-16 → 2026-05-17）

附录 D 是"视觉对比是新基线"，附录 E 是"全文穷举 audit"。本附录是**整个 article extractor 项目**（8 个 commit）的横向总结，回答"做完了什么 / 该学到什么 / 留下什么 TODO"。

### 累计 commits

| Commit | 主题 |
|---|---|
| `5720539` | feat: support `/articleDetail/xq_topic/`（docBlocks 形态） |
| `b560794` | fix: autolink bare URLs |
| `edf2480` | fix: demote long HEADING blocks to paragraphs |
| `04b04e9` | fix: article-specific HEADING mapping + FILE block resolver + audit tool |
| `016e2a3` | fix: heading bold redundancy + `**aa****bb**` merge + (color/align HTML inline — 后撤销) |
| `5812d62` | revert: drop HTML `<span style="color">` / `<div align>` — markdown only |
| `f207f73` | feat: legacy ql-editor HTML fallback（形态 2） |
| `8f8e427` | feat: plain-text + `<e>` 实体 fallback（形态 3） |

### 横向教训

1. **单 URL pattern 数据可能多形态 — 早采样**：article 看上去只是"一种 URL"，实际后端按帖子年代有 3 种 body 编码。我每次只看一个样本下结论 → 用户每次报问题才发现新形态。**未来给 scys / 飞书 / Bilibili 等做 extractor 前，至少抓 3-5 个不同年份/作者的样本对比 fixture 形状**。
2. **"markdown 标识正确性 > HTML 视觉精确"**：花了一轮加 `<span style="color">` / `<div align>` 想保留浏览器视觉，用户明确"不要 HTML，markdown 标识对就行"。**今后 markdown-vs-视觉 trade-off 默认选 markdown，HTML inline 只作 last resort 且要先问**。
3. **每次质量门上升一次，都会暴露之前没看到的差异层**：unit test PASS → 文本 diff PASS → 视觉肉眼对比 PASS → 全文穷举 audit PASS → **真插件裁剪 PASS**。dev cycle 不到位时（dist 没 build），最后一层会反复出问题。
4. **headless audit 工具是肉眼对比的必要补充**：1000+ 段全文用肉眼漏检率极高。`scripts/scys-visual-audit.py` 一次跑出 39 个 mismatch（之前肉眼对比只看到 4-5 个）。
5. **brainstorm skill 在"验收标准"决策上价值最大**：每次新 URL 来都先问"这次什么算 done"——避免做得过细或过粗。技术细节决策（fix 哪里、用什么数据结构）可以直接做不用 brainstorm。

### 完成的能力清单

| 能力 | 体现 |
|---|---|
| URL 检测 + 路由 | `isScysArticleUrl` + `parseScysArticleUrl` |
| API 反向工程 | `topicDetail` / `pageTopicComment` |
| 三种 body 编码支持 | `extractScysArticleStandalone` 三分支 |
| article-specific HEADING 映射 | `HEADING_REWRITE_ARTICLE` / `HEADING_PARAGRAPH_LEN_THRESHOLD_ARTICLE` |
| heading 滥用 demote 为 paragraph | 长度 cutoff + `forceBoldOnDemote` |
| heading 内 bold 冗余 strip | `renderHeading` `skipBold:true` |
| 相邻 `<strong>` 合并 | renderTextElements 末尾 collapse |
| bare URL autolink | `autolinkBareUrls`（处理 CJK 标点边界） |
| FILE block (视频附件) resolver | 重写 `feishu-file-block://` → article URL anchor |
| 评论分页 + 嵌套渲染 + 评论图片 base64 | `fetchScysArticleComments` + `renderScysArticleComments` |
| scys `<e type="web">` 实体解码 | `preprocessScysEntityHtml` |
| Headless 视觉 audit 工具 | `scripts/scys-visual-audit.py` |
| 全套 fixture-level 回归测试 | 4 个 article fixture + 158+ unit tests |

### 已接受的 trade-off（不再追修）

| 问题 | 原因 |
|---|---|
| text_color (red emphasis) 丢失 | 标准 markdown 无原语 |
| text-align (center/right) 丢失 | 同上 |
| ordered list 跨段累计编号 (浏览器 5/6/7 → md 各自从 1) | markdown 标准行为 |
| 1 张腾讯文档图 403 | scys 不暴露 OSS 凭证，需要带 referer 才能拿，得不偿失 |
| Obsidian 主题 H 字号/颜色与浏览器不一致 | Obsidian 主题异质性大，不属于 extractor scope |

### 未来潜在的 follow-up（不紧急）

| 项 | 优先级 | 触发 |
|---|---|---|
| 未见过的 `<e>` type 扩展 (mention/image/topic-ref...) | 中-低 | 用户报新差异时 |
| article 第 4 种 body 编码 | 取决于实际发现 | 抓 fixture 时碰到 |
| `scripts/scys-visual-audit.py` CLI 化 + 多 fixture batch | 低 | CI 接入时 |
| article H3-H5 在 Obsidian 主题下字号/颜色与浏览器精确对齐 | 极低 | 不属于 extractor scope |

### 总结性观察

- **8 个 commit 跨 2 天**（实际开发约 8 小时含视觉对比反复）
- **3 个 fixture 入仓**（55188248 / 418444442181248 / 2852488814854211 各覆盖一种 body 形态）
- **158 unit tests**（含 3 个 fixture-level e2e 回归 + 11+ 个新增能力单测）
- **memory 升级 2 次**（`feedback_extractor_acceptance.md` 加 dev cycle + HTML 限制；`project_scys_article_data.md` 从双形态升级到三形态）
- **新工具入 repo**：`scripts/scys-visual-audit.py`（headless 视觉 audit，不抢用户焦点）

**最大的认知更新**：scys 一个 URL pattern 的数据形态多到反复让我吃惊。今后任何看似"已经做完"的 extractor，遇到新样本都要假设"可能是另一种我没见过的形态"，先 inspect 数据再写代码。

---

## 附录 G：zsxq (知识星球) extractor 实施反思（2026-05-17）

`wx.zsxq.com/group/{gid}/topic/{tid}` 从 brainstorm → spec → plan → 实施 → 5 轮修复 ≈ 4 小时，13 commits，60 unit tests + 2 个真实 topic 端到端验证。**第一个 topic 一次跑通；第二个 topic 暴露 5 个独立 bug**——这个差距本身是最大的教训。

### 做对的事情

1. **完整走 brainstorming → writing-plans → subagent-driven 流程**：先用 superpowers:brainstorming 跟用户对齐 4 个关键决策（URL 范围 / 评论深度 / 图片策略 / 方案 A），再 writing-plans 写出 11 个 task 的 bite-sized plan，最后 subagent-driven-development 把 Task 1-7（zsxq-extractor.ts 全模块）和 Task 8-9（manifest + content.ts wiring）各派一个 subagent 实施。主上下文只做 Task 0（API 探测）和 Task 10（端到端迭代）。**两次 subagent 派发都一次完成、60 tests 全过**，证明 spec + plan 充分时 subagent 效率极高。
2. **Task 0 严格执行"先抓 fixture 再写代码"**：第一个 topic 的 3 个真实响应（topic.json / comments.json / article-qleditor.html）作为 fixture 入仓 + 单测基准。**6 处 spec 假设被实测推翻**（API path 加 `/info` 后缀、`sort=asc` 返空、评论嵌套非扁平、Article API 返 401、需要抓 articles.zsxq.com SSR HTML、有两个图床域），如果不先抓 fixture 这 6 处都要在 Task 10 端到端时才暴露，每次回头改 spec + plan 成本巨大。
3. **承认"两个真实样本不够"**：第一个 topic（type=talk + talk.article）端到端 5 轮稳定通过后，用户给了第二个 topic（type=talk + 无 article + 含 text_bold 段标题 + 大图）——立即暴露 5 个独立 bug。**没有抗辩"已经通过验收"**，直接补 fix。这跟附录 F 的教训完全一致：**单 URL pattern 数据可能多形态，1-2 个样本不足以覆盖**。
4. **每个 fix 都是单一原因 → 单一改动**：5 个 bug 分别独立 commit（虽然合并成一次 `23010c1` 但每个改动可独立解释），不混着改。

### 走过的弯路

1. **🔥 过度抓取**：第一版用户给的 topic 含 `talk.article`，spec 阶段未细问"展开 vs 不展开"，subagent 默认抓 articles.zsxq.com 全文内嵌，3 MB 笔记看起来"信息量大"——用户立刻指出"原页面就一个链接，别展开"。**回退到只显示 link card**，浪费 2 commits。**教训**：UX 上的"以页面显示为准"是默认边界（mirror, not augment），spec 阶段就该问清，不要技术上能拿到就抓。
2. **🔥 默认选最大图**：`pickImageUrl` 默认 `original`(quality 100)。第一个 topic 没碰这种情况（图都小），第二个 topic 3 张截图 → 5.9 MB base64 each → 17 MB 笔记 → Obsidian 拒开。**教训**：**any image-embed path 都该默认 medium 尺寸（800px / quality 75）**，base64 内嵌时 size budget 比 quality 更重要。Original 只用于显式高保真需求。
3. **🔥 inline tag 子集假设过窄**：spec 只列了 hashtag/mention/emoji/web 四种 `<e>` type，subagent 实现默认丢弃其他 type。第二个 topic 的 talk.text **以 4 个 `<e type="text_bold">` 段标题为骨架**——丢弃后正文骨架全没。**教训**：抓 fixture 时不只看 type 出现频次，要 grep 出 `<e type="..."` 的全部 unique 值，确保 spec 覆盖所有实测见过的 type（这次新增的 text_bold/text_italic 是补救；text_color 可能下次又冒）。
4. **🔥 sentinel 设计的反复**：web `<e>` 输出 markdown `[t](u)` 被 turndown 转义为 `\[t\](u)`（附录 D 的同款 footgun，feishu 已有解决）；改 raw `<a>` HTML 又被 renderTextAsParagraphs 的 escapeHtml 转 `&lt;a&gt;`；最后用 `\x01...\x02...\x03` control-char sentinel 通过 escapeHtml，再在 `promoteEmphasis` 中还原为 `<a>`。**linter 一度把 control chars strip 了**，发现后用 python 重写。**教训**：control char sentinel 不可读但是最稳的"绕过中间层处理"策略；下次类似场景直接用，不要尝试 `LINK:` 文本前缀（会被用户输入碰撞）。
5. **content-script 跨域 fetch 间歇性 `succeeded:false`**：comments retry 已实施（`d016199`），但 topic fetch 没加同样保护——第二个 topic title 偶发空字符串，Obsidian 报 `"" 打开失败`。**教训**：content-script 首次跨 origin fetch SPA API 的 race condition 是**通用问题**（已在 §1.8 记录 CORS 行为表，但没强调时序）。**任何 content-script 调外部 SPA 的 API 都该默认 3× retry**。
6. **dev cycle 反复出问题**：webpack `--watch` 进程偶尔卡死、dist/content.js 不更新；touch 触发 + sleep + 检查标识 / `pkill -9 webpack` + 删 dist 再启动 是标准疏通流程，本次重复 3 次。**教训**：已在 §2.7 / §2.9 沉淀，但 webpack watch 死活检测仍依赖人工判断；考虑写 healthcheck（webpack 多次未 emit 时自动重启）。
7. **写 spec 时假设 article 卡片需要保留 teaser blockquote**：实施后发现 teaser 的 205 字与 article body 完全重叠，**视觉重复**。第一轮 fix（去 teaser）当时是"显然该这样"——但 spec 没想到。**教训**：当数据来源是 truncated preview + 完整 alternative 时，先问"哪个是 canonical"，不要叠加。

### 可借鉴的模式（沉淀进基础设施）

1. **content-script SPA API retry 模板**：
   ```ts
   async function fetchWithRetry<T>(fn: () => Promise<T | null>): Promise<T | null> {
     for (let attempt = 0; attempt < 3; attempt++) {
       const got = await fn();
       if (got) return got;
       if (attempt < 2) await sleep(800 * (attempt + 1));
     }
     return null;
   }
   ```
   **未来所有 cross-origin SPA API 调用都包一层 retry**（飞书、Bilibili、scys、zsxq、未来的小红书 / 得到 / 微博等）。SPA 首次加载时 session cookie 写入与首个 API request 偶发 race，这是 web app 普遍现象。

2. **Control-char sentinel 模式（突破 escapeHtml/turndown 中间层）**：当 extractor 想让某段语义（链接、bold、callout）原样穿过 escapeHtml + turndown，用 `\x01TAG\x02arg1\x02arg2\x03` 控制字符序列。**escapeHtml 不动控制字符；turndown 也不动**。最后在已知会运行的后处理点（`promoteEmphasis` 类函数）regex 还原为目标 HTML 标签。比 `[[PLACEHOLDER_N]]` 字符串前缀更安全（不会与用户输入碰撞）。

3. **图片域 ordering：`large > original > thumbnail`**：默认保护笔记大小。`original` 是高保真存档级别，base64 内嵌不适合；`large` 通常 200-400 KB 单图，3 张总 ~1 MB 是 Obsidian 能接受的笔记尺寸。**未来任何新 extractor 处理图片，默认这个 ordering**。

4. **页面渲染逻辑要 mirror，不要 augment**：当 extractor 技术上能拿到比页面显示更多的内容（zsxq 的 articles.zsxq.com 全文、飞书的不在主 doc 里的子 doc 等），**默认按页面显示**——除非用户明确要"抓全"。这是 UX 上的语义边界：用户看到链接卡片就期望 markdown 也是链接卡片。

5. **inline `<e>` tag 全集 audit**：抓 fixture 后立即 `grep -oE '<e type="[^"]+"'` 查所有 unique tag types，spec 阶段就覆盖所有见过的 type，未覆盖的也标记"实际见到再加"。**避免 spec 假设过窄导致正文骨架被丢弃**。

6. **"两个真实样本"作为最小验收门槛**：单一 URL pattern 至少抓 2 个不同样本（不同作者、不同时间、不同内容形态）跑端到端。一个样本是 spec 探针，第二个样本验证泛化。本次第二个 topic 一打就暴露 5 个 bug，证明这条规则的必要性。

7. **navigate + sleep 5s** 作为 SPA bridge 触发前的固定预热：之前迭代里 sleep 2s/3s 偶发 fail，5s 是稳定基线。content-script 同步注入但 SPA session warmup（cookie 复活 / token refresh）是 async 的。**未来所有 SPA 站点的 bridge 测试都先 sleep 5s 再 trigger**，节省调试时间。

### 仍可改进的地方（未列入 §6 feature）

1. **`wx.zsxq.com/group/{gid}/article/{aid}` 专栏文章 URL 提取**：当前 `isZsxqArticleUrl` + `parseZsxqUrl` 已识别，但 `extractZsxqStructuredContent` 走到 `kind === 'article'` return null。**等抓到一个实际的 article URL（用户 ping 时再做）**。
2. **评论 image 字段**：fixture 都不含，端到端未验证。代码 `renderCommentBody` 已写支持，但没跑真路径。
3. **buildVariables reserved-keys 防御（§6.10）**：本次没踩坑因为 published 直传 ContentResponse 而非 extractedContent dict。但本附录的 5 个 bug 之一（topic title 为空 → frontmatter title 空 → Obsidian 拒开）暴露**"frontmatter 字段空字符串"是一个未被防御的 footgun 类**。可以考虑在 buildVariables 中给 title / source 等关键字段加非空兜底。
4. **不再 fetch articles.zsxq.com**：保留 `fetchZsxqArticleHtml` 函数 + background handler 备用（标记 dead code 一年后无人启用就删）。

### 跨仓库（上游同步）影响

zsxq 是 cn fork 独有 feature，**不计划上游化**（知识星球是中文小众商业平台）。但**附录 G 提到的两个通用模式可以贡献**：

- **content-script SPA API retry 模板**（任何 SPA-based extractor 都适用）
- **图片域 ordering `large > original`** 防巨笔记策略（任何 image-embed extractor 都适用）

### 总结性观察

- **commits 数**：13（spec/plan/fixture 3 + extractor 7 + wiring 3 + 4 个 follow-up fix）
- **从 brainstorm → 两个 topic 全过**：约 4 小时
- **subagent 派发**：2 次（Task 1-7 一次完成 + Task 8-9 一次完成），review 0 次额外迭代
- **新沉淀进 BACKLOG**：§6.14 完成标记 + §7 加 5 条 TODO + 本附录
- **5 个 follow-up bug 共性**：都源自"第一个样本不能代表所有样本"——单 URL pattern 内变化范围被低估

**最大的认知更新**（与附录 F 一致但角度不同）：spec 阶段做"假设标记"（先写假设 + 后续 Task 0 实测）已经是好实践，但**至少跑 2 个真实样本端到端**应该是新基线。Subagent-Driven Development 在 spec 详尽时效率极高（2 次派发 0 额外迭代），但 spec 详尽的前提是**先抓多样本 fixture**。

---

## 附录 H：articles.zsxq.com SSR 文章页提取（2026-05-17）

紧接附录 G。用户给了第三个 zsxq URL `articles.zsxq.com/id_j31pruhtakqc.html`——发布时间没填进 frontmatter。30 分钟、1 个 commit 完成（`c5efe22`），但暴露了一个**之前 spec 没考虑到的入口**和几个可沉淀的小模式。

### 一句话：为什么这么小却值得反思

附录 G 的 spec 把 zsxq 的 URL 范围限定在 `wx.zsxq.com`，理由是"用户从知识星球客户端打开都是这个域"。**漏掉了 articles.zsxq.com**——topic 内嵌的"专栏文章卡片"点开就跳这个域。Defuddle 兜底虽然能抓正文，但**抓不到站点专属的 frontmatter 元数据**（`#article-date`、`.nick-name`）。

**根因**：spec 的 URL 范围 = "用户怎么进入"，而非"用户怎么 *从* 你支持的能力进入新内容"。任何 extractor 实施时，**spec 阶段都要列出"该站点所有可能的内容页 URL host + path"**，不仅是用户最常用的那种。

### 做对的事情

1. **承认 spec scope 漏 + 立即补**：用户截图+URL，30 分钟 commit 落地。没辩"按 spec 这是 Defuddle 兜底"——用户实际想要的是元数据，spec 的 scope 不够。
2. **DOM-first 提取范式**：articles.zsxq.com 是纯 SSR，**不调 API、不 retry、不 sentinel**——直接 `doc.querySelector(...)`。29 行新代码（含注释）、0 个新单测（直接端到端验证）。**SSR vs SPA 的提取范式繁简差距大**：SPA 走 §1.7 的 fetch+retry+sentinel 全套，SSR 一句 querySelector 就完。
3. **复用现有 pipeline**：`rewriteArticleImageSrcsToTokens` + `resolveZsxqImages` 是 §6.14 已有函数，原本用来处理 SPA fetch 来的 articles.zsxq.com HTML —— 现在直接给 DOM 的 ql-editor outerHTML 用，**零修改、复用率 100%**。这印证了附录 B "优先写薄适配层把数据转换到现有管线"的判断。
4. **dispatch kind 第三类直接加进 ZsxqUrlInfo discriminated union**：`kind: 'articles-html'` 自然嵌入现有 `parseZsxqUrl` switch，调用方 type-safe 自动 narrow。**discriminated union 是 extractor 内部多入口的首选模式**。

### 走过的弯路（很少，本次基本一遍过）

1. **首先想"是不是要给 Defuddle 加一个 metadata hook"**：很快否决——已有 zsxq-extractor 是更自然的归属（同站点系列），不要污染通用 Defuddle 流水线。
2. **`parseZsxqUrl` 旧版直接 `if hostname !== 'wx.zsxq.com' return null` 早返**：扩展时要先判 articles.zsxq.com，再 wx.zsxq.com fallthrough。否则 URL 落到 null 走 Defuddle。**教训**：早返判断逻辑在扩展多 host 支持时要拆。

### 可借鉴的模式（沉淀进基础设施）

1. **"以页面用户最终如何访问内容"为 spec URL scope 的依据**，而不是"用户最常点进来的那个 URL"。任何站点都列：
   - 客户端/SPA 容器 URL（如 wx.zsxq.com）
   - 内嵌/分享出来的独立 URL（如 articles.zsxq.com）
   - 移动端跳转中间页（如 t.zsxq.com）
   - PDF / 打印视图 URL
   spec 阶段 grep + 走一遍页面的"分享 / 复制链接 / 卡片点击"动作记下所有 host。

2. **`parseChineseArticleDate(raw)` 中文日期解析**：`"2026年05月01日 21:02"` → `"2026-05-01"`。当前定义在 zsxq-extractor.ts。**若 scys/微信公众号/其他站点也用同一格式**，提到 `src/utils/date-utils.ts`。先内部用，第二个用例再抽。

3. **SSR DOM 提取 checklist**（articles.zsxq.com 的 4 个字段，未来 SSR 站点照抄）：
   - title：`document.title`（注意去除站点 "-后缀"）
   - author：站点专属选择器（`.nick-name` / `.author-name` 等）
   - published：站点专属时间元素（`#article-date` / `.publish-time` 等），解析为 `YYYY-MM-DD`
   - content：站点专属正文容器（`.ql-editor` / `.article-content` / `article` 等），rewrite img src 后过 resolveImages

4. **discriminated-union dispatch kind 模式**：
   ```ts
   type ZsxqUrlInfo =
     | { kind: 'topic'; ... }
     | { kind: 'article'; ... }
     | { kind: 'articles-html'; ... };
   ```
   单一入口函数 `extractZsxqStructuredContent(doc)` 内 switch on kind，每种 kind 独立 pipeline。比"多个 export function `extractZsxqTopicContent` / `extractZsxqArticleContent`"路由更聚合。

### 仍可改进的地方

1. **fixture-level 单测缺失**：本次 SSR 提取依赖 DOM API，vitest 默认无 jsdom——加 SSR fixture 测试需要先解决环境（feishu-extractor.test.ts 用了什么？）。低优先级，端到端已覆盖。
2. **articles.zsxq.com 的评论 / 点赞数 / 阅读量信号**：当前只抓 title/author/published/content；如果用户后续想加，DOM 还有 `.reading-amount` / `.likes-count` 等元素。等用户提需求。

### 总结性观察

- **commits 数**：1（feat + spec extend + content.ts wire + bridge origin = 单 commit）
- **从用户报问题 → 端到端验证 OK**：约 30 分钟
- **新沉淀进 BACKLOG**：§6.15 完成标记 + §7 update + 本附录
- **触发的核心反思**：**spec URL scope 要列全所有"该站点可能产生的内容页 URL"**，不仅是用户首次截图给的那个。这条规则后续 extractor 实施时主动应用：抓样本时同时 grep 站点所有 link/share 出口，列入 spec URL allowlist。

**最大的认知更新**：附录 G 是"两个真实样本最低门槛"，附录 H 是"**两个不同 URL host 的最低门槛**"。同一站点用户实际访问内容的入口 URL 可能跨 host，spec 阶段一并列举，避免后期补丁。

---

## 附录 I：q&a topic author 错位（2026-05-17）

紧接附录 H。用户裁剪 `topic/55188411525252124`（type='q&a'）→ frontmatter `author` 写成 "投资致富"（提问者），而页面顶部显示 "释老毛"（被问的星主）。1 commit、~15 分钟修复（`0949660`），但**为什么没在前两轮发现**值得专门反思。

### 为什么没发现：测试样本的 type 单一性

`zsxq-extractor` 的 `topic.type` 字段在 spec 里列了 4 种：`talk / q&a / task / solution`，代码 switch 都写了——但 **fixture 只有 talk 一种**。

| 阶段 | 检查覆盖 | 用了什么样本 |
|---|---|---|
| spec | 类型枚举 4 种全列 | 假设值，无 fixture |
| Task 0 fixture | 1 个 talk topic（185414442218552）| 缺 q&a/task/solution |
| 第二轮（topic 14588214414288282）| 又是 talk | 同上 |
| 单测 `renderZsxqTopicBodyHtml q&a` | **合成 mock**：`question.owner.name='Q', answer.owner.name='A'` | 测了 render 路径，**没测 author 选择路径** |
| 端到端 5 + 4 轮稳定 | 都是 talk URL | 同上 |

合成单测**只验证渲染出 提问/回答 section 的存在**，没断言 `buildZsxqAuthor(qaTopic)` 该返回谁。所以 4 个 case 的 author 决策逻辑里只有 `talk` 真实跑过；`q&a` 的 `body = talk ?? question ?? ...` 短路到 question——返回提问者——但单测无 author 断言无法触发。

**根因**：附录 G 的"2 个样本"规则停在了"2 个真实 URL"层面，**没下沉到"覆盖所有 type 枚举值"**。

### 修复

`buildZsxqAuthor` 改为 type-aware：

| topic.type | author 字段来源 |
|---|---|
| `talk` / `task` | `body.owner.name` |
| `q&a` | `answer.owner` → `question.owner`（answerer = 星主 优先） |
| `solution` | `solution.owner` → `task.owner` |

加 fixture `zsxq-topic-qa-55188411525252124.json` + 2 个断言测试，**显式验证 `qaTopic.question?.owner.name === '投资致富' && qaTopic.answer?.owner.name === '释老毛'`**——这两个断言才是真正的回归保护，渲染 section 断言不算。

### 为什么 spec 阶段没暴露

我在 spec 里写了"talk / q&a / task / solution 都支持"，**但只有 talk 有详细字段表**（`talk.owner / talk.text / talk.images / talk.files / talk.article`）。q&a 的字段表是模糊的"question + answer"——**没有明确"哪个 owner 是用户期望的 author"**。

回头看，spec 阶段应该问的问题：
> 对每个 type，**哪个子结构的 owner 字段对应页面顶部头像/署名**？

这个问题用合成数据答不出，必须**抓一个真实样本看 zsxq 自己怎么显示**。我没做，因为找不到自然的 q&a URL 入口（用户给的 URL 都是 talk）。

### 可借鉴的新规则

**spec 阶段的"type 枚举验收"清单**——当 API 返回的 type 字段有 N 个可能值，**fixture 必须覆盖至少 (N - rare 长尾)**，否则任何"按 type 分支的字段选择逻辑"都是 untested。

具体三条：
1. **如果 type 字段决定了下游字段选择**（title / author / published / content 哪里来），fixture 必须**每个 type 至少一个真实样本**
2. **合成 mock 单测只能验证渲染管线连通**，不能替代真实 fixture 上的"业务字段断言"（"这个字段值应当 = X"）
3. **当无法获得某 type 的真实 URL 时，在 spec 里显式标注"untested-in-real-data"**，并把该 type 的字段映射作为推测保留，等用户给样本后再验证

### 把附录 G+H+I 合并成新基线 checklist

**Spec 阶段抓 fixture 的最低门槛**（每个 extractor 立项前必填）：

| 维度 | 最低样本数 | 验收 |
|---|---|---|
| **真实样本数**（G）| ≥ 2 | 不同作者 / 时间 / 内容形态 |
| **URL host 覆盖**（H）| 站点所有可能内容页 host | grep 站点 "复制链接 / 分享" 出口 |
| **type 枚举覆盖**（I）| 每个 type 字段值至少 1 个 | 端到端跑通 + 业务字段断言 |
| 内嵌 tag 子集 audit | `grep -oE '<e type="[^"]+"'` 全集 | 覆盖每种 type |

如果某维度无法满足（如 q&a 真实 URL 难找），spec 显式标注 "untested-in-real-data"，**不允许默默用合成数据冒充覆盖**。

### 总结性观察

- **commits 数**：1（fix + fixture + 2 tests）
- **从用户报问题 → 端到端验证**：约 15 分钟
- **新沉淀进 BACKLOG**：本附录 + 头部 commit 基线更新 + 新 type 枚举覆盖规则
- **本次教训属于 spec 上游层级**：不是代码 bug 修不完，是**spec 的"枚举值覆盖"假设**没明确写出来。代码 switch 写齐 ≠ 测试覆盖齐，下次 spec checklist 加上"每 type 至少 1 真实 fixture"。

**最大的认知更新**：附录 G→H→I 形成一个递进——**真实样本数 → URL host 数 → 字段枚举值数**。3 个维度都是"接口形态多样性"的不同切面，3 个都满足才算 spec 抓到真实需求。下次专项 extractor 立项前，用这个 3-维 checklist 走一遍。



---

## 2026-05-17 反思：audit 漏掉「评论裁剪丢失」

**症状**：feishu-audit-tool 报 `PASS — 0 misses across 10 buckets`，但用户实际裁剪到 Obsidian 后 .md 完全没有评论区。

**根因（两个独立 bug，audit 都漏）**：

1. **IPC unwrap 错位**：`fetchFeishuComments` 通过 `browser.runtime.sendMessage` 调 `fetchFeishuApi` action，background 返回 `{success, data: <OpenAPI 完整响应>}`，OpenAPI 响应又是 `{code, data: <payload>, msg}` ——客户端代码当成 `resp.data = payload` 用，少 unwrap 一层 `data`，永远返 0 条评论。audit-tool 用原生 Node `fetch` 绕过了这条链路，所以一直绿。

2. **Markdown 接缝错位**：评论 markdown 之前被 tail-append 到 HTML `content` 末尾，下游 `createMarkdownContent` 整体过 turndown——markdown 符号被转义/吞掉，Obsidian 看不到任何评论。audit-tool 是「先 turndown 再拼 markdown」，接缝在 turndown 之后，也绕过了这个 bug。

**audit 的盲区性质**：audit-tool 走了一条**与生产不同的 pipeline**——既不经过 IPC，也不在同一个位置拼接。它验证了"OpenAPI 数据→期望 markdown"，但没验证"生产代码能否产出那个 markdown"。

**修复**：commit `6c8d8d9` 修 Bug 1（统一走 `fetchFeishuApi`），commit `ed5d59c` 修 Bug 2（评论走 `extractedContent.commentsMarkdown` 通道，在 turndown 之后追加）。新增 `src/utils/feishu-comments.integration.test.ts` 用 mock `browser.runtime.sendMessage` 跑生产代码路径，覆盖两类 bug。

**沉淀给未来 audit 的纪律**：
- audit 工具不是生产的替代——它验证"约定知识库 vs 输出"，但不能保证"生产代码到那个输出"。任何新增 IPC 接缝/markdown 转换接缝都要补一条 vitest 集成测试。
- 视觉验收若声称"通过"，必须基于**生产产物**（真实 Obsidian vault `.md`）或与生产同形态的渲染产物，不能只读 audit-tool 的中间产物。

**未来可选升级（BACKLOG）**：playwright headless 加载扩展、自动裁剪、拦截 `obsidian://` URL、提取 content 参数、用 audit-tool 校验。代价：脚本依赖重 + Chrome 版本脱手。当前 mock-based 集成测试已覆盖两类根因 bug。

---

## 附录 J：zsxq extractor 项目全程综合（2026-05-17）

整合附录 G + H + I 三次 retro 的内容，从项目整体视角看 zsxq extractor 的完成状态、累计成本、横向规律。结构模仿附录 F（scys article 全程回顾）。

### 累计 commits（21 个 zsxq/articles 相关）

| Commit | 主题 | 类别 |
|---|---|---|
| `1ec9161` | test: topic + comments + article HTML fixtures（185414442218552）| Task 0 fixture |
| `f0a742e` | docs: mark Task 0 complete + API discovery | Task 0 plan update |
| `4e179f5` | feat: URL detection + parseZsxqUrl | Task 1 |
| `394feee` | feat: parseZsxqInlineText — `<e>` tags / `<br>` / entities | Task 2 |
| `3241954` | feat: topic types + renderZsxqTopicBodyHtml（talk/q&a/task）| Task 3 |
| `7e2d007` | feat: comment types + renderZsxqCommentsHtml（nested blockquotes）| Task 4-5 |
| `b924a4a` | feat: API fetchers — topic /info / comments / article SSR | Task 6 |
| `908a35d` | feat: resolveZsxqImages — 三级 fallback | Task 7 |
| `5e53eec` | feat: extractZsxqStructuredContent top-level | Task 8 |
| `f3e5dae` | feat: manifest host_permissions（api/articles/images）| Task 9 |
| `ef2ea7a` | feat: background handlers | Task 9 |
| `83640e6` | feat: wire into content.ts + page-world test bridge | Task 9 |
| `3847ad8` | fix: rewrite article image srcs + drop redundant teaser | 第一轮 e2e fix |
| `d016199` | fix: retry empty comments fetch（content-script SPA race）| 第一轮 e2e fix |
| `143d9e5` | **fix: match original page — render article link card, not body** | **附录 G #1：过度抓取回退** |
| `23010c1` | **fix: unblock second test topic（5-part fix）** | **附录 G #2-5：text_bold / image size / web link / topic retry / title** |
| `3c37532` | feat: expose topic create_time as published frontmatter | 第二轮补缺 |
| `af0ba4f` | docs: backlog + appendix G | 反思 G |
| `c5efe22` | **feat: articles.zsxq.com SSR article page extractor** | **附录 H：URL host 缺口** |
| `e7090b9` | docs: backlog + appendix H | 反思 H |
| `0949660` | **fix: q&a topic author resolves to answerer** | **附录 I：type 枚举缺口** |
| `f8b33f1` | docs: appendix I + 3-dim spec coverage rule | 反思 I |

### 完成的能力清单

| 能力 | 体现 |
|---|---|
| URL 检测 + 路由（3 种 kind） | `isZsxqTopicUrl` / `isZsxqArticleUrl` / `isZsxqArticlesHtmlUrl`；`parseZsxqUrl` discriminated union |
| API 调用（同源 fetch + 3× retry） | `fetchZsxqTopic` (`/v2/topics/{id}/info`) / `fetchZsxqAllComments` 分页 |
| 跨域 SPA 时序 retry 模板 | content-script 首次跨 origin fetch race 通用解 |
| inline `<e>` 标签解析 | hashtag/mention/emoji/web/text_bold/text_italic；`\x01...\x03` sentinel 穿透 escapeHtml/turndown |
| Topic body 渲染（type 分支）| talk / q&a / task / solution；**mirror page**（不展开 articles.zsxq.com）|
| 评论嵌套渲染 | API 已是 `replied_comments[]` 嵌套（depth=2），直接 walk |
| 图片三级 fallback | L1 content-script / L2 background / L3 raw URL；`large > original > thumbnail` |
| Title / Author / Published 三字段策略 | type-aware：q&a 用 answer.owner；published 从 ISO8601 → `YYYY-MM-DD` |
| articles.zsxq.com SSR 直接 DOM 提取 | 与 SPA 提取范式形成对照（30 行代码 vs 600+） |
| Page-world test bridge 接入 | content.ts dispatch + origin 白名单 + ContentResponse cascade |
| Fixture-level 回归测试 | 3 个真实 fixture（topic / comments / article HTML）+ q&a fixture + 62 unit tests |

### 已接受的 trade-off（不再追修）

| 项 | 原因 |
|---|---|
| `articles.zsxq.com` 评论 / 点赞数 / 阅读量未抓 | 用户未提需求，DOM 元素已知（`.likes-count` 等）可加 |
| `kind === 'article'`（`wx.zsxq.com/group/{gid}/article/{aid}`）返回 null | 未抓到真实样本 URL，等用户给再实施 |
| 闲置 `fetchZsxqArticleHtml` + background handler | 留作 article URL 提取启动时复用，否则 deadcode 删除 |
| 评论内 image 字段未端到端验证 | 当前 fixture 都不含；代码已写 placeholder |

### 未来潜在的 follow-up（不紧急）

| 项 | 优先级 | 触发 |
|---|---|---|
| 未见过的 `<e>` type 扩展（text_color / image / topic-ref / mention-link 等）| 中-低 | 用户报新差异时 |
| `wx.zsxq.com/group/{gid}/article/{aid}` 专栏文章 URL 提取 | 低 | 抓到真实样本 URL |
| `parseChineseArticleDate` 提到 `src/utils/date-utils.ts` | 极低 | 第二个 extractor 复用此格式时 |
| q&a / task / solution 真实样本进 fixture | 低 | task / solution 真实 URL 抓到时 |
| 评论中 image 字段的端到端验证 | 低 | 抓到含图评论的真实样本 |

### 横向规律（3 个附录的同一根因）

| 附录 | 漏检维度 | 触发 bug | 修复 |
|---|---|---|---|
| G | **真实样本数**（topic 1 不能代表 topic 2）| 5 个独立 bug（text_bold / image size / web link / retry / title）| 一轮 23010c1 修齐 |
| H | **URL host**（wx.zsxq.com ↮ articles.zsxq.com）| frontmatter published 缺失 | c5efe22 新增 dispatch kind |
| I | **type 枚举**（talk ↮ q&a）| author 错位（提问者 vs 答主）| 0949660 type-aware buildZsxqAuthor |

3 个都源于 spec 阶段对**接口形态多样性的低估** → 已上升为 §2.14 "新 extractor 3 维 fixture 覆盖 checklist"。

### 总结性观察

- **commits 数**：21（spec/plan/fixture 3 + extractor 7 + wiring 3 + e2e fix 4 + 反思 4）
- **从 brainstorm → 当前稳定**：约 6 小时（含 3 次跨日小修：articles.zsxq.com / published / q&a）
- **subagent 派发**：2 次（Task 1-7 + Task 8-9），0 额外迭代——证明 spec + plan 详尽时效率极高
- **真实 fixture 数**：4（topic talk × 2 + comments × 1 + article qleditor HTML × 1 + topic q&a × 1）
- **新沉淀进 BACKLOG**：§2.14（3 维 checklist 提到顶层）+ §6.14 / §6.15 完成标记 + §7 加 5 条 TODO + 附录 G/H/I/J
- **基线认知**：未来任何 extractor，spec 阶段强制走 §2.14 3 维 checklist；缺一个维度都标 `untested-in-real-data` 而非合成 mock 冒充

**最大的认知更新**（跨 G/H/I/J）：bug 不是在代码里"修不完"，bug 是在 **spec 上游"看不全"**。Subagent-Driven Development + 双 reviewer 在 spec 详尽时是高质量高效率的实施保障，但 spec 详尽的**前提**是 §2.14 的 3 维 fixture 覆盖。**spec 阶段一小时的样本走查比实施期一小时的 bug 修复价值高 10 倍**——这一规律以后 extractor 立项时反复 quote。
