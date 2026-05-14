# 设计文档：合并 obsidianmd/obsidian-clipper 最新主线到 obsidian-clipper-cn

**日期**：2026-05-14
**目标分支**：`origin/main`（nextcaicai/obsidian-clipper-cn）
**合并来源**：`upstream/main`（obsidianmd/obsidian-clipper）
**当前状态**：cn 自分叉点 `d5161c02` 后从未合并过上游

---

## 1. 目标与范围

把上游主线自 fork 点以来的 24 个 commit 一次性合并到 cn 主线，保留 cn 已有的飞书 / Bilibili / 微信增强，最终产出一个：

- 工作区干净
- `npm test` 全绿
- 三浏览器 `npm run build` 通过
- 飞书、Bilibili、WeChat 三类剪存路径手测通过
- 上游 Highlights 2.0 / Highlights Viewer / Reader 重构功能可用

的合并提交，并以此为新的同步基线。

**不在本次范围内**：
- 不调整 cn 的扩展 ID / 名称 / 图标资产
- 不删除 cn 自行实现的 `logger.ts`、`string-utils.ts`、`clip-utils.ts`、`iframe-resize.ts`
- 不接入未来的上游版本（本次只合到 `776d083`）

---

## 2. 事实清单

| 维度 | 值 |
|------|------|
| Fork 分叉点 | `d5161c02` |
| 上游 HEAD | `776d083`（版本 1.5.1） |
| cn HEAD | `2169327`（版本 1.4.4） |
| 上游自分叉新增 commit | 24 |
| cn 自分叉新增 commit | 28 |
| 文件差异（cn ↔ 上游 HEAD） | 134 个文件，+6203 / −9210 |
| 模拟合并冲突文件数 | 11 |

---

## 3. 上游新增功能（必须吸收）

按重要性排序：

### A. Highlighter 2.0（PR #797, commit `a9d80fb`）
- 高亮器重写：选区控件、悬浮工具栏、SVG 位置修复、表格内高亮、移动端体验
- 各 `_locales/*/messages.json` 新增 highlighter 翻译键

### B. Highlights Viewer（PR #778, commit `e535a5b` + 后续 4 个优化）
- 全新独立高亮浏览页：`src/core/highlights.ts` + `src/highlights.html` + `src/styles/highlights.scss`
- 搜索（`cb6b27b`）、平滑刷新（`9215cd4`）、UI 字体评论计数（`decb281`）

### C. Reader 重构
- `src/core/reader-view.ts` + `src/reader.html` 独立化
- 样式拆到 `src/styles/reader/` 子目录（13 个 scss）
- 滚动观察器修复（`84c1566`）、滚动锁定修复（`42cb239`）

### D. 杂项修复（必拿）
- `12ab25a` Safari 嵌入模式剪贴板修复
- `f65c336` popup 选择 vault 修复
- `c14fae8` Advanced template section 修复（issue #779）
- `83bf59a` 移除 innerHTML（XSS 加固）
- `66e3d02` debug script 修复（在 background 中）
- `58c438e` debug → logger 模块迁移
- `3254738` 图片高亮改进

---

## 4. cn 必须保留的增强

| 路径 | 用途 | 保留策略 |
|------|------|----------|
| `src/utils/feishu-extractor.ts` | 飞书文档 API 提取 | 文件独立，merge 自动保留 |
| `src/utils/bilibili-extractor.ts` + `.test.ts` | Bilibili 视频提取 | 文件独立 |
| `src/utils/bilibili-playback-tracker.ts` + `.test.ts` | Bilibili 播放进度 | 文件独立 |
| `src/utils/logger.ts` | cn 自实现的日志层 | **保留 cn 版本**；上游迁移到 `debug.ts → 新 logger` 的部分需对齐 |
| `src/utils/string-utils.ts` + `.test.ts` | cn 工具函数 | 文件独立 |
| `README.md` / `README_EN.md` | 中文 fork 说明 | **保留 cn 版本** |
| `src/utils/feishu-*` 在 `background.ts` 的逻辑 | 飞书 image 解析（chrome.scripting）、设置读取 | 冲突解决时手动保留 |
| `src/utils/bilibili-*` 在 `background.ts` 的逻辑 | Bilibili Referer / declarativeNetRequest | 冲突解决时手动保留 |
| WeChat 文章图片保留（commit `cf0e972`） | 微信剪存改进 | 已在 cn 中，merge 后验证未被覆盖 |
| 扩展 ID / 名称（manifest × 3） | 避免与官方扩展冲突 | 手动保留 |
| AppIcon 资产（`AppIcon.icon/`） | cn 的 logo | 手动保留，拒绝上游 `AppIcon.appiconset/` 覆盖（或并存） |

