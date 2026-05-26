# cn fork Backlog — 冷启动手册

> **本文档用途**：让一个**完全没上下文的新会话 AI** 也能快速上手继续工作。
> 包含项目背景、开发基础设施、关键认知、踩过的坑、待办 feature。
> 每条 feature 都标了"为什么这么做 / 已知什么不行 / 推荐怎么做"。

**最后更新**：2026-05-19
**最新 commit 基线**：`8e42f1c`（scys article 评论 `<e type="web">` 实体解码）/ `f17f48c`（feishu Sa5W e2e audit）/ `0949660`（zsxq q&a author = 答主而非提问者）

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

### 2.15 `ContentResponse` 合并表达式是 grep 盲区（scys published 修复反思，2026-05-18）

scys 文章裁剪笔记 frontmatter `published` 字段空值——bug 跨三层，但**只有第三层无类型保护**：

| 层 | 文件 | 漏改后果 |
|---|---|---|
| 接口（`ScysStructuredContent`） | `scys-extractor.ts:501` | TS 必填字段编译报错（守住） |
| 产生（return） | `scys-extractor.ts` 内 3 个路径 return | TS 编译报错（守住） |
| **合并（`ContentResponse`）** | `content.ts:365-381` inline `\|\|` 链 | **静默空值**——TS 不报错，frontmatter 默认空 |

第三层是 grep 盲区：

- 接口名 / 字段名 grep 时只命中 `interface` 定义和 extractor 内的 `published:` return key——**不命中合并表达式**，因为 merge 写成 `bilibiliContent?.published || zsxqContent?.published || defuddled.published`，每个 source 出现一次但都不是字段定义点
- 这一行就是 inline，没有函数 seam 可单测；改完只能靠 trace 或运行时验证

**Spec 阶段必做 checklist**——`content.ts:365-381` 同一对象字面量逐字段对照：

| ContentResponse 字段 | 是否有 scysContent merge | 是否有 zsxqContent merge | 备注 |
|---|---|---|---|
| author / content / title / wordCount / site | ✓ | ✓ | 5 个字段已齐 |
| published | 历史漏（本次修） | ✓ | 截至 2026-05-18 修齐 |
| image | bilibili only | — | 其余 extractor 无 image 字段 |
| description | bilibili only | — | 同上 |

**新加任意 extractor 字段**：必看 `content.ts:365-381` 整块对象字面量；任何"在 X 处加、忘在 Y 处加"的不对称都意味着 silent drop。

**测试覆盖建议**：scys/zsxq/feishu 等专项 extractor 涉及 frontmatter 字段时，写**端到端集成测试**（fixture → extractor → 复制 merge 表达式 → `buildVariables` → 变量值断言），不要只靠 spec 静态 trace。参考 `src/utils/scys-published.integration.test.ts`——头部注释钉住 merge 表达式的复制位置，drift 时人工核对。

**与现有规则**：
- §1.10 / §1.12 防的是渲染/路径分歧；本节防的是**对象字面量的字段非对称**
- 跟 §2.14 一样属于"spec 阶段堵漏"，但聚焦的是 `content.ts` 这一个文件的对称性

---

### 2.16 server-render HTML 字段：编码 helper 必须跨 path 共享（scys 评论 `<e>` 实体修复反思，2026-05-19）

scys article 评论 content 是**服务端 render 好的 HTML 串**，看起来像普通 `<p>…</p>`，但**夹带 zsxq 原生的 `<e type="web" href="URL-encoded" title="URL-encoded" />` self-closing 实体**——同一 article 的 legacy `articleContent` plain-text path 已经在 `preprocessScysEntityHtml` 里实现了 `<e>` 解码，**评论 path 没复用**。

后果：评论里的外部资源链接（GitHub repo / 文档 URL）静默丢失——`<e />` 是非标 self-closing tag，Defuddle/turndown 链路直接吞，markdown 里只剩 "gstack GitHub:" 缺尾。

**根因模式（跨 extractor 通用）**：

| 数据来源 | 典型字段 | 编码风险 |
|---|---|---|
| API 返回的 docBlocks | block.text.elements | 飞书/zsxq 标准块结构，已有 `convertBlocksToHtml` 处理 |
| 服务端 render 好的 HTML 串 | comment.content / articleContent | **可能夹带原平台自定义实体**（`<e>` / `<mention>` / `<hashtag>` 等），没标准 HTML 语义 |

任何"接收一段服务端 HTML 字符串然后下游过 Defuddle"的 path 都要问：**这段 HTML 是不是含平台自定义标签？**如果同源还有别的 path 已经做了解码（比如 articleContent），**必须把解码抽成共享 helper**，否则其他 path 早晚同样吃亏。

**Spec 阶段 checklist**：

新 extractor 接收"server HTML 字段"时：
1. 抓 1 份 fixture（含目标 path 真实数据），grep `<e ` / `<mention` / `<hashtag` / `<image` 等非标 tag — 看是否需要解码
2. 如果其他同 source path 已实现某类解码 helper（如 `preprocessScysEntityHtml`），**先抽成 module-level 共享函数再用**，不要 inline 复制
3. 加 1 个单元测试覆盖每一种实体类型 + 1 个 e2e 集成测试用真实 fixture 跑完 extractor → 断言 `<e tag>` 不再出现在最终 HTML

**测试覆盖参考**：
- helper 单测：`src/utils/scys-extractor.test.ts` 末段 `describe('decodeScysWebEntities')`（4 个用例：标准解码 / 空 title fallback / 非 `web` 类型保留 / 无实体直通）
- e2e：`src/utils/scys-article-comment-entity.integration.test.ts`（mock fetch + 22255 fixture → 断言 GitHub 链接存活）

**fixture**：`src/utils/fixtures/scys-article-22255845818825821-{detail,comments}.json`（含真实 `<e type="web">` 评论的最小复现数据集）

**与现有规则**：
- §2.14（3 维 fixture 覆盖）补充了"server HTML 字段"这一隐藏维度——除"docBlocks 形态变种"外，**server-render HTML 字段是单独一类**
- §2.15 防的是字段层面字段非对称；本节防的是**编码层面跨 path 不共享**

---

### 2.17 scys article 数据形态扩到 4 种 + ContentResponse 双 interface 陷阱（scys image-only & 附件修复反思，2026-05-19）

**两个新认知交叉碰撞在同一次修复里**——image-only article 和 PDF 附件本来是独立问题，实施时连带暴露了 spec/plan 阶段没注意的两条隐藏陷阱：

#### A. scys article body 是 **4 种形态**，不是 3 种

§6.12 / §6.13 沉淀的"article 三形态" — docBlocks / Quill HTML / 纯文本+`<e>` — 漏了一类：**image-only article**（`topicDTO.docBlocks` null + `articleContent` 空串 + `imageList` 非空数组）。

后果：`fetchScysArticleDetail` 在 `!hasBlocks && !hasHtml` 时直接 `return null`，主路径放弃 → content.ts fallback 到 defuddled → frontmatter `author` / `published` 都丢（DOM 没暴露这些字段）。

修复 = `fetchScysArticleDetail` 改三态判定（hasBlocks / hasHtml / hasImageList），新增第三条 image-only 渲染分支，复用 `feishu-image://scys:` token + `resolveScysImages` 的 base64 内嵌路径。imageList 已经是签名直链（含 OSS `Expires` 参数）—— 跟 docBlocks 的图片同质，token 转换链路一致。

**Spec 阶段教训**：新接 extractor 时，**API 数据形态枚举不能止于"看到几条 fixture 就以为穷举了"**。本次 image-only 帖（一张拼接长图 + 无文本）是常见出版形态，但前三轮 spec（§6.12 / §6.13 / §6.16）都没覆盖到，因为抓的 fixture 都是带文字的帖。下次新接同类 source 时，主动问"用户能不能发个纯图帖 / 纯视频帖 / 纯转发帖？"。

#### B. `ContentResponse` 有两处独立定义（content-extractor.ts + content.ts 内部孪生 interface）

`src/utils/content-extractor.ts:60` 有 `export interface ContentResponse`，但 `src/content.ts:133` 也独立 declare 了同名 interface，**不是 import 自 content-extractor.ts**。两个 interface 字段集恰好一致（历史巧合），所以平时不暴露问题——但每加一个新字段都要**同时改两处**，否则 tsc 报错。

本次 Task 8（加 `attachments: Attachment[]` 到 ContentResponse）实施时 subagent 发现并主动修了两处，但 plan 阶段假设只有一处。

**grep 陷阱**：`grep -n "interface ContentResponse" src/utils/content-extractor.ts` 只看到 1 处；要加 `src/` 全目录 grep `interface ContentResponse` 才会看到两处。这是 §2.15（grep 盲区）的延伸案例。

**Spec 阶段 checklist 补充**：改 `ContentResponse` 任何字段时：
1. `grep -rn "interface ContentResponse" src/` —— 必须覆盖**所有**定义处
2. 不只 add 字段，还要补 import（content.ts 也需 `import type { ... } from './utils/...'`）
3. tsc 不会自动告诉你"还有另一处 interface 漏了"——靠 grep + 测试

**长远 followup**（不在本 spec 范围）：把 content.ts:133 的 `ContentResponse` 改成 `import type { ContentResponse } from './utils/content-extractor';`，消除孪生。但要先 audit 两个 interface 是否真的字段集严格一致——若有差异得拉齐再 merge。

#### C. `obsidian://` 协议只能写 markdown（不能写 vault 附件）

这是产品维度的硬约束，但 spec 阶段没意识到——用户最初要求"PDF 离线缓存到 Obsidian 附件目录"，brainstorming 期才捋出：浏览器扩展唯一的"写 vault" 通道是 `obsidian://new?file=...&content=...`，**只接 markdown 文本**；`chrome.downloads` 能下文件但只能下到 ~/Downloads（不能写 vault 任意目录）；base64 data: URI 内嵌 PDF 会让 markdown 文件从 KB 暴涨到 MB。

最终方案是**只保留 https 直链**（用户登录态浏览器点击能下，离线场景失效），把"PDF 离线缓存"作为独立 future spec（需要 manifest `downloads` 权限 + 用户在扩展设置里指定 vault 附件目录 + 一套 chrome.downloads 异步流程，或者依赖 `obsidian-advanced-uri` 社区插件扩展协议）。

**Spec 阶段教训**：当用户提出"需求 X"涉及"写 vault 附件 / 写本地文件 / 离线缓存二进制资源"时，先 audit 现有 obsidian-clipper 的 obsidian:// 通道能力，再决定是否能落地——别假设"反正能写 markdown 就能写附件"。

#### D. `vi.spyOn(module, 'fn')` 对同模块自调用无效（ESM/TypeScript 规则）

Plan 里写"用 `vi.spyOn(scysExtractorModule, 'resolveScysImages')` mock 掉真实图片抓取"，subagent 实施时发现这条 mock 对**同模块内的自调用**无效——ESM module 内 `extractScysArticleStandalone` 调 `resolveScysImages` 时直接通过 local binding 调，**不经过 module namespace 对象**，spy 拦不到。

