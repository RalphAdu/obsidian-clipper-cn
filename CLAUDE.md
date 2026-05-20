# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

这是 **Obsidian Web Clipper** 的中文定制版（obsidian-clipper-cn），一个支持 Chrome、Firefox、Safari 的浏览器扩展，用于将网页内容裁剪并保存到 Obsidian 笔记。本仓库在上游基础上增加了飞书文档和 Bilibili 视频的专项支持。

## 常用命令

### 输出目录约定（**重要**）

**dev 与 build 都输出到同一目录** —— Chrome 加载 `dist/`、Firefox 加载 `dist_firefox/`、Safari 加载 `dist_safari/`。**不再有 `dev/` 目录**。

历史背景：早期 dev 输出到 `dev/`、build 输出到 `dist/`，扩展加载哪个都可能。结果反复出现"代码改了 watch 在 dev/ 而扩展加载 dist/，chrome.alarms reload 看不到新代码"的混乱（参见 BACKLOG §2.7）。已在 webpack.config.js 中固化约定。

### 开发构建（watch 模式 + sourcemap）

```bash
npm run dev:chrome      # Chrome 开发模式（watch → dist/，带 sourcemap）
npm run dev:firefox     # Firefox 开发模式（dist_firefox/）
npm run dev:safari      # Safari 开发模式（dist_safari/）
```

### 生产构建（minified + 打包）

```bash
npm run build:chrome    # Chrome 生产构建（dist/，并打包 builds/*.zip）
npm run build:firefox   # Firefox 生产构建（dist_firefox/）
npm run build:safari    # Safari 生产构建（dist_safari/）
npm run build           # 三浏览器全量构建
```

**约定**：扩展永远从 `dist/`（chrome）/ `dist_firefox/` / `dist_safari/` 加载。dev mode 写 sourcemap 到同目录；prod mode 覆盖之并 minify。每次重新 `dev:chrome` / `build:chrome` 都会覆盖。

### 测试

```bash
npm test                # 一次性运行所有测试（vitest run）
npm run test:watch      # 监听模式
```

运行单个测试文件：

```bash
npx vitest run src/utils/parser.test.ts
npx vitest run src/utils/filters/replace.test.ts
```

### 国际化

```bash
npm run update-locales  # 同步 _locales 翻译文件
npm run check-strings   # 检查未使用的 i18n 字符串
npm run add-locale      # 添加新语言
```

## 架构概览

### 扩展入口点（Webpack 多入口）

| 文件 | 编译输出 | 用途 |
|------|----------|------|
| `src/background.ts` | `background.js` | Service Worker，处理消息路由、快捷键、declarativeNetRequest 规则 |
| `src/content.ts` | `content.js` | 内容脚本，注入到每个页面，管理 iframe/侧边栏、高亮 |
| `src/core/popup.ts` | `popup.js` | 弹窗 UI |
| `src/core/settings.ts` | `settings.js` | 设置页面 |
| `src/reader-script.ts` | `reader-script.js` | 阅读模式脚本 |

### 核心数据流

1. **用户触发裁剪** → `content.ts` 打开 iframe（侧边栏）
2. **内容提取** → `content-extractor.ts` 调用 Defuddle 解析页面，特殊站点走专项提取器
3. **变量解析** → `template-compiler.ts` → `resolver.ts` 将模板变量映射到提取的内容
4. **模板渲染** → `tokenizer.ts` → `parser.ts`（AST）→ `renderer.ts` 输出最终 Markdown
5. **保存到 Obsidian** → `obsidian-note-creator.ts` 通过 `obsidian://` URL 协议打开

### 模板引擎（`src/utils/`）

自研 Jinja2 风格模板引擎，三层处理：

- `tokenizer.ts`：词法分析，Token 流
- `parser.ts`：语法分析，生成 AST（支持 if/elseif/else/endif、for/endfor、set、变量插值）
- `renderer.ts`：AST 求值，输出字符串

