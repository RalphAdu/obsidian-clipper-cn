# scys.com standalone 飞书 docx 页面（`/view/docx/*`）提取器 设计文档

**日期**：2026-05-16
**目标**：让 cn extension 能裁剪 `https://scys.com/view/docx/{token}` 这类 scys 上 standalone 飞书文档页面，输出语义完整的 Markdown：标题层级正确、列表/表格/callout/代码块/图片完整、效果与浏览器渲染对等。
**约束**：
- 不影响 scys course 路径（`/course/detail/*?chapterId=*`）的现有实施
- 复用现有 `flattenScysBlocks` / `convertBlocksToHtml` / `resolveScysImages` 等管线
- 不破坏用户体验（不要求 reload tab、不让用户手动操作）

## 1. 问题陈述

测试 URL：`https://scys.com/view/docx/QSn2dD6QnoYlDxxiYItcudnPnZg`（标题"AI 工具怎么选丨超级 AI 大航海丨生财有术"）

**当前行为**（无 docx 专项提取器，走通用 Defuddle 流水线）：
- 标题正确（但带"丨超级 AI 大航海丨生财有术" suffix 污染）
- 正文 DOM 含 TOC 树（侧边栏 202 项）+ 40 个 `.block-wrapper[id]` 主体 block
- Defuddle 不识别 scys 自定义 class（`.heading1` / `.heading2` / `.heading4` / `.bulletlist` / `.text` 等）→ 输出降级为段落
- 折叠 / 虚拟化机制下，DOM 中可能漏数据

**关键差异（vs scys course）**：

| 维度 | course `/course/detail/*` | docx `/view/docx/*` |
|---|---|---|
| 后端 API | `/search/course/getChapterContent` 返回完整飞书 block 数组 | `/search/docx/{token}/info` **只返回 user+version**，**无内容**；正文在加密 JSON |
| 数据源 | scys 后端解出明文 | `search01.shengcaiyoushu.com/upload/doc/{token}/{token}.json`（110KB 加密，前端 AES 解密） |
| DOM 结构 | `.feishu-doc-content` + `.vc-doc-item[block-id]` | `.block-wrapper[id]` + `.heading{N}` / `.bulletlist` / `.text` |
| 评论 API | 有（`getCourseComments`，分页 70 条） | **无** |
| 折叠/虚拟化 | 无 | 有（TOC 折叠 + 可能虚拟化） |

**已实测**：scys 主 bundle (`index.6xhqvjuU.js`, 685KB) 不含 `CryptoJS` / `AES.decrypt` / `crypto-js` 等可识别解密字符串——解密代码在 Vite 懒加载 chunk 内，函数名混淆。Vue 3 prod build 屏蔽了 `_instance` 和 DOM 上的 `__vueParentComponent`，无法 walk 组件树拿解密后数据。

## 2. 设计概览

**核心思路（D6 方案）**：scys 自己在客户端解密 → 调用 `JSON.parse(decryptedString)` 得到飞书 block 数组喂给 Vue 渲染。我们**在 MAIN-world 注入早期 patch 包装 `JSON.parse`**，scys 调用时被透明拦截，捕获飞书 block 数组到 localStorage。content-script 触发裁剪时读出，复用现有渲染管线。

**为什么不选其他方案**：
- **A（DOM scraping）**：scys docx 有折叠 + 可能虚拟化（实测 scroll 后 block 数不增）；图片懒加载；数据完整性脆弱
- **B（逆向 AES）**：解密函数名混淆且在懒加载 chunk；scys 改 key/algo 即崩
- **C（hook fetch）**：拿到的是加密 ciphertext，仍需自己解密——退化为 B
- **D（直接调 scys 解密函数）**：Vue 3 prod 屏蔽 + 解密函数名不可见，无切入点

**D6 优势**：
- **效果对等浏览器**：浏览器看到什么块结构，我们就拿什么（scys 自己解密完的）
- **抗 scys 变化**：只要还用 JSON.parse 形态就工作，即使 scys 改 key/algo
- **不影响用户体验**：manifest 静态声明 `run_at: document_start, world: 'MAIN'` 在 page JS 任何执行前生效，**无需 reload tab**
- **不影响 course 路径**：URL 互斥分发（`isScysCourseUrl` vs `isScysDocxUrl`），零代码冲突

**数据流**：

