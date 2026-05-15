# scys.com standalone docx 提取器 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 cn extension 能裁剪 `https://scys.com/view/docx/{token}` standalone 飞书文档页面，输出语义完整的 Markdown（标题层级 / 列表 / 表格 / callout / 图片均与浏览器对等）。

**Architecture:** MAIN-world JSON.parse 拦截器（patch script 通过 manifest `content_scripts.run_at:'document_start', world:'MAIN'` 在 scys docx 页面注入）嗅探 scys 客户端解密后的飞书 block 数组并写入 localStorage；content-script 触发裁剪时读出并复用现有 scys-extractor 全部渲染管线（`flattenScysBlocks + convertBlocksToHtml + resolveScysImages`）。现有 scys course 路径零代码变化（仅通过 URL 路由分发新增 docx 分支）。

**Tech Stack:** TypeScript / Plain JS for MAIN-world patch / Vitest / `content_scripts.world: 'MAIN'` (Chrome 111+, Firefox 128+, Safari 18.2+) / CopyWebpackPlugin 静态资源复制

**Spec:** [`docs/superpowers/specs/2026-05-16-scys-docx-extractor-design.md`](../specs/2026-05-16-scys-docx-extractor-design.md)

---

## 自动化基础设施（沿用 scys course 实施时建立的工具）

本 plan 复用 cn 已有的端到端自动化三件套：webpack hot-reload (commit `a04bc32`)、page-world test bridge (`src/content.ts` 末尾) + HTTP receiver (`/tmp/recv_server.py`) + chrome MCP javascript_tool。Task 6（端到端验收）完全自动循环，不需任何手动操作。

**特别注意（dist/ 约定，BACKLOG §2.7）**：dev 与 build 都输出到 `dist/`，扩展恒定加载 `dist/`。`webpack.config.js` 中 `getOutputDir` 已固化不再区分 mode。

---

## File Structure

| 操作 | 路径 | 责任 |
|---|---|---|
| 新建 | `src/scys-docx-patch.js` | MAIN-world IIFE，~30 行 plain JS：wrap JSON.parse 嗅探飞书 block 数组 → localStorage `__cnScysDocxBlocks` |
| 新建 | `src/utils/fixtures/scys-docx-QSn2dD.json` | 真实 docx block 数组 fixture（端到端测试时从 patch 抓出） |
| 修改 | `webpack.config.js` (line ~140-158 CopyPlugin patterns) | 加 `{ from: 'src/scys-docx-patch.js', to: 'scys-docx-patch.js' }` |
| 修改 | `src/manifest.chrome.json` / `manifest.firefox.json` / `manifest.safari.json` | `content_scripts` 数组追加 docx patch 声明 |
| 修改 | `src/utils/scys-extractor.ts` | 新增 `isScysDocxUrl` / `parseScysDocxUrl` / `extractScysDocxStandalone`；现 `extractScysStructuredContent` 函数体重命名为 `extractScysCourseChapter`，新入口仅做 URL 路由 |
| 修改 | `src/utils/scys-extractor.test.ts` | 新增 ~8 个测试在 3 个 describe block |
| 修改 | `src/content.ts` (line 16 + line 276 + line 626) | 加 `isScysDocxUrl` import；两处 URL 判断改为 `isScysCourseUrl OR isScysDocxUrl` |

**复用（不修改）**：`flattenScysBlocks` / `convertBlocksToHtml` / `renderScysChapterContent` / `resolveScysImages` / `countWordsFromBlocks` / `ScysBlock` / `ScysStructuredContent` 接口；现有 background fetch handler；page-world test bridge。

---

## Task 1: URL 检测函数 + 路由分发改造

**Files:**
- Modify: `src/utils/scys-extractor.ts`
- Modify: `src/utils/scys-extractor.test.ts`

### 步骤

- [ ] **Step 1: 写失败测试**

追加到 `src/utils/scys-extractor.test.ts` 末尾：

