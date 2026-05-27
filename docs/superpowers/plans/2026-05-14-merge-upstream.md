# 合并上游 obsidian-clipper 最新主线到 cn —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `upstream/main`（`776d083`，1.5.1）合并到 cn 仓库 `origin/main`（`2169327`，1.4.4），保留 cn 的飞书/Bilibili/WeChat 增强，吸收上游 Highlighter 2.0 / Highlights Viewer / Reader 重构及杂项修复。

**Architecture:** 在新分支 `merge-upstream-2026-05-14` 上做 `git merge upstream/main`，逐文件解决 11 个冲突，把 cn 在 `reader.ts` 中深度集成的 Bilibili 代码抽到独立模块（`bilibili-reader-integration.ts`），样式同步抽到 `_bilibili.scss`。最后跑全套测试 + 三浏览器构建 + 手测清单后合回 main。

**Tech Stack:** Git merge、TypeScript、Vitest、Webpack、SCSS、webextension-polyfill、Chrome/Firefox/Safari Manifest V3。

**Spec:** `docs/superpowers/specs/2026-05-14-merge-upstream-design.md`

---

## File Structure

**新建：**
- `src/utils/bilibili-reader-integration.ts` — cn 在阅读模式中对 Bilibili 播放器/字幕/时间戳的集成钩子，从旧 `reader.ts` 抽取
- `src/styles/reader/_bilibili.scss` — Bilibili 在阅读模式中的样式片段

**修改（冲突文件）：**
- `README.md` / `README_EN.md` — 保留 cn 版本
- `package.json`、`package-lock.json` — 字段级合并 + lockfile 重生
- `src/manifest.chrome.json` / `manifest.firefox.json` / `manifest.safari.json` — 保留 cn 扩展 ID/名称，吸收上游新权限和入口
- `src/background.ts` — 上游骨架 + cn 飞书/Bilibili/微信片段
- `src/content.ts` — 上游骨架 + cn Bilibili/飞书入口
- `src/utils/debug.ts` — 上游迁移到 logger，cn 已有 `logger.ts`，需统一引用
- `src/utils/reader.ts` — 接受上游重构后的逻辑层，cn 增强迁出到新模块
- `src/reader.scss` — 接受上游样式拆分，cn 增强迁到子样式表

**接收（上游新文件，无冲突）：**
- `src/core/highlights.ts`、`src/highlights.html`、`src/styles/highlights.scss`（Highlights Viewer）
- `src/core/reader-view.ts`、`src/reader.html`、`src/styles/_reader-content.scss`、`src/styles/_sidebar.scss`、`src/styles/reader-view.scss`（Reader 重构入口）
- `src/styles/reader/*.scss`（13 个 reader 子样式表）
- `src/utils/logger.ts`（上游新增的 logger 模块 —— 与 cn 同名，按 Task 4 合并）
- 上游新增的 `_locales/*/messages.json` 翻译键
- 各浏览器 manifest 中新引用的资源

**删除：**
- `src/utils/debug.ts`（上游已迁出到 logger）
- 上游引入的 `xcode/.../AppIcon.appiconset/`（与 cn 的 `AppIcon.icon/` 重复）

**保留不变（cn 独有）：**
- `src/utils/feishu-extractor.ts`
- `src/utils/bilibili-extractor.ts` + `.test.ts`
- `src/utils/bilibili-playback-tracker.ts` + `.test.ts`
- `src/utils/string-utils.ts` + `.test.ts`
- `src/utils/clip-utils.ts`、`src/utils/iframe-resize.ts`
- `xcode/Obsidian Web Clipper/Shared (App)/AppIcon.icon/`

---

## Task 0：准备分支和基线快照

**Files:**
- 无文件改动

- [ ] **Step 0.1：确认工作区干净**

Run（在 `obsidian-clipper-cn/` 目录）：
```bash
git status --short
```
Expected：输出为空或只有 `?? docs/superpowers/...`（设计/计划文档未跟踪）。如果还有别的改动，先 stash 或 commit。

- [ ] **Step 0.2：确认上游已 fetch 到最新**

```bash
git fetch upstream
git rev-parse upstream/main
```
Expected：输出 `776d083ef8fcae35bcf44015e77b86a47e7a61dc`（设计时锁定的上游 HEAD）。如果不同，与设计文档对齐后再继续。