---

## 5. 11 个冲突文件的处理策略

按从易到难列：

### 5.1 低难度（机械合并）

#### `README.md` / `README_EN.md`
- **决策**：保留 cn 版本（中文 fork 自我介绍），不接收上游 README 改动
- **操作**：冲突后选 `--theirs` 反面 / 手动 `git checkout --ours -- README.md README_EN.md`

#### `package.json`
- **保留 cn**：`name`、扩展 ID、版本号（向后冲突时不被上游 `1.5.1` 覆盖；本次合并后由 cn 自行 bump 到 `1.5.x`）
- **接受上游**：`dependencies` / `devDependencies` 新增项、`scripts` 改动
- **操作**：手工分段合，逐字段对照

#### `package-lock.json`
- **决策**：merge 完成后直接删除并 `npm install` 重生成，不手工调和
- **操作**：合并冲突标记后跑 `rm package-lock.json && npm install`

#### `src/manifest.chrome.json` / `manifest.firefox.json` / `manifest.safari.json`
- **保留 cn**：扩展 ID（`d284a12` 避免与官方碰撞）、扩展名称
- **接受上游**：`permissions` 新增项、`web_accessible_resources` 新增项、`content_scripts` 新规则、新增的 `highlights.html` / `reader.html` 入口
- **操作**：逐字段对齐，注意上游可能新增 `declarativeNetRequestWithHostAccess` 之类权限

### 5.2 中难度

#### `src/background.ts`（上游 +753 行，cn 也大改）
- **保留 cn**：
  - `chrome.scripting.executeScript`（飞书图片在页面 runtime 解析，commit `34d36c0`）
  - `browser.webRequest.onBeforeSendHeaders`（Bilibili Referer）
  - `chrome.declarativeNetRequest.updateSessionRules`（Bilibili 动态规则）
  - 读取 `feishu_settings` 的逻辑
- **接受上游**：
  - 新增的消息路由（`toggleHighlights` 类）
  - 调试日志迁移到 `logger.ts`
  - `66e3d02` debug 修复
  - 任何新增的 `tabs.onUpdated` 处理
- **操作**：以上游版本为基线，把 cn 的飞书 / Bilibili / 微信片段以函数形式重新插入

#### `src/content.ts`（上游 +280 行）
- **保留 cn**：Bilibili 内容监听入口、飞书 wiki 检测
- **接受上游**：highlights mode 切换、reader-view 集成、`83bf59a` innerHTML 移除
- **操作**：同 background，先取上游骨架，再贴 cn 增强

#### `src/utils/debug.ts`
- **决策**：上游已将日志迁移到独立的 `logger.ts`（commit `58c438e`），与 cn 自行实现的 `src/utils/logger.ts` 重名
- **策略**：以 cn 现有的 `logger.ts` 为准，把上游 `debug.ts` 里的引用全部改为引用 cn 的 `logger.ts`；如签名不一致则适配
- **操作**：先 `git checkout --ours -- src/utils/logger.ts`，然后把 `debug.ts` 的内容并入或删除，更新所有 import

### 5.3 高难度

#### `src/utils/reader.ts`（cn vs 上游差 1151 行）
- **本质冲突**：cn 在旧版 reader.ts 中深度加了 Bilibili 播放器集成（auto-scroll、字幕高亮、时间戳跳转、暂停时停止滚动），上游做了 reader 架构重构，将 reader 视图独立到 `src/core/reader-view.ts`
- **策略**：
  1. 接受上游的新架构（保留 `reader.ts` 的纯逻辑层）
  2. 把 cn 的 Bilibili 集成代码从旧 `reader.ts` 提取到 `src/utils/bilibili-reader-integration.ts`（新建）
  3. 在上游新的 `src/core/reader-view.ts` 中调用 Bilibili 集成钩子
- **验收点**：
  - Bilibili 阅读模式下播放时字幕自动滚动 ✓
  - 暂停后停止滚动（commit `5c5a302`）✓
  - 点击时间戳跳转 ✓
  - Safari 下播放器和字幕正常（commit `2169327` `f1701db`）✓
- **预估工作量**：合并总耗时的 50%

#### `src/reader.scss`（上游 +1514 行 / cn 大改）
- **本质冲突**：上游把 reader 样式拆到了 `src/styles/reader/*.scss`，cn 在单一 `reader.scss` 里加了 Bilibili 播放器样式、字幕样式
- **策略**：
  1. 接受上游拆分后的样式结构（`src/styles/reader/` 子目录全部纳入）
  2. cn 的 Bilibili 相关样式抽到新文件 `src/styles/reader/_bilibili.scss`
  3. 在 `reader.scss` 主入口加 `@import 'reader/bilibili';`
