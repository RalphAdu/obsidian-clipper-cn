# Spec — docs.qq.com 专项 extractor (MVP /doc/ only)

**日期**：2026-05-26
**作者**：阿杜 + Claude
**目标**：让浏览器扩展在 `https://docs.qq.com/doc/<token>` 页面触发裁剪时，绕过 Defuddle 通用通路，走腾讯文档"导出 docx"接口取得高保真内容，转为 markdown 写入 Obsidian。

---

## 1. 背景

- 上游 Defuddle 对腾讯文档这种 SPA + canvas/contenteditable 渲染的协作文档产物极差（跟当初做 `feishu-extractor` 同类问题）。
- 阿杜验收一个 docs.qq.com URL 后确认默认通路不可用，立项做专项 extractor。
- 既有同模式参考：`feishu-extractor`（OpenAPI 路径）、`scys-extractor` + `zsxq-extractor`（cookie 路径）、`weixin-extractor`（页面 DOM 路径）。

## 2. 范围

### 2.1 MVP 范围（本 spec）

- **URL**：仅 `https://docs.qq.com/doc/<token>`（doc 类型）
- **数据源**：用户已登录 docs.qq.com 的 cookie + 腾讯文档"导出 docx"异步接口
- **导出格式**：`.docx`（Word），本地用 mammoth.js 转 HTML，再走现有 turndown pipeline 转 markdown
- **请求 runtime**：content.ts 页面 runtime（自动带 cookie / CSRF / Referer）
- **内容覆盖**：
  - 正文（段落、标题、列表、表格、图片、链接、加粗斜体等基础块） ← mammoth 默认
  - 公式（LaTeX `$...$` / `$$...$$`） ← 需 MathML → LaTeX 后处理
  - 文档元数据（title / author / createTime / modifyTime → frontmatter）

### 2.2 Out of MVP（v2 再做）

- 其它 URL 类型：`/sheet/`（表格）、`/slide/`（幻灯片）、`/form/`（表单）、`/flowchart/`、`/mind/`、`/pdf/`、`/smartsheet/`
- 评论（腾讯文档侧栏评论）
- 嵌入子文档（mention_doc 类似 feishu 的 inline_block）
- 历史版本 / 修订追踪

## 3. 架构总览

### 3.1 数据流

```
用户在 docs.qq.com/doc/<token> 触发裁剪
  ↓
content.ts: parseDocsQQUrl(url) → { type: 'doc', token }
  ↓ 命中
extractDocsQQContent({ token, url, doc })  ← docs-qq-extractor.ts 主入口
  ↓
  ① fetchDocMetadata(token)         拿 title / author / createTime / modifyTime
  ② requestExportTask(token, 'docx') 发起异步导出任务 → operationId
  ③ pollExportStatus(operationId)    每 1s poll，timeout 30s → 拿到 downloadUrl
  ④ fetchDocxFile(downloadUrl)       拿 ArrayBuffer
  ⑤ await import('mammoth')          动态加载（webpack 自动分包）
  ⑥ mammoth.convertToHtml({ arrayBuffer }, { convertImage })
                                     图片 base64 内嵌；公式默认转 MathML
  ⑦ postProcessHtml(html)            MathML → LaTeX；清理空段落
  ↓
返回 DocsQQStructuredContent {
  title, author, published, content: html, wordCount
}
  ↓
content.ts → 现有 createMarkdownContent (turndown) → postProcessExtractorMarkdown → obsidian://
```

### 3.2 设计原则（跟 feishu 对齐）

- extractor **返回 HTML**，由主流程 turndown 转 markdown → 复用所有现有后处理（链接清理、空行规范化、frontmatter 注入等）
- 公式转换在 HTML 阶段做：MathML `<math>` → `$...$` / `$$...$$`，turndown 不动公式
- 错误一律 **throw**（禁止 return null 软失败），由 content.ts catch → `ContentResponse.extractorWarnings[]` → popup 顶部黄色 banner（参考 `project_extractor_warning_banner` / `feedback_extractor_silent_fallback`）

## 4. 文件结构

```
src/utils/
├── docs-qq-extractor.ts           ← 新建主文件（预计 400-600 行）
├── docs-qq-extractor.test.ts      ← vitest 单测
└── docs-qq-extractor.e2e.test.ts  ← playwright e2e

src/content.ts                     ← 加 isDocsQQUrl branch
webpack.config.js                  ← splitChunks cacheGroups 加 mammoth chunk
package.json                       ← deps 加 mammoth + mathml-to-latex
_locales/{en,zh-CN}/messages.json  ← 复用现有 extractorFailedFallback
                                      （可考虑新增 docsQQ-specific message）
```

### 4.1 docs-qq-extractor.ts 内部函数

