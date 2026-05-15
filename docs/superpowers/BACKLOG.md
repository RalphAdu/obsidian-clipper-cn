# cn fork Backlog — 冷启动手册

> **本文档用途**：让一个**完全没上下文的新会话 AI** 也能快速上手继续工作。
> 包含项目背景、开发基础设施、关键认知、踩过的坑、待办 feature。
> 每条 feature 都标了"为什么这么做 / 已知什么不行 / 推荐怎么做"。

**最后更新**：2026-05-15
**最新 commit 基线**：`02251b2`（docs: add Backlog）/ `7a19a10`（feat: render embedded Feishu sheets as Markdown tables）

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

**用法**：
```bash
OUT="/Users/adu/Documents/Obsidian /Life/_cn-test/output.md"  # 注意 "Obsidian " 后含空格
lsof -i:17923 -t 2>/dev/null | xargs -r kill -9 2>/dev/null
nohup python3 /tmp/recv_server.py "$OUT" 17923 > /tmp/recv.log 2>&1 < /dev/null &
disown
```

**特性**：单次 POST 后 server 自动 shutdown（避免端口占用），用 `nohup` + `disown` 防止 Claude Code background mode 杀进程。

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

**screencapture 限制**：macOS 屏幕录制权限阻止 `screencapture -x`（Terminal 权限问题）。视觉验证需用户手动看。

### 1.6 飞书 OpenAPI 凭证

**位置**：`/Users/adu/Workspace/github/obsidian-clipper/feishu.md`

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
- **小心 destructive 操作** — `git reset --hard`、`rm -rf` 等必须明确授权
- **不擅自 commit** — 必须用户明确说"commit"或者推进流程的语境（如方案 brainstorming 走到尾声）
- **不擅自 push** — 用户多次明示"不 push"
- **完整的自动化测试** — 用户对 chrome MCP + bridge + HTTP receiver 三件套熟悉，验证过来回（端到端比手测可信）
- **brainstorming 流程** — 大改动用 `superpowers:brainstorming` 走 spec → plan → 实施 → 自动测试
- **不擅自 amend 已有 commit** — 总是新 commit

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
| `src/utils/content-extractor.ts` | popup 端：拿到 content 后用 defuddle 转 markdown |
| `src/utils/reader.ts` | Reader Mode 逻辑（cn 在其中加 Bilibili 播放器集成，**不再 inline base64** for PDF） |

### 飞书提取关键函数（`src/utils/feishu-extractor.ts`）

| 函数 | 行号附近 | 用途 |
|------|----------|------|
| `extractFeishuStructuredContent` | 880+ | 入口：解析 URL → fetch blocks → 渲染 HTML → resolve images/sheets/files |
| `convertBlocksToHtml` | 606 | blocks 转 HTML（PAGE 起递归） |
| `renderChildren` | 622 | 递归子块，特别处理 BULLET/ORDERED/TODO 合并 list |
| `renderBlock` | 688 | 单块按 type switch 渲染 |
| `fetchFeishuApi` | 154 | 消息桥：调 background `fetchFeishuApi` |
| `resolveFeishuImages` | 443 | 图片 token → data: URL（含 cookie-based MainWorld fallback） |
| `resolveFeishuSheets` | (P0 已加) | sheet token → HTML 表格（并发 fetch） |
| `resolveFeishuFiles` | 418 | file token → `wiki_url#block_id` 跳转链接（B 方案） |

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
**含**：`feishu-pdf-test.md`、`feishu-sheet-test.md`（自动化测试输出）

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

## 7. 代码内 TODO 注释

| 文件:行 | 内容 | 优先级 |
|---------|------|--------|
| `src/core/highlights.ts:1278` | `wrapOrphanListItems` 永远包 `<ul>`，stored `<li>` 来自 `<ol>` 编号丢失 — 修需要在 highlight 存储时记录父 list 类型 | 中 |
| `src/utils/highlighter-overlays.ts:143` | overlay 算法 O(N × rects)，>50 高亮的页面有性能问题 | 低 |
| `src/utils/filters/title.ts:1` | title 过滤器考虑多语言 case 转换 | 低 |

---

## 8. 操作 / 工作流类待办

### 8.1 push 远端

- main 当前领先 `origin/main` 多个 commit
- 用户**明示不 push**（保留本地控制）
- 想 push 时：`git push origin main`
- 不可 `git push --force` 到 main

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
5. **如要自动化测试**：参考第 1 节"开发基础设施速查"重启 receiver + 用 page-world bridge
6. **如要拉新上游 commit**：参考第 9 节