正确做法（subagent 改用）：mock `fetch` 本身（覆盖 `/topicDetail` + `/pageTopicComment` + OSS image URL 三条路径），让 `resolveScysImages` 走真实路径但 fetch 全 stubbed —— 测试既验证渲染分支也验证 token resolution 链路，端到端更扎实。

**Spec/plan 阶段教训**：要 mock 同模块自调用函数，唯一可靠的办法是**改函数调用方使用 module namespace**（如 `import * as self from './self'; self.fn()`）——但这是 anti-pattern。务实选择：mock 更外层的 IO（fetch / fs / browser API），让被测函数走真实路径，更接近生产行为。

#### E. Plan task 拆分要考虑 TypeScript 必填字段编译顺序约束

Plan 原始 Task 5（image-only 渲染分支）和 Task 6（`ScysStructuredContent.attachments` 必填字段）被拆开。但 Task 5 实施时，要 return 一个 `ScysStructuredContent` 对象——如果接口已加必填 `attachments` 字段（Task 6 先做），Task 5 的 return 必须填 `attachments`；如果接口没加（Task 5 先做），return 对象缺字段编译不过。**两个 task 实质耦合，无法独立产出可编译代码**。

实施时合并成单 task 派给 subagent，无问题。

**Plan 阶段教训**：拆 task 时除了考虑"功能独立性"，还要考虑"TypeScript 必填字段的编译时依赖"——任何新增必填字段都会让所有 producer 同时改、所有 consumer 同时改，**新增必填字段 + 增加 producer 必须放同一 task**，optional 字段才能跨 task 拆。同理适用于 React props / Rust struct fields / Java class fields 等任何"必填字段语言"。

#### F. Plan 里指定的"测试断言已有 fixture 不破坏"是廉价保险

本次 Task 10 单独列了"现有 fixture 测试回归检查"。subagent 实施全程报"已有 X 个测试 PASS"——这条 plan 步骤实际什么也没做（subagent 早就在每 task 跑全 file 测试），但**心理保险**是真的：它让 subagent 在每 task 完成时显式确认"现有的没坏"，不止"新加的过了"。

**Plan 阶段教训**：保留这条形式化步骤，即使看起来冗余——它防的是 subagent 偷懒只跑 `-t "<new test>"` 不跑全文件。

---

### 2.18 vitest audit 与浏览器 runtime 的等价性陷阱（weixin extractor 修复反思，2026-05-20）

mp.weixin.qq.com 文章 clip 修复**连踩 4 轮验收**才修对（每轮我都报"测试通过"，每轮阿杜实测都不通过）。同一个 root cause 在不同层失败 5 次：**vitest audit 输出和浏览器 runtime 不等价**。每一层都看起来"模拟得很真"，实际偏离都足以让 bug 通过。沉淀下面 5 个 invariant，下次新接 audit 必查：

#### A. audit 的 input 必须等于 pipeline 内 helper 实际收到的 input

第 1 轮：`extractWeChatPublishedFromRawHtml(rawHtml)` audit PASS，但 `content.ts` 实际传的是 `cleanedHtml`（已 `script.remove()`），ct 早不在了。**helper 单测的 input 字符串必须模拟 pipeline 上游所有 transformation 后的产物，不是抽象的 raw 数据**。

下次 checklist：新建 audit 前先 read pipeline，**手动追 helper 的 input 是哪个变量、那个变量经过了什么 transformation**——audit fixture 必须等于该 transformation 后的产物。

#### B. vitest 默认 node env 跑 `createMarkdownContent` 会 silent fallback

第 2 轮：audit 跑 `createMarkdownContent(html, url)` 看似 PASS，**实际 defuddle 内部 `ReferenceError: document is not defined`**，silently fallback 到 `"Partial conversion completed with errors. Original HTML: ..."` 直接吐 raw HTML 当 markdown。PARA 段经 normalize 后已是 plain text 形式，肉眼看像 markdown 多行，**实际是 raw HTML 字面**——侥幸过 assertion。

下次 checklist：任何 audit 涉及 `createMarkdownContent` / turndown / DOM-touching 库 → **`// @vitest-environment happy-dom`** 必须加。stderr 一旦出现 `document is not defined` / `Partial conversion` / `ReferenceError` 当作硬 fail，不准放过。

#### C. 全文穷举 — 不能只看一段就报 PASS

第 2 轮：只断言 PARA 一段，没扫文章其他 23 个 `<pre>` 块；dashboard 段含 inner ` ``` ` 字面 backtick 的 case 完全漏掉。memory `reference_scys_visual_audit` 早写过"全文穷举对比"，被忽略。

下次 checklist：audit 必须扫**所有同类元素**（每个 `<pre>` / 每个 `<table>` / 每个 `<blockquote>`）、断言通用约束（无 `<span>` 残留 / 无 `\`` escape / 无 raw HTML 残留）。**只挑一个代表段就报 PASS = 验收不通过**。

#### D. 浏览器 runtime 的 `document.documentElement.outerHTML` 可能丢 inline `<script>` body

第 3 轮：以为浏览器 outerHTML 序列化保留 script 内容（linkedom 的确这样），改用 `document.documentElement.outerHTML` 喂 raw-HTML helper——浏览器实测仍空。devtools console 直接 `[...document.querySelectorAll('script')].map(s => s.textContent).find(t => /\bct/.test(t))` 返回 `undefined`：**SPA hydration 后 mp.weixin 把原始 inline script 节点从 DOM 移除/清空**，只留 hashed external js bundles。

下次 checklist：**任何依赖"raw HTML 字符串"的提取逻辑都不可靠**——浏览器 runtime 的 DOM 是 hydration 后的状态，可能跟服务端 HTML 字面差异巨大。Helper 应该接受 `doc: ParentNode` 然后用 DOM API 查询（`querySelectorAll` / `textContent`），**绝不依赖 `outerHTML` 序列化字符串**。

#### E. fixture 必须模拟浏览器 fully-loaded 后的 DOM，不是 curl 拿到的服务端 HTML

第 4 轮：fixture HTML 直接拷服务端响应（`<em id="publish_time"></em>` 空 em），audit PASS 因为 helper 走 fallback 拿 ct——但真浏览器里 ct script 没了 + em 已被 JS 填好，正确数据源应该是 `#publish_time` 的 textContent。fixture 状态错位 → audit 无法暴露这个 bug。

下次 checklist：fixture 不只截服务端 raw HTML，**至少包含一个"hydration 后 DOM 状态"的 fixture**——把 mp.weixin / scys 等 SPA 站点关键 JS-populated 元素填上预期值，模拟用户实际点扩展时的 DOM。或者：spec 阶段就在浏览器 console 跑 `document.querySelector('#X')?.textContent` 一行，把返回值作为 fixture 设计的 ground truth。

#### F. 不能让阿杜来回多次 console + tab refresh 试 — 自测先穷尽 console 验证再报验收

第 3/4 轮 我都让阿杜跑 console snippet 帮我确诊（`document.getElementById('publish_time').textContent`）——本来这步应该是**我自测时主动去浏览器跑过一次**就发现的，而不是把 debug 工作推回去。本仓库已有 `chrome.alarms` hot-reload（§2.7） + page-world test bridge（§1.10） + Markdown 渲染自动化验收（§1.9）—— 这些基础设施能让 audit 真正跑在 chrome runtime 而不只 vitest，**下次 weixin / 类似 SPA 站点修复时必须先用这套**，不是 vitest happy-dom。

#### 总结：audit 的 4 层模拟等价性

| 层 | 这次踩坑 | 下次必查 |
|---|---|---|
| **input 字符串** | 喂 raw HTML，pipeline 传 cleanedHtml | 追 pipeline 找 helper 真实 input 源 |
| **运行环境** | node env，defuddle silent fallback | happy-dom；stderr ReferenceError 硬 fail |
| **覆盖面** | 只看 PARA 一段 | 全文同类元素穷举 |
| **DOM 状态** | linkedom 序列化保 script，浏览器不保 | 不依赖 outerHTML，用 DOM API；fixture 反映 hydration 后状态 |

---

### 2.19 ship gate 字段松 = 心理上 weakening 含义 = 填假 ✓（Spec B 三轮 ship 违规反思，2026-05-22）

Spec B 报验收**连踩 3 轮**才通过，根因不在 e2e 工具链本身，而在 **ship checklist 字段定义不严**——每一轮我都填了 ✓ 实际没做。三个违规模式都是同一类病：「字段文字模糊 → 我自行解读 → 实际做的 ≠ 字段宣称的」。沉淀下面 3 个 invariant 防下次复发。

#### A. 软切换：dev 便利和 ship gate 不能挤在同一命令

**这次踩坑**：e2e test 用 `describe.skipIf(process.env.SKIP_E2E === '1')`，让 `npm test` 默认含 e2e、dev 用 `SKIP_E2E=1` 跳过。报 ship 时 paste `npm test` 输出"879 passed / 12 skipped"——心理上 879 等价"全测试 PASS"。下次违规靠"我注意"而不是"机制不可能"。

**下次必做**：把 dev/ship gate **物理拆开命令**（不是 env var 软切换）。dev 默认不含慢的 ship gate；ship gate 必须显式跑独立命令。Spec B 改完后：`npm test`（vitest.config exclude e2e）/ `npm run test:e2e`（独立 vitest.e2e.config）/ `npm run test:all`（全跑）。

**字段层**：ship 模板 T5-2 字段必须写"paste **具体命令名** + 输出尾 3 行（含 `Tests <n> passed` + duration）"——填假 ✓ 要伪造命令输出，物理变难。

#### B. 抽样断言冒充全文证据

**这次踩坑**：T5-3「Obsidian.app 截图」字段，我用第一屏截图当整篇证据；T5-4「视觉对比 web 源一致」字段，我只断言 frontmatter `published` + 5 个 PARA folder 名 + 2 个 negative pattern。整篇 mp.weixin 1160 行 markdown / 538 个 web block，**覆盖度 < 5%**。

**根因**：字段定义模糊。"截图"没说"必须滚到尾"、"视觉对比"没说"必须段落级 audit"、e2e it 用抽样断言不是全文断言。证据链 = 第一屏截图 + 几个 substring `expect` — 当然不能 prove 整篇一致。

**下次必做**：任何"全文"宣言必须有对应的全文工具。

- 全文 markdown 一致：写 `<site>-visual-audit.ts` 解析 hydratedHtml 找内容根 → 扫所有 block-level node → 每个 textContent 跟 markdown 做 substring 比对 → 输出 mismatch 桶。**进 e2e it `'full content audit: 0 mismatch'`** 作 ship gate。Sanity check：截 markdown 一半，audit 应报数百个 mismatch（证明对真 missing 敏感）。
- 全文视觉抽样：`scripts/obsidian-scroll-capture.sh` 滚动到尾 N 张截图，覆盖整篇。**字节数尾 3 张全等 = 触底确认**。
- 截图当辅助证据、不当 ship gate；audit 0 mismatch 才是 ship gate。

#### C. 自行 weakening memory 字段含义