- [ ] **Step 0.3：跑一次基线测试，建立比较基准**

```bash
npm test 2>&1 | tail -20
```
Expected：所有测试通过。记下测试总数（merge 后预期 ≥ 这个数 + 上游新增）。

- [ ] **Step 0.4：跑一次基线构建，确认当前能构建**

```bash
npm run build:chrome 2>&1 | tail -5
```
Expected：构建成功（`dist/` 生成）。

- [ ] **Step 0.5：创建合并分支**

```bash
git checkout -b merge-upstream-2026-05-14
git status
```
Expected：当前在新分支上，工作区干净。

- [ ] **Step 0.6：Commit（保存基线点，便于回退）**

无文件需要 commit，跳过此 step。`main` 分支即为回退点。

---

## Task 1：启动 merge，列出冲突

**Files:**
- 临时进入 merge 状态，全工作区受影响

- [ ] **Step 1.1：执行 merge（必然出现冲突）**

```bash
git merge upstream/main
```
Expected：输出多行 `CONFLICT (content)` 和 `Auto-merging`，最后 `Automatic merge failed; fix conflicts and then commit the result.`

- [ ] **Step 1.2：列出冲突文件，与设计文档对照**

```bash
git diff --name-only --diff-filter=U
```
Expected 输出（11 个文件）：
```
README.md
package-lock.json
package.json
src/background.ts
src/content.ts
src/manifest.chrome.json
src/manifest.firefox.json
src/manifest.safari.json
src/reader.scss
src/utils/debug.ts
src/utils/reader.ts
```
如果实际清单与此不同，停下来对齐设计文档（可能上游又前进了）。

- [ ] **Step 1.3：粗看自动合入的新文件（无冲突但要验收）**

```bash
git diff --name-only --diff-filter=A HEAD
```
Expected：列出 `src/core/highlights.ts`、`src/core/reader-view.ts`、`src/highlights.html`、`src/reader.html`、`src/styles/reader/*.scss`、`src/utils/logger.ts`、`src/utils/string-utils.test.ts` 等。

- [ ] **Step 1.4：不要 commit，开始下一个 task**

此时 merge 进行中，`.git/MERGE_HEAD` 存在。直接进入 Task 2。

---

## Task 2：解决 README 冲突（保留 cn 版本）

**Files:**
- Modify: `README.md`
- Modify: `README_EN.md`（如果有冲突）

- [ ] **Step 2.1：检查 README.md 是否冲突**

```bash
git diff --name-only --diff-filter=U | grep README
```
Expected：`README.md`（如果 `README_EN.md` 也在列表中则一并处理）。

- [ ] **Step 2.2：保留 cn 版本，丢弃上游改动**

```bash
git checkout --ours -- README.md
git diff --name-only --diff-filter=U | grep README || echo "README clean"
```
（如果 `README_EN.md` 也冲突）：
```bash
git checkout --ours -- README_EN.md
```
Expected：`README clean`，README 不再出现在冲突清单中。

- [ ] **Step 2.3：标记为已解决**

```bash
git add README.md README_EN.md 2>/dev/null || git add README.md
```

- [ ] **Step 2.4：人工抽查 README 顶部**

```bash
head -10 README.md
```
Expected：第一行是 `# Obsidian Web Clipper（中文内容增强版）`。

---

## Task 3：解决 manifest × 3 冲突（保留扩展 ID/名称，吸收上游新权限）

**Files:**
- Modify: `src/manifest.chrome.json`
- Modify: `src/manifest.firefox.json`
- Modify: `src/manifest.safari.json`

- [ ] **Step 3.1：查看 chrome manifest 冲突，对照上游与 cn 差异**

```bash
git diff upstream/main HEAD -- src/manifest.chrome.json | head -80
```
观察：扩展 `name`、`id`、`key`、`version` 等标识性字段保持 cn 的；`permissions`、`host_permissions`、`web_accessible_resources`、`content_scripts`、`action.default_popup`、新 `*.html` 入口接收上游。

- [ ] **Step 3.2：编辑 chrome manifest**