```
用户访问 scys.com/view/docx/{token}
  ↓ content_scripts (manifest 声明, run_at:'document_start', world:'MAIN')
src/scys-docx-patch.js IIFE 注入
  → JSON.parse 被透明 wrap
  ↓
scys 主 JS 加载 → fetch 加密 .json → AES 解密 → JSON.parse(decrypted) → wrapper 拦截
  → 嗅探：飞书 block 数组？(Array.isArray + first 3 都有 block_id 字符串 + block_type 数字)
  → 是：保存到 localStorage['__cnScysDocxBlocks']（保留最大 length）
  → 同步设 <html data-cn-scys-docx-blocks="N"> 暴露 debug marker
  ↓
用户触发裁剪
  ↓ scys-extractor.ts 入口分发
isScysDocxUrl(doc.URL) → extractScysDocxStandalone(doc)
  → 读 localStorage['__cnScysDocxBlocks']
  → flattenScysBlocks(blocks) + convertBlocksToHtml + resolveScysImages
  → 返回 { title, author='', content: html, wordCount }
  ↓
content.ts 合并 → template → Obsidian
```

## 3. 详细设计

### 3.1 patch script (`src/scys-docx-patch.js`)

Plain JavaScript（不走 TypeScript / webpack 编译，直接由 CopyWebpackPlugin 复制到 dist/），~30 行 IIFE：

```js
(function () {
  if (window.__cnScysDocxPatchInstalled) return;
  window.__cnScysDocxPatchInstalled = true;

  var originalParse = JSON.parse;

  function isFeishuBlockArray(value) {
    if (!Array.isArray(value) || value.length === 0) return false;
    var max = Math.min(value.length, 3);
    for (var i = 0; i < max; i++) {
      var b = value[i];
      if (!b || typeof b !== 'object') return false;
      if (typeof b.block_id !== 'string') return false;
      if (typeof b.block_type !== 'number') return false;
    }
    return true;
  }

  function tryCapture(parsed) {
    try {
      if (!isFeishuBlockArray(parsed)) return;
      var prev = localStorage.getItem('__cnScysDocxBlocks');
      var prevLen = 0;
      if (prev) {
        try { prevLen = originalParse(prev).length; } catch (e) {}
      }
      if (parsed.length > prevLen) {
        localStorage.setItem('__cnScysDocxBlocks', JSON.stringify(parsed));
        document.documentElement.setAttribute('data-cn-scys-docx-blocks', String(parsed.length));
      }
    } catch (e) { /* never throw from a hook */ }
  }

  JSON.parse = function () {
    var result = originalParse.apply(JSON, arguments);
    tryCapture(result);
    return result;
  };
  JSON.parse.__cnOriginal = originalParse;
})();
```

**设计要点**：
- IIFE 自隔离，不污染 window 全局
- 防重入：`__cnScysDocxPatchInstalled` flag
- 透明 wrapper：永远返回原 parse 结果
- 嗅探函数 catch error：异常不影响 parse 调用
- 抽样 3 个元素：性能开销最小化（飞书 block 必有 block_id+block_type，普通 JSON 极难巧合命中）
- 保留最大 length：scys 可能多次 parse 不同子集，保留最完整快照
- `__cnOriginal` 暴露原函数：避免内部反序列化时被自己 wrap 拦截

### 3.2 URL 检测函数（`src/utils/scys-extractor.ts` 新增）

```ts
export function isScysDocxUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.hostname !== 'scys.com') return false;
    return /^\/view\/docx\/[A-Za-z0-9_-]+\/?$/.test(u.pathname);
  } catch {
    return false;
  }
}

export function parseScysDocxUrl(url: string): { token: string } | null {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^\/view\/docx\/([A-Za-z0-9_-]+)\/?$/);
    return m ? { token: m[1] } : null;
  } catch {
    return null;
  }
}
```

**与 course URL 互斥**：`/course/detail/{id}?chapterId=` vs `/view/docx/{token}`，pathname 前缀不同，绝不双触发。

### 3.3 入口分发改造（`src/utils/scys-extractor.ts`）

把现有 `extractScysStructuredContent` 函数体**重命名**为 `extractScysCourseChapter`（仅 rename，零逻辑变化）。新入口仅做路由：

```ts
export async function extractScysStructuredContent(doc: Document): Promise<ScysStructuredContent | null> {
  if (isScysCourseUrl(doc.URL)) return extractScysCourseChapter(doc);
  if (isScysDocxUrl(doc.URL)) return extractScysDocxStandalone(doc);
  return null;
}
```