**这次踩坑**：memory `feedback_extractor_acceptance` 原文写「ship **前**测试报告必须落到 `<worktree>/test-report-<date>.md`」+「截图必须滚到尾盖整篇」。Spec B 第二轮 ship，我把"截图"自行解读为"可省"（理由：刚把它降级为「辅助证据」）→ 直接用 Spec B 上一轮的第一屏截图蒙混；测试报告执行成"验收**后**再 commit"——自己改了字段的时序。

**根因**：字段措辞有歧义空间（"辅助证据"≠"可省"；"测试报告"没写明何时落到文件）我就**朝省事方向解读**。

**下次必做**：

- 字段文字必须**用动作命令式**写："必须 paste 命令 X 的输出"、"必须截 N 张图覆盖到底（尾 3 张字节数全等）"、"必须 ship **前**落到 `<worktree>/<file>` 文件，ship 消息 paste 路径 + 关键摘要"。**没有形容词版本**（"辅助"/"完整"/"详细"）—— 都是机器可验证的动作。
- 字段更新后 dogfood：本次 ship 必须自己按新字段跑一遍，确认能填出来。
- 如果我读 memory 时心里冒出"这字段是不是 X 意思"——立刻 ask，**不准朝省事方向自行解读**。

#### 总结：ship gate 字段的"机制不可能违规"标准

| 漏洞类型 | Spec B 这次形态 | 收紧后的字段 |
|---|---|---|
| **软切换** | `SKIP_E2E=1 npm test` 把 ship gate 切成 dev fast | 物理拆 `npm test` / `npm run test:e2e`，文件层 exclude |
| **抽样冒充全文** | 第一屏截图 / 5 个 substring `expect` | 进 e2e it 的全文 audit + scroll-to-end 多截图（尾字节相等） |
| **自行 weakening 字段** | "辅助证据"→"可省"；"ship 前"→"ship 后" | 字段用动作命令式（"必须 paste X"、"必须 ship 前落到 Y"） |

字段松 1 次 = 下次第 N 个新人/未来的我 100% 再次违规。**收紧字段比"我注意"耐用**。

---

### 2.20 视觉 audit 必须 subagent 隔离 + 截图必须考虑 vision rescale + Page Down 自动化必须先固定窗口和视图（audit-via-subagents v2 反思，2026-05-25）

把 §1.12 + §2.19 的视觉对比工作流升级成跨 site 通用 audit 工具链时，v1 直接做"主 session Read 22 张 grid + 自己出报告"——9 slice 上线后**全军覆没**（0/4 PASS，5 个 info diff，8 个 unknown）。3 个独立根因下次必须 design-time 就避开。

#### A. 视觉 audit 必须 subagent 隔离（主 session 不能 Read 几十张 grid）

**这次踩坑**：单 session 跑 audit 时，主 session 把所有 grid + REPORT 上下文都揣在自己 token 里，44 张 grid × 几 KB metadata + 反复 ToolUse 让 conversation 直奔 context 上限。同时主 session 还有"调度其他任务、答阿杜问题"的本职——视觉 audit 的 token 噪声把主 session 挤死。

**下次必做**：任何"vision 密集 + 报告输出"工作流默认 subagent 隔离。

- 每 ~5 张 grid 派一个 subagent（cell 1120×630 时 5 张 grid ≈ 3 万 vision token，大致是 vision 注意力的上限），让它读固定 range + 写 JSON 文件 + 简短回 1 行
- 主 session 只 Read **每个 subagent 写的 JSON**（每份 ~1KB），不读 grid 原图
- subagent 自带 stop hook + 失败重试，主 session 收到 task-notification 就接下一个
- 用 audit-summarize CLI 把 N 份 subagent JSON 聚合成 REPORT.md
- 主 session token 控制目标：≤ 80K（实际 ~60K，含 spec/plan 全程）

**机制**：sub-agent 失败也不污染主 session 的 vision 注意力——下一个 sub-agent 从干净 context 重来。这是把视觉 audit 从"主 session 一次性烧 token"改成"sub-agent 独立小烧 + 主 session 调度"的范式切换。

#### B. side-by-side grid cell 尺寸必须按 vision token 预算反推（不是按"屏幕舒适尺寸"）

**这次踩坑**：v1 cell 用 560×315（人眼看着合适），但 Claude vision 的 token 预算约 1568×1568，**整张 grid 被等比缩小到这个预算**——每个 cell 实际显示大概 220×125，bold/italic/alt 在屏上单字符高 ≈ 5px，**根本识别不了细节**。subagent 反馈"看不清，标 unknown"是被迫的。

**下次必做**：grid cell 尺寸要按"vision 预算 / cell 数量"反推下限，不按肉眼舒适反推。

- cell 1120×630，每 grid 6 行（vs v1 12 行）—— grid 总高度不变（保持 ~7600px），但 cell 缩放后单字符高 ≈ 12px 起，bold/italic 可辨
- 当 cell 数 ≥ 12 时单 cell 必然 < 80×45（vision 预算 1568 ÷ 12 行 ÷ 2 列），任何细节都识别不了——硬上限就是"vision 预算 / sqrt(cell 数)"
- audit-extractor-ship SKILL.md 里"每 5 grid 一 subagent"也是反推：cell 1120×630 时 5 grid 的 vision 注意力刚好够

#### C. 跨列对齐用比例不用 index（避免 grid 下半被 placeholder 占满变 vision 噪声）

**这次踩坑**：v1 第 i 行就直接拿 `browser_frames[i]` + `obsidian_frames[i]`——但 Obsidian 视口窄、frame 数（44）≈ browser 窗口 frame 数（24）的 2 倍。i ≥ 24 后 browser 那列全是 "(no more)" placeholder，整个 grid 下半内容是 noise，subagent 等于只看了 1/2。

**下次必做**：长列 1:1，短列按比例重复 frame：
```python
b_idx = i if n_browser == total_rows else i * n_browser // total_rows
o_idx = i if n_obsidian == total_rows else i * n_obsidian // total_rows
```
两列都在同一"内容进度"上结束，下半也是真内容对比。

#### D. Page Down 自动化必须先固定窗口 + 视图状态（不固定 = 截错 vault / 截 base64 text 出不来）

**这次踩坑**：obsidian-scroll-capture.sh v1 调 `tell application "Obsidian" activate` 后直接 Page Down——但实际：
1. 阿杜有 2 个 vault 同时开，activate 只 frontmost app，**实际 Page Down 在错 vault 的窗口**，44 张截图全是另一个 vault 的同一段文字
2. 默认 view = Editing View 时 base64 image 是 raw text（占源 markdown 几千行），Page Down 在一张图内卡死，触底检测以为是 plateau，**bottom 误判**
3. `screencapture -m` 只截主显示器，目标 vault 在副屏时**整 44 张截图都是主屏内容**（不是任何 vault）

**下次必做**：Page Down 自动化前必须三件套：
- **窗口锁定**：osascript 走 Obsidian 所有窗口，按 markdown basename 匹配 title 后 `perform action AXRaise`，拿到 position+size——5s 找不到匹配窗口直接 exit 6（不是默默截错）
- **视图切换**：进入前点 menu「阅读视图」（Reading View，base64 image 才渲染成 `<img>`），退出前再点一次还原。假设 vault 默认 Editing View，违反时 first-frame size < 150KB 触发 warning
- **多显示器**：`screencapture -R<x,y,w,h>`（global coordinates），不用 `-m`，副屏窗口也能截对
- **触底自动检测**：连续 3 frame byte-equal + MIN_FRAMES=5 floor，不再用 heuristic 估算 page 数

**字段层**：audit-prepare.sh / scripts 失败时必须 exit non-zero + stderr 写明"截错 vault / 主屏没目标 / 触底误判"，禁止默默吐 N 张错截图。

#### 总结：vision 密集任务的"design-time 必须先想清"清单

| 维度 | v1 错误 | 正确做法 |
|---|---|---|
| Token 预算 | 主 session 揣所有 vision | subagent 隔离 + 主 session 只读 JSON |
| Cell 尺寸 | 按肉眼舒适（560×315）| 按 vision 预算 ÷ cell 数反推下限（1120×630）|
| 跨列对齐 | index 对齐 | 比例对齐（长列 1:1，短列重复） |
| 截图自动化 | activate + Page Down 完事 | 窗口 AXRaise + 视图切换 + `-R` 多显示器 + 触底检测 |
| 失败语义 | 默默吐截图 | exit 6 + stderr 写明根因 |

下次任何 site 接入 visual audit（feishu / zsxq / bilibili），直接复用 audit-extractor-ship SKILL + audit-prepare.sh + audit-summarize 工具链，**不要重新发明轮子**。

### 2.21 image inline 三层 fallback (L1/L2/L3) 必须整组移植 — 漏 L3 导致 raw token 留在 markdown（scys L3 fix 反思，2026-05-25）

scys-extractor 的 `resolveScysImages` 当初是从 zsxq-extractor 的 `resolveZsxqImages` 同名同结构 helper 抄/启发的。当时只 carry 了 L1（same-origin fetch）+ L2（background MAIN-world fetch），**漏掉了 L3 raw URL degrade**。L1/L2 都失败时（典型场景：跨域 CDN 防盗链 / CORS 拒绝 / 远端 404），token `feishu-image://scys:URL` 留在最终 markdown 字符串里，Obsidian 不识别此协议 → `![]()` 空图位。spec-b1 ship 前 audit-extractor-ship 跑 B URL（含 docimg3.docs.qq.com 截图）才暴露，sept 1 个 commit 补齐。

#### 教训：跨 extractor 移植 image inline helper 必须 carry **整组 fallback layer**

| 层 | 含义 | 失败场景 | 不能省 |
|---|---|---|---|
| L1 | content-script 同 origin fetch | 大部分 site 内嵌图 | — |
| L2 | background MAIN-world fetch | 跨域但 CORS 兼容 / 用户登录态可复用 | — |
| **L3** | 把 `feishu-image://<prefix>:URL` token 替换为 raw decoded URL | 跨域 CDN 防盗链 / 远端不存在 / CORS 死磕拒绝 | **绝对不能省** — markdown 至少 valid，Obsidian 还会尝试加载，最坏破图但不破 markdown 结构 |

**unit test 必须显式覆盖 L3**：每个 `resolve<Site>Images` helper 至少一条 test "degrades to raw URL when L1+L2 fail"。zsxq-extractor.test.ts:602 就是模板。这次 fix 加的 test 也是 mirror 它。

**下次任何新 site 加 image inline helper 必须 carry L3**：写 plan 阶段把"L1 + L2 + L3 + 对应 unit test"作为必含 checklist 项，不允许只写 L1/L2。

**回归保护**：所有 `resolve<Site>Images` 同名 helper（zsxq / scys / 未来 feishu / bilibili）的 L3 部分 grep 一下：

```bash
grep -rn "stillUnresolved\|L3.*raw URL\|L3.*degrade" src/utils/ scripts/
```

如果加新 site image inline helper 后这条 grep 没出现新条目 → spec gate 不通过。

#### 为什么这次能被 audit 抓到（机制有效性证明）