打开 `src/manifest.chrome.json`，逐 `<<<<<<< / ======= / >>>>>>>` 标记：
- **保留 cn**：`name`、`description`（如果是中文版本）、`key`、扩展 ID 相关字段（commit `d284a12`）
- **接受上游**：新增的 `permissions`（如 `declarativeNetRequestWithHostAccess`、`scripting`、`activeTab` 等）、`web_accessible_resources`、`content_scripts` 匹配规则、`background.service_worker` 调整、上游新增的 `highlights.html` / `reader.html` 入口配置
- **合并**：`commands` 区域如果两边都有改动，逐键合并

- [ ] **Step 3.3：JSON 语法校验 chrome manifest**

```bash
node -e "JSON.parse(require('fs').readFileSync('src/manifest.chrome.json','utf8')); console.log('OK')"
```
Expected：`OK`。

- [ ] **Step 3.4：同样处理 firefox manifest**

打开 `src/manifest.firefox.json`，应用与 Step 3.2 相同的规则。注意 firefox 特有的 `browser_specific_settings.gecko.id` 也属于 cn 自定义，必须保留。

```bash
node -e "JSON.parse(require('fs').readFileSync('src/manifest.firefox.json','utf8')); console.log('OK')"
```

- [ ] **Step 3.5：同样处理 safari manifest**

打开 `src/manifest.safari.json`，应用同样规则。Safari 在 `declarativeNetRequest` 上行为与 Chrome 不同（Bilibili Referer 走 native video，commit `9056cac` 之后用 `webRequest`），保持 cn 现有取舍。

```bash
node -e "JSON.parse(require('fs').readFileSync('src/manifest.safari.json','utf8')); console.log('OK')"
```

- [ ] **Step 3.6：检查没有遗漏的冲突标记**

```bash
grep -n "^<<<<<<<\|^=======\|^>>>>>>>" src/manifest.chrome.json src/manifest.firefox.json src/manifest.safari.json
```
Expected：无输出。

- [ ] **Step 3.7：标记为已解决**

```bash
git add src/manifest.chrome.json src/manifest.firefox.json src/manifest.safari.json
```

---