```ts
import { isScysDocxUrl, parseScysDocxUrl } from './scys-extractor';

describe('isScysDocxUrl', () => {
	it('matches /view/docx/{token}', () => {
		expect(isScysDocxUrl('https://scys.com/view/docx/QSn2dD6QnoYlDxxiYItcudnPnZg')).toBe(true);
		expect(isScysDocxUrl('https://scys.com/view/docx/QSn2dD6QnoYlDxxiYItcudnPnZg/')).toBe(true);
	});
	it('rejects course URLs', () => {
		expect(isScysDocxUrl('https://scys.com/course/detail/172?chapterId=11408')).toBe(false);
	});
	it('rejects /view/wiki/* or other view variants', () => {
		expect(isScysDocxUrl('https://scys.com/view/wiki/ABC')).toBe(false);
		expect(isScysDocxUrl('https://scys.com/view/sheet/XYZ')).toBe(false);
	});
	it('rejects non-scys hosts', () => {
		expect(isScysDocxUrl('https://example.com/view/docx/X')).toBe(false);
	});
	it('rejects malformed URL', () => {
		expect(isScysDocxUrl('not a url')).toBe(false);
	});
});

describe('parseScysDocxUrl', () => {
	it('extracts token', () => {
		expect(parseScysDocxUrl('https://scys.com/view/docx/Abc-XYZ_123')).toEqual({ token: 'Abc-XYZ_123' });
	});
	it('extracts token with trailing slash', () => {
		expect(parseScysDocxUrl('https://scys.com/view/docx/Test/')).toEqual({ token: 'Test' });
	});
	it('returns null for invalid URL', () => {
		expect(parseScysDocxUrl('https://scys.com/foo')).toBeNull();
		expect(parseScysDocxUrl('not a url')).toBeNull();
	});
});
```

用 tab 缩进（项目约定）。

- [ ] **Step 2: 跑测试验证失败**

```bash
npx vitest run src/utils/scys-extractor.test.ts
```

Expected: FAIL with "isScysDocxUrl is not exported"

- [ ] **Step 3: 实现 URL 函数 + 路由改造**

修改 `src/utils/scys-extractor.ts`：

**3a. 追加 URL 函数（建议放在 `isScysCourseUrl` 旁边，约 line 8 附近）**：

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

**3b. 重命名现有 `extractScysStructuredContent` → `extractScysCourseChapter`**：

找到 line ~406 的函数定义：

```ts
export async function extractScysStructuredContent(doc: Document): Promise<ScysStructuredContent | null> {
	if (!isScysCourseUrl(doc.URL)) return null;
	const parsed = parseScysUrl(doc.URL);
	// ... rest of function body ...
}
```

把这整个函数体的**函数名 + export 关键字**改为：

```ts
async function extractScysCourseChapter(doc: Document): Promise<ScysStructuredContent | null> {
	if (!isScysCourseUrl(doc.URL)) return null;
	const parsed = parseScysUrl(doc.URL);
	// ... rest unchanged ...
}
```

注意：
- 去掉 `export`（现在是私有，由新的 router 函数 export）
- 函数体内逻辑**一字不改**

**3c. 在文件**任意合理位置（建议紧跟 `extractScysCourseChapter` 之后）**加新的 router 入口**：

```ts
export async function extractScysStructuredContent(doc: Document): Promise<ScysStructuredContent | null> {
	if (isScysCourseUrl(doc.URL)) return extractScysCourseChapter(doc);
	// Task 3 之后会加 isScysDocxUrl 分支
	return null;
}
```

- [ ] **Step 4: 跑测试验证通过**

```bash
npx vitest run src/utils/scys-extractor.test.ts
```

Expected: PASS（所有 prior 测试 + 8 新测试）

并跑全套：
```bash
npm test 2>&1 | tail -3
```

Expected: 与 baseline 相同（628 pass / 3 known pre-existing failures），无新增 regression

- [ ] **Step 5: Commit**