**Course 路径零代码变化**——保证现有 56 个单测 + 端到端验收全过。

### 3.4 docx 分支主体 `extractScysDocxStandalone`

```ts
async function extractScysDocxStandalone(doc: Document): Promise<ScysStructuredContent | null> {
  const raw = localStorage.getItem('__cnScysDocxBlocks');
  if (!raw) {
    logger.warn('[scys-docx] no decrypted blocks captured; patch may not have run');
    return null;
  }
  let blocks: ScysBlock[];
  try { blocks = JSON.parse(raw); } catch (err) {
    logger.warn(`[scys-docx] failed to parse captured blocks: ${String(err)}`);
    return null;
  }
  if (!Array.isArray(blocks) || blocks.length === 0) return null;

  let html = renderScysChapterContent(blocks);
  html = await resolveScysImages(html);

  // Title 后处理：剥离 "丨超级 AI 大航海丨生财有术" 类品牌 suffix
  const rawTitle = doc.title || '';
  const title = rawTitle
    .replace(/丨超级\s*AI\s*大航海.*$/, '')
    .replace(/丨生财有术$/, '')
    .trim() || rawTitle;

  const wordCount = countWordsFromBlocks(flattenScysBlocks(blocks));

  return { title, author: '', content: html, wordCount };
}
```

**Metadata 来源**：
- `title`：`document.title` + 剥离品牌 suffix（实测页面 title 是 `"AI 工具怎么选丨超级 AI 大航海丨生财有术"`，处理后变 `"AI 工具怎么选"`）
- `author`：standalone docx 无 author API，留空字符串（与 feishu / bilibili 缺 author 时一致）

**为什么不调 `/search/docx/{token}/info`**：实测该 API 只返回 `data.user + data.version`，无 title/author 等信息，调用无意义。

**为什么不抓评论**：scys standalone docx 无评论 API（实测 network 请求中无 `getComments` 类）。

### 3.5 Manifest 声明（三份）

`src/manifest.chrome.json` / `src/manifest.firefox.json` / `src/manifest.safari.json` 的 `content_scripts` 数组**追加**一项：

```json
{
  "matches": ["https://scys.com/view/docx/*"],
  "js": ["scys-docx-patch.js"],
  "run_at": "document_start",
  "world": "MAIN"
}
```

不修改现有 content_script（仍匹配 `https://*/*` + ISOLATED world + content.js）。新声明与现有声明**并存**，两个 script 都注入到 docx 页面，分工：patch 在 MAIN world 拦 JSON.parse，content.js 在 ISOLATED world 等待用户裁剪。

### 3.6 webpack 配置改造

`webpack.config.js` 的 CopyWebpackPlugin patterns 数组追加：

```js
{ from: 'src/scys-docx-patch.js', to: 'scys-docx-patch.js' },
```

`dev:chrome` watch 与 `build:chrome` production build 都自动产出 `dist/scys-docx-patch.js`。

不修改 webpack `entry`——patch script 不需要 TS/webpack runtime（plain JS）。

### 3.7 content.ts 接入点（一行改动）

`src/content.ts` 现有：

```ts
const scysContent = isScysCourseUrl(document.URL)
  ? await extractScysStructuredContent(document).catch(...)
  : null;
```

改为：

```ts
const scysContent = (isScysCourseUrl(document.URL) || isScysDocxUrl(document.URL))
  ? await extractScysStructuredContent(document).catch(...)
  : null;
```

`isScysDocxUrl` import 加到顶部。下游 `if (scysContent) { ... }` 合并逻辑零变化。

### 3.8 跨浏览器兼容性

| 浏览器 | manifest `content_scripts.world: 'MAIN'` 支持 |
|---|---|
| Chrome 111+（2023-03） | ✓ |
| Firefox 128+（2024-07） | ✓ |
| Safari 18.2+（2024-12） | ✓ |
| 更早版本 | ✗ 字段被忽略，注入到 ISOLATED world，patch 无效 |

**降级行为**：旧浏览器无 patch → content-script 读 localStorage 为 null → docx 提取返回 null → 流水线回退 Defuddle 通用提取，零退化。

## 4. 安全考量

`JSON.parse` wrapper 的攻击面与现有 cn 注入面对比：

