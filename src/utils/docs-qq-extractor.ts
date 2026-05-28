// Static imports so mammoth + mathml-to-latex are bundled directly into the
// content script chunk. Dynamic imports create async split-chunks that content
// scripts cannot load via <script> injection (web_accessible_resources issue).
import mammothStatic from 'mammoth';
import mathmlToLatexMod from 'mathml-to-latex';

export interface DocsQQParsedUrl {
  type: 'doc';
  token: string;
}

export function parseDocsQQUrl(url: string): DocsQQParsedUrl | null {
  const match = url.match(/^https:\/\/docs\.qq\.com\/doc\/([A-Za-z0-9]+)/);
  if (!match) return null;
  return { type: 'doc', token: match[1] };
}

export function isDocsQQDocUrl(url: string): boolean {
  return parseDocsQQUrl(url) !== null;
}

// ============================================
// TypeScript Interfaces
// ============================================

export interface DocsQQMetadata {
  title: string;
  author: string;
  createTime: string;  // YYYY-MM-DD
  modifyTime: string;  // YYYY-MM-DD
  wordCount: number;
}

export interface DocsQQStructuredContent {
  title: string;
  author: string;
  content: string;        // HTML (待主流程 turndown)
  published: string;      // YYYY-MM-DD, from modifyTime
  wordCount: number;
}

export interface DocsQQExtractOpts {
  token: string;
  url: string;
  doc: Document;
}

// ============================================
// Error 子类
// ============================================

export class DocsQQAuthError extends Error {
  constructor(message: string) { super(message); this.name = 'DocsQQAuthError'; }
}
export class DocsQQNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = 'DocsQQNotFoundError'; }
}
export class DocsQQTransientError extends Error {
  constructor(message: string) { super(message); this.name = 'DocsQQTransientError'; }
}
export class DocsQQExportFailedError extends Error {
  constructor(message: string) { super(message); this.name = 'DocsQQExportFailedError'; }
}
export class DocsQQConvertError extends Error {
  constructor(message: string) { super(message); this.name = 'DocsQQConvertError'; }
}

// ============================================
// HTTP helpers
// ============================================

const FETCH_TIMEOUT_MS = 10_000;

function getXsrfFromCookies(): string {
	// docs.qq.com uses the TOK cookie as the xsrf/CSRF token value.
	// The page JS reads TOK and passes it as ?xsrf= query param to all API requests.
	// (Reconnaissance confirmed: xsrf value === TOK value in all observed requests.)
	// Fallback to a literal 'xsrf' cookie for forward-compatibility.
	const tok = document.cookie.match(/(?:^|;\s*)TOK=([^;]+)/);
	if (tok) return tok[1];
	const xsrf = document.cookie.match(/(?:^|;\s*)xsrf=([^;]+)/);
	if (xsrf) return xsrf[1];
	throw new DocsQQAuthError('cookie 缺 TOK/xsrf token，请先登录腾讯文档');
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
	try {
		return await fetch(url, { ...init, signal: ctrl.signal });
	} catch (e) {
		if ((e as Error).name === 'AbortError') {
			throw new DocsQQTransientError(`fetch timeout: ${url}`);
		}
		throw new DocsQQTransientError(`fetch failed: ${(e as Error).message}`);
	} finally {
		clearTimeout(timer);
	}
}

function throwForStatus(status: number, context: string): void {
	if (status === 401 || status === 403) {
		throw new DocsQQAuthError(`${context}: 未登录或无权限 (HTTP ${status})`);
	}
	if (status === 404) {
		throw new DocsQQNotFoundError(`${context}: 文档不存在 (HTTP ${status})`);
	}
	if (status >= 500) {
		throw new DocsQQTransientError(`${context}: 腾讯服务暂时不可用 (HTTP ${status})`);
	}
	if (status >= 400) {
		throw new DocsQQTransientError(`${context}: HTTP ${status}`);
	}
}

// ============================================
// Endpoint: 文档元数据
// ============================================