| 函数 | 职责 |
|------|------|
| `parseDocsQQUrl(url)` | URL parser → `{ type: 'doc', token } \| null` |
| `fetchDocMetadata(token)` | 拿 title / author / createTime / modifyTime |
| `requestExportTask(token, format)` | POST 发起异步导出 → operationId |
| `pollExportStatus(operationId, opts)` | 每 1s poll，timeout 30s → downloadUrl |
| `fetchDocxFile(downloadUrl)` | 拉 ArrayBuffer（带 size 上限校验） |
| `convertDocxToHtml(arrayBuffer)` | `await import('mammoth')` + convertToHtml + 图片 base64 内嵌 |
| `postProcessHtml(html)` | MathML → LaTeX；空段落清理 |
| `extractDocsQQContent({ token, url, doc })` | **主入口**：编排 ①-⑦ |

### 4.2 为什么单文件

- 跟 feishu（1390 行单文件）比，docx 路径少了"自己渲染所有 block 类型" 大头，预计 400-600 行
- 单文件便于 `git log` 跟踪、便于 grep
- 拆 helper 子文件得权衡引入"循环依赖" / "import 链复杂"的成本
- 若日后膨胀到 1000+ 行再拆不迟

## 5. URL routing + endpoint reconnaissance

### 5.1 URL routing 规则

```ts
function parseDocsQQUrl(url: string): { type: 'doc'; token: string } | null {
  const match = url.match(/^https:\/\/docs\.qq\.com\/doc\/([A-Za-z0-9]+)/);
  if (!match) return null;
  return { type: 'doc', token: match[1] };
}
```

**入路由的 URL 形态**：
- `https://docs.qq.com/doc/DQmZvdEFOR0RFWU9t` ✓
- `https://docs.qq.com/doc/DQmZvdEFOR0RFWU9t#?...` ✓（hash 忽略）
- `https://docs.qq.com/doc/DQmZvdEFOR0RFWU9t?p=...` ✓（query 忽略）
- `https://docs.qq.com/sheet/...` ✗（v2）
- `https://docs.qq.com/slide/...` ✗（v2）

### 5.2 Endpoint reconnaissance（spec 实施前必做）

**brainstorming 阶段无法确定具体 endpoint 名**（避免编造）。spec 实施第一步 plan task = 做完 endpoint reconnaissance，落实以下 4 个 endpoint 的实际路径、请求体、响应 schema：

1. **元数据 endpoint** — 拿 `title / author / createTime / modifyTime / wordCount`
2. **导出任务发起 endpoint** — POST，传 `docId / format='docx' / range=full`
3. **导出任务状态轮询 endpoint** — 拿 `status / progress / downloadUrl`
4. **docx 文件下载 endpoint** — 拿 ArrayBuffer

### 5.3 Reconnaissance 工具链

```bash
# 1. Playwright launchPersistentContext + 已登录 chrome
#    (pycookiecheat 读 macOS Chrome cookie 注入)
# 2. browser_navigate("https://docs.qq.com/doc/<test_token>")
# 3. browser_network_requests()  ← 清空 baseline
# 4. browser_click("文件 → 导出为 → Word")
# 5. browser_network_requests()  ← 抓所有出去的 fetch
# 6. dump URL/method/header/body 到
#    docs/superpowers/specs/2026-05-26-docs-qq-extractor-recon.md
```

Reconnaissance 产出 **单独一份 recon.md**（不入本 spec），spec 里只引用最终 endpoint 路径。

## 6. 调用流程编排 + 错误处理

### 6.1 Happy path（伪代码）

```ts
async function extractDocsQQContent(opts: {
  token: string;
  url: string;
  doc: Document;
}): Promise<DocsQQStructuredContent> {
  const meta = await fetchDocMetadata(opts.token);
  const operationId = await requestExportTask(opts.token, 'docx');
  const downloadUrl = await pollExportStatus(operationId, {
    timeoutMs: 30_000,
    intervalMs: 1_000,
  });
  const arrayBuffer = await fetchDocxFile(downloadUrl);

  const mammoth = await import('mammoth');
  const { value: rawHtml } = await mammoth.convertToHtml(
    { arrayBuffer },
    {
      convertImage: mammoth.images.imgElement(image =>
        image.read('base64').then(data => ({
          src: `data:${image.contentType};base64,${data}`,
        }))
      ),
    }
  );

  return {
    title: meta.title,
    author: meta.author,
    published: meta.modifyTime,  // YYYY-MM-DD
    content: await postProcessHtml(rawHtml),
    wordCount: estimateWordCount(rawHtml),
  };
}
```

### 6.2 错误分类（fail-loud，禁止 null 软失败）

