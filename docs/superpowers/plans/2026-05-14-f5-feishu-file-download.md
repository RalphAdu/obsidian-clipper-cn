# F5：飞书文档附件下载 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 飞书 FILE block 在剪存时下载附件作为 base64 data URL 嵌入 markdown；超 10MB 留 fallback 占位。

**Architecture:** 复制图片下载路径：feishu-extractor 把 FILE block 渲染为 `<a href="feishu-file://TOKEN">` 占位 → `resolveFeishuFiles` 在最后阶段把所有占位 token 通过 background message 转 data URL → background `fetchFeishuFileAsBase64` 调飞书 OpenAPI `/medias/{token}/download` 端点。

**Tech Stack:** TypeScript / Fetch API / FileReader / browser.runtime.sendMessage / 飞书 OpenAPI

**Spec:** `docs/superpowers/specs/2026-05-14-f5-feishu-file-download-design.md`

---

## File Structure

**修改：**
- `src/background.ts` — 新增 `fetchFeishuFileAsBase64()` 函数 + `'fetchFeishuFile'` message handler
- `src/utils/feishu-extractor.ts` — 改 FILE block 渲染 + 新增 `fetchFeishuFileDataUrl()` / `resolveFeishuFiles()` / `formatFileSize()` 函数
- `README.md` — 飞书章节加附件说明
- `README_EN.md` — 同上英文

**不修改：**
- manifest（host_permissions 已包含 `open.feishu.cn`）
- 其他飞书 block 类型处理

---

## Task 1：background.ts 加 fetchFeishuFile 处理

**Files:**
- Modify: `src/background.ts:251-277`（在 `fetchFeishuImageAsBase64` 之后插入新函数）
- Modify: `src/background.ts:870-885`（在 `fetchFeishuImage` action 之后插入新 handler）
- Modify: `src/background.ts:1211-1216`（async response allowlist 中加 `fetchFeishuFile`）

- [ ] **Step 1.1：阅读现有 `fetchFeishuImageAsBase64`（行 251-277）作为参考**

确认函数签名、错误处理风格、tenant token 用法。

- [ ] **Step 1.2：在 `fetchFeishuImageAsBase64` 函数末尾（行 277 之后）插入新函数**

打开 `src/background.ts`，在行 277 之后插入：

```ts
const FEISHU_FILE_SIZE_CAP_BYTES = 10 * 1024 * 1024; // 10 MB

async function fetchFeishuFileAsBase64(fileToken: string): Promise<{
	dataUrl?: string;
	tooLarge?: boolean;
	size?: number;
	mimeType?: string;
	filename?: string;
}> {
	const url = `https://open.feishu.cn/open-apis/drive/v1/medias/${fileToken}/download`;
	if (!isAllowedFeishuFetchUrl(url)) {
		throw new Error('Blocked Feishu file URL');
	}

	const token = await getFeishuTenantToken();

	// Try HEAD first to check size without downloading
	let knownSize: number | undefined;
	try {
		const headResp = await fetch(url, {
			method: 'HEAD',
			headers: { Authorization: `Bearer ${token}` },
			cache: 'no-store',
		});
		if (headResp.ok) {
			const len = headResp.headers.get('Content-Length');
			if (len) {
				const parsed = parseInt(len, 10);
				if (!isNaN(parsed)) knownSize = parsed;
			}
			if (knownSize !== undefined && knownSize > FEISHU_FILE_SIZE_CAP_BYTES) {
				return { tooLarge: true, size: knownSize };
			}
		}
		// HEAD failed or no Content-Length: proceed to GET; size check after download
	} catch {
		// Some Feishu endpoints reject HEAD with 405; fall through to GET
	}

	const response = await fetch(url, {
		method: 'GET',
		headers: { Authorization: `Bearer ${token}` },
		cache: 'no-store',
	});

	if (!response.ok) {
		throw new Error(`Feishu file fetch failed: HTTP ${response.status}`);
	}

	const mimeType = response.headers.get('Content-Type') || 'application/octet-stream';
	const buffer = await response.arrayBuffer();
	const size = buffer.byteLength;

	if (size > FEISHU_FILE_SIZE_CAP_BYTES) {
		return { tooLarge: true, size };
	}

	const bytes = new Uint8Array(buffer);
	let binary = '';
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	const base64 = btoa(binary);
	return {
		dataUrl: `data:${mimeType};base64,${base64}`,
		size,
		mimeType,
	};
}
```

- [ ] **Step 1.3：在 `fetchFeishuImage` message handler 之后（行 885 之后，`sidePanelOpened` 之前）插入新 handler**

```ts
		if (typedRequest.action === 'fetchFeishuFile') {
			const fileToken = (typedRequest as any).fileToken as string;
			if (!fileToken) {
				sendResponse({ success: false, error: 'Missing fileToken' });
				return true;
			}
			fetchFeishuFileAsBase64(fileToken).then((result) => {
				sendResponse({ success: true, ...result });
			}).catch((error) => {
				sendResponse({
					success: false,
					error: error instanceof Error ? error.message : String(error)
				});
			});
			return true;
		}
