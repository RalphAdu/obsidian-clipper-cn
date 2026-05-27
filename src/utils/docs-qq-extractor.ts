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
	const m = document.cookie.match(/(?:^|;\s*)xsrf=([^;]+)/);
	if (!m) throw new DocsQQAuthError('cookie 缺 xsrf token，请先登录腾讯文档');
	return m[1];
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