| 触发条件 | Error 类 | 用户看到的 banner 文案 | 退回行为 |
|---------|---------|---------------------|---------|
| 401 / 403 | `DocsQQAuthError` | "docs.qq 提取失败：未登录或无权限" | 走 Defuddle |
| 404 | `DocsQQNotFoundError` | "docs.qq 提取失败：文档不存在" | 走 Defuddle |
| 网络 / 5xx / timeout | `DocsQQTransientError` | "docs.qq 提取失败：网络异常，请重试" | 走 Defuddle |
| 导出任务状态 = FAILED | `DocsQQExportFailedError` | "docs.qq 提取失败：导出任务失败" | 走 Defuddle |
| mammoth 转换抛错 | `DocsQQConvertError` | "docs.qq 提取失败：docx 解析失败" | 走 Defuddle |

所有错误 **throw** → content.ts try/catch 收集到 `ContentResponse.extractorWarnings[]` → popup 顶部黄色 banner 显示。**禁止 return null**。

### 6.3 防御性约束

- 所有 fetch 加 `AbortController` + 10s timeout（防 hang）
- `fetchDocxFile` 检查 `Content-Length` 上限 50MB（防 OOM）
- `pollExportStatus` 30s 内未完成 throw transient（不无限等）
- 每个 fetch 失败仅 retry 1 次（防止反爬封号）

## 7. 公式转换 + HTML 后处理

### 7.1 Mammoth 默认对 OMML 的行为

mammoth.js 把 Word 文档里的 OMML（Office Math Markup Language）公式自动转成 **MathML `<math>...</math>`**，但 Obsidian 默认不渲染 MathML——必须转成 LaTeX `$...$` / `$$...$$`。

### 7.2 转换实现

```ts
async function postProcessHtml(rawHtml: string): Promise<string> {
  const doc = new DOMParser().parseFromString(rawHtml, 'text/html');

  // 1. MathML → LaTeX
  if (doc.querySelector('math')) {
    const { default: mathmlToLatex } = await import('mathml-to-latex');
    for (const math of doc.querySelectorAll('math')) {
      try {
        const latex = mathmlToLatex(math.outerHTML);
        const isBlock = math.getAttribute('display') === 'block';
        const wrapped = isBlock ? `$$${latex}$$` : `$${latex}$`;
        math.replaceWith(doc.createTextNode(wrapped));
      } catch {
        // 转换失败保留 MathML 原标签，不阻塞裁剪
      }
    }
  }

  // 2. 清理空段落 / 连续 <br>
  doc.querySelectorAll('p:empty').forEach(p => p.remove());
  doc.querySelectorAll('br + br').forEach(br => br.remove());

  return doc.body.innerHTML;
}
```

### 7.3 新增 npm 依赖

| 包 | 用途 | bundle 影响 |
|---|------|----|
| `mammoth` (^1.9.x) | docx → HTML | ~250KB（含 jszip） |
| `mathml-to-latex` (^1.x) | MathML → LaTeX | ~30KB |

**两个都进 mammoth chunk**（动态分包），其它页面零开销。

### 7.4 边缘情况

- **OMML 转 MathML 失败**：mammoth 留 `<m:oMath>` 原标签 → 后处理转成 `[公式解析失败]` 占位符（不 throw，仅在 markdown 里露出问题）
- **mathml-to-latex 转 LaTeX 失败**：保留 `<math>` 原标签 → Obsidian 显示原 XML（不理想但不阻塞）
- **公式中含中文 mtext**：mathml-to-latex 支持 `\text{中文}` 输出，Obsidian/KaTeX 也能渲染

## 8. frontmatter 元数据映射

extractor 返回字段 → ContentResponse → buildVariables → template frontmatter：

```ts
{
  title: meta.title,                  // → {{title}}
  author: meta.author,                // → {{author}}
  published: meta.modifyTime,         // → {{published}}, format YYYY-MM-DD
  source: url,                        // → {{source}} (现有变量)
  wordCount: estimateWordCount(html), // → {{wordCount}} (现有变量)
}
```

不需要新增 ContentResponse 字段——复用 feishu 已建立的 author/published 字段（参 `project_content_response_dual_interface.md`，加字段两处 interface 都要改的盲区在 docs-qq 这里不存在）。

## 9. Webpack 动态分包配置

```js
// webpack.config.js 现有 splitChunks 配置上加 cacheGroup:
optimization: {
  splitChunks: {
    cacheGroups: {
      mammoth: {
        test: /[\\/]node_modules[\\/](mammoth|mathml-to-latex|jszip)[\\/]/,
        name: 'mammoth',
        chunks: 'async',  // 仅 dynamic import 触发时打包
        priority: 10,
      },
      // ... 现有 cacheGroups
    },
  },
}
```