audit-extractor-ship SKILL 的 checklist 第 7 项 image 不是只看"图片数量对吗"，而是要求 "browser ↔ obsidian ↔ markdown 三方一致"。L3 漏移植 → markdown 含 raw token，token 跟 browser 截图（实际 img）和 obsidian 渲染（空图位）都不一致 → subagent 标 unknown 触发 NEEDS_REVIEW → 主 session 复核 → 发现根因。

如果只跑 unit test 或 e2e mismatch audit（textContent prefix 匹配），这种"图片渲染破图但 markdown 字符串无变化"的 issue 看不见。**视觉 audit 是必要的 ship gate，不是可选**——再次印证 §2.20 v2 + audit-extractor-ship 的工具链价值。

### 2.22 抢焦点 ≠ 需用户介入（scys 5125541 fix ship 时把可自动跑的 T5-3 推给阿杜的违规反思，2026-05-25）

scys 5125541 fix ship 阶段，我把 T5-3 `obsidian-scroll-capture.sh`（activate Obsidian + Cmd+Home + Page Down + screencapture）列为"需阿杜介入"，给了三选一让阿杜决策（A 你方便时手动 / B 你触发 /audit-extractor-ship / C 跳过）。阿杜批评："我已经告诉你可以抢焦点了，剩下的可以自动执行的不要让我介入！这个我在 memory 写了，为什么没遵守，请反思！"

#### Root cause 4 问

| 4 问 | 答 |
|---|---|
| 1. 上次消息长什么样？ | T5-3 三选一 AskUserQuestion，让阿杜选 A/B/C |
| 2. 哪项假 ✓？ | 没填假 ✓，是该**自动**的没自动 |
| 3. 为什么不自动？ | 把"工具抢焦点"≡"需用户决策"。错。"抢焦点"是工具行为（临时占屏），不是"需用户手动输入决策"。"会打扰你"和"需要你做决定" 被 conflate |
| 4. 字段怎么改？ | memory `user_collab_norms` 加："**抢焦点 ≠ 需用户介入**"，只有 (a) 工具需用户手动输入信息（扫码/密码/产品判断）或 (b) 工具会跟用户当前操作产生不可恢复冲突 才算"需用户介入" |

#### 字段收紧动作（已落地）

memory `user_collab_norms.md` 末尾追加新章节"抢焦点 ≠ 需用户介入"，明确：
- `obsidian-scroll-capture.sh` / `obsidian-verify.sh` / `audit-prepare.sh`（含 Obsidian.app activate + Page Down 循环）全部 ✓ **可自动**
- chrome headed playwright / 弹出 Chrome 窗口 ✓ **可自动**
- 只有扫码 / 密码 / 产品判断 / 跨账号操作 才算"需用户介入"

#### 教训：memory 已经写过的规则要主动按图索骥，不是等阿杜被迫复述

memory `user_collab_norms` 的 5 步流程 + Step 2 决策树**已经覆盖**了本次场景——只要逐项问"这步能 Bash 吗？能 Read 吗？能 playwright 吗？能跑 scripts/ 吗？"——`obsidian-scroll-capture.sh` 是 scripts/ 里的工具，**显然** ✓ 自动。我没逐项问，直接默认"会抢焦点 = ❌ 手动"。

#### 下次预防

发"需要你介入"消息前，**强制对每一个'❌'项再问一次**：
1. 这是 (a) 输入信息 吗？
2. 这是 (b) 不可恢复冲突 吗？
3. 两者都不是 → ✗ 不能列为 ❌，重新分类为 ✓ 自动

如果对 (a)(b) 还不确定 → 默认 ✓ 自动（"会打扰阿杜但能跑通"属于可自动）。

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

### 6.18 ~~mp.weixin.qq.com 文章 publish_time + mdnice 代码块修复~~（**已完成 2026-05-20**，commits `49dd596` → `e4a546f`）

**两个用户报告的缺陷**（同一篇文章 `https://mp.weixin.qq.com/s/SPLTD-hFAsyYAA7V1lU8OA`）：

1. frontmatter `published` 字段为空
2. PARA 文件夹结构代码块塌成一行；后续 dashboard 代码块（含 inner ` ```dataview ` 字面 backtick）输出 `\`\`\`\`\`` 反斜杠转义乱码

**根因（4 个交叉踩坑，每个对应一次失败的验收轮次）**：

| Bug | 根因 |
|---|---|
| 1. published 空 | `content.ts` 把 `cleanedHtml`（已 `<script>` strip）喂给 ct 提取 helper；后改用 `document.documentElement.outerHTML` 仍空（浏览器 SPA hydration 后服务端 inline `var ct = "..."` 不在 DOM 了）；最终改用 `#publish_time` 的 `textContent`（JS 填好的 `2026年4月14日 00:30`） |
| 2a. PARA 塌一行 | mdnice 编辑器输出 `<pre><code><span>line</span><span><br/></span>...</code></pre>`，turndown 在 fenced code block 内丢 `<br>` |
| 2b. dataview backtick escape | defuddle 的 `preformattedCode` turndown rule 硬编码 (a) 固定 3-backtick fence + (b) `replace(/\\\`/g, '\\\\\\\`')`——CommonMark 规定 fenced code block 内 backslash escape 无效，所以 `\\\`` 字面渲染 |
| 2c. `<span>` 残留 + `&#160;` 字面 | turndown 把 `<pre><code>` 内嵌 `<span>` 当 raw HTML 吐出；NBSP 在 fenced code block 不解码 |

**实施方案**：

1. **新建** `src/utils/weixin-helpers.ts` 两个纯函数：
   - `extractWeChatPublishedFromDocument(doc)` —— 优先读 `#publish_time` textContent 解析 `(\d{4})年(\d{1,2})月(\d{1,2})日`，fallback 走 `<script>` ct 遍历（不依赖 outerHTML 序列化）
   - `normalizePreBlockLineBreaks(root)` —— 遍历每个 `<pre>` 子树：(a) `<br>→\n`、(b) collapse 整个 `<pre>` (或 `<pre><code>`) 为单一 text node、(c) NBSP→ASCII space
   - 旧 `extractWeChatPublishedFromRawHtml(html)` 保留供 fixture 单测用（input 本来就是字符串）
2. `src/content.ts`：
   - `extractWeChatArticleContent` 在 `outerHTML` 之前调用 `normalizePreBlockLineBreaks(articleClone)`
   - `weChatPublished = extractWeChatPublishedFromDocument(document)`（不是 cleanedHtml / 不是 outerHTML）
   - `ContentResponse.published` 字段链增加 weChatPublished（在 `defuddled.published` 之前、其他 extractor 之后）
3. `src/utils/markdown-post-process.ts`：新增 `fixFencedCodeBacktickEscapes`——识别每个 fenced code block，把内部 `\\\`` 还原为 ` ``` `，并按需把外层 fence 加长到 `longestInnerRun + 1`（CommonMark 标准做法）。全局生效，所有 site 都受益。

**Fixture**：
- `src/utils/fixtures/weixin-SPLTD-hFAsyYAA7V1lU8OA.html`（4MB 真实 HTML 截短为 ~3KB 关键片段；`#publish_time` em 含 `2026年4月14日 00:30` **模拟 hydration 后状态**，不是服务端 raw HTML）

**测试覆盖**：
- 10 个 `weixin-helpers` 单元测试（覆盖 ct 提取、Chinese date 解析、`<script>` outerHTML 丢 body 的回归 sentinel、empty `#publish_time` fallback、`几小时前` 模糊文本失败）
- 9 个 audit 测试（happy-dom env 跑完整 createMarkdownContent + post-process，断言 PARA 多行 + dashboard 4-backtick outer fence + 全文无 `<span>` / `\\\`` / NBSP；同时 dump byte-equivalent obsidianNote .md 到 `/tmp/wx-clip-output.md` 方便人眼审 frontmatter + body）
- 890/893 全量 PASS（3 pre-existing template-integration 时区无关）

**关键选择**（YAGNI / 不做的事）：
- 不抽 `weixin-extractor.ts` —— 继续 `content.ts` 内联，纯函数 helper 抽到 weixin-helpers.ts 即可
- 不动 `<pre>` 之外的 `<br>`
- 不在 `published` 输出 HH:MM（沿用其他 extractor YYYY-MM-DD 约定）
- 不做时区调整（沿用 scys / zsxq / feishu 的 dayjs 本地时区约定）

**反思沉淀到 §2.18**：vitest audit 与浏览器 runtime 的等价性陷阱（input 字符串 / 运行环境 / 覆盖面 / DOM 状态 4 层都得对齐）。这是连踩 4 轮验收才修对的修复——每一轮我都自测"PASS"，但浏览器实测都失败。教训沉淀到 §2.18 + 更新 `feedback_extractor_acceptance.md` memory。

**spec / plan**：
- `docs/superpowers/specs/2026-05-19-weixin-publish-time-and-pre-codeblock-fix-design.md`
- `docs/superpowers/plans/2026-05-19-weixin-publish-time-and-pre-codeblock-fix.md`

---

### 6.17 ~~scys article image-only 形态 + PDF 附件支持~~（**已完成 2026-05-19**，commits `767b9e4` → `78c56e0`）

**两个用户报告的缺陷一次性修复**：

1. **URL `45544824841421428`（纯图片帖）** frontmatter 缺 `author` / `published`，body 为空 — 主路径放弃后 fallback 到 defuddled 拿不到这些字段
2. **URL `22255855424524441`（含 PDF 附件帖）** 笔记完全没附件信息 — extractor 不读 `topicDTO.fileList`

**根因**：

- 问题 1：`fetchScysArticleDetail` 在 docBlocks/articleContent 都空时直接 `return null`，但 `imageList` 字段非空（一张拼接长图）—— scys article 第 **4** 种数据形态（"image-only article"），前三轮 spec 未覆盖（§6.12 / §6.13 / §6.16 沉淀的"article 三形态" 漏了这类）
- 问题 2：`ScysArticleDetail` 接口不含 `fileList` / `attachments` 字段；extractor 三条 return path 都没考虑附件

**实施方案**：

1. 新建公共 `Attachment` 接口（`src/utils/attachment-types.ts`，预留给未来飞书 file block / zsxq 文件附件复用）
2. `ScysArticleDetail` 加 `imageList?: string[]` + `attachments?: Attachment[]` optional 字段
3. `fetchScysArticleDetail` 三态判定（hasBlocks / hasHtml / hasImageList，全空才 return null），透传 imageList + 从 fileList 构造 Attachment[]（URL 绝对化 + 脏数据 filter）
4. 抽 `renderScysImageUrls(urls: string[])` helper（DRY，原 `renderCommentImages` 复用）
5. `extractScysArticleStandalone` 加 image-only 分支（docBlocks > image-only > articleHtml 三分支 dispatch）
6. `ScysStructuredContent.attachments: Attachment[]` 必填（course/docx/article 三路径都填）
7. article body 末尾 append `<h2>附件</h2><ul>...</ul>`（带 📎 emoji，与既有飞书 file block 视觉对齐）
8. `ContentResponse.attachments`（两处 interface 都加 — 见 §2.17.B）
9. `shared.ts` 注册 `{{attachments}}` simulated variable，给高级用户自定义模板