## Task 4：解决 package.json + package-lock.json

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`（直接重生）

- [ ] **Step 4.1：检查 package.json 冲突区域**

```bash
git diff package.json | head -60
```

- [ ] **Step 4.2：编辑 package.json**

逐冲突标记处理：
- **保留 cn**：`name`（cn 自命名）、`description`（如有）、`version`（先保 cn 的 `1.4.4`，最后一个 task bump）、`repository.url`、`bugs.url`、`homepage` 中 cn 自己的字段
- **接受上游**：`scripts` 新增条目（如新 dev/build 脚本）、`dependencies` 和 `devDependencies` 中的新包和版本升级、`engines` 字段
- **合并**：如果某依赖两边都改了版本，取更高的

- [ ] **Step 4.3：JSON 语法校验 package.json**

```bash
node -e "JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log('OK')"
```
Expected：`OK`。

- [ ] **Step 4.4：删除 package-lock.json 并重生**

```bash
rm package-lock.json
npm install 2>&1 | tail -10
```
Expected：成功生成新 lockfile，`up to date in Xs` 或新增包安装行。

- [ ] **Step 4.5：标记为已解决**

```bash
git add package.json package-lock.json
```

- [ ] **Step 4.6：确认包能正常 import**

```bash
node -e "require('./node_modules/webextension-polyfill'); console.log('OK')"
```
Expected：`OK`。

---

## Task 5：解决 debug.ts / logger.ts 冲突（统一到 cn 的 logger）

**Files:**
- Modify or Delete: `src/utils/debug.ts`
- Keep cn: `src/utils/logger.ts`

- [ ] **Step 5.1：对比 cn `logger.ts` 与上游 `debug.ts` 的 API**

```bash
cat src/utils/logger.ts | head -80
```
（注意：上游已新增 `src/utils/logger.ts`，但 cn 也有一个同名文件——`git merge` 已自动合入了某一边或两边的并集。先看清现状。）

```bash
git show upstream/main:src/utils/logger.ts | head -40 2>/dev/null || echo "上游版本不存在"
```

- [ ] **Step 5.2：确定保留策略**

- 如果 cn `logger.ts` 已涵盖上游 `debug.ts` 的功能（`debugLog`、`createLogger` 等）→ 删除 `debug.ts`
- 如果上游 logger.ts 有 cn 没有的能力 → 把那些能力合并到 cn 的 logger.ts 中
- **不要**保留两个并行的 logger 模块

- [ ] **Step 5.3：解决 debug.ts 冲突**

```bash
git diff src/utils/debug.ts | head -40
```

如果文件冲突来自"上游删了 debug.ts、cn 仍在用"：
```bash
git rm src/utils/debug.ts
```

如果文件还需要存在但被双方改了：选 `--theirs`（上游版）然后手工把 cn 的 import 改成引用 logger：
```bash
git checkout --theirs -- src/utils/debug.ts
```

- [ ] **Step 5.4：全仓库搜索 debug.ts 引用**

```bash
grep -rn "from.*utils/debug" src/ || echo "no refs"
grep -rn "import.*debug" src/ | grep -v node_modules | head -20
```

- [ ] **Step 5.5：把所有 debug.ts 引用替换为 logger.ts 引用**

针对每个 hit，编辑文件把 `from './debug'` 或 `from '../utils/debug'` 改为对应的 `logger`。具体路径以 grep 结果为准，逐文件 `Edit`。

- [ ] **Step 5.6：确保没有 dangling import**

```bash
npx tsc --noEmit 2>&1 | head -30
```
Expected：要么完全通过，要么报错与 logger/debug 无关（其他冲突文件还没解完，可以暂时忽略）。

- [ ] **Step 5.7：标记为已解决**

```bash
git add -u src/utils/
```

---

## Task 6：解决 background.ts 冲突

**Files:**
- Modify: `src/background.ts`

cn 在此文件中加了：飞书图片解析（`chrome.scripting.executeScript`）、Bilibili Referer 修改（`webRequest.onBeforeSendHeaders` / `declarativeNetRequest.updateSessionRules`）、读取 `feishu_settings` 存储。上游加了：消息路由扩展、debug→logger 迁移、新页面入口的 tabs 管理。

- [ ] **Step 6.1：查看冲突规模与片段**

```bash
git diff src/background.ts | wc -l
grep -c "^<<<<<<<" src/background.ts
```

- [ ] **Step 6.2：策略：以上游为骨架，逐段贴回 cn 增强**

打开 `src/background.ts`，对每个 `<<<<<<< / ======= / >>>>>>>` 段：

**保留 cn 的代码块（关键标识，搜这些字符串）：**
- `feishu_settings`
- `chrome.scripting.executeScript`（飞书图片专用部分，标题/注释包含 `apiHost` 或 `Feishu`）
- `webRequest.onBeforeSendHeaders`（Bilibili Referer）
- `declarativeNetRequest.updateSessionRules`（Bilibili 动态规则）
- 任何提及 `bilibili.com` / `b23.tv` / `feishu.cn` / `larksuite.com` 的逻辑分支

**接受上游：**
- 新消息 action（如 `toggleHighlights`、`openHighlightsViewer`）的 onMessage 分支
- 日志从 `console.debug` / `debug.ts` 迁移到 `logger.ts`
- popup 选择 vault 修复（`f65c336`）
- 新 tabs.onUpdated 处理（与 highlights / reader-view 集成相关）

- [ ] **Step 6.3：逐冲突标记解决，保留所有 cn 飞书/Bilibili 函数**

每解一段 marker，检查：
- 标识符没有重复定义
- import 区域包含 `chrome.scripting`、`webRequest`、`declarativeNetRequest` 等所需 API（如果用 webextension-polyfill 则相应封装）

- [ ] **Step 6.4：确认没遗漏的冲突标记**

```bash
grep -n "^<<<<<<<\|^=======\|^>>>>>>>" src/background.ts || echo "clean"
```
Expected：`clean`。

- [ ] **Step 6.5：TypeScript 类型检查**

```bash
npx tsc --noEmit --project tsconfig.json 2>&1 | grep "src/background.ts" | head -20
```
Expected：与 background.ts 相关报错为 0（其他文件可能还有报错，下个 task 解决）。

- [ ] **Step 6.6：标记为已解决**

```bash
git add src/background.ts
```

---

## Task 7：解决 content.ts 冲突

**Files:**
- Modify: `src/content.ts`

- [ ] **Step 7.1：查看冲突片段**

```bash
git diff src/content.ts | head -100
grep -c "^<<<<<<<" src/content.ts
```

- [ ] **Step 7.2：策略：以上游为骨架，逐段贴回 cn 增强**

打开 `src/content.ts`，对每个 `<<<<<<< / ======= / >>>>>>>` 段：

**保留 cn 的代码块（关键标识，搜这些字符串）：**
- `bilibili-playback-tracker`（Bilibili 播放追踪 import 与初始化调用）
- `bilibili.com` / `b23.tv` URL 判断分支（播放器嵌入、字幕监听）
- `wiki.feishu.cn` / `docs.feishu.cn` / `larksuite.com` URL 判断分支
- cn 在 iframe 内通信 / 显隐控制相关的扩展（commit `2ce8097` 风格更新、commit `9056cac` 之后的 reader UI 修复涉及的 content 改动）

**接受上游：**
- innerHTML 移除（`83bf59a`）相关重写，特别是动态 HTML 注入处改为 `createElement` + `appendChild`
- Highlighter 2.0 content-side 集成（`a9d80fb`）：选区监听、悬浮工具栏挂载、SVG 渲染
- reader-view 切换逻辑：从旧的内联 reader 切换到与上游 `src/core/reader-view.ts` 的消息通信
- `toggleReaderMode` / `toggle-iframe` 消息处理升级
- mobile/touch 选区边缘忽略相关改动

- [ ] **Step 7.3：解冲突标记**

逐 marker 处理。

- [ ] **Step 7.4：确认没遗漏标记**

```bash
grep -n "^<<<<<<<\|^=======\|^>>>>>>>" src/content.ts || echo "clean"
```

- [ ] **Step 7.5：类型检查**

```bash
npx tsc --noEmit 2>&1 | grep "src/content.ts" | head -10
```
Expected：无报错。

- [ ] **Step 7.6：标记为已解决**

```bash
git add src/content.ts
```

---

## Task 8：探针——评估 reader.ts 解耦可行性（不要 commit）

**Files:**
- 仅探查，不修改

- [ ] **Step 8.1：先看上游 reader.ts 新架构是什么样**

```bash
git show upstream/main:src/utils/reader.ts | wc -l
git show upstream/main:src/utils/reader.ts | head -50
```
观察导出符号、文件职责（应该是纯逻辑层，不含 reader-view UI 渲染）。

- [ ] **Step 8.2：看上游新增的 `src/core/reader-view.ts`**

```bash
git show upstream/main:src/core/reader-view.ts | head -80
```
理解 reader-view 与 reader.ts 的边界。

- [ ] **Step 8.3：在 cn 旧 reader.ts 中识别 Bilibili 集成代码块**

```bash
git show origin/main:src/utils/reader.ts | grep -nE "bilibili|Bilibili|BILI|playback|subtitle|timestamp|chapter" | head -40
```
列出 Bilibili 相关的行号区间。

- [ ] **Step 8.4：识别可独立抽出的函数 / 类**

记录下来（在此 task 不创建文件）：
- 函数名 / 类名
- 它们的依赖（reader.ts 内部辅助函数）
- 它们对 DOM 的假设（reader 容器选择器等）
- 它们是否依赖 cn 旧版本 reader.ts 的特定钩子

- [ ] **Step 8.5：决策点**

- 如果 cn Bilibili 集成的钩子在上游新 `reader-view.ts` 中能找到对应入口（如 `onReaderMount`、`afterReaderRendered` 类） → 走 Task 9 的"抽到独立模块 + 在 reader-view 内调用"路线
- 如果上游 reader-view 闭合到几乎没有外部钩子 → 改为在 Task 9 中保留 cn 旧 `reader.ts` 的一部分作为 `bilibili-reader-integration.ts`，并在 content.ts 中接管挂载（不依赖 reader-view 的内部钩子）

记录决策（在终端或临时笔记），下一个 task 按此执行。

---

## Task 9：解决 reader.ts 冲突（核心难点）

**Files:**
- Modify: `src/utils/reader.ts`
- Create: `src/utils/bilibili-reader-integration.ts`

- [ ] **Step 9.1：以上游版本为基准重置 reader.ts**

```bash
git checkout --theirs -- src/utils/reader.ts
```
说明：先放弃 cn 的旧版本，得到上游重构后的干净 reader.ts。

- [ ] **Step 9.2：从历史中提取 cn 的 Bilibili 集成代码**

```bash
git show origin/main:src/utils/reader.ts > /tmp/cn-old-reader.ts
```
现在 `/tmp/cn-old-reader.ts` 是 cn 旧版 reader.ts 完整内容（含 Bilibili 集成）。

- [ ] **Step 9.3：创建 bilibili-reader-integration.ts**

新建 `src/utils/bilibili-reader-integration.ts`，文件结构：

```typescript
// Bilibili 阅读模式集成：从旧 reader.ts 抽出
// 由 src/core/reader-view.ts（或 content.ts）在阅读模式渲染后调用 initBilibiliReaderIntegration()