```

- [ ] **Step 1.4：把 `fetchFeishuFile` 加入 async response allowlist**

找到 background.ts 行 1213 附近的 allowlist（包含 `fetchFeishuImage` 等的 if-block）。在那里加入 `'fetchFeishuFile'`：

```ts
		if (typedRequest.action === 'fetchFeishuImagesViaMainWorld' ||
			typedRequest.action === 'fetchFeishuImage' ||
			typedRequest.action === 'fetchFeishuFile') {
			return true;
		}
```

具体行号可能略有不同 —— grep `'fetchFeishuImage'` 找到 allowlist 那一段，按现有风格加入。

- [ ] **Step 1.5：TypeScript 类型检查**

```bash
cd /Users/adu/Workspace/github/obsidian-clipper/obsidian-clipper-cn
npx tsc --noEmit 2>&1 | grep "src/background.ts" | head -10
```
Expected：无错误。

- [ ] **Step 1.6：跑构建确认无 break**

```bash
npm run build:chrome 2>&1 | tail -3
```
Expected：成功，3 warnings。

---

## Task 2：feishu-extractor.ts 加 file 处理

**Files:**
- Modify: `src/utils/feishu-extractor.ts:676-682`（FILE block 渲染）
- Modify: `src/utils/feishu-extractor.ts:295` 附近（添加 `fetchFeishuFileDataUrl` + `resolveFeishuFiles` + `formatFileSize`）
- Modify: `extractFeishuStructuredContent` 函数（在 `resolveFeishuImages` 调用之后追加 `resolveFeishuFiles`）

- [ ] **Step 2.1：找 `extractFeishuStructuredContent` 中调用 `resolveFeishuImages` 的位置**

```bash
grep -n "resolveFeishuImages\b" src/utils/feishu-extractor.ts | head -5
```
记录该函数的调用位置（应在 extractor 主流程末尾）。

- [ ] **Step 2.2：在 `fetchFeishuImageDataUrl` 函数之后（行 315 之后）插入新 helper 和函数**

打开 `src/utils/feishu-extractor.ts`，在行 315（`fetchFeishuImageDataUrl` 函数闭合大括号之后、空行之后）插入：

```ts
function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function fetchFeishuFileDataUrl(fileToken: string): Promise<{
	dataUrl?: string;
	tooLarge?: boolean;
	size?: number;
	error?: string;
}> {
	try {
		const response = await browser.runtime.sendMessage({
			action: 'fetchFeishuFile',
			fileToken,
		}) as { success?: boolean; dataUrl?: string; tooLarge?: boolean; size?: number; error?: string };

		if (!response?.success) {
			logger.warn(`File binary fetch failed [${fileToken}]: ${response?.error}`);
			return { error: response?.error || 'unknown' };
		}
		if (response.tooLarge) {
			return { tooLarge: true, size: response.size };
		}
		if (response.dataUrl) {
			return { dataUrl: response.dataUrl, size: response.size };
		}
		return { error: 'no dataUrl in response' };
	} catch (err) {
		logger.warn(`File binary fetch error [${fileToken}]: ${String(err)}`);
		return { error: String(err) };
	}
}