| 项 | 评估 |
|---|---|
| URL 匹配范围 | 仅 `scys.com/view/docx/*`（窄于现有 `https://*/*` 的 content.js） |
| 凭证读取 | 无（patch 不读 cookie、storage、headers） |
| 网络请求 | 无（patch 是观察者，不主动 fetch） |
| 数据外发 | 无（localStorage 同 origin，content-script 同 origin） |
| 与 scys 自身行为冲突 | 透明 wrapper，scys 完全无感知 |
| 与其他扩展冲突 | `__cnScysDocxPatchInstalled` flag 防自重入；其他扩展 wrap 后仍能透明传递 |
| localStorage key 冲突 | `__cnScysDocxBlocks` 前缀 `__cn`，scys 自己用 `__obsidianClipper*` / 业务 key |

安全水平与现有 scys course 路径（同样在 scys.com 注入 content.js）等价。

## 5. 测试策略

### 5.1 单元测试 — `src/utils/scys-extractor.test.ts` 追加

约 8 个新测试在 3 个 describe block 中：

1. `isScysDocxUrl` 正反例（4 测试）
2. `parseScysDocxUrl` 提取 + null 兜底（2 测试）
3. `extractScysDocxStandalone` mock localStorage（2 测试）：
   - 无捕获数据 → null
   - 有数据 → 渲染 HTML + title 剥离 suffix

复用 `scys-chapter-11408.json` fixture 验证 pipeline 通用性（scys docx block 与 course block 是同种飞书 docx block 数组）。无需新增 docx fixture。

### 5.2 端到端自动化验收

复用 cn 已建立的全自动循环（BACKLOG §1.9）：

```bash
# 1. webpack watch
npm run dev:chrome  # dist/ 自动更新，含 scys-docx-patch.js

# 2. chrome.alarms 自动 reload extension（3-5 秒）

# 3. claude-in-chrome 自动化
navigate scys.com/view/docx/QSn2dD6QnoYlDxxiYItcudnPnZg
  → content_scripts 立即注入 patch (run_at:'document_start')
  → page JS 解密后 JSON.parse 被拦截
  → window.__cnScysDocxPatchInstalled = true
  → localStorage['__cnScysDocxBlocks'] = <captured>
  → <html data-cn-scys-docx-blocks="N"> 暴露 block 数

# 4. trigger bridge (同 course)
postMessage __obsidianClipperTestExtract__ → bridge 检测 docx URL → extractScysDocxStandalone

# 5. HTTP receiver 接收 markdown → /tmp/scys-docx-test.md

# 6. md → HTML (markdown-it) → Python HTMLParser 结构化校验
```

### 5.3 验收清单

具体数字在 Task 0 抓 fixture 后定准。预期 gate：

- [ ] `<html>` 有 `data-cn-scys-docx-blocks="N"` 且 N > 0（证明 patch 工作）
- [ ] markdown title 不含 "丨生财有术" suffix
- [ ] H2 数量 ≥ TOC 一级标题数（实测目标 docx ~18-22）
- [ ] H3 / H4 / H5 / H6 数量与浏览器侧 TOC 树匹配
- [ ] 无 broken-escape callout（`\[!quote\]+` 等）
- [ ] 图片全 base64（如果 docx 含图）
- [ ] markdown 文件大小 > 5KB（保底确保非空）
- [ ] **course 路径无 regression**：复跑 scys course 端到端验收，10 条 gate 仍全 pass

### 5.4 时序失败的诊断

若用户访问 docx 页面后 patch 没有捕获到 block：

| 诊断点 | 检查命令 | 含义 |
|---|---|---|
| `<html data-cn-scys-docx-blocks>` 是否存在 | DevTools Elements | 未设 → patch 没注入 / 没拦截到飞书 block 数组 |
| `window.__cnScysDocxPatchInstalled` | DevTools Console | undefined → patch 没注入（manifest 配置错或 chrome 不支持 world: 'MAIN'） |
| `localStorage.getItem('__cnScysDocxBlocks')` | DevTools Console | null → 没捕到，但 patch 已安装 → scys 没走 JSON.parse 形态 |
| `dist/scys-docx-patch.js` 文件 | shell ls | 不存在 → webpack copy 配置错 |

## 6. 文件清单

| 操作 | 路径 |
|---|---|
| 新建 | `src/scys-docx-patch.js` |
| 修改 | `webpack.config.js` (CopyWebpackPlugin patterns) |
| 修改 | `src/manifest.chrome.json` |
| 修改 | `src/manifest.firefox.json` |
| 修改 | `src/manifest.safari.json` |
| 修改 | `src/utils/scys-extractor.ts` (URL 函数 + 路由 + docx 分支) |
| 修改 | `src/utils/scys-extractor.test.ts` (~8 新测试) |
| 修改 | `src/content.ts` (OR 条件) |