import { Logger } from './logger';
// 其他必要 import 按需添加

const logger = new Logger('BilibiliReader');

export interface BilibiliReaderHooks {
    container: HTMLElement;  // reader 渲染后的根容器
    videoBvid?: string;       // 当前 Bilibili 视频 ID
}

/**
 * 初始化 Bilibili 集成（播放器嵌入、字幕高亮、时间戳跳转、自动滚动）。
 * 返回清理函数。
 */
export function initBilibiliReaderIntegration(hooks: BilibiliReaderHooks): () => void {
    // 从 /tmp/cn-old-reader.ts 中提取以下逻辑：
    //   - 嵌入 Bilibili 播放器到 container
    //   - 监听 postMessage 获取播放时间
    //   - 字幕高亮 + 自动滚动（参考 commit 9bdf748）
    //   - 时间戳点击跳转（commit b499248）
    //   - 暂停时停止滚动（commit 5c5a302）
    //   - Safari 字幕恢复（commit f1701db）
    //   - Safari 播放修复（commit 2169327）
    // ...
    return () => {
        // 清理监听器、定时器、DOM
    };
}
```

复制粘贴 `/tmp/cn-old-reader.ts` 中所有 Bilibili 相关函数体到这里，调整 export 与 hooks 签名。

- [ ] **Step 9.4：在 reader-view 中调用集成**

打开 `src/core/reader-view.ts`（这是上游 merge 后自动新增的），找到 reader 渲染完成的钩子（搜 `afterMount` / `onMount` / `render()` 结尾 / `loadContent` 之类）。

在合适位置加入：
```typescript
import { initBilibiliReaderIntegration } from '../utils/bilibili-reader-integration';

