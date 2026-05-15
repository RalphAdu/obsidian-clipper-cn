# Backlog（cn fork 待办清单）

**最后更新**：2026-05-15
**状态参考点**：commit `7a19a10`（feat: render embedded Feishu sheets as Markdown tables）

本文档汇总 cn fork 当前所有 **未完成 / 已跳过 / 部分实施** 的工作。已完成的 feature 见 `docs/superpowers/specs/` 和 git log。

---

## 1. 待清理的开发基础设施

### 1.1 临时测试文件
- **位置**：`~/Documents/Obsidian /Life/_cn-test/`
- **内容**：`feishu-pdf-test.md`、`feishu-sheet-test.md` — 自动化测试期间写入的样本剪存
- **处理**：用户验证完整功能后手动删除，或 `rm -rf "~/Documents/Obsidian /Life/_cn-test"`

### 1.2 Page-world test bridge
- **位置**：`src/content.ts` 末尾 ~50 行
- **代码**：`window.addEventListener('message', ...)` 监听 `__obsidianClipperTestExtract__`
- **功能**：自动化测试 cn 飞书提取流程的桥接口（限飞书 origin）
- **现状**：保留中，对生产用户无影响（仅在 feishu.cn / larksuite.com 响应）
- **三个处理选项**：
  - **A. 直接删** — 生产代码最干净，未来测试要重新加
  - **B. 保留 + 限制 uploadUrl 必须 127.0.0.1**（推荐）— 攻击者无法外传数据
  - **C. 完整保留** — 攻击面小（XSS 攻击飞书页面才可触发），但有
- **决策**：未拍板

### 1.3 `data-cn-clipper-build` 属性
- **位置**：`src/content.ts:589-591`
- **功能**：content.js 注入时写时间戳到 `<html>` 标签，供 page world JS 验证版本
- **现状**：纯调试用，建议保留（无害且对后续 debug 有用）

---

## 2. 已识别但未实施的 Feature

### 2.1 F1 重做：段内高亮 `<mark>` → Obsidian `==text==`

**原 spec**：`docs/superpowers/specs/2026-05-14-f1-mark-to-equals-design.md`

**已知失败原因**：
- 在 cn HTML 阶段插入字面 `==` text node → defuddle 0.18 把 `==` escape 成 `\==`
- 用 alphanumeric 占位符（如 `HLMARKSTART9F2A`）+ markdown 输出后 string replace → 占位符在 defuddle 转换中**没出现在最终 markdown**（中间环节丢失，原因未深查）
- F1 改动还附带**飞书剪存 regression**（占位符注入元素子节点干扰序列化）

**未来重做思路**：
- 不在 HTML 阶段动 highlight DOM（避免 defuddle 干扰）
- 在 `obsidian-note-creator.ts`（最末 markdown 拼装阶段）做：
  1. 拿到 highlights 数组 + 最终 markdown 字符串
  2. 对每个 text 高亮，在 markdown 中**搜索高亮原文** → 替换为 `==原文==`
  3. 注意：原文可能含正则元字符要 escape；处理多次出现的相同文字要按 startOffset 选择

**估时**：3-4 hr（含 chrome MCP 自动测试）

**状态**：未启动

---

### 2.2 F2：普通页面选中即弹悬浮工具栏

**已知约束**：
- 上游 Highlighter 2.0 设计为"先激活高亮模式（`toggleHighlighterMenu(true)`）才会监听 selection"
- 激活后有副作用：禁用所有 `<a>` 点击、添加 body class `obsidian-highlighter-active`

**三个备选方案**：
- **A. setting `selectionToolbarDefault`，默认 false，开启后 init 时激活** — 简单但代价是链接被禁，**用户已 reject**
- **B. 修改 `toggleHighlighterMenu` 加 `keepLinksActive` 参数** — 改核心函数，风险中
- **C. 复用 reader 模式的"浮动按钮"机制** — selection 后弹小按钮，点击进入高亮 — **最优 UX，未实施**

**估时**：方案 C 约 2-3 hr

**状态**：未启动（用户跳过）

---

### 2.3 F3：vault 配置 UX 改善

**起因**：Phase 10 手测发现 user 扩展 `vaults: []`，popup 没显示 vault 下拉。代码逻辑正确——chrome 扩展无法自动发现 Obsidian app 内的 vault 列表（macOS sandbox 限制）。

**改进方向**：
- Settings UI 加更明显的 "vault 列表必须手动添加" 说明 + 引导
- 加 "测试 vault 名是否存在" 按钮（用 `obsidian://open?vault=X` 试探）
- README 提示

**估时**：1-2 hr

**状态**：未启动

---

### 2.4 F4：Highlights Viewer 加 "在原页面打开 + 滚动到高亮"

**当前**（上游设计）：
- `src/core/highlights.ts:1210` `createHighlightItem` 每条高亮只挂 copy / delete 按钮
- 页面标题点击是 viewer 内部导航，不开新 tab
- 标题旁 reader 图标用扩展自己的 reader.html 打开（不定位到具体高亮）