export async function fetchDocMetadata(token: string): Promise<DocsQQMetadata> {
	const xsrf = getXsrfFromCookies();
	const url = `https://docs.qq.com/cgi-go/padinfo/getpadinfo?encodePadId=${encodeURIComponent(token)}&infoKeys=[1,2]&xsrf=${encodeURIComponent(xsrf)}`;
	const response = await fetchWithTimeout(url, {
		method: 'GET',
		credentials: 'include',
		headers: {
			Referer: `https://docs.qq.com/doc/${token}`,
			Accept: 'application/json, text/plain, */*',
		},
	});

	throwForStatus(response.status, 'fetchDocMetadata');

	const data = await response.json();
	const title: string = data?.data?.title || '';
	// author / createTime / modifyTime / wordCount 不返回（recon.md §1）— 留空，v2 优化
	return {
		title,
		author: '',
		createTime: '',
		modifyTime: '',
		wordCount: 0,
	};
}

// ============================================
// Endpoint: 导出任务发起
// ============================================

export async function requestExportTask(
	globalPadId: string,
	token: string,
): Promise<string> {
	const body = new URLSearchParams({
		exportType: '0',
		switches: '{"embedFonts":false}',
		exportSource: 'client',
		docId: globalPadId,
		objectMapping: '{"hinaMappings":[]}',
	}).toString();

	const response = await fetchWithTimeout('https://docs.qq.com/v1/export/export_office', {
		method: 'POST',
		credentials: 'include',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
			'Accept': 'application/json, text/plain, */*',
			'Referer': `https://docs.qq.com/doc/${token}`,
		},
		body,
	});

	throwForStatus(response.status, 'requestExportTask');

	const data = await response.json();
	if (data.ret !== 0) {
		throw new DocsQQExportFailedError(`requestExportTask: ret=${data.ret}, body=${JSON.stringify(data).slice(0, 200)}`);
	}
	if (!data.operationId) {
		throw new DocsQQExportFailedError(`requestExportTask: 缺 operationId 字段, body=${JSON.stringify(data).slice(0, 200)}`);
	}
	return data.operationId;
}

// 内部用：从 metadata response 同步拿 globalPadId（task 6 requestExportTask 用）
// 但 padInfo.globalPadId 不在 DocsQQMetadata 里，需要单独 helper
export async function fetchGlobalPadId(token: string): Promise<string> {
	const xsrf = getXsrfFromCookies();
	const url = `https://docs.qq.com/cgi-go/padinfo/getpadinfo?encodePadId=${encodeURIComponent(token)}&infoKeys=[1,2]&xsrf=${encodeURIComponent(xsrf)}`;
	const response = await fetchWithTimeout(url, {
		method: 'GET',
		credentials: 'include',
		headers: {
			Referer: `https://docs.qq.com/doc/${token}`,
			Accept: 'application/json, text/plain, */*',
		},
	});
	throwForStatus(response.status, 'fetchGlobalPadId');
	const data = await response.json();
	const globalPadId: string | undefined = data?.data?.padInfo?.globalPadId;
	if (!globalPadId) {
		throw new DocsQQExportFailedError('getpadinfo: 缺 globalPadId 字段');
	}
	return globalPadId;
}

// ============================================
// Endpoint: 任务状态轮询
// ============================================

export async function pollExportStatus(
	operationId: string,
	token: string,
	opts: { timeoutMs: number; intervalMs: number }
): Promise<string> {
	const deadline = Date.now() + opts.timeoutMs;
	const url = `https://docs.qq.com/v1/export/query_progress?operationId=${encodeURIComponent(operationId)}`;

	while (Date.now() < deadline) {
		const response = await fetchWithTimeout(url, {
			method: 'GET',
			credentials: 'include',
			headers: {
				'Accept': 'application/json, text/plain, */*',
				'Referer': `https://docs.qq.com/doc/${token}`,
			},
		});
		throwForStatus(response.status, 'pollExportStatus');

		let data: { status?: string; file_url?: string };
		try {
			data = await response.json();
		} catch {
			throw new DocsQQTransientError(`pollExportStatus: 无法解析响应 JSON`);
		}
		const status: string = data.status ?? '';

		if (status === 'Done') {
			if (!data.file_url) {
				throw new DocsQQExportFailedError(`pollExportStatus: status=Done 但缺 file_url`);
			}
			return data.file_url;
		}
		if (status === 'Failed' || status === 'failed') {
			throw new DocsQQExportFailedError(`pollExportStatus: 任务失败 (response.status=${status})`);
		}

		await new Promise(resolve => setTimeout(resolve, opts.intervalMs));
	}

	throw new DocsQQTransientError(`pollExportStatus: 超过 ${opts.timeoutMs}ms 仍未完成`);
}