// 在 reader 渲染完毕后
if (currentUrl.includes('bilibili.com') || currentUrl.includes('b23.tv')) {
    const cleanup = initBilibiliReaderIntegration({
        container: readerRoot,
        videoBvid: extractBvid(currentUrl),
    });
    // 把 cleanup 挂在 reader 卸载钩子上
}
```

具体集成点根据 reader-view.ts 实际结构调整。如果 reader-view 没有暴露合适钩子，回到 Task 8 的备选方案：在 `content.ts` 监听 reader-view DOM 渲染完成（MutationObserver）后调用。

- [ ] **Step 9.5：标记为已解决**

```bash
git add src/utils/reader.ts src/utils/bilibili-reader-integration.ts src/core/reader-view.ts
```

- [ ] **Step 9.6：类型检查**

```bash
npx tsc --noEmit 2>&1 | grep -E "reader|bilibili" | head -20
```
修任何报错。

---

## Task 10：解决 reader.scss 冲突

**Files:**
- Modify: `src/reader.scss`
- Create: `src/styles/reader/_bilibili.scss`

- [ ] **Step 10.1：从 cn 旧版本提取 Bilibili 相关样式**

```bash
git show origin/main:src/reader.scss > /tmp/cn-old-reader.scss
grep -nE "bilibili|\.bili-|player|subtitle|timestamp|chapter" /tmp/cn-old-reader.scss | head -30
```
记录这些样式块所在行号。

- [ ] **Step 10.2：以上游版本为基准重置 reader.scss**

```bash
git checkout --theirs -- src/reader.scss
```

- [ ] **Step 10.3：创建 _bilibili.scss**

新建 `src/styles/reader/_bilibili.scss`，把 `/tmp/cn-old-reader.scss` 中提取的 Bilibili 样式块全部复制进来。保持选择器、变量引用一致。

- [ ] **Step 10.4：在 reader.scss 主入口引用新子样式**

打开合并后的 `src/reader.scss`，找到 `@import 'reader/...'` 系列引入语句的末尾，加入：
```scss
@import 'reader/bilibili';
```

如果上游 reader.scss 用 `@use` 而不是 `@import`，对齐其语法。

- [ ] **Step 10.5：检查样式编译**

```bash
npx sass --no-source-map src/reader.scss /tmp/test-reader.css 2>&1 | tail -10
```
Expected：编译成功，无 `error:` 输出。

- [ ] **Step 10.6：标记为已解决**

```bash
git add src/reader.scss src/styles/reader/_bilibili.scss
```

---

## Task 11：处理 xcode 图标与其它自动合入文件

**Files:**
- Delete: `xcode/Obsidian Web Clipper/Shared (App)/Assets.xcassets/AppIcon.appiconset/` 整个目录（如已存在）
- Keep: `xcode/Obsidian Web Clipper/Shared (App)/AppIcon.icon/`

- [ ] **Step 11.1：列出 merge 后 xcode 下的图标资产**

```bash
ls "xcode/Obsidian Web Clipper/Shared (App)/"
ls "xcode/Obsidian Web Clipper/Shared (App)/Assets.xcassets/" 2>/dev/null
```

- [ ] **Step 11.2：删除上游 appiconset（保留 cn AppIcon.icon）**

```bash
git rm -r "xcode/Obsidian Web Clipper/Shared (App)/Assets.xcassets/AppIcon.appiconset" 2>/dev/null || echo "appiconset not present"
```

- [ ] **Step 11.3：核对 pbxproj 引用**

```bash
grep -c "AppIcon.appiconset" "xcode/Obsidian Web Clipper/Obsidian Web Clipper.xcodeproj/project.pbxproj"
```
如果还有引用，打开 pbxproj 移除 `AppIcon.appiconset` 行，保留 `AppIcon.icon` 行。

- [ ] **Step 11.4：标记为已解决**

```bash
git add -u "xcode/"
```

---

## Task 12：完成 merge commit

**Files:**
- 提交合并状态

- [ ] **Step 12.1：确认无残留冲突**

```bash
git diff --name-only --diff-filter=U
```
Expected：空输出。

- [ ] **Step 12.2：确认所有变更已 add**

```bash
git status --short
```
所有变更都应该是 `M` / `A` / `D` 状态（已 stage），不应有 `??` 未跟踪的非文档文件。

- [ ] **Step 12.3：跑测试**

```bash
npm test 2>&1 | tail -20
```
Expected：全绿（含 cn 的 bilibili / string-utils 测试 + 上游新加的测试）。

如果有红：
- 退回相关 task 重审冲突解决
- 不要 commit 红测试

- [ ] **Step 12.4：跑三浏览器构建**

```bash
npm run build:chrome 2>&1 | tail -5 && \
npm run build:firefox 2>&1 | tail -5 && \
npm run build:safari 2>&1 | tail -5
```
Expected：三个构建都成功，`dist/` / `dist_firefox/` / `dist_safari/` 都生成。

- [ ] **Step 12.5：提交 merge commit**

```bash
git commit -m "$(cat <<'EOF'
chore: merge upstream obsidianmd/obsidian-clipper main (1.5.1)