**改进**：
- 给每个 highlight item 加 "在源页面打开" 按钮
- 点击 → `browser.tabs.create({ url: pageUrl + '#highlight-' + id })`
- content script 监听 hash → 滚动到对应高亮 + 闪烁定位

**估时**：2-3 hr

**状态**：未启动

---

### 2.5 飞书 SHEET 表格 P1：保留 cell 粗体 / 颜色

**当前 P0**：表格内容文本完整渲染（92 行 / 12 表已验证）

**P1 阻塞**：
- 飞书公开 OpenAPI `/style`、`/v3/cells` 端点均 404（不暴露 cell style）
- 唯一路径：cookie-based MainWorld 拦截飞书 web client 的 internal sheet API
- 需要：在飞书 sheet web app reverse-engineer style API 路径（参考 cn 现有 `fetchFeishuImagesViaMainWorld` 模式）
- 风险：飞书 internal API 不稳定，随时可能改

**估时**：探索 1-3 hr（不确定上限）

**状态**：P0 完成，P1 deferred

---

### 2.6 飞书附件下载（飞书 PDF 完整二进制嵌入 / 单独保存到 vault attachments）

**当前**：飞书 PDF 附件用 `wiki_url#block_id` 链接跳到飞书原文档（B 方案）

**用户可能想要的进阶**：
- D 方案变体：cn 触发 chrome.downloads 下载到 `~/Downloads/cn-clipper-attachments/{vault}/`，用户做 symlink 让 vault 看到文件
- 完美方案 N：Native messaging host 写到任意路径（含 vault attachments）
- 方案 4：写 Obsidian companion plugin 接收 cn 发的 base64

**估时**：方案 A+symlink ~2 hr / 方案 N ~6-8 hr / Obsidian plugin ~8-12 hr

**状态**：B 方案已上线，进阶 D/N 未启动（用户决定先不做）

---

## 3. 代码内已标注的 TODO

| 文件:行 | 内容 | 优先级 |
|---------|------|--------|
| `src/core/highlights.ts:1278` | `wrapOrphanListItems` 永远包 `<ul>`，ordered list `<ol>` 编号丢失 | 中 |
| `src/utils/highlighter-overlays.ts:143` | 高亮 overlay 算法 O(N × rects)，>50 高亮的页面性能问题 | 低 |
| `src/utils/filters/title.ts:1` | title 过滤器考虑多语言 case | 低 |

---

## 4. 操作 / 工作流类待办

### 4.1 推送远端
- main 当前领先 `origin/main` 多个 commit（merge + 7 个 feature/fix commits + spec/plan docs）
- 用户决定**不 push**（保留本地控制）
- 想 push 时：`git push origin main`

### 4.2 测试基线 3 个 known failures
- `template-integration.test.ts > edge-cases`
- `template-integration.test.ts > minimal`
- `template-integration.test.ts > youtube`
- 原因：jsdom 序列化把内容包 `<body>` + 时区写死 `-08:00`（本机是 `+08:00`）
- 不是 merge 引入，是 cn 主线既存
- 处理建议：在 vitest.config.ts 设 `TZ=America/Los_Angeles` 修 youtube；其他 2 个更新 fixture

### 4.3 文档更新
- README.md / README_EN.md 飞书章节补充 SHEET 表格支持说明
- 添加 `docs/superpowers/BACKLOG.md`（本文件）入口提示

---

## 5. 跨仓库（obsidian-clipper-cn ↔ obsidian-clipper 上游）

### 5.1 定期合上游
- 当前合到 `776d083`（1.5.1）
- 建议每 N 周拉一次上游，避免再次累积 24 个 commit
- 流程：`git fetch upstream && git merge upstream/main`，按本次 spec/plan 经验解 reader.ts 等冲突

### 5.2 cn 增强上游化（候选 PR）
- `src/utils/logger.ts` — 已 merge 时与上游差异调和过
- `src/utils/string-utils.ts` — 可能可贡献回上游
- 飞书 / Bilibili / WeChat 提取器 — 上游维护者明确说放到 Defuddle，cn fork 独立维护

---

## 6. 优先级建议（如要继续工作）

1. **删测试文件 + 决策 bridge 处理**（5 min）
2. **F4 Highlights Viewer 跳源**（2-3 hr，独立模块，风险低）
3. **F3 vault UX 改善**（1-2 hr，纯 UI）
4. **F2 方案 C 浮动按钮**（2-3 hr，独立 UI 组件）
5. **F1 重做 markdown 后处理路线**（3-4 hr，需自动化测试谨慎）
6. **飞书 SHEET P1 bold**（探索性，1-3 hr 不确定）
7. **飞书附件本地保存**（中-高复杂度）

---

## 7. 已完成清单（参考）

详见 git log。本次合并 + feature 工作的代表性 commit：
- `b4d... f947779 fix: Feishu file link uses parent doc URL + block_id anchor`
- `9f4776c fix: render Feishu VIEW container so embedded FILE attachments emit`
- `a04bc32 feat: auto-reload extension on rebuild via build-marker polling`
- `7a19a10 feat: render embedded Feishu sheets as Markdown tables`
- 上游 merge: `9d0e0be chore: merge upstream obsidianmd/obsidian-clipper main (1.5.1)`