// ============================================
// Endpoint: docx 文件下载 (COS signed URL)
// ============================================

const DOWNLOAD_SIZE_LIMIT = 50 * 1024 * 1024;  // 50MB

export async function fetchDocxFile(fileUrl: string): Promise<ArrayBuffer> {
	const response = await fetchWithTimeout(fileUrl, {
		method: 'GET',
		credentials: 'omit',
	});

	if (response.status === 404) {
		throw new DocsQQTransientError(`fetchDocxFile: CDN 文件已失效 (HTTP 404, URL 可能过期)`);
	}
	throwForStatus(response.status, 'fetchDocxFile');

	const contentLength = response.headers.get('Content-Length');
	if (contentLength && Number(contentLength) > DOWNLOAD_SIZE_LIMIT) {
		throw new DocsQQTransientError(`fetchDocxFile: 文件过大 ${contentLength} bytes > ${DOWNLOAD_SIZE_LIMIT}`);
	}

	return await response.arrayBuffer();
}

// ============================================
// docx → HTML (mammoth, 静态 import 内联到 bundle)
// ============================================

export async function convertDocxToHtml(arrayBuffer: ArrayBuffer): Promise<string> {
	// Use the statically imported mammoth (bundled directly into this chunk,
	// avoiding the async split-chunk that content scripts cannot load).
	// CJS interop: real mammoth exposes convertToHtml directly on namespace;
	// ESM-style mocks (vitest vi.doMock) wrap in .default.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const mammoth: any = (mammothStatic && typeof (mammothStatic as any).convertToHtml === 'function')
		? mammothStatic
		: (mammothStatic as any)?.default ?? mammothStatic;

	try {
		const result = await mammoth.convertToHtml(
			{ arrayBuffer },
			{
				convertImage: mammoth.images.imgElement((image: { contentType: string; read: (encoding: string) => Promise<string> }) =>
					image.read('base64').then((data: string) => ({
						src: `data:${image.contentType};base64,${data}`,
					}))
				),
			},
		);
		return result.value;
	} catch (e) {
		throw new DocsQQConvertError(`mammoth 转换失败: ${(e as Error).message}`);
	}
}

// ============================================
// HTML 后处理 (MathML → LaTeX + 清理)
// ============================================

