# cn fork Backlog — 冷启动手册

> **本文档用途**：让一个**完全没上下文的新会话 AI** 也能快速上手继续工作。
> 包含项目背景、开发基础设施、关键认知、踩过的坑、待办 feature。
> 每条 feature 都标了"为什么这么做 / 已知什么不行 / 推荐怎么做"。

**最后更新**：2026-05-16
**最新 commit 基线**：`7eefd56`（bridge popup-path simulation）/ `4d74412`（fix: extractedContent.content HTML leak）/ `ff102cd`（scys docx fixture）

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

**脚本**：`/tmp/recv_server.py`（每次会话临时创建）

**用法**（仅传端口，按请求 `?path=` 落盘）：
```bash
pkill -f recv_server.py 2>/dev/null
nohup python3 /tmp/recv_server.py 17923 > /tmp/recv.log 2>&1 < /dev/null &
disown
```

```bash
# bridge / 任意 client 调用：
curl -X POST "http://127.0.0.1:17923/save?path=/Users/adu/Documents/Obsidian /Life/_cn-test/x.md" -d @body
```

**当前特性（2026-05-16 升级，scys docx 视觉对比迭代时）**：
- **多次接收**（不再 single-shot shutdown，方便迭代连发多次 POST）
- **支持 `?path=<绝对路径>` 请求参数**（按 client 指定落盘；缺省退化到 `/tmp/feishu-out.md`）
- **CORS + Chrome PNA 头**：`Access-Control-Allow-Private-Network: true` —— HTTPS 页面（scys.com 等）的 content-script `fetch` 到 `http://127.0.0.1` 必须有此头，否则被 Chrome 拒绝并报 `TypeError: Failed to fetch`（参见 §2.13）

**为什么需要**：chrome MCP `javascript_tool` 返回值有大小限制（约几 KB），>100KB markdown 走不出来。HTTP POST 突破这个限制。

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