合并上游自分叉点 d5161c02 以来的 24 个 commit，吸收：
- Highlighter 2.0 (PR #797)
- Highlights Viewer (PR #778)
- Reader 重构（独立 reader-view.ts + 拆分样式）
- 杂项修复：Safari 嵌入剪贴板、popup vault 选择、Advanced template、innerHTML 移除

保留 cn 增强：飞书文档 API 提取、Bilibili 播放/字幕集成、WeChat 图片保留、cn 扩展 ID。

Bilibili 在阅读模式中的集成从旧 reader.ts 抽到 src/utils/bilibili-reader-integration.ts，
Bilibili 样式抽到 src/styles/reader/_bilibili.scss。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 12.6：确认 commit 成功**

```bash
git log --oneline -3
git status
```
Expected：HEAD 是新的 merge commit，工作区干净，2 个父提交（merge 默认）。

---

## Task 13：功能手测清单

**Files:**
- 无文件修改，只测试

- [ ] **Step 13.1：加载 dist 到 Chrome**

打开 `chrome://extensions`，开启开发者模式，"加载已解压的扩展程序"选择 `dist/`。

- [ ] **Step 13.2：cn 增强不能回归**

逐项验证（每项打勾）：
- [ ] 飞书 docx 文档剪存：打开任意飞书 docx 文档 → 用扩展剪存 → 检查 Markdown 内容完整、图片以 base64 嵌入
- [ ] 飞书 wiki 文档剪存：同上，URL 是 `/wiki/`
- [ ] Bilibili 视频剪存：打开任意 Bilibili 视频 → 剪存 → 检查简介、章节、字幕、时间戳跳转
- [ ] Bilibili 阅读模式：进入阅读模式 → 播放视频 → 字幕自动滚动 ✓、当前字幕高亮 ✓、点击时间戳跳转 ✓
- [ ] Bilibili 暂停停滚：阅读模式播放中按暂停 → 字幕停止自动滚动
- [ ] 微信公众号文章剪存：打开公众号文章 → 剪存 → 图片完整保留

- [ ] **Step 13.3：上游新功能要可用**

- [ ] Highlighter 2.0：在普通网页上选中文字 → 出现新的悬浮工具栏 → 点击高亮 → SVG 位置准确
- [ ] 表格内高亮：在带表格的页面尝试高亮表格内文字
- [ ] Highlights Viewer：从扩展菜单/快捷键打开 highlights 页面 → 列表显示已有高亮 → 搜索框可用
- [ ] Reader 阅读模式：在文章页面切换 reader → 滚动锁定生效 → 切回正常视图正常

- [ ] **Step 13.4：回归验证**

- [ ] 普通网页剪存：Wikipedia 任意页面 → 剪存正常
- [ ] 模板变量解析：在设置中调出 Templates → 自定义模板（含 `{{title}}` `{{content}}` `{{selector}}` 等）→ 渲染正确
- [ ] 设置页所有 section 可访问（issue #779 修复点）
- [ ] popup 中选择 vault 正常（`f65c336`）

- [ ] **Step 13.5：（可选）Firefox 加载测试**

打开 `about:debugging` → "临时载入附加组件" → 选 `dist_firefox/manifest.json` → 重跑关键剪存路径（飞书、Bilibili、普通网页各一次）。

- [ ] **Step 13.6：发现回归如何处理**

任何 13.2 或 13.3 失败：
- 回到对应 task（如飞书坏了去 Task 6 background.ts，Bilibili 阅读模式坏了去 Task 9 / 10）
- 修完后 amend 当前 merge commit 或追加新 commit
- 不允许带红回归合回 main

---

## Task 14：bump 版本号并合回 main

**Files:**
- Modify: `package.json`、`src/manifest.chrome.json`、`src/manifest.firefox.json`、`src/manifest.safari.json`

- [ ] **Step 14.1：决定新版本号**

cn 跟随上游主版本到 `1.5.x`，加 cn 自身递增：`1.5.0` 作为本次合并的发布版本。

- [ ] **Step 14.2：bump package.json**

打开 `package.json`，把 `"version": "1.4.4"` 改为 `"version": "1.5.0"`。

- [ ] **Step 14.3：bump 三个 manifest 的 version**

`src/manifest.chrome.json`、`src/manifest.firefox.json`、`src/manifest.safari.json` 中的 `"version"` 字段同步改为 `"1.5.0"`。

- [ ] **Step 14.4：commit**

```bash
git add package.json src/manifest.*.json
git commit -m "$(cat <<'EOF'
chore: bump version to 1.5.0 after upstream merge

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 14.5：合回 main**

```bash
git checkout main
git merge merge-upstream-2026-05-14
git log --oneline -5
```
Expected：main 现在指向合并分支的 HEAD（fast-forward）。

- [ ] **Step 14.6：（可选）推送到远端**

**仅在用户明确指示下执行**：
```bash
git push origin main
```

- [ ] **Step 14.7：（可选）清理分支**

合回 main 且推送后：
```bash
git branch -d merge-upstream-2026-05-14
```

---

## 回滚预案

若 Task 12 之前发现不可挽救：
```bash
git merge --abort
git checkout main
git branch -D merge-upstream-2026-05-14
```

若 Task 12 提交后、Task 14 合回 main 前发现问题：
```bash
git checkout main
git branch -D merge-upstream-2026-05-14
```
（main 未受影响）

若已合回 main 但未推送：
```bash
git reset --hard origin/main
```
（**只在 main 未推送时使用**；若已推送，改用 revert）