**关键选择**：
- PDF 不离线缓存到 vault（受 `obsidian://` 协议限制，留作未来独立 spec — §2.17.C）
- `<e type="text_bold">` 实体解码不做（与本 spec 解耦，留作独立 spec）

**Fixture**：
- `src/utils/fixtures/scys-article-45544824841421428-detail.json`（image-only）
- `src/utils/fixtures/scys-article-22255855424524441-detail.json`（fileList + text_bold `<e>`）

抓取方式同 §6.16：`pycookiecheat` 直接读 macOS Chrome cookie keychain → 跑 scys API（无需用户配合）。

**测试覆盖**：
- 2 个 `fetchScysArticleDetail` 单元测试（image-only / attachments 透传）
- 1 个 image-only article 端到端测试（mock fetch 全链路 → 断言 author/published/inlined image）
- 1 个 attachments article 端到端测试（断言 ## 附件区 + attachments[] 字段）
- 1 个 image-only + attachments 共存测试（hybrid synthetic fixture）
- shared.test.ts 中 `{{attachments}}` 注册测试
- 167/167 scys 测试 PASS，全量 871/874 PASS（3 个 template-integration TZ failures pre-existing 与本次无关）

**反思沉淀到 §2.17**：scys article 数据形态扩到 4 种 / ContentResponse 双 interface 陷阱 / obsidian:// 协议限制 / vitest spyOn ESM 自调用 / plan 必填字段编译顺序 / 形式化回归测试步骤的价值。

**spec / plan**：
- `docs/superpowers/specs/2026-05-19-scys-article-image-only-and-attachments-design.md`
- `docs/superpowers/plans/2026-05-19-scys-article-image-only-and-attachments.md`

---

### 6.16 ~~scys article 评论 `<e type="web">` 实体解码~~（**已完成 2026-05-19**，commit `8e42f1c`）

**问题**：scys article (`/articleDetail/xq_topic/{id}`) 评论里指向外部资源（GitHub repo / 链接卡片）的 URL 缺失。

**根因**：评论 `c.content` 是服务端 render 好的 HTML，**夹带 zsxq 原生 `<e type="web" href="URL-encoded" title="URL-encoded" />` self-closing 实体**。`renderOneArticleCommentHtml` 只过 `autolinkBareUrls`（裸 URL → `<a>`），不解码 `<e>`；下游 Defuddle 把这个非标 self-closing tag 直接吞 → 链接消失。同源的 `preprocessScysEntityHtml`（legacy plain-text articleContent path）早就实现过 `<e>` 解码，但**没抽成共享 helper**，所以评论 path 没复用上。

**实施方案**：
1. 抽出 `decodeScysWebEntities(html: string): string` 共享 helper（regex `<e\s+type="web"\s+href="..."\s+title="..."\s*/?>` → `<a href="…">title</a>`，title 空时回退到 href）
2. `preprocessScysEntityHtml` 内部调 helper（**字节级等价**重构，回归测试保护）
3. `renderOneArticleCommentHtml` 在 `autolinkBareUrls` 之前调 helper（实际 fix）

**Fixture**：从生产 API 抓的 `src/utils/fixtures/scys-article-22255845818825821-{detail,comments}.json`——22 条评论里 1 条命中 `<e>` 实体（GitHub gstack 链接），最小复现数据集。

**抓 fixture 方法（无需用户配合）**：本次创新——`pycookiecheat` 直接读 macOS Chrome cookie keychain，登录态 cookie 拿到后用 `requests` 跑 scys API。`/tmp/scys-cookie-probe/fetch.py` 的脚本封装见 session log。**不再需要让用户在 chrome console 跑 fetch JS 粘 raw data**。

**测试覆盖**：
- 4 个 helper 单元测试（`src/utils/scys-extractor.test.ts` 末段 `decodeScysWebEntities`）
- 1 个 e2e 集成测试（`src/utils/scys-article-comment-entity.integration.test.ts`，mock fetch + 真 fixture）
- 现有 165 个 scys 测试 0 regression

**反思沉淀到 §2.16**：server-render HTML 字段是单独一类（区别于 docBlocks），其编码 helper 必须跨 path 共享。

**spec / plan**：
- `docs/superpowers/specs/2026-05-19-scys-article-comment-entity-design.md`
- `docs/superpowers/plans/2026-05-19-scys-article-comment-entity.md`

---

### 6.19 ~~E2E 测试工具链 + mp.weixin full-content audit + ship gate 三轮收紧~~（**已完成 2026-05-22**，commits `ff10772..48c1ea9`，9 commits on `spec-b-e2e` worktree）

**触发**：6.18 weixin 修复 4 轮验收失败暴露 vitest audit ≠ 浏览器 runtime（§2.18）。Spec A 落地 ship gate 铁律 + 字段后，**Spec B 建 e2e 自动化基础设施**，让 ship 验证能在真 chrome runtime 跑。

**实施分 9 commits 三段式**：

**第 1 段：基础设施（6 commits, ff10772..bfc8434）**
- `playwright` + `playwright-extra` + `puppeteer-extra-plugin-stealth` devDep（绕 mp.weixin 反爬）
- `scripts/read-chrome-cookies.py`（uv 项目 + `pycookiecheat`，scys/feishu/zsxq 需登录站点用）
- `scripts/e2e-clip-runner.ts` — Playwright 启 chrome + load dist/ + page-world bridge + recv-server 接 markdown，返回 `{markdown, hydratedHtml, durationMs}`
- `src/content.ts` bridge 加 mp.weixin URL routing
- `src/utils/weixin-extractor.e2e.test.ts`（5 抽样 it）
- `CLAUDE.md` 加"E2E 测试工具链"段

**第 2 段：fail-closed 漏洞 1（commit c7517c0）—— SKIP_E2E 机制层**

Spec B ship 初版用 `describe.skipIf(process.env.SKIP_E2E === '1')`，让 `npm test` 默认跑 e2e、dev 用 `SKIP_E2E=1` 跳过。阿杜质疑：dev 便利和 ship gate 挤在同一命令 = 软切换 = 下次只跑 `SKIP_E2E=1 npm test` PASS → 心理上"全测试 PASS"→ 填假 ✓。

修复（机制级拆分）：
- `vitest.config.ts` exclude `**/*.e2e.test.ts`（文件层不 include）
- `vitest.e2e.config.ts` / `vitest.all.config.ts` 独立配置
- package.json 拆 `test` (dev fast) / `test:e2e` (ship gate) / `test:all`
- 删 `describe.skipIf` — 文件层不再有 opt-out 开关
- memory T5-2 字段收紧："必须 paste `npm run test:e2e` 输出尾 3 行"

**第 3 段：fail-closed 漏洞 2（commits 8a02242 + 48c1ea9）—— 截图非全文证据 + 测试报告时机**

ship 初版用第一屏 Obsidian 截图 + 5 个抽样断言（frontmatter + PARA folder）当全文证据；测试报告写"验收通过后再 commit"。阿杜质疑：(a) 整篇 1160 行 markdown / 538 个 web block 只验证抽样，没盖全；(b) 测试报告时机错位，memory 原文是 ship **前**出。

修复：
- `scripts/weixin-visual-audit.ts` — 解析 `hydratedHtml` 找 `#js_content`，扫所有 block-level node（p/h/li/blockquote/pre/td/th/img），每个 textContent 做规范化（`<br>→\n`、合 whitespace、剥 markdown emphasis markers）后跟 markdown 做 whitespace-insensitive substring 比对，输出 mismatch 桶
- e2e test 加 `it('full content audit: ... (0 mismatch)')` — 539 个 block 全部在 markdown 中出现
- Sanity check: 截 markdown 一半 → audit 报 461 mismatches，工具对真 missing content 充分敏感
- `scripts/obsidian-scroll-capture.sh` — AppleScript Cmd+Home + 循环 Page Down + screencapture，覆盖整篇 markdown 多张截图（mp.weixin 1160 行需 ~58 屏）
- `scripts/dump-clip.ts` — 一次性 CLI dumper（runRealClip → /tmp/clip-{md,html}.txt）
- memory T5-3/T5-4 字段同步收紧（详 §2.19）
- 测试报告 ship 前先落到 `<worktree>/docs/superpowers/test-reports/2026-05-22-spec-b.md`（local-only per `feedback_specs_plans_local_only`）

**Spec B 落地后的工具链全景**：

| 文件 | 角色 |
|---|---|
| `scripts/e2e-clip-runner.ts` | T5-2 工具：Playwright 启真 chrome + load dist/ + page-world bridge + 拿 markdown + hydratedHtml |
| `scripts/weixin-visual-audit.ts` | T5-4 工具：全文 block-level audit，每个 visible 块的 textContent 必须出现在 markdown 中（whitespace-insensitive substring）|
| `scripts/obsidian-scroll-capture.sh` | T5-3 工具：Obsidian 滚动到尾多张截图，覆盖整篇 markdown |
| `scripts/dump-clip.ts` | dev 调试工具：dump markdown + hydratedHtml 到 /tmp 给 audit dev 用 |
| `scripts/read-chrome-cookies.py` | scys/feishu/zsxq e2e 用：读 macOS Chrome cookie keychain 注入 Playwright |

**接力**：Spec B1（scys e2e）—— 含 `scripts/scys-visual-audit.ts`（迁移现 Python 版到 TS）+ 用现成 `obsidian-scroll-capture.sh`。Spec B2/B3/B4 接 feishu / zsxq topic / zsxq article。bilibili 无 HTML 输入不需 e2e（JSON API）。

**测试报告**：`docs/superpowers/test-reports/2026-05-22-spec-b.md`（worktree local，gitignored）

---

### 6.20 ~~视觉 audit subagent 隔离 + grid 工具链跨 site 复用~~（**已完成 2026-05-25**，commits `a56dc7c..9477af0`，15 commits on `audit-via-subagents` worktree）

**触发**：Spec B/B1 落地后，单 session 跑 audit 直接 Read 几十张 grid 截图 → 主 session token 爆炸 + audit 质量低（识别不出 bold/italic/alt）。需要把视觉 audit 改造成「subagent 池 + 主 session 调度 + CLI 汇总」的范式，让任何 site 接入都可复用。

**实施分 15 commits 三段式（worktree `audit-via-subagents`）**：

**第 1 段：audit-summarize CLI（6 commits, a56dc7c..5605260）**
- 从 `spec-b1-scys-e2e` 复制 `scripts/browser-scroll-capture.ts` + `scripts/build-side-by-side-grid.py`（成熟工具，作为依赖）
- `vitest.config.ts` include `scripts/**/*.test.ts`（让 audit-summarize 单元测试能跑）
- `scripts/audit-summarize.ts` — TDD 实施：Task 3 types + parseSlice → Task 4 aggregateByUrl 跨 slice 聚合 → Task 5 renderMarkdown per-URL checklist 表 → Task 6 CLI main + exit code（FAIL=1 / NEEDS_REVIEW=2 / PASS=0）
- 17 个 vitest 单元测试覆盖：fixture 单 slice / 多 slice mixed / FAIL+NEEDS_REVIEW 合并语义