async function resolveFeishuFiles(html: string): Promise<string> {
	const linkPattern = /<a href="feishu-file:\/\/([A-Za-z0-9_-]+)" data-filename="([^"]*)"(?: data-size="(\d+)")?>([^<]*)<\/a>/g;
	const matches: Array<{
		full: string;
		token: string;
		filename: string;
		dataSize?: number;
		displayName: string;
	}> = [];
	let match: RegExpExecArray | null;
	while ((match = linkPattern.exec(html)) !== null) {
		matches.push({
			full: match[0],
			token: match[1],
			filename: match[2],
			dataSize: match[3] ? parseInt(match[3], 10) : undefined,
			displayName: match[4],
		});
	}

	if (matches.length === 0) return html;

	logger.debug(`Resolving ${matches.length} Feishu file(s)`);

	let result = html;
	for (const m of matches) {
		// Client-side size pre-check using block.file.size (when available),
		// to skip HEAD/GET for known-large files.
		if (m.dataSize !== undefined && m.dataSize > 10 * 1024 * 1024) {
			const size = formatFileSize(m.dataSize);
			const fallback = `<p>📎 <strong>${escapeHtml(m.filename)}</strong> <em>(${size} — 请到原飞书文档下载)</em></p>`;
			result = result.replace(m.full, fallback);
			continue;
		}

		const res = await fetchFeishuFileDataUrl(m.token);
		let replacement: string;
		if (res.dataUrl) {
			replacement = `<a href="${res.dataUrl}">${escapeHtml(m.displayName)}</a>`;
		} else if (res.tooLarge) {
			const size = res.size ? formatFileSize(res.size) : '过大';
			replacement = `<p>📎 <strong>${escapeHtml(m.filename)}</strong> <em>(${size} — 请到原飞书文档下载)</em></p>`;
		} else {
			replacement = `<p>📎 <strong>${escapeHtml(m.filename)}</strong> <em>(下载失败)</em></p>`;
		}
		result = result.replace(m.full, replacement);
	}

	return result;
}
```

- [ ] **Step 2.3：改 FILE block 渲染（行 676-682）**

把：
```ts
		case FEISHU_BLOCK_TYPE.FILE: {
			const file = block.file;
			if (file?.name) {
				return `<p>[File: ${escapeHtml(file.name)}]</p>`;
			}
			return '';
		}
```

改为：
```ts
		case FEISHU_BLOCK_TYPE.FILE: {
			const file = block.file;
			if (!file?.token || !file?.name) {
				return file?.name ? `<p>📎 ${escapeHtml(file.name)}</p>` : '';
			}
			const sizeAttr = typeof file.size === 'number' ? ` data-size="${file.size}"` : '';
			return `<a href="feishu-file://${file.token}" data-filename="${escapeHtml(file.name)}"${sizeAttr}>${escapeHtml(file.name)}</a>`;
		}
```

- [ ] **Step 2.4：扩展 `FeishuBlock.file` 类型加 `token` 和 `size`**

grep `file?:` 在 feishu-extractor.ts 中确认现有类型定义：

```bash
grep -nE "file\?:.*token|file\?:" src/utils/feishu-extractor.ts | head -5
```

找到 file 字段类型定义（应为 `file?: { name?: string; token?: string }` 类似），补全为：
```ts
file?: { name?: string; token?: string; size?: number };
```

如已有 `token`、`size` 则跳过。

- [ ] **Step 2.5：在 `extractFeishuStructuredContent` 中调用 `resolveFeishuFiles`**

参考 Step 2.1 找到的 `resolveFeishuImages` 调用位置。在其调用之后追加：

```ts
html = await resolveFeishuFiles(html);
```

（变量名 `html` 可能不同，按现有上下文调整 —— grep `resolveFeishuImages` 的调用行就能看清。）

- [ ] **Step 2.6：TypeScript 类型检查**

```bash
npx tsc --noEmit 2>&1 | grep "src/utils/feishu-extractor.ts" | head -10
```
Expected：无错误。

- [ ] **Step 2.7：跑测试**

```bash
npm test 2>&1 | tail -8
```
Expected：**574 passed + 3 known baseline failures**。无新失败。

- [ ] **Step 2.8：跑构建**

```bash
npm run build:chrome 2>&1 | tail -3
```
Expected：成功。

---

## Task 3：浏览器手测

**Files:** 无文件改动

- [ ] **Step 3.1：reload 扩展**

`chrome://extensions` → cn 扩展卡片 ↻ 重新加载。

- [ ] **Step 3.2：测试用例 1 — 小 PDF 附件嵌入**

1. 找一篇含 < 10MB PDF 附件的飞书文档（任何 docx 或 wiki）
2. 剪存 → popup 看 markdown 预览
3. 复制到剪贴板 → 粘贴到任意编辑器
4. **验证**：markdown 包含 `[文件名.pdf](data:application/pdf;base64,...)`
5. 保存到 Obsidian → 点击该链接 → 浏览器打开 PDF data URL

- [ ] **Step 3.3：测试用例 2 — 大文件 fallback**

1. 找一篇含 > 10MB 附件的飞书文档（视频 / 大 PPT / 大 PDF）
2. 剪存 → 复制 markdown
3. **验证**：markdown 包含 `📎 **filename** *(XX.X MB — 请到原飞书文档下载)*`，无 data URL