export async function postProcessHtml(rawHtml: string): Promise<string> {
	// Use native DOMParser (available in browser + extension content scripts).
	// Fallback to linkedom for vitest (node environment, no DOMParser).
	let docNode: Document;
	if (typeof DOMParser !== 'undefined') {
		docNode = new DOMParser().parseFromString(`<!DOCTYPE html><html><body>${rawHtml}</body></html>`, 'text/html');
	} else {
		// vitest / node environment
		const { parseHTML } = await import('linkedom');
		const parsed = parseHTML(`<!DOCTYPE html><html><body>${rawHtml}</body></html>`);
		docNode = parsed.document as unknown as Document;
	}
	const document = docNode;

	// 1. MathML → LaTeX
	if (document.querySelector('math')) {
		// Use statically-imported mathml-to-latex (bundled into content chunk).
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const mathmlToLatex = ((mathmlToLatexMod as unknown as { default?: (xml: string) => string }).default || mathmlToLatexMod) as unknown as ((xml: string) => string) | null;

		if (mathmlToLatex) {
			for (const math of Array.from(document.querySelectorAll('math'))) {
				try {
					const latex = mathmlToLatex(math.outerHTML);
					const isBlock = math.getAttribute('display') === 'block';
					const wrapped = isBlock ? `$$${latex}$$` : `$${latex}$`;
					math.replaceWith(document.createTextNode(wrapped));
				} catch {
					// 单条转换失败保留 MathML 原标签
				}
			}
		}
	}

	// 2. 清理空段落
	for (const p of Array.from(document.querySelectorAll('p'))) {
		if (!p.textContent?.trim() && !p.querySelector('img,video,br')) {
			p.remove();
		}
	}

	// 3. 折叠连续 <br> (保留 1 个)
	for (const br of Array.from(document.querySelectorAll('br'))) {
		let next = br.nextSibling;
		while (next && next.nodeName === 'BR') {
			const toRemove = next;
			next = next.nextSibling;
			toRemove.parentNode?.removeChild(toRemove);
		}
	}

	// 4. 拆 heading 内仅含 <img>（docx 源头 bug — 腾讯文档把图片段落误标 Heading style）
	// 否则 turndown 输出 `### ![](data:...)` 破坏大纲；audit FAIL 路径
	for (const h of Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))) {
		const imgs = Array.from(h.querySelectorAll('img'));
		if (imgs.length === 0) continue;
		if ((h.textContent ?? '').trim() !== '') continue;
		const parent = h.parentNode;
		if (!parent) continue;
		for (const img of imgs) {
			const p = document.createElement('p');
			p.appendChild(img);
			parent.insertBefore(p, h);
		}
		h.remove();
	}

	// 5. 解包 heading 内顶层 <strong> / <b> — docx 源头 H2 段落整体加粗 →
	// `<h2><strong>...</strong></h2>` → turndown `## **...**`. heading 本身已加粗，
	// 重复 bold markup 在 Obsidian 里渲染语义冗余。
	for (const h of Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))) {
		// 仅当 heading 唯一 child 是 <strong>/<b> 才解包；mixed inline 不动
		const children = Array.from(h.childNodes).filter(n => n.nodeType === 1 || (n.nodeType === 3 && (n.textContent ?? '').trim() !== ''));
		if (children.length !== 1) continue;
		const only = children[0] as Element;
		if (only.nodeType !== 1) continue;
		const tag = only.tagName.toLowerCase();
		if (tag !== 'strong' && tag !== 'b') continue;
		// 把 strong/b 的子节点直接挂回 heading
		while (only.firstChild) h.insertBefore(only.firstChild, only);
		only.remove();
	}

	return document.body.innerHTML;
}

// ============================================
// 主入口：extractDocsQQContent 编排
// ============================================

function estimateWordCount(html: string): number {
	// 剥 HTML tags 后统计 CJK 字符 + ASCII 词数
	const text = html.replace(/<[^>]*>/g, '');
	const cjk = (text.match(/[一-鿿]/g) || []).length;
	const words = (text.match(/[a-zA-Z0-9]+/g) || []).length;
	return cjk + words;
}

export async function extractDocsQQContent(
	opts: DocsQQExtractOpts,
): Promise<DocsQQStructuredContent> {
	const { token } = opts;

	// ① 拿 metadata + globalPadId (2 次同 endpoint 调用合并为 1 次 — fetchGlobalPadId 内部)
	// 但本 task 用 fetchDocMetadata + fetchGlobalPadId 都 export 着，让 task 11 也用 — 2 次调用接受 (重复 endpoint 调用是 minor perf 问题，v2 优化合并)
	const meta = await fetchDocMetadata(token);
	const globalPadId = await fetchGlobalPadId(token);

	// ② 发起导出任务
	const operationId = await requestExportTask(globalPadId, token);

	// ③ 轮询任务
	const fileUrl = await pollExportStatus(operationId, token, {
		timeoutMs: 30_000,
		intervalMs: 1_000,
	});

	// ④ 下载 docx
	const arrayBuffer = await fetchDocxFile(fileUrl);

	// ⑤ mammoth 转 HTML
	const rawHtml = await convertDocxToHtml(arrayBuffer);

	// ⑥ 后处理 (MathML→LaTeX + 清理)
	const html = await postProcessHtml(rawHtml);

	return {
		title: meta.title,
		author: meta.author,
		published: meta.modifyTime,
		content: html,
		wordCount: meta.wordCount || estimateWordCount(html),
	};
}