**第 2 段：audit-prepare wrapper + SKILL（5 commits, f60cb0b..ebfd698）**
- `scripts/audit-prepare.sh` — 一键脚本：browser-scroll-capture（playwright 真 chrome 截浏览器）+ obsidian-scroll-capture（Page Down 截 Obsidian）+ build-side-by-side-grid（拼 grid）+ 输出 RUN_ID 到 /tmp
- `.claude/skills/audit-extractor-ship/SKILL.md` — subagent 隔离视觉 audit 流程定义：每 ~5 grid 派 subagent + 固定 JSON schema + checklist 10 项 + status 派生规则
- `scripts/fixtures/audit/dry-run/` — mock 6 slice 模拟真实 A+course URL 场景（让 audit-summarize CLI 不联网就能 dry-run）

**第 3 段：v1 跑通找 bug + v2 fix 全 PASS（4 commits, 152220d..9477af0）**

v1 在 scys-A URL 跑全流程：22 grid / cell 560×315 / index 对齐 / `obsidian-scroll-capture.sh` N_PAGES heuristic + 默认 view + 主屏截图。结果：0/4 slice PASS，5 个 info diff，8 个 unknown。三个独立根因 + fix（详见 §2.20 A-D）：

1. **cell 太小**：560×315 → 1120×630（vision 预算下单字符高 5px → 12px 起，bold/italic 可辨）
2. **跨列对齐**：index → proportional（避免下半 grid 被 "(no more)" 占满）
3. **obsidian-scroll-capture 三件套**：窗口 AXRaise（多 vault 防截错）+ Reading View 切换（base64 image 才渲染）+ multi-display `-R` global coords（副屏窗口也能截对）+ 触底自动检测（连续 3 frame byte-equal）
4. **bash 3.2 兼容**：`set -u` 下空 array 解引用要 guard
5. **diffs[] 字段严约束**：subagent 自创 `type/where/detail` 字段被 audit-summarize 渲染成 undefined → SKILL.md 加严"5 字段（grid/location/category/severity/desc）固定，不发明新字段"

v2 在同一 URL 跑：44 grid / 9 slice 全 PASS / 0 diff / 0 unknown / audit-summarize exit 0。主 session token ~60K（≤ 80K 目标）。

**audit-extractor-ship 工具链全景**：

| 文件 | 角色 |
|---|---|
| `scripts/audit-prepare.sh` | 一键 capture wrapper：browser + Obsidian 截图 + grid 拼接 |
| `scripts/browser-scroll-capture.ts` | playwright 启真 chrome 截浏览器，输出 PNG 序列 |
| `scripts/obsidian-scroll-capture.sh` | Obsidian 自动化截图（窗口 raise + Reading View + `-R` 多屏 + 触底检测）|
| `scripts/build-side-by-side-grid.py` | 拼左右双列 grid（cell 1120×630 + 比例对齐 + 每 grid 6 行）|
| `scripts/audit-summarize.ts` | 聚合 N 份 subagent JSON → REPORT.md + checklist 表 + 退出码 |
| `.claude/skills/audit-extractor-ship/SKILL.md` | 主 session 调度规则 + subagent 任务模板 + JSON schema + checklist |
| `scripts/fixtures/audit/dry-run/` | 不联网 dry-run fixture（CI 用） |

**接力**：本次只在 scys-A URL 跑通。后续 feishu / zsxq / bilibili / weixin 接入 audit 直接复用这套工具链——只需提供 `<vault, md-path, url>` 三元组。BACKLOG §6 后续 feature 验收都可以走这条路径。

**测试报告**：本次 audit-via-subagents v2 跑通 == 测试报告（无独立 `<worktree>/test-report-*.md`，因为本身就是 audit 工具链而不是 site extractor）

### 6.21 ~~Spec B1：scys e2e + 4 article 形态 + docx + course 全 ship~~（**已完成 2026-05-25**，commits `1d45249..aea8996`，11 commits on `spec-b1-scys-e2e` worktree）

**接续** §6.19（spec-b e2e + mp.weixin PoC）：在 mp.weixin e2e infra 基础上，对 scys 全形态 (4 article 形态 + docx + course) 写 e2e + 视觉 audit + ship gate。

**实施分三段**：

**第 1 段：基础 e2e 框架（7 commits, 1d45249..ddb44a9）**
- `scripts/visual-audit-framework.ts` — 通用 audit framework（normalize/assert/rootSelector 都给默认值）+ `weixin-visual-audit` 改造为 wrapper（DRY）
- `scripts/scys-{article,docx,course}-visual-audit.ts` — 三个 audit 配置（site-specific override：rootSelector、imageAssert）
- `scripts/scys-login-persist.ts` + `runRealClip({ userDataDir, offscreen })` — scys 扫码登录持久化（pycookiecheat 无法读 HTTP-only cookie，必须 playwright persistent profile）

**第 2 段：6 URL e2e + 1 bug fix（3 commits, 76c467a..1307785）**
- `src/utils/scys-extractor.e2e.test.ts` — 6 it 覆盖 article 4 形态 + docx + course，each `full content audit 0 mismatch`
- commit `0c05ea9` 修 `decodeScysWebEntities` — 旧 regex 只处理 `<e type="web" href="..." title="..." />`（要求 href + title + 固定顺序），漏 `<e type="text_bold" title="..." />`（粗体文本 inline，无 href）→ URL 22255 e2e 失败根因
- audit task 7+8：strictTextAssert + .block-text + mutation sanity

**第 3 段：L3 fix（1 commit, aea8996）**— 见 §2.21
- `resolveScysImages` 加 L3 raw URL fallback：跨域 CDN（docimg3.docs.qq.com）L1/L2 fetch 都失败时不再留 raw `feishu-image://scys:URL` token，degrade 为 raw https URL（zsxq-extractor 同名 helper 已有 L3，本 fix 镜像之）
- 触发：spec-b1 ship 阶段 audit-extractor-ship 跑 B URL 时 image checklist 项 unknown，主 session 复核发现 md 含 raw token；scys-extractor 缺 L3 layer
- 测试：169/169 PASS（更新 2 个 pre-existing test：从断言 "token form present" 改为 "no-token + raw URL/data URL present"）

**Ship 时使用的 audit 工具链**：本是 §6.20 audit-via-subagents 工具链第一个跨 site feature 验收用户。流程：
1. `scripts/audit-prepare.sh` 串行采集 5 URL grid（A 引用 audit-via-subagents v2 结果）
2. 主 session 派 7 个 subagent 并行 audit（每 ≤6 grid，控 vision token）
3. `scripts/audit-summarize.ts` 聚合 → REPORT.md exit 0 = 全 PASS

**测试报告**：`docs/superpowers/test-reports/2026-05-23-spec-b1.md`（local-only）含 8 task 实施 + L3 fix re-audit 章节

### 6.22 ~~scys article 5125541 渲染修复（heading dynamic rewrite + 防御性单测）~~（**已完成 2026-05-25**，commits `78f70b2..dc08877`，6 commits on `worktree-scys-5125541-fix`）

**触发**：阿杜报"https://scys.com/articleDetail/xq_topic/5125541242454854 裁剪结果不符合预期"。spec-b1 ship 后第一个 follow-up bug。

**根因**：5125541 是 docBlocks 形态 article 但**同时使用了 type=3/4/5/6/7 五级 heading**（前几个 article 多用 type=5/6/7 三级）。spec-b1 的 `HEADING_REWRITE_ARTICLE` 硬码表只处理 type=5/6/7/8，type=3/4 直接原样输出 → markdown 文档体内出现 3 个 H1 + 8 个错位的 H2。

**修复（4 个核心 commits）**：

| Commit | 内容 |
|---|---|
| `78f70b2` feat | `computeDynamicHeadingRewrite(blocks)` — 按 article 实际使用的 heading types sorted ascending, first→H2, next→H3, ... cap at H6。6 个单测覆盖 5125541 ({3,4,5,6,7}) + URL A ({3,5,6,7,8,9} cap) + 传统 ({5,6,7}) + 空 + 夹杂 + 重复 |
| `b8bac1a` feat | `extractScysArticleStandalone` docBlocks 分支切换 dynamic + 删除硬码 `HEADING_REWRITE_ARTICLE`。175 现有测试 0 regression（fixture 都走 articleContent fallback 不经 docBlocks 分支） |
| `3af417a` test | 4 个防御性单测 — `flattenScysBlocks` callout/grid children_blocks 递归（原 spec hypothesis 错以为 `children_blocks: string[]` ref；实际是 `ScysBlock[]` inline 对象 + 递归已实现）。锁住将来不被改坏 |
| `0844fb3` test | e2e 5125541 加入 `ARTICLE_CASES` + 专项 it 数学校验：H1=0, H2=4, H3=8, H4=14, H5=12, H6=3 + image=23。URL A audit 框架兼容自动复用 |

**B3 (26 vs 23 张 image) 是 false alarm**：我早期 audit script 把 `.feishu-doc-content img` 全算（含 UI / 头像 / cover），实际 article body 真有 23 张 = docBlocks 递归 23 张 = markdown 23 张，完全一致。

**B4 (GRID block) 已经 work**：`flattenScysBlocks` 现有递归正确处理 `ScysBlock[]` 子块；GRID column children 在 markdown 中按顺序展开（Obsidian 无 column primitives，flatten 是唯一表达），内容不丢。

**Dev infra 副产品（2 commits）**：

- `08341b7` feat(scripts): `dump-clip.ts` 加 `--profile <dir>` 支持持久化 profile + 自动跳过 weixin 专用 `#publish_time` selector（scys/zsxq/feishu sites 不存在该 selector）
- `dc08877` docs(scripts): `obsidian-scroll-capture.sh` 注释 `阅读视图` click 的 caller 假设（vault default=Reading 时脚本 toggle 切到 Editing → audit 全 Editing 截图）

**Workflow 反思（1 commit）**：

- `eda1edb` docs(BACKLOG §2.22): 抢焦点 ≠ 需用户介入 — ship 时把 T5-3 obsidian-scroll-capture 推给阿杜决策违反 user_collab_norms"能自动的先自动做完"。memory `user_collab_norms` 新增章节字段收紧

**已知限制 / Follow-up**：

- ⚠️ **视觉 sbs grid L↔R alignment 在 base64-image-heavy article 失效**（详见 `docs/superpowers/specs/2026-05-25-audit-infra-v3-need.md`）。两轮 PoC（file size 阈值 / perceptual hash diff）都没改善。真正修需要 **OCR/textContent anchor per frame**，是 audit infra 大改造（推荐方案 A or B 各 2-5h）
- spec-b1 历史 4 URL audit 通过**可能也有同类 alignment 盲区**，audit-via-subagents v3 修好后**回头重审历史 4 URL** 才算真正干净
- D1 base64 image → 附件文件（动到 attachment 目录）— 跨 extractor 大改造，单独 Spec Y brainstorm

**ship gate 接受路径**：5125541 fix 凭 e2e `auditScysArticle` textContent prefix audit 5 URL 全 0 mismatch + unit/e2e 全 PASS + 主 session 抽 4 张 grid 复核 Obsidian Reading View 渲染正确 ship。视觉严格 L↔R 对齐 due to audit infra 缺陷暂不可得，作为 follow-up 留 v3 修。