过滤器在 `src/utils/filters/` 下按功能拆分为独立文件（每个过滤器一个文件 + 对应测试）。

### 变量系统（`src/utils/variables/`）

- `simple.ts`：基础变量（title、url、content 等）
- `selector.ts`：CSS/XPath 选择器变量
- `schema.ts`：Schema.org 结构化数据变量
- `prompt.ts`：LLM 提示词变量（通过 `interpreter.ts` 发送给 AI）

### 专项提取器（本仓库新增）

- `src/utils/feishu-extractor.ts`：飞书文档（wiki/docx/doc）内容提取，使用飞书开放 API，图片通过 `background.ts` 的 `executeScript` 在页面 runtime 环境中解析为 base64
- `src/utils/bilibili-extractor.ts`：Bilibili 视频结构化内容提取
- `src/utils/bilibili-playback-tracker.ts`：Bilibili 播放进度追踪

### 状态管理

- `src/utils/storage-utils.ts`：封装 `browser.storage.local`，`generalSettings` 为全局单例
- `src/managers/`：各功能模块的 UI 管理器（模板、高亮、设置各节等）

### 跨浏览器兼容

- 通过 `webextension-polyfill` 统一 API
- `src/utils/browser-detection.ts` 处理运行时检测
- Manifest 按浏览器分别维护：`manifest.chrome.json`、`manifest.firefox.json`、`manifest.safari.json`
- YouTube 嵌入：Chrome 用 `declarativeNetRequest`；Safari/Firefox 用原生 video 元素

### 调试

代码中使用 `DEBUG_MODE` 全局常量（开发模式为 `true`），通过 `debugLog()` 和 `createLogger()` 输出日志，生产构建时 Terser 的 dead code elimination 会移除这些日志。

## 测试约定

- 测试文件与源文件同目录，命名为 `*.test.ts`
- 使用 Vitest，`webextension-polyfill` 被 mock（见 `src/utils/__mocks__/`）
- 过滤器测试在 `src/utils/filters/*.test.ts`
- 夹具数据在 `src/utils/fixtures/`

## Helper API 设计原则（2026-05-20 weixin 修复 4 轮验收失败后沉淀）

凡是"从页面提取数据"的 helper 函数，签名必须是 `(doc: ParentNode)` 或 `(node: Element)` 等 DOM 类型，**禁止** `(html: string)` / `(rawHtml: string)`。

**正例**：

```ts
export function extractPublishedFromDocument(doc: ParentNode): string {
	const el = doc.querySelector('#publish_time');
	return el?.textContent || '';
}
```

**反例**：

```ts
// 错：依赖字符串 input 来源（curl raw HTML / browser outerHTML / fixture）
// 引入歧义；这种签名是 2026-05-20 weixin 修复 4 轮验收失败的根因之一
export function extractPublishedFromRawHtml(rawHtml: string): string {
	return rawHtml.match(/ct = "(\d+)"/)?.[1] || '';
}
```

**原因**：浏览器 runtime 的 DOM 经过 hydration 后跟服务端 raw HTML 结构差异巨大（详见 BACKLOG §2.18）。接受 `string` = 内部必然要 regex 一段 HTML 字符串，而这段 HTML 是从哪来的会引入歧义；接受 `doc` 用 DOM API（`querySelector` / `textContent`）则浏览器和测试都能直接喂自己环境的 DOM 对象，绕开"字符串到底是哪一刻快照"陷阱。

**例外**：纯字符串处理 helper（如 `markdown-post-process.ts`、URL 解码、JSON parsing）不在此约束内——它们不"从页面提取数据"，input 字符串语义明确。

**测试调用**：单测想直接喂字符串测正则，先 `parseHTML(str).document` 转 DOM 再调 helper：

```ts
import { parseHTML } from 'linkedom';
const { document: doc } = parseHTML('<html><body><em id="publish_time">2026年4月14日</em></body></html>');
expect(extractPublishedFromDocument(doc)).toBe('2026-04-14');
```