- [ ] **Step 3.4：测试用例 3 — 多 file block 混合**

1. 找一篇同时含图片 + PDF + 通用文件的飞书文档
2. 剪存
3. **验证**：图片仍以 base64 嵌入，文件按大小分别处理（< 10MB 嵌入 / > 10MB fallback）

- [ ] **Step 3.5：测试用例 4 — 错误处理（飞书凭证失效）**

1. 临时改扩展设置中的飞书 App Secret 为错误值
2. 剪存任意含附件的文档
3. **验证**：file block 输出 `📎 文件名 (下载失败)`，**文档其他内容（文字、图片）不受影响**
4. 改回正确凭证

- [ ] **Step 3.6：测试用例 5 — wiki 文档同行为**

1. 找一篇含 PDF 附件的飞书 wiki（`/wiki/` URL）
2. 剪存
3. **验证**：与 docx 行为一致（嵌入或 fallback）

- [ ] **Step 3.7：回归 — 无附件文档**

1. 纯文本飞书文档剪存
2. **验证**：行为与之前一致，无新增 `📎` 或异常

- [ ] **Step 3.8：回归 — 仅图片文档**

1. 含图片但无 file 附件的飞书文档剪存
2. **验证**：图片仍以 base64 嵌入，无新增异常

5 用例 + 2 回归全过 → 进 Task 4。任一失败 → 检查 console 日志（Service Worker + popup DevTools），可能要调 endpoint 或类型。

---

## Task 4：更新 README

**Files:**
- Modify: `README.md`
- Modify: `README_EN.md`

- [ ] **Step 4.1：找飞书章节**

```bash
grep -n "飞书\|Feishu" README.md | head -10
grep -n "Feishu" README_EN.md | head -10
```

找到现有 "飞书文档完整提取" / "Feishu Document Extraction" 章节。

- [ ] **Step 4.2：在飞书章节末尾或图片提示之后追加附件说明（中文）**

在 README.md 飞书章节加入：

```markdown
- **附件下载** — 文档内的 PDF / Office / 通用附件会自动下载并以 base64 data URL 嵌入 markdown（< 10 MB）。超过 10 MB 的附件会留占位提示（含文件名与大小），请到原飞书文档手动下载。
```

- [ ] **Step 4.3：在 README_EN.md 同位置加英文**

```markdown
- **Attachment download** — PDFs, Office files, and other attachments inside Feishu documents are automatically downloaded and embedded as base64 data URLs in the markdown (< 10 MB). Files larger than 10 MB are replaced with a placeholder showing the filename and size; download them manually from the source Feishu document.
```

---

## Task 5：Commit

**Files:**
- 修改过的：`src/background.ts`、`src/utils/feishu-extractor.ts`、`README.md`、`README_EN.md`

- [ ] **Step 5.1：暂存改动**

```bash
git add src/background.ts src/utils/feishu-extractor.ts README.md README_EN.md
git status --short
```
Expected：4 个 M 文件，无意外 untracked。

- [ ] **Step 5.2：提交**

```bash
git commit -m "$(cat <<'EOF'
feat: download Feishu document file/attachment blocks

FILE blocks (PDF, Office, generic attachments) are now downloaded and
embedded as base64 data URLs in the clipped markdown, mirroring how
images are handled. Files larger than 10 MB stay as a placeholder with
the filename and size since base64-inlining a large binary would bloat
the note.

Implementation mirrors fetchFeishuImageAsBase64 in background.ts and
resolveFeishuImages in feishu-extractor.ts. Uses the same Feishu
OpenAPI media-download endpoint. Reuses existing host_permissions and
tenant token; no manifest change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git log --oneline -3
```

Expected：新 commit 在 HEAD，前一个是 `4fb8dec docs: add F5 spec`。

---

## 回滚预案

如手测发现严重问题（如附件下载导致剪存失败 / 飞书 API endpoint 不通）：

```bash
# 回滚未 commit 的改动
git checkout src/background.ts src/utils/feishu-extractor.ts README.md README_EN.md
```

如已 commit：
```bash
git revert HEAD
```

如发现是 endpoint 问题（`/medias/{token}/download` 对 file token 不通），可能要换 endpoint：
- 候选：`https://open.feishu.cn/open-apis/drive/v1/files/{token}/download`
- 候选：用 cookie-based internal API（参考 `fetchFeishuImagesViaMainWorld` 实现）
- 调整 `fetchFeishuFileAsBase64` 的 URL 重新跑手测