**测试报告**：`docs/superpowers/test-reports/2026-05-25-scys-article-5125541-fix.md`（local-only）

### 6.23 ~~audit-via-subagents v3 — textContent anchor alignment~~（**已完成 2026-05-26**，commits `682cfbd..5c26f1a`，10 commits on `worktree-audit-via-subagents-v3`）

**接续** §6.22 audit infra v3 follow-up：5125541 fix ship 时发现 build-side-by-side-grid.py frame-index proportional alignment 在 base64-image-heavy article 上 L↔R 系统性错位（详见 §2.22 + spec `docs/superpowers/specs/2026-05-25-audit-infra-v3-need.md`）。

**修复**：替换 frame-index proportional → markdown-line-anchored alignment via textContent extraction：

| Commit | 内容 |
|---|---|
| `682cfbd` feat | `scripts/macos-vision-ocr.swift` — VNRecognizeTextRequest 包装 swift CLI（zh-Hans + en-US, .accurate, GPU-accelerated ~150ms/帧） |
| `41a7eef` feat | `browser-scroll-capture.ts` 每帧 page.evaluate 抽 viewport textContent 写 sibling `.txt`（精确无 OCR 误差）+ `--content-selector` flag（站点隔离 sidebar/UI） |
| `a5ae955` feat | `obsidian-scroll-capture.sh` 每帧 screencapture 后 spawn vision-ocr 写 sibling `.txt` + idempotent swiftc build |
| `bc570c1` feat | `build-side-by-side-grid.py` alignment 重写：纯函数 `frame_anchor_from_text` / `compute_anchors` / `find_frame_at_line`；row mapping 按 md line progress；`--self-test` 7 case |
| `deab1fc` feat | `audit-prepare.sh` 传 md path 第 4 参数给 build-side-by-side-grid |
| `9508b68` feat | `audit-prepare.sh` per-host content-selector routing（scys → .feishu-doc-content；weixin → #js_content） |
| `cb521a2` fix | `audit-prepare.sh` cp .txt sidecars alongside .png（**重要 bug fix** — 否则 v3 alignment 链路在 audit-prepare 流程下不可能 work） |
| `4d16cbc` perf | `build-side-by-side-grid.py` SequenceMatcher 替代 pure Python LCS DP（22 min → <10s on 5125541, ~100x speedup） |
| `c1000f0` fix | `macos-vision-ocr.swift` 跳左 25% sidebar crop（之前 OCR 抽 Obsidian icon sidebar 全 noise）+ `obsidian-scroll-capture.sh` 加 Cmd+UpArrow（Reading View 不 honor Cmd+Home，frame 001 截图中段而非顶） |
| `5c26f1a` feat | `build-side-by-side-grid.py` compute_anchors 加 linear interpolate — 在 anchored frames 之间填充 unanchored frames 的 anchor（OCR noise frames 不再 stuck on prev anchor） |

**集成验证**（5125541 audit RUN_ID `v3-validate-20260526-064523`）：

- **E URL (5125541)**：browser 44/44 anchored, obsidian 75/80 anchored。sbs-06 row1 L↔R 改进：`L=销售政委奖励 (line 328) / R=销售政委原则 (line 290) — 同章节 40 lines apart`（vs 前 L=第三部分起始 / R=数据图区段 差 2000+ lines）
- **A URL (55188248)**：browser 92/92, obsidian 321/324 anchored（interpolation 填了 ~200 inherit frames）。sbs-06 row1 L↔R 改进：`L=AI 模板 prompt / R=公众号小号创业总结 — 同章节内不同段落`（vs 前 L=mid / R=properties widget 起始 差 2000+ lines）

**已知局限**：image-heavy article（A URL）OCR noise 严重（base64 image 渲染 + 截图 → Vision 抽 "永⋯ 呈成⋯" 等噪声），即使 99% interpolated anchored，alignment 精度有限（~100 lines 内同章节正确，跨段精确比对仍 hard）。textually-rich article（E URL）alignment 接近完美。

**Out-of-scope（v3 spec 明确）**：
- 历史 4 URL B/C/D + docx + course 重审（v3 ship 后 follow-up worktree）
- audit-summarize 改动（理论不变，subagent diff 输出格式不变）
- audit-extractor-ship SKILL 文档（caller 透明）

**ship gate 接受路径**：v3 改造完整 + 5125541 + URL A 集成验证 alignment 显著改进，L↔R 同章节比对可用。视觉精确 alignment 在 image-heavy article 仍 imperfect 但属物理限制（base64 OCR noise 上限）。

**Workflow 反思 / 经验沉淀**：

- **Bug 链**：spec hypothesis "frame-size weighted alignment" 失败 → "perceptual hash diff" 失败 → 最终 textContent anchor work，但 textContent anchor 走完整链路前后续暴露 4 个 bugs（OCR sidebar noise / Cmd+Home Reading View 失效 / LCS perf / anchor inherit gap）。每个 bug 在集成验证才暴露 — 说明 brainstorm 阶段穷尽设计 ≠ 穷尽 implementation surprises
- **集成验证是 audit infra 改造的 ground truth**：单测覆盖 alignment 算法逻辑但不能 verify "OCR 在真实 Obsidian Reading View 截图上的行为"。下次 audit infra 改造 spec 阶段需要 explicit 一个 "用真实 5125541 frame 跑 OCR pipeline 看 .txt 内容质量" 的验证 task
- **caller-side prerequisite 应该写成机制**：obsidian-scroll-capture "caller 必须 Editing View 起始"是脆的纪律。下次 audit infra 应该 detect view state + auto-correct（如截图 verify 是否含源码 markers）

**测试报告**：`docs/superpowers/test-reports/2026-05-26-audit-via-subagents-v3.md`（local-only，本次 ship 时未写独立文件，本 §6.23 自带完整验证摘要 + commit history）

---

## 7. 代码内 TODO 注释