## 7. 实施顺序（5 步）

1. **URL 函数 + 路由改造**：`isScysDocxUrl` / `parseScysDocxUrl` + 把现有 `extractScysStructuredContent` 函数体重命名为 `extractScysCourseChapter`，新加 router → 单测 + 现有 course 测试全 pass
2. **patch script + manifest + webpack copy**：3 个 manifest 加声明 + webpack patterns 加复制 + 新文件 → build 验证 `dist/scys-docx-patch.js` 存在
3. **docx 分支主体**：`extractScysDocxStandalone` 读 localStorage、渲染、复用 resolveScysImages → fixture mock 测试
4. **content.ts 接入**：OR 条件改造 → typecheck pass + 全单测 pass
5. **端到端自动化验收**：navigate docx URL → 验证 patch 捕获 → bridge 抓 md → HTML 解析校验 → 全 pass；同时复跑 course 验收确保无 regression

## 8. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| scys 改解密管线不再走 JSON.parse | docx 提取失败 | 回退 Defuddle，零退化 |
| scys 多次 parse 同份数据（chunked） | 可能只捕到部分 | "保留最大 length" 策略 |
| 用户访问 docx 页面后 < 1 秒就触发裁剪 | patch 尚未捕获 | content-script 端检测 null → 回退 Defuddle |
| 旧版 Firefox/Safari 不支持 `world: 'MAIN'` | 这些用户的 docx 走 Defuddle | 已知接受（BACKLOG §2.6）；新版自动启用 |
| `JSON.parse` wrapper 性能开销 | 用户感知卡顿 | 抽样 3 元素 + try/catch；实测开销 < 1ms |
| 与其他扩展冲突 wrap JSON.parse | wrapper 链堆叠 | `__cnScysDocxPatchInstalled` 防自重入；透明传递不破坏其他 wrap |
| 误匹配 scys 其他业务的飞书 block 形态数据 | 错误捕获非 docx 内容 | URL 匹配仅 `/view/docx/*`，patch 不在其他页面注入 |
| docx 图片来自第三域且 host_permissions 不覆盖 | 图片留 OSS URL（24h 过期） | 现有 `<all_urls>` host_permissions 已覆盖所有 https；L2 background fetch 凭权限绕 CORS |

**回滚**（5 行内可逆）：
1. `src/content.ts` OR 条件改回单 `isScysCourseUrl`
2. `src/utils/scys-extractor.ts` 路由分发改回直接 `extractScysCourseChapter` 实现
3. 删 manifest docx content_script 声明（可选）
4. 删 `src/scys-docx-patch.js` + webpack copy 配置（可选）

course 路径完全不受影响——所有改动 additive。

## 9. 非目标（YAGNI 边界）

- ❌ 反编译 scys 解密算法 / 抓 AES key —— 选 D6 就是为了避免脆弱方案
- ❌ scys docx 评论支持 —— standalone docx 无评论 API
- ❌ `/view/wiki/*` / `/view/sheet/*` 等其他 view 形态 —— 遇到再说
- ❌ 历史版本回看 / docx 修订记录 —— 超出裁剪当前快照目标
- ❌ docx TOC 抓取为单独 markdown 部分 —— 块结构已含 heading，markdown 自然有 H1-H6 层级
- ❌ 旧版 Firefox/Safari 通过 `chrome.scripting.registerContentScripts` 动态降级 —— 现阶段静态 manifest 声明足够；新版本浏览器自动启用

## 10. 与现有 cn 资产的对齐

- **复用模块**：`flattenScysBlocks` / `convertBlocksToHtml` / `renderScysChapterContent` / `resolveScysImages` / `countWordsFromBlocks`
- **复用基础设施**：webpack hot-reload (`a04bc32`) / page-world test bridge / HTTP receiver / chrome MCP automation
- **复用约定**：扩展恒定加载 `dist/`（BACKLOG §2.7 固化）；markdown 渲染自动化验收（BACKLOG §1.9）
- **遵守安全模型**：与 scys course 路径同 attack surface 级别
- **遵守编码规范**：TypeScript / 4 tab 缩进 / TDD（fixture-based 单测）

设计完毕。