**验证 chunk 分离正确**：

```bash
npm run build:chrome
ls dist/  # 应该看到 mammoth.<hash>.js 单独文件
# content.js 大小不应该 +250KB
```

**⚠️ 2026-05-27 实测修正**: 动态分包设计在 chrome extension content script runtime 不 work — async chunk 无法通过 `<script>` 注入加载（不在 `web_accessible_resources` 白名单的 chunk 被 chrome 拦）。**实际实现改为 static import** `import mammoth from 'mammoth'`。代价：`content.js` 体积 +800KB（从 2.5MB 变 3.3MB）。

替代方案考虑过：
- 把 mammoth 移到 background service worker — 但 background↔content 跨 runtime 传 ArrayBuffer 复杂且慢
- 把 chunk 加进 `web_accessible_resources` — 需 hardcode chunk hash，每次 build 变化，fragile

最终选 static import 因为简单稳定。splitChunks 配置保留在 webpack.config.js (mammoth cacheGroup) 是 dead config 不影响构建。

## 10. 测试策略

### 10.1 Unit test (`docs-qq-extractor.test.ts`, vitest)

- `parseDocsQQUrl`：covering happy / hash / query / sheet 不命中 / 非 docs.qq 不命中
- `postProcessHtml`：MathML inline+block → LaTeX、空段落清理、转换失败保留原 MathML
- `fetchDocMetadata` / `requestExportTask` / `pollExportStatus` / `fetchDocxFile`：mock fetch，验证 URL/method/header/body 拼装、retry 次数、timeout
- 错误分类：mock fetch 各 status → 验证 throw 对应 Error 子类
- `convertDocxToHtml`：mock `import('mammoth')`，验证 convertImage handler 注入

### 10.2 E2E test (`docs-qq-extractor.e2e.test.ts`, playwright)

3-5 个 fixture URL（阿杜后续提供）覆盖：
- 纯文本文档
- 含表格 + 列表
- 含图片
- 含公式（LaTeX 验收关键点）
- 含嵌入子文档 / 长文档（可选）

调用现有 `runRealClip(url)` → snapshot 比对 markdown。

### 10.3 Ship-gate T5-1..4（按既有铁律）

- **T5-1**: `npm test` PASS（vitest exclude e2e）
- **T5-2**: `npm run test:e2e` PASS + `audit-extractor-ship` 报告所有 fixture diffs[] ≤ acceptable threshold
- **T5-3**: `npm run build:chrome` 成功 + 扩展 hot reload + 手工测试 1 个真 URL（不靠 mock，必须能写入 Obsidian.app 看到产物）
- **T5-4**: BACKLOG §6.xx + memory 更新（新增 `project_docs_qq_endpoints.md`，提示 endpoint 反向工程结果）

## 11. 风险

| 风险 | 缓解 |
|------|------|
| 腾讯文档导出 endpoint 改动 / 加固反爬 | 错误分类已覆盖；reconnaissance 文档便于 re-engineer |
| mammoth 对某些 docx 复杂结构转换失败（合并单元格、嵌入对象、批注） | 边缘情况落到 console warning，不阻塞 happy path |
| 导出 docx 触发腾讯侧 rate limit | 每个 fetch 仅 retry 1 次；用户层若高频裁剪需自己控制节奏 |
| bundle size 增长（mammoth + jszip + mathml-to-latex ~280KB） | 动态分包，仅 docs.qq URL 触发加载 |
| 用户未登录或文档无权限 | DocsQQAuthError + warning banner，引导用户登录 |

## 12. 实施顺序（给 writing-plans）

1. **Reconnaissance**：在 docs.qq.com 实测 4 个 endpoint，产 recon.md
2. **依赖准备**：`npm i mammoth mathml-to-latex` + webpack splitChunks 配置
3. **URL routing + 主入口骨架**：`parseDocsQQUrl` + `extractDocsQQContent` 框架 + content.ts 集成
4. **元数据 endpoint** + 单测
5. **导出任务发起 + 轮询 + 下载** + 单测
6. **mammoth 集成 + 公式后处理** + 单测
7. **错误分类 + warning banner 集成** + 单测
8. **E2E 测试 + ship-gate T5-1..4**
9. **BACKLOG + memory 更新**

## 13. 引用

- `project_extractor_warning_banner` — extractor fallback banner 机制（已落地）
- `feedback_extractor_silent_fallback` — 软失败禁令铁律
- `project_content_response_dual_interface` — ContentResponse 双 interface 盲区（本 spec 不踩雷）
- 既有 extractor：`feishu-extractor.ts`（OpenAPI 模式参考）、`scys-extractor.ts` / `zsxq-extractor.ts`（cookie 模式参考）