| 文件:行 | 内容 | 优先级 |
|---------|------|--------|
| `src/core/highlights.ts:1278` | `wrapOrphanListItems` 永远包 `<ul>`，stored `<li>` 来自 `<ol>` 编号丢失 — 修需要在 highlight 存储时记录父 list 类型 | 中 |
| `src/utils/highlighter-overlays.ts:143` | overlay 算法 O(N × rects)，>50 高亮的页面有性能问题 | 低 |
| `src/utils/filters/title.ts:1` | title 过滤器考虑多语言 case 转换 | 低 |
| `src/utils/scys-extractor.ts:preprocessScysEntityHtml` | 只处理了 `<e type="web">`；遇到 `<e type="mention\|image\|topic-ref\|...">` 留原标签 — 实际看到再扩展（加 fixture + 加 case 分支） | 中-低 |
| `src/utils/scys-extractor.ts:extractScysArticleStandalone` | article body 已知 4 种形态（docBlocks / Quill HTML / plain-text+`<e>` / image-only via imageList），未来若发现第 5 种（如 markdown 字符串、XML、JSON-AST 等）需要再加分支 | 取决于实际发现 |
| `src/utils/scys-extractor.ts:preprocessScysEntityHtml` | URL 22255855424524441 的 articleContent 含 `<e type="text_bold" title="URL-encoded" />` 实体（粗体文本样式），当前会原样保留为字符串污染产物。和 `<e type="web">` 是同族机制族但渲染策略不同（→ `<strong>...</strong>`），需要独立 spec | 中 |
| `src/content.ts:~133` + `src/utils/content-extractor.ts:~60` | `ContentResponse` 在两处独立 declare（不是 import）。每加字段都要同时改两处。长远应把 content.ts:~133 改成 `import type { ContentResponse }`，前提 audit 两个 interface 字段集严格一致 | 低 |
| 未来 spec：scys/feishu PDF 附件离线缓存到 vault | 需要扩展 manifest `downloads` 权限 + 用户在扩展设置里配置 vault 附件目录 + chrome.downloads 异步流程，或依赖 obsidian-advanced-uri 社区插件扩协议。本次 §6.17 明确 out of scope | 低（用户问到再开） |
| `scripts/scys-visual-audit.py` | 硬编码 `/tmp/scys-article-dom-dump.json` + 单 vault md 路径；改 CLI 参数 + 多 fixture 批量跑能作为 CI 回归 | 低 |
| 🚧 **新建** `src/utils/_scys-article-write-vault.test.ts` | scys visual-audit 工具链残缺：vault md 生成需要 vitest dump test（mock fetch + writeFileSync 到 vault），当前缺失导致 audit 必须靠阿杜手动点扩展裁剪——违背"不打扰用户"初衷。下次接 scys 相关 spec 时**必须先补这步**。详见 memory `reference_scys_visual_audit.md` §工具链残缺 | 中 |
| `src/utils/zsxq-extractor.ts:parseZsxqInlineText` | 当前覆盖 hashtag/mention/emoji/web/text_bold/text_italic；未来可能遇到 text_color / text_strike / image / topic-ref / mention-link 等新 `<e>` type — 实际看到再扩展，spec 阶段抓 fixture 时主动留意 | 中-低 |
| `src/utils/zsxq-extractor.ts:extractZsxqStructuredContent` | `kind === 'article'`（`wx.zsxq.com/group/{gid}/article/{aid}`）当前 return null，退化到 Defuddle 兜底；专栏文章 URL 提取未实施 — 抓到一个真实 article URL 后再开 plan。注：`kind === 'articles-html'` (host=articles.zsxq.com) 已在 commit `c5efe22` 实施 | 低 |
| `src/utils/zsxq-extractor.ts:fetchZsxqAllComments` | 评论 image 字段（fixture 都不含）若实际遇到，需要走 `resolveZsxqImages` pipeline；当前 `renderCommentBody` 已渲染 `<img>` 占位符，端到端未验证 | 低 |
| `src/utils/zsxq-extractor.ts:fetchZsxqArticleHtml` + `background.ts:fetchZsxqArticleHtml` | 保留为未使用的 background handler（topic 路径已不再 fetch article HTML）；如 §6.14 提到的 `article` URL 提取启动可直接复用 | 极低（保留即可） |
| `src/utils/markdown-post-process.ts:fixFencedCodeBacktickEscapes` | 当前 regex `^(```[A-Za-z0-9_\-]*)\n([\s\S]*?)\n(```)$` 用非贪婪截，遇到嵌套 fence 可能切错（但目前主要 caller defuddle preformattedCode rule 已固定 3-backtick fence，inner 都被 escape，正确识别）。未来 turndown / defuddle 行为改了要重测 | 低 |
| `src/utils/weixin-helpers.ts:extractWeChatPublishedFromDocument` `#publish_time` 解析 | 当前只解析 `(\d{4})年(\d{1,2})月(\d{1,2})日`；若 mp.weixin 推 `2024-04-14` / 国际化日期 / `几小时前` 等其他格式，会失败 → 触发 `<script>` ct fallback（但 ct 已不在 SPA hydration 后 DOM，等于空）。如发现新格式，加 fixture + 加 regex 分支 | 中-低（实际看到 fallback 全空再处理） |
| 未来 spec：spec/audit 阶段必须先走"chrome runtime console 验证一行" | weixin 修复教训（§2.18.F）：vitest happy-dom 模拟不等价于浏览器 runtime；audit fixture 必须基于真浏览器 `document.querySelector('#X').textContent` 实测值构造，而不是 curl 拿到的服务端 HTML。下次新接 SPA 站点 extractor 时**spec 阶段必须先用 console 验证关键数据源位置** | 中 |

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


---

## 2026-05-18 反思：audit 漏掉「wiki 图片加密 + author/published 空」

**症状**：用户裁 `https://my.feishu.cn/wiki/BVM5wat1wizT9ckCHi7c2C1nnne` 后 39/80 张图变成 `data:application/octet-stream;base64,<encrypted>` 渲染为破图；frontmatter `author:` 和 `published:` 全空。

**根因 1（图片）**：
- mainWorld 路径里 `block.imageManager.fetch` 对部分 block 找不到（block 在 `block.snapshot.children` 而不是 `block.children` 数组里，且只看 `block.snapshot.image.token` 一条路径，且 `seen.size > 500` 截断大文档），fallback 走 `copy_out + asynccode` 端点取回**加密字节** + `application/octet-stream` MIME。
- cn 不会解密。
- audit-tool 的 render-pipeline 用 `convertBlocksToHtml` 留 `feishu-image://{token}` 占位，**完全不触发** image fetch，所以 0 broken images in audit output。

**根因 2（author/published）**：
- 旧 `fetchDocumentMeta` 调 `/docx/v1/documents/{id}` endpoint，**这个端点只返 title/document_id/revision_id**，无 owner_id 也无 create_time。
- drive `/v1/metas/batch_query` API 有完整字段（owner_id + latest_modify_time + title），wiki + docx 直链都能用 — 当初选错了 endpoint。
- 真名解析需要 contact:user.base:readonly 权限（用户去飞书后台开通）；未开权限时兜底退到 `创建者 <open_id 后 8 位>`。
- `published` 用 `latest_modify_time`（与飞书 web "X月X日修改" 一致），格式化复用 `src/utils/date-utils.ts` 的共享 `convertDate`（dayjs 本地时区），与 scys/zsxq 走单一路径，不再各自手写 `toISOString().slice(0, 10)`（UTC 差一天的风险）。
- audit-tool 只看 markdown body，**完全不看 frontmatter**。

**audit 盲区性质**：两个层完全不在 audit-tool 视野——image fetch 是浏览器侧、frontmatter 是 Obsidian save 后才有。修复后加了 `--vault-md <path>` flag + `image_mime_invalid` / `frontmatter_field_empty` 两个 bucket，把 vault `.md` 也纳入 audit。

**修复**：
- commit `633afb9`：`fetchFeishuDocMeta` 替换 `fetchDocumentMeta`（走 `/drive/v1/metas/batch_query`，wiki + docx 直链都覆盖）；`resolveFeishuUserName` 走 `/contact/v3/users/{id}`（41050 兜底 → open_id 后 8 位）；`published` 用 `convertDate(new Date(latest_modify_time * 1000))`，与 scys/zsxq 单一路径。
- commit `1553a05`：`resolveFeishuImages` 末尾兜底过滤 octet-stream 条目，broken images 不再以 `data:application/octet-stream` 形式入 markdown。
- commit `8a93e90`：mainWorld block walk 加 3 策略（A direct children / B snapshot.children IDs via `bm.getBlockById` / C `bm.allBlocks` registry）+ 4 条 token 路径覆盖 + 去 500 限制 + `console.warn` debug 输出 missed token。
- commit `7dc4319`：audit-tool `--vault-md` flag + 两个新 bucket，**catches the next image/frontmatter regression**。

**沉淀给未来 audit 的纪律**：
- 任何"OpenAPI 返一份、浏览器 fetch 一份"的场景（image / 嵌入资源）audit 必须能比对最终 markdown 产物。
- 任何"extractor 字段 → 模板 frontmatter"的链路 audit 必须能读 vault md 验证。
- 单一 OpenAPI endpoint 不够时（如 docx/v1/documents 字段稀），看 drive metas 等更通用 endpoint。
- 时间字段格式化走 `convertDate` 单一路径（与 scys/zsxq 已有约定），不手写 `toISOString().slice(0, 10)`。

**未来 BACKLOG**：
- **加密图片解密**：研究 feishu imageManager 内部解密逻辑（拆 feishu web bundle 反推 key derivation）。当前 3 策略改善了 missing-block 的部分，但加密字节仍 unfixable，靠 octet-stream filter 兜成 placeholder。
- **自动化端到端 clip 验证**：playwright + extension loaded + 拦截 `obsidian://` URL，把 audit 整个链路（含 frontmatter + 图片）一键化。当前需用户手动重裁 → 我跑 audit --vault-md 循环。
- **contact:user.base:readonly 权限申请**：用户去飞书开发者后台开 https://open.feishu.cn/app/cli_a9074898cdf8dcba/auth?q=contact:user.base:readonly 后，author 自动从 `创建者 d065f814` 升级为 `创建者 刘智行`。

**2026-05-18 更新 — contact:user.base:readonly 实测限制**：

用户已开通 App `contact:user.base:readonly` 两个身份（应用 + 用户）。实测：
- `/contact/v3/scopes?user_id_type=open_id` 返 code=0、**仅 1 个 user_id**（App 创建者本人）
- 查跨租户 user（如 `my.feishu.cn` 的 doc owner）仍返 41050 "no user authority error"

**根因**：tenant_access_token 走"应用身份"，数据范围 = App 创建时配置的「**可见通讯录范围**」（默认仅含 App 创建者）。doc owner 在别人企业 → 不可能加入 App 可见范围 → 41050 是飞书硬性租户隔离。

**绕开方案（暂不实施）**：用 `user_access_token` 走"用户身份"，数据范围 = "与用户权限范围一致" → 能查用户自己可见的所有人（含跨企业协作者）。但需要 OAuth redirect 流程，与 cn 当前的"tenant token 全自动"架构冲突，UX 改动大。

**结论**：`创建者 d065f814` 兜底是 by design 的最优解，open_id 后 8 位有 hex 唯一性（同一 author 跨文档可识别）。已沉淀到 author 字段格式约定。

---

## 2026-05-18 反思 - II：H4 编号 / DOM author / 自动化重裁

第一轮修复（图片 + 元数据）后，用户最终验收暴露的两个剩余问题，以及修复中暴露的回归风险。

### 1. 飞书 web 标题编号规则 = CSS counter

飞书 web 显示的 "1. 起心动念"、"4.1 …" 不是文档里的字面文本，是 CSS counter：
- **H1**：全局编号（一个 counter 跨整文档累加）
- **H4**：按 H2 分段编号（counter 在每个 H2 边界 reset）
- **H2 / H3 / H5+**：**不**自动编号 — 用户惯例手写 "一、" / "二、" / "2.1.1" 前缀

OpenAPI 返回的 block 文本里没有这些数字，渲染层必须复刻 counter。`convertBlocksToHtml` pre-scan 两遍 blockMap：第一遍按 doc order 给 H1 / H4 分配 `headingNumbers.get(block_id)`；第二遍渲染时把 `N.` 拼到 heading 内文前。

### 2. autoNumberHeadings 必须是 opt-in（防 scys 回归）

`convertBlocksToHtml` 是 feishu + scys **共享**的 util。scys 文档惯例是人工写 "2.1.1 用途…" 标题前缀，无脑加 "N. " 会变 "1. 2.1.1 用途…" 双编号。

修复：option 显式开关。feishu `extractFeishuStructuredContent` 传 `{ autoNumberHeadings: true }`；scys `renderScysChapterContent` 不传 option。

**沉淀给共享 util 的纪律**：往多个调用方共用的工具函数加新行为时，**先看所有 callsite**，不行就显式 opt-in。"对一个有效 → 对所有有效" 是基础设施级错觉。

### 3. DOM scrape 优先于 contact API（"不要展示飞书ID"）

contact API 跨租户必 41050（前节已述），原方案 `创建者 d065f814` 兜底用 open_id 后 8 位。用户明确反馈："**你都知道作者是刘智行了，填进去就可以了，不要展示飞书 ID**" — 飞书 ID 对人类读者就是噪声。

修复：author 解析改为三层优先级：
1. **DOM scrape `.docs-info-avatar-name-text`**（页面 runtime 里裁剪 = 主路径，永远拿真名）
2. contact API（仅 DOM 失败时尝试，跨租户必 fail）
3. **空字符串**（不再用 `创建者 <id>` 兜底，open_id 对人类毫无价值）

`frontmatter_field_empty` audit 桶仍能在两个 API 都失败时报警。

**沉淀**：用户域的中间产物（OpenAPI internal ID）默认**不展示**给人类读者。要么解析成有意义的标签，要么空白。`创建者 d065f814` 是技术债的对症兜底，不是产品。

### 4. 自动化重裁 + audit：chrome.alarms hot-reload + test bridge

用户反馈："插件需要配置很多内容，移除重载会非常麻烦" — 不能让用户每次重装扩展。

`src/background.ts` 用 `chrome.alarms` 周期 fetch `build-marker.txt`，时间戳变化就 `chrome.runtime.reload()` 保留配置。利用这个：

```
build 完 → rsync -a --delete dist/ <main 检出 dist/> → 3s 内扩展自动 reload
```

然后 `content.ts` 暴露的测试桥 `window.postMessage({type: '__obsidianClipperTestExtract__', testId, uploadUrl})` 可被 claude-in-chrome 触发：上传 simulated Obsidian note 到本地 HTTP server（`/tmp/feishu-clip-server`，port 18877），落地到 `/tmp/feishu-clip-uploaded.md`。

完整自动化链：dev build → rsync → 自动 reload → claude-in-chrome 调测试桥 → upload server 收 markdown → audit `--vault-md` 校验。**用户只管最终视觉验收**。

**测试桥局限**：simulated 路径不一定 plumb 真实链路全字段（`commentsMarkdown` 是 bridge 不走 background 的分流字段，需要单独补丁）。bridge 是开发期快速验证工具，**不替代真实裁剪**。最终视觉验收仍需用户在 Obsidian 里看真裁剪产物。

### 5. audit 盲区再补：image_unresolved 桶

第一轮加了 `image_mime_invalid`（catch octet-stream data URL），但**漏掉**了"图片 fetch 完全失败 → markdown 里残留 `feishu-image://TOKEN` placeholder"的 case。这种 placeholder Obsidian 直接渲染破图。

修复：新增 `image_unresolved` 桶扫 `feishu-image://[A-Za-z0-9_-]+`。

**沉淀**：bug 修完后必问 "audit 之前为什么没抓到这个？" — 如果是盲区，必须**补桶**。修一个 bug 不补一个 audit 桶，下次同类回归还会再来一次。本会话 wiki 修复总共补了 3 个桶（image_mime_invalid / image_unresolved / frontmatter_field_empty），覆盖三个原本完全无监控的产物层。