- **验收点**：阅读模式下 Bilibili 播放器布局、字幕样式、时间戳样式正常

---

## 6. 自动合入的新文件（无冲突但需验收）

merge 会自动引入以下上游新文件：

- `src/core/highlights.ts`、`src/highlights.html` —— 新高亮查看页
- `src/core/reader-view.ts`、`src/reader.html` —— 新阅读视图入口
- `src/styles/highlights.scss`、`src/styles/_reader-content.scss`、`src/styles/_sidebar.scss`、`src/styles/reader-view.scss`
- `src/styles/reader/*.scss` —— 13 个 reader 子样式
- `xcode/.../AppIcon.appiconset/*` —— 上游新图标资产

**处理**：
- 前 4 类全部接受
- xcode 图标：cn 已有 `AppIcon.icon/`，上游引入的是另一种格式 `AppIcon.appiconset/`。**保留 cn 的 `AppIcon.icon/`，删除上游引入的 `AppIcon.appiconset/`**，并检查 pbxproj 引用一致。

---

## 7. 测试计划

### 7.1 静态验证（必跑）
```bash
npm install              # 重建 lockfile
npm test                 # vitest run（cn 的全部测试 + 上游新加的测试都必须绿）
npm run build:chrome     # 构建 Chrome 包
npm run build:firefox    # 构建 Firefox 包
npm run build:safari     # 构建 Safari 包
```

### 7.2 功能手测（必跑）

加载 `dist/` 到 Chrome，逐项验证：

**cn 增强不能回归：**
- [ ] 飞书 docx 文档剪存：内容完整、图片以 base64 嵌入
- [ ] 飞书 wiki 文档剪存：同上
- [ ] Bilibili 视频剪存：简介、章节、字幕、时间戳跳转、自动滚动、暂停停止滚动
- [ ] 微信公众号文章剪存：图片保留

**上游新功能要可用：**
- [ ] Highlighter 2.0：选区高亮、悬浮工具栏、表格内高亮、移动端友好
- [ ] Highlights Viewer 页：能从扩展菜单进入、搜索、删除
- [ ] Reader 阅读模式：滚动锁定、滚动观察器、reader-view 入口

**回归验证：**
- [ ] 普通网页剪存（Wikipedia / Medium / 任意博客）正常
- [ ] 模板渲染、变量解析、过滤器全套正常
- [ ] 设置页所有 section 可访问（issue #779 修复点）
- [ ] popup 中选择 vault 正常（commit `f65c336`）

---

## 8. 风险与回滚

### 风险点
1. **reader.ts 解耦失败**：cn 的 Bilibili 集成与旧 reader.ts 紧耦合，迁移到上游新架构可能引发功能丢失 → 在合并前先在分支上做一次"探针提交"测试可行性
2. **logger.ts 签名不兼容**：cn 自实现 vs 上游 `debug.ts → logger` 的 API 可能不一致 → 用 cn 版本，统一改 import
3. **manifest 权限漏合**：上游 Highlighter 2.0 可能加了新 host permission → 测试时若高亮工具不显示，对照 `manifest.json` 检查
4. **iOS / Safari xcode 工程**：cn 的 `AppIcon.icon/` 与上游 `AppIcon.appiconset/` 并存可能导致 Xcode 构建报错 → 必要时清理 pbxproj 引用

### 回滚策略
- 整个合并在新分支 `merge-upstream-2026-05-14` 上进行，main 不变
- 若不可挽救：`git checkout main && git branch -D merge-upstream-2026-05-14`
- 单文件回退：`git checkout HEAD~ -- <path>`（merge 提交前）
- 已 push 但发现问题：在分支上继续修，不直接 force-push main

---

## 9. 执行检查表（高层）

writing-plans 会把这些拆成可执行的 plan，此处仅列里程碑：

1. 在 cn 仓库创建 `merge-upstream-2026-05-14` 分支
2. 执行 `git merge upstream/main`（产生冲突）
3. 按 §5 顺序解决冲突（低 → 中 → 高）
4. `npm install` 重建 lockfile
5. 跑 §7.1 静态验证
6. 提交合并 commit
7. 跑 §7.2 手测清单
8. 全绿后 merge 到 main（或开 PR 后再合）
9. bump 版本号到 `1.5.0-cn` 或类似

---

## 10. 后续（不在本次范围）

- 建立"每 N 周从上游拉新"的同步节奏，避免再次累积 24 个 commit
- 考虑把飞书 / Bilibili 提取器作为 PR 提到上游（虽然上游维护者建议放到 Defuddle，但小修复仍可上游化）
- 把 cn 的 logger.ts 与 string-utils.ts 上游化（候选 PR）