```bash
git add src/utils/scys-extractor.ts src/utils/scys-extractor.test.ts
git -c commit.gpgsign=false commit -m "$(cat <<'EOF'
feat(scys-docx): add URL detection + route extractScysStructuredContent

Adds isScysDocxUrl + parseScysDocxUrl for /view/docx/{token} URLs.
Renames the existing extractScysStructuredContent function body to
extractScysCourseChapter (private), and turns the export into a thin
URL-based router. Course path receives zero behavioral changes — all
prior tests + acceptance pass unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: MAIN-world JSON.parse patch script

**Files:**
- Create: `src/scys-docx-patch.js`

### 步骤

- [ ] **Step 1: 创建 patch 文件**

创建 `src/scys-docx-patch.js`（plain JavaScript，不走 TS 编译）：

```js
// MAIN-world content_script injected at document_start on scys.com/view/docx/*.
// Wraps JSON.parse to sniff Feishu docx block arrays that scys decrypts
// client-side from /upload/doc/*.json. Captured array is mirrored to
// localStorage so the extension's isolated-world content script can read it.
//
// Side effects:
// - JSON.parse is wrapped (transparent: original result always returned).
// - localStorage key '__cnScysDocxBlocks' written when blocks captured.
// - <html> attr 'data-cn-scys-docx-blocks' = block count (debug marker).
//
// Why plain JS not TS: webpack runtime overhead unwarranted for ~30 lines;
// MAIN-world script can't import webextension-polyfill or chrome.* APIs anyway.
(function () {
	if (window.__cnScysDocxPatchInstalled) return;
	window.__cnScysDocxPatchInstalled = true;

	var originalParse = JSON.parse;

	function isFeishuBlockArray(value) {
		if (!Array.isArray(value) || value.length === 0) return false;
		// Sample first 3 — full scan would be O(n) on every parse call.
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

- [ ] **Step 2: 验证语法**

```bash
node -c src/scys-docx-patch.js
```

Expected: 无输出（syntax OK）

- [ ] **Step 3: Commit**

```bash
git add src/scys-docx-patch.js
git -c commit.gpgsign=false commit -m "$(cat <<'EOF'
feat(scys-docx): add MAIN-world JSON.parse patch script

Plain JS IIFE injected via manifest content_scripts run_at:'document_start'
world:'MAIN' on scys.com/view/docx/*. Wraps JSON.parse transparently;
sniffs return value for Feishu block array shape (Array + first 3 entries
have block_id:string + block_type:number). When matched, mirrors to
localStorage['__cnScysDocxBlocks'] keeping the largest-length capture.
Sets data-cn-scys-docx-blocks attribute on <html> as debug marker.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: webpack 配置 + manifest 声明

**Files:**
- Modify: `webpack.config.js`
- Modify: `src/manifest.chrome.json`
- Modify: `src/manifest.firefox.json`
- Modify: `src/manifest.safari.json`

### 步骤

- [ ] **Step 1: 加 webpack CopyPlugin 复制规则**

修改 `webpack.config.js` line ~140 附近的 `patterns` 数组，在 `flatten-shadow-dom.js` 行之后追加一项：

找到：
```js
				{ from: "src/flatten-shadow-dom.js", to: "flatten-shadow-dom.js" },
				{
					from: 'src/_locales',
					to: '_locales'
				}
```

改为：
```js
				{ from: "src/flatten-shadow-dom.js", to: "flatten-shadow-dom.js" },
				{ from: "src/scys-docx-patch.js", to: "scys-docx-patch.js" },
				{
					from: 'src/_locales',
					to: '_locales'
				}
```

- [ ] **Step 2: 加 manifest 声明（三份）**

每个 manifest 的 `content_scripts` 数组追加一项。

**`src/manifest.chrome.json`**：找到现有：

```json
"content_scripts": [
  {
    "matches": ["http://*/*", "https://*/*"],
    "js": ["browser-polyfill.min.js", "content.js"]
  }
]
```

改为：

```json
"content_scripts": [
  {
    "matches": ["http://*/*", "https://*/*"],
    "js": ["browser-polyfill.min.js", "content.js"]
  },
  {
    "matches": ["https://scys.com/view/docx/*"],
    "js": ["scys-docx-patch.js"],
    "run_at": "document_start",
    "world": "MAIN"
  }
]
```

**`src/manifest.firefox.json`** 和 **`src/manifest.safari.json`** 同样追加完全相同的第二项。

- [ ] **Step 3: 验证 manifest JSON 合法**

```bash
for f in src/manifest.chrome.json src/manifest.firefox.json src/manifest.safari.json; do
  echo "==== $f ===="
  jq . "$f" > /dev/null && echo "valid"
done
```

Expected: 三个文件都 "valid"

- [ ] **Step 4: 验证 manifest 都含 docx patch 声明**

```bash
for f in src/manifest.chrome.json src/manifest.firefox.json src/manifest.safari.json; do
  echo "==== $f ===="
  jq '.content_scripts[] | select(.js[]? | contains("scys-docx-patch"))' "$f"
done
```

Expected: 三个文件都打印出含 `scys-docx-patch.js` 的 content_script 对象

- [ ] **Step 5: build:chrome 验证 dist/scys-docx-patch.js 存在**

```bash
npm run build:chrome 2>&1 | tail -5
ls -la dist/scys-docx-patch.js
```

Expected: build 成功；`dist/scys-docx-patch.js` 存在且与 src 内容一致

- [ ] **Step 6: 验证 dist/manifest.json 含 docx patch 声明**

```bash
jq '.content_scripts[] | select(.js[]? | contains("scys-docx-patch"))' dist/manifest.json
```

Expected: 输出含 `"world": "MAIN"` 的对象

- [ ] **Step 7: Commit**

```bash
git add webpack.config.js src/manifest.chrome.json src/manifest.firefox.json src/manifest.safari.json
git -c commit.gpgsign=false commit -m "$(cat <<'EOF'
feat(scys-docx): register MAIN-world patch script for /view/docx/*

webpack CopyPlugin copies src/scys-docx-patch.js → dist/ unchanged.
Three manifests get content_scripts entry matching scys.com/view/docx/*
with run_at:'document_start' + world:'MAIN' so JSON.parse wrapper
is installed before scys page JS runs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: extractScysDocxStandalone 主体 + router 完整接入

**Files:**
- Modify: `src/utils/scys-extractor.ts`
- Modify: `src/utils/scys-extractor.test.ts`

### 步骤

- [ ] **Step 1: 写失败测试**

追加到 `src/utils/scys-extractor.test.ts`：

```ts
describe('extractScysDocxStandalone (via router)', () => {
	const originalGetItem = Storage.prototype.getItem;
	afterEach(() => { Storage.prototype.getItem = originalGetItem; });

	it('returns null when no captured blocks in localStorage', async () => {
		Storage.prototype.getItem = vi.fn().mockReturnValue(null);
		const doc = { URL: 'https://scys.com/view/docx/Test', title: 'Test' } as any;
		expect(await extractScysStructuredContent(doc)).toBeNull();
	});

	it('returns null when captured blocks is empty array', async () => {
		Storage.prototype.getItem = vi.fn().mockReturnValue('[]');
		const doc = { URL: 'https://scys.com/view/docx/Test', title: 'Test' } as any;
		expect(await extractScysStructuredContent(doc)).toBeNull();
	});

	it('returns null when captured blocks is malformed JSON', async () => {
		Storage.prototype.getItem = vi.fn().mockReturnValue('not-json');
		const doc = { URL: 'https://scys.com/view/docx/Test', title: 'Test' } as any;
		expect(await extractScysStructuredContent(doc)).toBeNull();
	});

	it('renders content from captured blocks (reusing course fixture)', async () => {
		const fixture = (await import('./fixtures/scys-chapter-11408.json')) as any;
		const blocks = fixture.default.data.chapter.content;
		Storage.prototype.getItem = vi.fn().mockReturnValue(JSON.stringify(blocks));
		const doc = { URL: 'https://scys.com/view/docx/Test', title: 'AI 工具怎么选丨超级 AI 大航海丨生财有术' } as any;
		const result = await extractScysStructuredContent(doc);
		expect(result).not.toBeNull();
		expect(result?.title).toBe('AI 工具怎么选');  // suffix stripped
		expect(result?.content).toContain('<h2>0. 本章概要</h2>');
		expect(result?.content).toContain('class="feishu-callout"');
		expect(result?.author).toBe('');
		expect(result?.wordCount).toBeGreaterThan(100);
	});

	it('strips only 丨生财有术 suffix when 丨超级 AI 大航海 absent', async () => {
		Storage.prototype.getItem = vi.fn().mockReturnValue('[{"block_id":"x","block_type":2,"text":{"elements":[]}}]');
		const doc = { URL: 'https://scys.com/view/docx/X', title: '简单标题丨生财有术' } as any;
		const result = await extractScysStructuredContent(doc);
		expect(result?.title).toBe('简单标题');
	});

	it('falls back to original title when suffix patterns not present', async () => {
		Storage.prototype.getItem = vi.fn().mockReturnValue('[{"block_id":"x","block_type":2,"text":{"elements":[]}}]');
		const doc = { URL: 'https://scys.com/view/docx/X', title: 'Pure Title' } as any;
		const result = await extractScysStructuredContent(doc);
		expect(result?.title).toBe('Pure Title');
	});
});
```

- [ ] **Step 2: 跑测试验证失败**

```bash
npx vitest run src/utils/scys-extractor.test.ts
```

Expected: FAIL（router 仍只处理 course，docx URL 命中后返回 null 因为没有 extractScysDocxStandalone 分支）。具体哪些测试失败因实现而异；至少最后 3 个会失败。

- [ ] **Step 3: 实现 extractScysDocxStandalone**

在 `src/utils/scys-extractor.ts` 中，找到 Task 1 加入的 router 函数：

```ts
export async function extractScysStructuredContent(doc: Document): Promise<ScysStructuredContent | null> {
	if (isScysCourseUrl(doc.URL)) return extractScysCourseChapter(doc);
	return null;
}
```

改为：

```ts
export async function extractScysStructuredContent(doc: Document): Promise<ScysStructuredContent | null> {
	if (isScysCourseUrl(doc.URL)) return extractScysCourseChapter(doc);
	if (isScysDocxUrl(doc.URL)) return extractScysDocxStandalone(doc);
	return null;
}
```

在文件**任意合理位置**（建议紧跟 `extractScysCourseChapter` 之后）加新函数：

```ts
async function extractScysDocxStandalone(doc: Document): Promise<ScysStructuredContent | null> {
	const raw = localStorage.getItem('__cnScysDocxBlocks');
	if (!raw) {
		logger.warn('[scys-docx] no decrypted blocks captured; patch may not have run');
		return null;
	}
	let blocks: ScysBlock[];
	try {
		blocks = JSON.parse(raw);
	} catch (err) {
		logger.warn(`[scys-docx] failed to parse captured blocks: ${String(err)}`);
		return null;
	}
	if (!Array.isArray(blocks) || blocks.length === 0) return null;

	let html = renderScysChapterContent(blocks);
	html = await resolveScysImages(html);

	// title 后处理：剥离 "丨超级 AI 大航海..." 与 "丨生财有术" 品牌 suffix
	const rawTitle = doc.title || '';
	const stripped = rawTitle
		.replace(/丨超级\s*AI\s*大航海.*$/, '')
		.replace(/丨生财有术$/, '')
		.trim();
	const title = stripped || rawTitle;

	const wordCount = countWordsFromBlocks(flattenScysBlocks(blocks));

	return { title, author: '', content: html, wordCount };
}
```

`logger` / `ScysBlock` / `renderScysChapterContent` / `resolveScysImages` / `flattenScysBlocks` / `countWordsFromBlocks` / `ScysStructuredContent` 都已在文件中可用，无需新增 import。

- [ ] **Step 4: 跑测试验证通过**

```bash
npx vitest run src/utils/scys-extractor.test.ts
```

Expected: 所有测试 PASS（含 6 个新 docx 测试 + 全部 prior 测试）

并跑全套：

```bash
npm test 2>&1 | tail -3
```

Expected: 与 baseline 一致（无新 regression）

- [ ] **Step 5: Commit**

```bash
git add src/utils/scys-extractor.ts src/utils/scys-extractor.test.ts
git -c commit.gpgsign=false commit -m "$(cat <<'EOF'
feat(scys-docx): add extractScysDocxStandalone reading from localStorage

Reads Feishu block array captured by MAIN-world JSON.parse patch (from
localStorage key __cnScysDocxBlocks), reuses the full course pipeline
(renderScysChapterContent + resolveScysImages + countWordsFromBlocks),
and post-processes document.title to strip scys-specific brand suffix.

Returns null when patch hasn't captured anything yet, so the upstream
pipeline falls back to Defuddle generic extraction (zero regression).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: content.ts 接入

**Files:**
- Modify: `src/content.ts` (line 16 import + line 276 + line 626)

### 步骤

- [ ] **Step 1: 加 isScysDocxUrl 到 import 行**

`src/content.ts` line 16 现有：

```ts
import { extractScysStructuredContent, isScysCourseUrl } from './utils/scys-extractor';
```

改为：

```ts
import { extractScysStructuredContent, isScysCourseUrl, isScysDocxUrl } from './utils/scys-extractor';
```

- [ ] **Step 2: 修改主提取分支条件（line 276 附近）**

找到：

```ts
			const scysContent = isScysCourseUrl(document.URL)
				? await extractScysStructuredContent(document).catch((error) => {
					contentLogger.warn('Failed to extract scys structured content', { error: String(error) });
					return null;
				})
				: null;
```

改为：

```ts
			const scysContent = (isScysCourseUrl(document.URL) || isScysDocxUrl(document.URL))
				? await extractScysStructuredContent(document).catch((error) => {
					contentLogger.warn('Failed to extract scys structured content', { error: String(error) });
					return null;
				})
				: null;
```

- [ ] **Step 3: 修改 test bridge URL 路由（line 626 附近）**

找到：

```ts
				if (isScysCourseUrl(document.URL)) {
					result = await extractScysStructuredContent(document);
					source = 'scys';
				} else if (isFeishuDocUrl(document.URL)) {
```

改为：

```ts
				if (isScysCourseUrl(document.URL) || isScysDocxUrl(document.URL)) {
					result = await extractScysStructuredContent(document);
					source = 'scys';
				} else if (isFeishuDocUrl(document.URL)) {
```

- [ ] **Step 4: typecheck pass**

```bash
npx tsc --noEmit 2>&1 | tail -10
```

Expected: 无新错误（既有的 pre-existing errors 不变）

- [ ] **Step 5: 全套测试 pass**

```bash
npm test 2>&1 | tail -3
```

Expected: 与 baseline 一致

- [ ] **Step 6: Commit**

```bash
git add src/content.ts
git -c commit.gpgsign=false commit -m "$(cat <<'EOF'
feat(scys-docx): wire docx URL into content.ts + test bridge

Adds isScysDocxUrl to the import line; extends two URL guards (main
extraction branch + page-world test bridge) from isScysCourseUrl-only
to OR isScysDocxUrl. Both code paths share the same router function
extractScysStructuredContent, so docx handling is transparent.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: 端到端自动化验收

**Files:** 仅产出验收报告 + 任何修复 commit；无新代码文件

**前提**：用户已在 chrome 加载 dist/ 扩展（per CLAUDE.md / BACKLOG §2.7 约定）

### 6.1 准备阶段

- [ ] **Step 1: 启动 webpack dev 后台 watch**

```bash
lsof -i:17923 -t 2>/dev/null | xargs -r kill -9 2>/dev/null
ps aux | grep "webpack.*BROWSER=chrome" | grep -v grep | awk '{print $2}' | xargs -r kill -9 2>/dev/null
sleep 1

nohup npm run dev:chrome > /tmp/scys-docx-dev.log 2>&1 &
echo $! > /tmp/scys-docx-dev.pid
disown
sleep 1
```

确认首次 build 完成：

```bash
until grep -q "compiled successfully" /tmp/scys-docx-dev.log 2>/dev/null; do sleep 2; done
ls -la dist/build-marker.txt dist/scys-docx-patch.js
grep -c "JSON.parse" dist/scys-docx-patch.js
```

Expected: build-marker.txt 时间戳最新；`dist/scys-docx-patch.js` 存在；含 1 个或多个 `JSON.parse` 引用

- [ ] **Step 2: 等 chrome.alarms reload extension**

```bash
sleep 6
date
```

- [ ] **Step 3: 在 chrome 中 navigate scys docx 页面 + 验证 patch 注入**

使用 claude-in-chrome `mcp__claude-in-chrome__tabs_context_mcp` 找当前 scys tab id（或 `mcp__claude-in-chrome__tabs_create_mcp` 新建）。

设 tabId 后 navigate：

```
mcp__claude-in-chrome__navigate(tabId, 'https://scys.com/view/docx/QSn2dD6QnoYlDxxiYItcudnPnZg')
```

等 page 加载完成。验证 patch 注入：

```js
new Promise(r => setTimeout(() => r({
  patchInstalled: !!window.__cnScysDocxPatchInstalled,
  blocksAttr: document.documentElement.getAttribute('data-cn-scys-docx-blocks'),
  localStorageHas: !!localStorage.getItem('__cnScysDocxBlocks'),
  capturedBlockCount: localStorage.getItem('__cnScysDocxBlocks')
    ? JSON.parse(localStorage.getItem('__cnScysDocxBlocks')).length
    : 0,
  url: location.href,
  buildMarker: document.documentElement.getAttribute('data-cn-clipper-build'),
}), 6000));
```

Expected:
- `patchInstalled: true` ← patch 注入成功
- `blocksAttr` 是某正整数字符串（如 "200"）← 捕获成功
- `localStorageHas: true`
- `capturedBlockCount > 0` ← 捕到飞书 block 数组
- `buildMarker` 是新时间戳

如果 `patchInstalled: false`：检查 dist/manifest.json 是否含 docx patch 声明；浏览器版本是否 ≥ Chrome 111。
如果 `patchInstalled: true` 但 `capturedBlockCount === 0`：等更久（patch 在 scys 解密前已生效，但 scys 解密本身需要时间）；或检查 scys 是否真的走 JSON.parse 形态。

### 6.2 抓 fixture 用于回归测试

- [ ] **Step 4: 从 localStorage 抓 block 数组写入 fixture**

启动 receiver：

```bash
mkdir -p src/utils/fixtures
lsof -i:17923 -t 2>/dev/null | xargs -r kill -9 2>/dev/null
nohup python3 /tmp/recv_server.py "$(pwd)/src/utils/fixtures/scys-docx-QSn2dD.json" 17923 > /tmp/recv-docx.log 2>&1 < /dev/null &
disown
sleep 0.5
lsof -i:17923 -t && echo "receiver up"
```

用 javascript_tool 把 localStorage 内容 POST 到 receiver：

```js
fetch('http://127.0.0.1:17923/', {
  method: 'POST',
  body: localStorage.getItem('__cnScysDocxBlocks')
}).then(r => r.text()).then(t => 'uploaded: ' + t);
```

Expected: `"uploaded: OK <bytes>"`

- [ ] **Step 5: 验证 fixture**

```bash
jq 'length, .[0].block_id, .[0].block_type, [.[].block_type] | unique' src/utils/fixtures/scys-docx-QSn2dD.json
```

Expected: 第一个数字是 block 总数（应 > 50）；第二个是 block_id 字符串；第三个是 block_type 数字（typically 1 = PAGE）；第四个是 unique block_type 列表

- [ ] **Step 6: Commit fixture**

```bash
git add -f src/utils/fixtures/scys-docx-QSn2dD.json
git -c commit.gpgsign=false commit -m "test(scys-docx): add real fixture captured via patch from QSn2dD docx"
```

### 6.3 单轮端到端裁剪 + markdown 校验

- [ ] **Step 7: 启动 receiver 接收 markdown**

```bash
OUT="/Users/adu/Documents/Obsidian /Life/_cn-test/scys-docx-test.md"
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
lsof -i:17923 -t 2>/dev/null | xargs -r kill -9 2>/dev/null
nohup python3 /tmp/recv_server.py "$OUT" 17923 > /tmp/recv-docx.log 2>&1 < /dev/null &
disown
sleep 0.5
lsof -i:17923 -t && echo "receiver up"
```

- [ ] **Step 8: 触发 bridge**

`javascript_tool` 在 scys docx tab：

```js
const testId = 'scys-docx-' + Date.now();
const key = '__obsidianClipperTestResult__:' + testId;
localStorage.setItem(key, JSON.stringify({ status: 'pending' }));
window.postMessage({
  type: '__obsidianClipperTestExtract__',
  testId,
  uploadUrl: 'http://127.0.0.1:17923/'
}, location.origin);
testId;
```

记下 testId。

- [ ] **Step 9: 等 receiver 写文件**

```bash
until [ -s "/Users/adu/Documents/Obsidian /Life/_cn-test/scys-docx-test.md" ]; do sleep 3; done
date
ls -la "/Users/adu/Documents/Obsidian /Life/_cn-test/scys-docx-test.md"
```

Expected: 文件非空（> 5KB）

- [ ] **Step 10: poll localStorage 拿 bridge 摘要**

`javascript_tool`（替换实际 testId）：

```js
const raw = localStorage.getItem('__obsidianClipperTestResult__:PASTE_TEST_ID_FROM_STEP_8');
JSON.stringify(JSON.parse(raw), null, 2);
```

Expected: `status: 'done'`, `source: 'scys'`, `title` 不含 "丨生财有术" suffix

- [ ] **Step 11: 渲染 + Python 结构化校验**

```bash
FILE="/Users/adu/Documents/Obsidian /Life/_cn-test/scys-docx-test.md"
OUT=/tmp/scys-docx-preview.html

python3 <<PYEOF
import markdown_it
md = markdown_it.MarkdownIt('gfm-like', {'html': False, 'linkify': False})
with open('$FILE') as f: body = md.render(f.read())
with open('$OUT','w') as f: f.write('<!DOCTYPE html><html><body>' + body + '</body></html>')
PYEOF

python3 <<'PYEOF'
import re, base64
from html.parser import HTMLParser

class Counter(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tags = {}; self.bq_depth = 0; self.max_bq = 0
        self.img_srcs = []; self.h2_texts = []; self.h3_texts = []; self.h4_texts = []
        self.cur_h = None; self.cur_text = ''; self.broken_escapes = 0
    def handle_starttag(self, tag, attrs):
        self.tags[tag] = self.tags.get(tag, 0) + 1
        if tag == 'blockquote':
            self.bq_depth += 1; self.max_bq = max(self.max_bq, self.bq_depth)
        if tag == 'img':
            for k, v in attrs:
                if k == 'src': self.img_srcs.append(v)
        if tag in ('h2','h3','h4'):
            self.cur_h = tag; self.cur_text = ''
    def handle_endtag(self, tag):
        if tag == 'blockquote': self.bq_depth -= 1
        if tag in ('h2','h3','h4') and self.cur_h == tag:
            getattr(self, f'{tag}_texts').append(self.cur_text.strip()); self.cur_h = None
    def handle_data(self, data):
        if self.cur_h: self.cur_text += data
        bracket = chr(0x5C) + '[!quote' + chr(0x5C) + ']'
        if bracket in data: self.broken_escapes += 1

with open('/tmp/scys-docx-preview.html') as f: p = Counter(); p.feed(f.read())

# Image validation
data_count = http_count = bad_count = 0
mismatches = []
for i, src in enumerate(p.img_srcs):
    if src.startswith('data:image/'):
        m = re.match(r'data:image/([a-z]+);base64,(.+)$', src)
        if not m: bad_count += 1; continue
        mime, b64 = m.group(1), m.group(2)
        try:
            decoded = base64.b64decode(b64, validate=False)
            data_count += 1
            actual = '?'
            if decoded.startswith(b'\x89PNG'): actual = 'png'
            elif decoded.startswith(b'\xff\xd8'): actual = 'jpeg'
            elif decoded.startswith(b'GIF8'): actual = 'gif'
            elif decoded.startswith(b'RIFF') and b'WEBP' in decoded[:16]: actual = 'webp'
            if actual != '?' and actual != mime:
                mismatches.append((i, mime, actual))
                bad_count += 1
        except: bad_count += 1
    elif src.startswith('http'): http_count += 1
    else: bad_count += 1

print(f'H2: {len(p.h2_texts)}  H3: {len(p.h3_texts)}  H4: {len(p.h4_texts)}')
print(f'<table>: {p.tags.get("table",0)}  <tr>: {p.tags.get("tr",0)}  <li>: {p.tags.get("li",0)}  <blockquote>: {p.tags.get("blockquote",0)}')
print(f'<img>: {len(p.img_srcs)}  base64: {data_count}  http: {http_count}  mismatched-mime: {bad_count}')
print(f'broken escapes: {p.broken_escapes}')
print(f'H2 sample: {p.h2_texts[:3]}')

gates = [
    ('H2 ≥ 1', len(p.h2_texts) >= 1),
    ('no broken escapes', p.broken_escapes == 0),
    ('images all base64 (if any)', http_count == 0),
    ('images MIME consistent (if any)', bad_count == 0),
    ('has at least some structure (tags + headings > 5)', sum(p.tags.values()) > 5),
]
all_pass = True
print()
for label, ok in gates:
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}")
    if not ok: all_pass = False
print()
print('OVERALL:', 'PASS' if all_pass else 'FAIL')
PYEOF
```

Expected: OVERALL PASS

- [ ] **Step 12: 验证 markdown title 正确**

```bash
FILE="/Users/adu/Documents/Obsidian /Life/_cn-test/scys-docx-test.md"
head -1 "$FILE"
echo "---"
# Title should NOT contain "丨生财有术" or "丨超级 AI 大航海"
grep -E "丨(生财有术|超级.{0,5}AI.{0,5}大航海)" "$FILE" | head -3
```

Expected: head -1 显示某 markdown 内容；grep 行无输出（title suffix 已剥离）

### 6.4 Course 路径 regression 验证

- [ ] **Step 13: 复跑 scys course 端到端验收**

```bash
# Navigate course tab
```

`mcp__claude-in-chrome__navigate(tabId, 'https://scys.com/course/detail/172?chapterId=11408')`

等 6 秒页面加载，启动 receiver 收 course markdown：

```bash
OUT_COURSE="/Users/adu/Documents/Obsidian /Life/_cn-test/scys-course-regress.md"
rm -f "$OUT_COURSE"
lsof -i:17923 -t 2>/dev/null | xargs -r kill -9 2>/dev/null
nohup python3 /tmp/recv_server.py "$OUT_COURSE" 17923 > /tmp/recv-course-regress.log 2>&1 < /dev/null &
disown
sleep 0.5
```

`javascript_tool` 触发 bridge（在 course tab）：

```js
const testId = 'course-regress-' + Date.now();
window.postMessage({type:'__obsidianClipperTestExtract__', testId, uploadUrl:'http://127.0.0.1:17923/'}, location.origin);
testId;
```

等 receiver 写文件后 grep 关键指标：

```bash
F="/Users/adu/Documents/Obsidian /Life/_cn-test/scys-course-regress.md"
echo "h2 (expect 7): $(grep -cE '^## ' "$F")"
echo "comments header (expect 1): $(grep -cE '章节评论' "$F")"
echo "base64 images (expect 71): $(grep -cE 'data:image/[a-z]+;base64,' "$F")"
echo "broken escape (expect 0): $(grep -c '\\\[!quote' "$F")"
```

Expected: 7 / 1 / 71 / 0 — 与 scys course 实施完成时 (`dd0e028`) 数字一致，无 regression

- [ ] **Step 14: 清理 + 最终 commit（如有 bug 修复）**

```bash
kill $(cat /tmp/scys-docx-dev.pid 2>/dev/null) 2>/dev/null
lsof -i:17923 -t 2>/dev/null | xargs -r kill -9 2>/dev/null

git status
# 若 6.3-6.4 发现 bug 并已修复：
# git add -A
# git -c commit.gpgsign=false commit -m "fix(scys-docx): {根据实际修复填}"

# 否则:
echo "All acceptance gates passed; no fixes needed"
```

- [ ] **Step 15: 跨浏览器 build 验证**

```bash
npm run build 2>&1 | tail -10
```

Expected: chrome / firefox / safari 三个 build 全部 success；每个 dist*/manifest.json 都含 docx patch 声明：

```bash
for f in dist/manifest.json dist_firefox/manifest.json dist_safari/manifest.json; do
  echo "==== $f ===="
  jq '.content_scripts[] | select(.js[]? | contains("scys-docx-patch"))' "$f" | head -8
done
```

Expected: 三个文件都打印出含 `"world": "MAIN"` 的 content_script 对象

- [ ] **Step 16: 跑全套单测**

```bash
npm test 2>&1 | tail -3
```

Expected: 与 scys course 实施完成时 baseline 一致（628 pass + 3 known pre-existing failures），加上本 plan 新增的 ~14 个 docx 测试，共 ~642 pass

---

## Spec-Plan Deltas（自审记录）

无显著偏离。Task 6 的验收 gate 比 spec §5.3 描述更具体（含实际 grep 数字）— 这是 fixture 抓取后才能定的，符合 spec "Task 0 抓 fixture 后定准" 的描述。

## 后续改进（不在本计划范围内）

- 旧版 Firefox/Safari 通过 `chrome.scripting.registerContentScripts` 动态降级（当前接受静态 manifest + 旧浏览器走 Defuddle）
- scys 其他 view 形态 `/view/wiki/*` / `/view/sheet/*` 支持（遇到再实施）
- docx 内的 callout block 保留 Obsidian `[!tip]` 类型标记（与 course 同样的 Spec-Plan Delta，归到 BACKLOG §6.7 一并解决）
