import browser from './browser-polyfill';
import { createLogger } from './logger';
import { extractFeishuComments } from './feishu-comments';
import { convertDate } from './date-utils';

const logger = createLogger('Feishu');

export interface FeishuParsedUrl {
	type: 'wiki' | 'docx' | 'doc' | null;
	token: string | null;
}

export interface FeishuStructuredContent {
	title: string;
	author: string;
	content: string;             // HTML (no comments appended)
	commentsMarkdown?: string;   // already markdown — must NOT pass through turndown
	published?: string;          // YYYY-MM-DD, from latest_modify_time
	wordCount: number;
}

interface FeishuTextElement {
	content?: string;
	text_element_style?: {
		bold?: boolean;
		italic?: boolean;
		strikethrough?: boolean;
		underline?: boolean;
		inline_code?: boolean;
		link?: { url?: string };
	};
}

interface FeishuTextRun {
	content?: string;
	text_element_style?: FeishuTextElement['text_element_style'];
}

interface FeishuMentionUser {
	user_id?: string;
	text_element_style?: FeishuTextElement['text_element_style'];
}

interface FeishuTextBody {
	elements?: Array<{
		text_run?: FeishuTextRun;
		mention_user?: FeishuMentionUser;
		mention_doc?: { token?: string; title?: string; obj_type?: number; url?: string; text_element_style?: FeishuTextElement['text_element_style'] };
		equation?: { content?: string };
		inline_block?: { block_id: string; text_element_style?: FeishuTextElement['text_element_style'] };
	}>;
	style?: {
		align?: number; // 1=left, 2=center, 3=right
		list?: {
			type?: string; // "number" | "bullet" | "checkBox"
			indentLevel?: number;
			number?: number;
		};
		quote?: boolean;
	};
}

export interface FeishuBlock {
	block_id: string;
	parent_id?: string;
	children?: string[];
	block_type: number;
	page?: { elements?: FeishuTextBody['elements']; style?: FeishuTextBody['style'] };
	text?: FeishuTextBody;
	heading1?: FeishuTextBody;
	heading2?: FeishuTextBody;
	heading3?: FeishuTextBody;
	heading4?: FeishuTextBody;
	heading5?: FeishuTextBody;
	heading6?: FeishuTextBody;
	heading7?: FeishuTextBody;
	heading8?: FeishuTextBody;
	heading9?: FeishuTextBody;
	bullet?: FeishuTextBody;
	ordered?: FeishuTextBody;
	code?: FeishuTextBody & { style?: FeishuTextBody['style'] & { language?: number; wrap?: boolean } };
	quote?: FeishuTextBody;
	todo?: FeishuTextBody & { style?: FeishuTextBody['style'] & { done?: boolean } };
	callout?: FeishuTextBody & { style?: FeishuTextBody['style'] & { background_color?: number; emoji_id?: string } };
	quote_container?: object;
	divider?: object;
	image?: { width?: number; height?: number; token?: string; caption?: { content?: string } };
	table?: { cells?: string[]; property?: { row_size?: number; column_size?: number; merge_info?: Array<{ row_span?: number; col_span?: number }> } };
	table_cell?: object;
	grid?: { column_size?: number };
	grid_column?: object;
	file?: { name?: string; token?: string; size?: number };
	iframe?: { component?: { iframe_type?: number; url?: string } };
	view?: object;
	source_synced?: FeishuTextBody;
	undefined_block?: object;
}

// Feishu emoji shortcode → unicode emoji mapping for CALLOUT block icons.
// Common ones observed in scys + feishu docs. Unknown shortcodes return ''
// (silently dropped rather than rendering ":bulb:" raw text in markdown).
const FEISHU_EMOJI_MAP: Record<string, string> = {
	bulb: '💡',
	mag_right: '🔍',
	mag: '🔎',
	warning: '⚠️',
	bell: '🔔',
	info: 'ℹ️',
	information_source: 'ℹ️',
	pushpin: '📌',
	bookmark: '🔖',
	pencil: '✏️',
	memo: '📝',
	fire: '🔥',
	heavy_check_mark: '✅',
	white_check_mark: '✅',
	x: '❌',
	thumbsup: '👍',
	thinking_face: '🤔',
	star: '⭐',
	rocket: '🚀',
	books: '📚',
	clipboard: '📋',
	question: '❓',
	exclamation: '❗',
	heart: '❤️',
	speech_balloon: '💬',
};

function feishuEmojiToUnicode(emojiId: string): string {
	return FEISHU_EMOJI_MAP[emojiId] || '';
}

// Feishu emoji shortcode → Obsidian native callout type. Used so callout
// renders as a colored box in Obsidian (not a gray blockquote), while still
// preserving the original emoji in the title for visual parity with feishu.
const FEISHU_EMOJI_TO_CALLOUT_TYPE: Record<string, string> = {
	bulb: 'tip',
	mag_right: 'info', mag: 'info',
	info: 'info', information_source: 'info',
	warning: 'warning', exclamation: 'warning', bell: 'warning',
	pushpin: 'important', rocket: 'important',
	bookmark: 'note', pencil: 'note', memo: 'note',
	fire: 'danger',
	heavy_check_mark: 'success', white_check_mark: 'success', thumbsup: 'success',
	x: 'failure',
	thinking_face: 'question', question: 'question',
	star: 'example', heart: 'example',
	books: 'abstract', clipboard: 'abstract',
	speech_balloon: 'quote',
};

const FEISHU_BLOCK_TYPE = {
	PAGE: 1,
	TEXT: 2,
	HEADING1: 3,
	HEADING2: 4,
	HEADING3: 5,
	HEADING4: 6,
	HEADING5: 7,
	HEADING6: 8,
	HEADING7: 9,
	HEADING8: 10,
	HEADING9: 11,
	BULLET: 12,
	ORDERED: 13,
	CODE: 14,
	QUOTE: 15,
	TODO: 17,
	CALLOUT: 19,
	CHAT_CARD: 20,
	DIAGRAM: 21,
	DIVIDER: 22,
	FILE: 23,
	GRID: 24,
	GRID_COLUMN: 25,
	IFRAME: 26,
	IMAGE: 27,
	WIDGET: 28,
	MINDNOTE: 29,
	SHEET: 30,
	TABLE: 31,
	TABLE_CELL: 32,
	VIEW: 33,
	QUOTE_CONTAINER: 34,
	SOURCE_SYNCED: 49,
} as const;

export function isFeishuDocUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		const isFeishuHost = parsed.hostname.endsWith('.feishu.cn') || parsed.hostname.endsWith('.larksuite.com');
		if (!isFeishuHost) return false;
		return /^\/(wiki|docx|docs?)\/[\w-]+/.test(parsed.pathname);
	} catch {
		return false;
	}
}

export function parseFeishuUrl(url: string): FeishuParsedUrl {
	try {
		const parsed = new URL(url);
		const match = parsed.pathname.match(/^\/(wiki|docx|docs?)\/([\w-]+)/);
		if (!match) return { type: null, token: null };
		const rawType = match[1];
		const normalizedType = (rawType === 'docs' ? 'doc' : rawType) as 'wiki' | 'docx' | 'doc';
		return {
			type: normalizedType,
			token: match[2],
		};
	} catch {
		return { type: null, token: null };
	}
}

export async function fetchFeishuApi(url: string, options?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<any> {
	const response = await browser.runtime.sendMessage({
		action: 'fetchFeishuApi',
		url,
		options,
	}) as { success?: boolean; data?: any; error?: string };

	if (!response?.success) {
		const errMsg = response?.error || 'Failed to fetch Feishu API';
		logger.warn('API request failed', { error: errMsg, url });
		throw new Error(errMsg);
	}
	return response.data;
}

// ─── Cookie-based image URL generation ───────────────────────────────────────
// Ported from cloud-document-converter (MIT license)
// https://github.com/whale4113/cloud-document-converter

function _feishuMd5Hex(input: string): string {
	function add32(a: number, b: number): number {
		const lo = (a & 0xffff) + (b & 0xffff);
		return ((a >> 16) + (b >> 16) + (lo >> 16)) << 16 | (lo & 0xffff);
	}
	function rol32(n: number, s: number): number { return n << s | n >>> (32 - s); }
	function cmn(q: number, a: number, b: number, x: number, s: number, t: number): number {
		return add32(rol32(add32(add32(a, q), add32(x, t)), s), b);
	}
	function ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number) { return cmn(b & c | ~b & d, a, b, x, s, t); }
	function gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number) { return cmn(b & d | c & ~d, a, b, x, s, t); }
	function hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number) { return cmn(b ^ c ^ d, a, b, x, s, t); }
	function ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number) { return cmn(c ^ (b | ~d), a, b, x, s, t); }

	// UTF-8 encode
	const utf8 = unescape(encodeURIComponent(input));
	const bitLen = utf8.length * 8;

	// Pack string into 32-bit word array
	const words: number[] = [];
	for (let i = 0; i < bitLen; i += 8) {
		words[i >> 5] = (words[i >> 5] || 0) | (utf8.charCodeAt(i / 8) & 0xff) << (i % 32);
	}
	// Append padding bit and length
	words[bitLen >> 5] = (words[bitLen >> 5] || 0) | 0x80 << (bitLen % 32);
	words[14 + ((bitLen + 64 >>> 9) << 4)] = bitLen;

	// MD5 compression
	let h0 = 1732584193, h1 = -271733879, h2 = -1732584194, h3 = 271733878;
	for (let n = 0; n < words.length; n += 16) {
		const [a0, b0, c0, d0] = [h0, h1, h2, h3];
		const w = (i: number) => words[n + i] || 0;
		h0 = ff(h0,h1,h2,h3,w(0),7,-680876936); h3=ff(h3,h0,h1,h2,w(1),12,-389564586);
		h2=ff(h2,h3,h0,h1,w(2),17,606105819); h1=ff(h1,h2,h3,h0,w(3),22,-1044525330);
		h0=ff(h0,h1,h2,h3,w(4),7,-176418897); h3=ff(h3,h0,h1,h2,w(5),12,1200080426);
		h2=ff(h2,h3,h0,h1,w(6),17,-1473231341); h1=ff(h1,h2,h3,h0,w(7),22,-45705983);
		h0=ff(h0,h1,h2,h3,w(8),7,1770035416); h3=ff(h3,h0,h1,h2,w(9),12,-1958414417);
		h2=ff(h2,h3,h0,h1,w(10),17,-42063); h1=ff(h1,h2,h3,h0,w(11),22,-1990404162);
		h0=ff(h0,h1,h2,h3,w(12),7,1804603682); h3=ff(h3,h0,h1,h2,w(13),12,-40341101);
		h2=ff(h2,h3,h0,h1,w(14),17,-1502002290); h1=ff(h1,h2,h3,h0,w(15),22,1236535329);
		h0=gg(h0,h1,h2,h3,w(1),5,-165796510); h3=gg(h3,h0,h1,h2,w(6),9,-1069501632);
		h2=gg(h2,h3,h0,h1,w(11),14,643717713); h1=gg(h1,h2,h3,h0,w(0),20,-373897302);
		h0=gg(h0,h1,h2,h3,w(5),5,-701558691); h3=gg(h3,h0,h1,h2,w(10),9,38016083);
		h2=gg(h2,h3,h0,h1,w(15),14,-660478335); h1=gg(h1,h2,h3,h0,w(4),20,-405537848);
		h0=gg(h0,h1,h2,h3,w(9),5,568446438); h3=gg(h3,h0,h1,h2,w(14),9,-1019803690);
		h2=gg(h2,h3,h0,h1,w(3),14,-187363961); h1=gg(h1,h2,h3,h0,w(8),20,1163531501);
		h0=gg(h0,h1,h2,h3,w(13),5,-1444681467); h3=gg(h3,h0,h1,h2,w(2),9,-51403784);
		h2=gg(h2,h3,h0,h1,w(7),14,1735328473); h1=gg(h1,h2,h3,h0,w(12),20,-1926607734);
		h0=hh(h0,h1,h2,h3,w(5),4,-378558); h3=hh(h3,h0,h1,h2,w(8),11,-2022574463);
		h2=hh(h2,h3,h0,h1,w(11),16,1839030562); h1=hh(h1,h2,h3,h0,w(14),23,-35309556);
		h0=hh(h0,h1,h2,h3,w(1),4,-1530992060); h3=hh(h3,h0,h1,h2,w(4),11,1272893353);
		h2=hh(h2,h3,h0,h1,w(7),16,-155497632); h1=hh(h1,h2,h3,h0,w(10),23,-1094730640);
		h0=hh(h0,h1,h2,h3,w(13),4,681279174); h3=hh(h3,h0,h1,h2,w(0),11,-358537222);
		h2=hh(h2,h3,h0,h1,w(3),16,-722521979); h1=hh(h1,h2,h3,h0,w(6),23,76029189);
		h0=hh(h0,h1,h2,h3,w(9),4,-640364487); h3=hh(h3,h0,h1,h2,w(12),11,-421815835);
		h2=hh(h2,h3,h0,h1,w(15),16,530742520); h1=hh(h1,h2,h3,h0,w(2),23,-995338651);
		h0=ii(h0,h1,h2,h3,w(0),6,-198630844); h3=ii(h3,h0,h1,h2,w(7),10,1126891415);
		h2=ii(h2,h3,h0,h1,w(14),15,-1416354905); h1=ii(h1,h2,h3,h0,w(5),21,-57434055);
		h0=ii(h0,h1,h2,h3,w(12),6,1700485571); h3=ii(h3,h0,h1,h2,w(3),10,-1894986606);
		h2=ii(h2,h3,h0,h1,w(10),15,-1051523); h1=ii(h1,h2,h3,h0,w(1),21,-2054922799);
		h0=ii(h0,h1,h2,h3,w(8),6,1873313359); h3=ii(h3,h0,h1,h2,w(15),10,-30611744);
		h2=ii(h2,h3,h0,h1,w(6),15,-1560198380); h1=ii(h1,h2,h3,h0,w(13),21,1309151649);
		h0=ii(h0,h1,h2,h3,w(4),6,-145523070); h3=ii(h3,h0,h1,h2,w(11),10,-1120210379);
		h2=ii(h2,h3,h0,h1,w(2),15,718787259); h1=ii(h1,h2,h3,h0,w(9),21,-343485551);
		h0=add32(h0,a0); h1=add32(h1,b0); h2=add32(h2,c0); h3=add32(h3,d0);
	}

	// Words to binary string to hex
	const hex = '0123456789abcdef';
	let result = '';
	for (const word of [h0, h1, h2, h3]) {
		for (let i = 0; i < 4; i++) {
			const byte = (word >>> (i * 8)) & 0xff;
			result += hex[byte >>> 4] + hex[byte & 0xf];
		}
	}
	return result;
}

function _feishuRandomSeed(len: number): string {
	const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
	let result = '';
	for (let i = 0; i < len; i++) {
		result += chars[Math.floor(Math.random() * chars.length)];
	}
	return result;
}

function feishuEncodeToken(token: string): string {
	const t = Math.round(Date.now() / 1000);
	const n = t + 3600;
	const r = `${t}:${n}`;
	const tokenStr = `Token:${token}`;
	const s = _feishuRandomSeed(32);
	const hash = _feishuMd5Hex(`${s}_${tokenStr}_${r}_V4`);
	return `${hash}_${s}_${tokenStr}_${r}_V4`;
}

function feishuBase64Url(str: string): string {
	return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Cache the API host read from MAIN world (window.local.apiHost).
// We request it via background.ts which uses chrome.scripting (world: MAIN),
// bypassing the page's CSP that would block inline <script> injection.
let _feishuApiHostCache: string | null = null;

async function readFeishuApiHostFromMainWorld(): Promise<string> {
	if (_feishuApiHostCache !== null) return _feishuApiHostCache;

	try {
		const response = await browser.runtime.sendMessage({
			action: 'getFeishuApiHost',
		}) as { success?: boolean; apiHost?: string };

		const host = response?.success ? (response.apiHost || '') : '';
		_feishuApiHostCache = host;
		return host;
	} catch {
		_feishuApiHostCache = '';
		return '';
	}
}

// ─── End cookie-based image URL generation ───────────────────────────────────

async function fetchFeishuImageDataUrl(fileToken: string): Promise<string | null> {
	try {
		const response = await browser.runtime.sendMessage({
			action: 'fetchFeishuImage',
			fileToken,
		}) as { success?: boolean; dataUrl?: string; error?: string };

		if (!response?.success || !response.dataUrl) {
			logger.warn(`Image binary fetch failed [${fileToken}]: ${response?.error}`);
			return null;
		}
		return response.dataUrl;
	} catch (err) {
		logger.warn(`Image binary fetch error [${fileToken}]: ${String(err)}`);
		return null;
	}
}

async function fetchFeishuSheetData(token: string): Promise<{ values: string[][] } | null> {
	// token = {spreadsheet_token}_{sheet_id} — last underscore is the separator
	const idx = token.lastIndexOf('_');
	if (idx < 0) {
		logger.warn(`Invalid sheet token format: ${token}`);
		return null;
	}
	const ssToken = token.slice(0, idx);
	const sheetId = token.slice(idx + 1);

	// Feishu's public OpenAPI exposes cell values but not cell styles (bold,
	// color, etc.) — the /style and /v3 cells endpoints return 404. Bold
	// detection would require the cookie-based MainWorld pattern used for
	// images; deferred as a follow-up enhancement.
	try {
		const resp = await fetchFeishuApi(
			`https://open.feishu.cn/open-apis/sheets/v2/spreadsheets/${ssToken}/values_batch_get?ranges=${sheetId}&valueRenderOption=ToString`
		);
		const values = (resp?.data?.valueRanges?.[0]?.values as string[][]) || [];
		return { values };
	} catch (e) {
		logger.warn(`Sheet fetch failed [${token}]: ${String(e)}`);
		return null;
	}
}

function renderSheetAsHtmlTable(values: string[][]): string {
	if (values.length === 0) return '<p>📊 [Sheet 为空]</p>';
	const escape = (s: any) => escapeHtml(String(s ?? ''));

	const [header, ...rows] = values;
	const headHtml = `<thead><tr>${header.map((c) => `<th>${escape(c)}</th>`).join('')}</tr></thead>`;
	const bodyHtml = `<tbody>${rows
		.map((row) => `<tr>${row.map((c) => `<td>${escape(c)}</td>`).join('')}</tr>`)
		.join('')}</tbody>`;
	return `<table>${headHtml}${bodyHtml}</table>`;
}

async function resolveFeishuSheets(html: string): Promise<string> {
	const placeholderPattern = /<table data-feishu-sheet="([^"]+)"><\/table>/g;
	const matches: Array<{ full: string; token: string }> = [];
	let m: RegExpExecArray | null;
	while ((m = placeholderPattern.exec(html)) !== null) {
		matches.push({ full: m[0], token: m[1] });
	}

	if (matches.length === 0) return html;

	logger.debug(`Resolving ${matches.length} Feishu sheet(s)`);

	// Concurrent fetch all sheets
	const results = await Promise.all(matches.map((m) => fetchFeishuSheetData(m.token).then((r) => ({ token: m.token, full: m.full, data: r }))));

	let result = html;
	for (const item of results) {
		const replacement = item.data
			? renderSheetAsHtmlTable(item.data.values)
			: `<p>📊 [Sheet 加载失败: ${escapeHtml(item.token.slice(0, 10))}...]</p>`;
		result = result.replace(item.full, replacement);
	}
	return result;
}

function resolveFeishuFiles(html: string, sourceDocUrl: string): string {
	const linkPattern = /<a href="feishu-file-block:\/\/([A-Za-z0-9_-]+)" data-filename="([^"]*)">([^<]*)<\/a>/g;
	const matches: Array<{ full: string; blockId: string; filename: string }> = [];
	let m: RegExpExecArray | null;
	while ((m = linkPattern.exec(html)) !== null) {
		matches.push({ full: m[0], blockId: m[1], filename: m[2] });
	}

	if (matches.length === 0) return html;

	logger.debug(`Resolving ${matches.length} Feishu file(s) -> source doc + block anchor`);

	// Feishu attachments don't have standalone URLs. Instead, link to the
	// parent doc URL with the file block's id as URL hash — Feishu's docx
	// reader scrolls the matching block into view on load, so clicking the
	// link opens the doc with the PDF preview already in viewport.
	let result = html;
	for (const item of matches) {
		const url = `${sourceDocUrl}#${item.blockId}`;
		const replacement = `<p>📎 <a href="${escapeHtml(url)}">${escapeHtml(item.filename)}</a></p>`;
		result = result.replace(item.full, replacement);
	}
	return result;
}

async function resolveFeishuImages(html: string): Promise<string> {
	const tokenPattern = /feishu-image:\/\/([A-Za-z0-9_-]+)/g;
	const tokens = new Set<string>();
	let match: RegExpExecArray | null;

	while ((match = tokenPattern.exec(html)) !== null) {
		tokens.add(match[1]);
	}

	if (tokens.size === 0) return html;

	const tokenList = Array.from(tokens);
	logger.debug(`Resolving ${tokenList.length} Feishu image(s)`);

	const base64Results = new Map<string, string>();

	// Strategy 1: cookie-based internal URL → immediately fetch binary → base64 (permanent)
	// Read the real API host from MAIN world (window.local.apiHost), which is correct for
	// both standard (my.feishu.cn) and custom domains (waytoagi.feishu.cn etc.)
	if (typeof window !== 'undefined') {
		const mainWorldHost = await readFeishuApiHostFromMainWorld();
		// Use the page's host as the API base, matching CDC's evaluateBaseUrl logic.
		// Requests are made in MAIN world (via background chrome.scripting) so that
		// the page's full session cookies and Sec-Fetch-Site: same-origin are used.
		const apiBase = (mainWorldHost || ('https://' + location.host)) + '/space';
		logger.warn(`[img-resolve] mainWorldHost="${mainWorldHost}" apiBase="${apiBase}"`);

		const tokenToCode: Record<string, string> = {};
		for (const token of tokenList) {
			tokenToCode[token] = feishuBase64Url(feishuEncodeToken(token));
		}

		try {
			const response = await browser.runtime.sendMessage({
				action: 'fetchFeishuImagesViaMainWorld',
				apiBase,
				tokenToCode,
			}) as { success: boolean; error?: string; results?: Record<string, string> };

			if (response?.success && response.results) {
				for (const [token, dataUrl] of Object.entries(response.results)) {
					if (dataUrl) base64Results.set(token, dataUrl);
				}
				logger.warn(`[img-resolve] mainWorld fetched ${base64Results.size}/${tokenList.length} images`);
			} else {
				logger.warn(`[img-resolve] mainWorld fetch failed: ${response?.error}`);
			}
		} catch (err) {
			logger.warn(`[img-resolve] mainWorld message error: ${String(err)}`);
		}
	}

	// Strategy 2: for tokens still unresolved, fall back to Open Platform API binary download
	const missingTokens = tokenList.filter(t => !base64Results.has(t));
	if (missingTokens.length > 0) {
		logger.debug(`Falling back to Open Platform binary download for ${missingTokens.length} image(s)`);
		await Promise.all(
			missingTokens.map(async (token) => {
				const dataUrl = await fetchFeishuImageDataUrl(token);
				if (dataUrl) {
					base64Results.set(token, dataUrl);
				}
			})
		);
	}

	// Defensive filter: if an image was fetched but stayed as application/octet-stream,
	// the bytes are likely encrypted (feishu's copy_out/asynccode path returns encrypted
	// blobs that the cn extractor doesn't decrypt). Drop those from base64Results so the
	// substitution loop below leaves the token as an unresolved placeholder.
	let droppedOctetStream = 0;
	for (const [token, dataUrl] of [...base64Results.entries()]) {
		if (dataUrl.startsWith('data:application/octet-stream')) {
			base64Results.delete(token);
			droppedOctetStream++;
		}
	}
	if (droppedOctetStream > 0) {
		logger.warn(`[img-resolve] dropped ${droppedOctetStream} image(s) with application/octet-stream MIME (likely encrypted)`);
	}

	let resolved = html;
	for (const token of tokenList) {
		const replacement = base64Results.get(token);
		if (replacement) {
			resolved = resolved.split(`feishu-image://${token}`).join(replacement);
		} else {
			logger.warn(`Could not resolve image [${token}]`);
		}
	}

	return resolved;
}

async function resolveDocumentId(parsedUrl: FeishuParsedUrl): Promise<{ documentId: string; objType: string } | null> {
	if (!parsedUrl.token) return null;

	if (parsedUrl.type === 'wiki') {
		const result = await fetchFeishuApi(
			`https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${parsedUrl.token}`
		);
		const node = result?.data?.node;
		if (!node?.obj_token) {
			logger.warn('Wiki get_node returned no obj_token', { result });
			return null;
		}
		return { documentId: node.obj_token, objType: node.obj_type || 'docx' };
	}

	return { documentId: parsedUrl.token, objType: parsedUrl.type === 'doc' ? 'doc' : 'docx' };
}

async function fetchAllBlocks(documentId: string): Promise<FeishuBlock[]> {
	const allBlocks: FeishuBlock[] = [];
	let pageToken: string | undefined;

	do {
		const params = new URLSearchParams({ page_size: '500', document_revision_id: '-1' });
		if (pageToken) params.set('page_token', pageToken);

		const result = await fetchFeishuApi(
			`https://open.feishu.cn/open-apis/docx/v1/documents/${documentId}/blocks?${params.toString()}`
		);

		const items = result?.data?.items;
		if (Array.isArray(items)) {
			allBlocks.push(...items);
		}

		pageToken = result?.data?.has_more ? result.data.page_token : undefined;
	} while (pageToken);

	return allBlocks;
}

async function fetchFeishuDocMeta(documentId: string, docType: 'docx' | 'doc' = 'docx'): Promise<{ ownerOpenId?: string; latestModifyTime?: number; title?: string } | null> {
	try {
		const result = await fetchFeishuApi(
			'https://open.feishu.cn/open-apis/drive/v1/metas/batch_query?user_id_type=open_id',
			{
				method: 'POST',
				body: JSON.stringify({
					request_docs: [{ doc_token: documentId, doc_type: docType }],
					with_url: false,
				}),
			},
		);
		const meta = result?.data?.metas?.[0];
		if (!meta) return null;
		return {
			ownerOpenId: meta.owner_id,
			latestModifyTime: meta.latest_modify_time ? Number(meta.latest_modify_time) : undefined,
			title: meta.title,
		};
	} catch (e) {
		logger.warn(`fetchFeishuDocMeta failed: ${String(e)}`);
		return null;
	}
}

async function resolveFeishuUserName(openId: string): Promise<string | null> {
	try {
		const result = await fetchFeishuApi(
			`https://open.feishu.cn/open-apis/contact/v3/users/${openId}?user_id_type=open_id`,
		);
		return result?.data?.user?.name || null;
	} catch (e) {
		// 41050: App lacks contact scope. Expected until user grants permission.
		const msg = String(e);
		if (msg.includes('41050') || msg.includes('no user authority')) {
			logger.debug('Contact API blocked (41050) — falling back to open_id suffix');
		} else {
			logger.warn(`resolveFeishuUserName error: ${msg}`);
		}
		return null;
	}
}

interface RenderCtx {
	blockMap: Map<string, FeishuBlock>;
	headingNumbers: Map<string, number>;
	consumedInlineIds: Set<string>;
}

// Render an HTML heading with two scys-specific concerns handled:
//   1. skipBold — heading text is already visually bold, so `<strong>` inside
//      would round-trip as `## **二、…**` (noisy + breaks `**` pair counting).
//   2. block-level text-align (style.align): scys/feishu encodes alignment as
//      1=left (default), 2=center, 3=right. We translate to <div align="…">
//      wrapper so Obsidian Reading view renders the alignment.
function renderHeading(level: number, elements: any, _style: any, ctx: RenderCtx, seqNumber?: number): string {
	// skipBold: heading <h*> tag is already visually bold; nested <strong> →
	// markdown `## **…**` is noisy and breaks `**` pair counting in adjacent
	// runs (downstream `****` literal artifacts).
	// Note: alignment (style.align) is not represented in pure markdown.
	const inner = renderTextElements(elements, ctx, { skipBold: true });
	const prefix = seqNumber !== undefined ? `${seqNumber}. ` : '';
	return `<h${level}>${prefix}${inner}</h${level}>`;
}

interface RenderTextOptions {
	// Skip <strong> wrapping when bold=true. Used by HEADING* renderers since
	// markdown heading lines are already visually bold — emitting **…** inside
	// `## …` produces noisy `## **二、…**` and breaks `**` pair counting in
	// adjacent strong runs.
	skipBold?: boolean;
}

function renderInlineBlock(blockId: string, ctx: RenderCtx): string {
	const target = ctx.blockMap.get(blockId);
	if (!target) return '';
	ctx.consumedInlineIds.add(blockId);
	switch (target.block_type) {
		case FEISHU_BLOCK_TYPE.FILE: {
			const file = target.file;
			if (!file?.name) return '';
			return `<a href="feishu-file-inline://${target.block_id}" data-filename="${escapeHtml(file.name)}">${escapeHtml(file.name)}</a>`;
		}
		case FEISHU_BLOCK_TYPE.IMAGE: {
			const img = target.image;
			if (!img?.token) return '';
			return `<img src="feishu-image://${img.token}" alt="">`;
		}
		default:
			return `[内联块 ${blockId.slice(0, 8)}]`;
	}
}

function renderTextElements(elements: FeishuTextBody['elements'], ctx: RenderCtx, opts: RenderTextOptions = {}): string {
	if (!elements || !elements.length) return '';

	const rendered = elements.map((el) => {
		if (el.inline_block?.block_id) {
			return renderInlineBlock(el.inline_block.block_id, ctx);
		}
		if (el.equation?.content) {
			return `<code>${escapeHtml(el.equation.content)}</code>`;
		}

		if (el.mention_doc?.title) {
			const title = escapeHtml(el.mention_doc.title);
			const url = el.mention_doc.url;
			if (url) {
				return `<a href="${escapeAttr(url)}">${title}</a>`;
			}
			return title;
		}

		const run = el.text_run || el.mention_user;
		if (!run) return '';

		const text = el.text_run?.content ?? '';
		if (!text) return '';

		const style = run.text_element_style;
		let html = escapeHtml(text);

		if (style?.inline_code) {
			html = `<code>${html}</code>`;
		}
		if (style?.bold && !opts.skipBold) {
			html = `<strong>${html}</strong>`;
		}
		if (style?.italic) {
			html = `<em>${html}</em>`;
		}
		if (style?.strikethrough) {
			html = `<s>${html}</s>`;
		}
		if (style?.underline) {
			html = `<u>${html}</u>`;
		}
		// Note: scys/feishu text_color is not encoded into markdown — pure
		// markdown has no color primitive, and HTML <span style="color:…">
		// gets stripped by defuddle's turndown anyway. Skip silently.
		if (style?.link?.url) {
			try {
				const decoded = decodeURIComponent(style.link.url);
				html = `<a href="${escapeAttr(decoded)}">${html}</a>`;
			} catch {
				html = `<a href="${escapeAttr(style.link.url)}">${html}</a>`;
			}
		} else {
			// Autolink bare URLs in content. scys (esp. /articleDetail/xq_topic/)
			// strips link metadata and leaves URLs as plain strings in content;
			// GFM autolink fails when a CJK punctuation (e.g. "：") sits directly
			// before the URL, so Obsidian renders it as inert text. Wrap explicitly
			// so it becomes [url](url) in markdown.
			html = autolinkBareUrls(html);
		}

		return html;
	}).join('');
	// Collapse adjacent identical <strong>/<em> blocks into a single span. Defuddle
	// converts `<strong>aa</strong><strong>bb</strong>` to `**aa****bb**`, where
	// the middle `****` is two empty strong markers that some markdown renderers
	// surface as literal `**` artifacts. Merging avoids that.
	return rendered
		.replace(/<\/strong>(\s*)<strong>/g, '$1')
		.replace(/<\/em>(\s*)<em>/g, '$1');
}

// Wraps bare http(s) URLs in <a href="…">…</a>. Skips URLs already inside an
// anchor (defense against double-wrapping when called on rich HTML like
// server-rendered comment content) and trailing punctuation that's almost
// certainly not part of the URL (Chinese/ASCII sentence terminators and
// matching brackets).
export function autolinkBareUrls(html: string): string {
	// Stop URL at whitespace, HTML metacharacters, or common Chinese/ASCII
	// closing punctuation that won't be part of a URL.
	const URL_RE = /https?:\/\/[^\s<>"'）)】」』，。；：、！？]+/g;
	const wrapOne = (url: string): string => {
		const trailing = url.match(/[.,;:!?)\]}>'"]+$/);
		let core = url;
		let tail = '';
		if (trailing) {
			core = url.slice(0, -trailing[0].length);
			tail = trailing[0];
		}
		return `<a href="${escapeAttr(core)}">${core}</a>${tail}`;
	};
	// Split on existing <a>…</a> blocks; only autolink the segments outside.
	// Anchor opening tags may carry any attributes (href, target, …).
	const ANCHOR_RE = /<a\b[^>]*>[\s\S]*?<\/a>/gi;
	const parts: string[] = [];
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = ANCHOR_RE.exec(html)) !== null) {
		parts.push(html.slice(last, m.index).replace(URL_RE, wrapOne));
		parts.push(m[0]); // keep existing anchor untouched
		last = m.index + m[0].length;
	}
	parts.push(html.slice(last).replace(URL_RE, wrapOne));
	return parts.join('');
}

function getTextBody(block: FeishuBlock): FeishuTextBody | undefined {
	switch (block.block_type) {
		case FEISHU_BLOCK_TYPE.TEXT: return block.text;
		case FEISHU_BLOCK_TYPE.HEADING1: return block.heading1;
		case FEISHU_BLOCK_TYPE.HEADING2: return block.heading2;
		case FEISHU_BLOCK_TYPE.HEADING3: return block.heading3;
		case FEISHU_BLOCK_TYPE.HEADING4: return block.heading4;
		case FEISHU_BLOCK_TYPE.HEADING5: return block.heading5;
		case FEISHU_BLOCK_TYPE.HEADING6: return block.heading6;
		case FEISHU_BLOCK_TYPE.HEADING7: return block.heading7;
		case FEISHU_BLOCK_TYPE.HEADING8: return block.heading8;
		case FEISHU_BLOCK_TYPE.HEADING9: return block.heading9;
		case FEISHU_BLOCK_TYPE.BULLET: return block.bullet;
		case FEISHU_BLOCK_TYPE.ORDERED: return block.ordered;
		case FEISHU_BLOCK_TYPE.CODE: return block.code;
		case FEISHU_BLOCK_TYPE.QUOTE: return block.quote;
		case FEISHU_BLOCK_TYPE.TODO: return block.todo;
		case FEISHU_BLOCK_TYPE.CALLOUT: return block.callout;
		default: return undefined;
	}
}

export function convertBlocksToHtml(blocks: FeishuBlock[], options?: { autoNumberHeadings?: boolean }): string {
	const blockMap = new Map<string, FeishuBlock>();
	for (const b of blocks) {
		blockMap.set(b.block_id, b);
	}

	// Optional H1+H4 auto-numbering — feishu-only (scys reuses convertBlocksToHtml
	// but its docs hand-write their own "2.1.1" prefixes, so we'd double-number).
	// Feishu web's CSS counter:
	//   - H1: global "1./2./..." across the doc (one counter for the whole doc)
	//   - H4: "1./2./..." within each H2 section (counter resets at each H2)
	// H2/H3/H5+ are NOT auto-numbered (users typically hand-write "一、二、" prefixes).
	const headingNumbers = new Map<string, number>();
	if (options?.autoNumberHeadings) {
		let h1Seq = 0;
		let h4Seq = 0;
		for (const b of blocks) {
			if (b.block_type === FEISHU_BLOCK_TYPE.HEADING1) {
				h1Seq += 1;
				headingNumbers.set(b.block_id, h1Seq);
			} else if (b.block_type === FEISHU_BLOCK_TYPE.HEADING2) {
				h4Seq = 0; // reset H4 counter at each H2 boundary
			} else if (b.block_type === FEISHU_BLOCK_TYPE.HEADING4) {
				h4Seq += 1;
				headingNumbers.set(b.block_id, h4Seq);
			}
		}
	}

	const ctx: RenderCtx = { blockMap, headingNumbers, consumedInlineIds: new Set() };

	const pageBlock = blocks.find(b => b.block_type === FEISHU_BLOCK_TYPE.PAGE);
	if (!pageBlock?.children?.length) {
		return blocks.filter(b => b.block_type !== FEISHU_BLOCK_TYPE.PAGE)
			.map(b => renderBlock(b, ctx))
			.join('');
	}

	return renderChildren(pageBlock.children, ctx);
}

/**
 * Returns true if `block` is a TEXT block whose text content (joined across
 * all text_run elements) is empty after trim. Spacer = feishu's "blank line"
 * convention between paragraphs/sections.
 */
function isEmptyTextSpacer(block: FeishuBlock | undefined): boolean {
	if (!block || block.block_type !== FEISHU_BLOCK_TYPE.TEXT) return false;
	const text = (block.text?.elements || [])
		.map((e) => e.text_run?.content || '')
		.join('');
	return text.trim().length === 0;
}

/**
 * Returns true if `block` is a TEXT block whose every non-empty `text_run`
 * element is bold — the feishu-web convention for an inline section header
 * placed between two list groups (e.g. "家长的痛点：" above a bullet list).
 *
 * Empty TEXTs (spacers) → false. Plain TEXTs (explanation paragraphs) → false.
 */
export function isSectionHeaderText(block: FeishuBlock): boolean {
	if (block.block_type !== FEISHU_BLOCK_TYPE.TEXT) return false;
	const elements = block.text?.elements || [];
	const nonEmpty = elements.filter(
		(e) => (e.text_run?.content || '').trim().length > 0,
	);
	if (nonEmpty.length === 0) return false;
	return nonEmpty.every(
		(e) => e.text_run?.text_element_style?.bold === true,
	);
}

const LIST_KINDS = [
	FEISHU_BLOCK_TYPE.BULLET,
	FEISHU_BLOCK_TYPE.ORDERED,
	FEISHU_BLOCK_TYPE.TODO,
] as const;
type ListKind = typeof LIST_KINDS[number];

// Structural blocks that close any open list when encountered as a sibling.
// Anything not in this set and not a list kind is treated as a "follower"
// (continuation content) that gets appended to the preceding <li>.
const LIST_BOUNDARIES = new Set<number>([
	FEISHU_BLOCK_TYPE.PAGE,
	FEISHU_BLOCK_TYPE.HEADING1, FEISHU_BLOCK_TYPE.HEADING2, FEISHU_BLOCK_TYPE.HEADING3,
	FEISHU_BLOCK_TYPE.HEADING4, FEISHU_BLOCK_TYPE.HEADING5, FEISHU_BLOCK_TYPE.HEADING6,
	FEISHU_BLOCK_TYPE.HEADING7, FEISHU_BLOCK_TYPE.HEADING8, FEISHU_BLOCK_TYPE.HEADING9,
	FEISHU_BLOCK_TYPE.CALLOUT,
	FEISHU_BLOCK_TYPE.QUOTE_CONTAINER,
	FEISHU_BLOCK_TYPE.GRID,
	FEISHU_BLOCK_TYPE.TABLE,
	FEISHU_BLOCK_TYPE.DIVIDER,
	FEISHU_BLOCK_TYPE.IFRAME,
]);

function isListKind(t: number): t is ListKind {
	return (LIST_KINDS as readonly number[]).includes(t);
}

function renderTodoItem(
	block: FeishuBlock,
	ctx: RenderCtx,
	appendHtml = '',
): string {
	const done = (block.todo as any)?.style?.done === true;
	const inner = renderTextElements(block.todo?.elements, ctx);
	const children = renderBlockChildren(block, ctx);
	const checkbox = done ? '[x] ' : '[ ] ';
	return `<li>${escapeHtml(checkbox)}${inner}${children}${appendHtml}</li>`;
}

// Accumulates a single logical list starting at childIds[startIdx].
// - blocks of `kind` → new <li>, and any buffered followers flush to the
//   PREVIOUS <li> (the one this block does NOT belong to)
// - LIST_BOUNDARIES or a different list kind → close the list
// - other blocks → buffered as followers (TEXT, IFRAME, IMAGE, FILE, QUOTE, …)
// - on close, remaining followers flush to the LAST <li>
function collectListGroup(
	kind: ListKind,
	childIds: string[],
	startIdx: number,
	ctx: RenderCtx,
): { html: string; nextIdx: number } {
	type Entry = { block: FeishuBlock; followerBlocks: FeishuBlock[] };
	const entries: Entry[] = [];
	let pendingFollowers: FeishuBlock[] = [];
	let i = startIdx;

	while (i < childIds.length) {
		const b = ctx.blockMap.get(childIds[i]);
		if (!b) { i++; continue; }

		if (b.block_type === kind) {
			if (entries.length > 0 && pendingFollowers.length > 0) {
				entries[entries.length - 1].followerBlocks.push(...pendingFollowers);
				pendingFollowers = [];
			}
			entries.push({ block: b, followerBlocks: [] });
			i++;
			continue;
		}

		if (isListKind(b.block_type) || LIST_BOUNDARIES.has(b.block_type)) {
			break;
		}

		// A bold-only TEXT block is the feishu convention for a section header
		// (e.g., "家长的痛点：" above a bullet list). Close the current list so
		// the header renders as its own <p><strong>…</strong></p> paragraph.
		if (isSectionHeaderText(b)) {
			break;
		}

		// An empty TEXT spacer (feishu's blank-line convention) signals
		// end-of-list when the next non-empty block is NOT the same list kind.
		// If the next non-empty block IS the same kind, keep absorbing the
		// spacer as a follower so list items separated by a blank line stay
		// in one <ul>/<ol>.
		if (isEmptyTextSpacer(b)) {
			let j = i + 1;
			while (j < childIds.length && isEmptyTextSpacer(ctx.blockMap.get(childIds[j]))) {
				j++;
			}
			const next = j < childIds.length ? ctx.blockMap.get(childIds[j]) : undefined;
			if (next && next.block_type === kind) {
				pendingFollowers.push(b);
				i++;
				continue;
			}
			// Close the list; leave `i` pointing AT the spacer so the upper
			// `renderChildren` loop processes spacer + following blocks as
			// page-level siblings (empty TEXT renders as '' in renderBlock).
			break;
		}

		pendingFollowers.push(b);
		i++;
	}

	if (entries.length > 0 && pendingFollowers.length > 0) {
		entries[entries.length - 1].followerBlocks.push(...pendingFollowers);
	}

	const liHtml = entries.map(({ block, followerBlocks }) => {
		const appendHtml = followerBlocks.map((fb) => renderBlock(fb, ctx)).join('');
		if (kind === FEISHU_BLOCK_TYPE.TODO) {
			return renderTodoItem(block, ctx, appendHtml);
		}
		return renderListItem(block, ctx, appendHtml);
	}).join('');

	const openTag =
		kind === FEISHU_BLOCK_TYPE.ORDERED ? '<ol>' :
		kind === FEISHU_BLOCK_TYPE.TODO ? '<ul class="feishu-todo">' :
		'<ul>';
	const closeTag = kind === FEISHU_BLOCK_TYPE.ORDERED ? '</ol>' : '</ul>';

	return { html: `${openTag}${liHtml}${closeTag}`, nextIdx: i };
}

function renderChildren(childIds: string[], ctx: RenderCtx): string {
	const parts: string[] = [];
	let i = 0;

	while (i < childIds.length) {
		const block = ctx.blockMap.get(childIds[i]);
		if (!block) { i++; continue; }

		if (isListKind(block.block_type)) {
			const { html, nextIdx } = collectListGroup(
				block.block_type as ListKind,
				childIds,
				i,
				ctx,
			);
			parts.push(html);
			i = nextIdx;
			continue;
		}

		parts.push(renderBlock(block, ctx));
		i++;
	}

	return parts.join('');
}

function renderListItem(
	block: FeishuBlock,
	ctx: RenderCtx,
	appendHtml = '',
): string {
	const body = getTextBody(block);
	const inner = renderTextElements(body?.elements, ctx);
	const children = renderBlockChildren(block, ctx);
	return `<li>${inner}${children}${appendHtml}</li>`;
}

function renderBlockChildren(block: FeishuBlock, ctx: RenderCtx): string {
	if (!block.children?.length) return '';
	return renderChildren(block.children, ctx);
}

function renderBlock(block: FeishuBlock, ctx: RenderCtx): string {
	switch (block.block_type) {
		case FEISHU_BLOCK_TYPE.PAGE:
			return renderBlockChildren(block, ctx);

		case FEISHU_BLOCK_TYPE.TEXT: {
			const inner = renderTextElements(block.text?.elements, ctx);
			if (!inner.trim()) return '';
			return `<p>${inner}</p>`;
		}

		case FEISHU_BLOCK_TYPE.HEADING1:
			return renderHeading(1, block.heading1?.elements, (block.heading1 as any)?.style, ctx, ctx.headingNumbers.get(block.block_id));
		case FEISHU_BLOCK_TYPE.HEADING2:
			return renderHeading(2, block.heading2?.elements, (block.heading2 as any)?.style, ctx);
		case FEISHU_BLOCK_TYPE.HEADING3:
			return renderHeading(3, block.heading3?.elements, (block.heading3 as any)?.style, ctx);
		case FEISHU_BLOCK_TYPE.HEADING4:
			return renderHeading(4, block.heading4?.elements, (block.heading4 as any)?.style, ctx, ctx.headingNumbers.get(block.block_id));
		case FEISHU_BLOCK_TYPE.HEADING5:
			return renderHeading(5, block.heading5?.elements, (block.heading5 as any)?.style, ctx);
		case FEISHU_BLOCK_TYPE.HEADING6:
			return renderHeading(6, block.heading6?.elements, (block.heading6 as any)?.style, ctx);
		case FEISHU_BLOCK_TYPE.HEADING7:
		case FEISHU_BLOCK_TYPE.HEADING8:
		case FEISHU_BLOCK_TYPE.HEADING9: {
			const body = getTextBody(block);
			return renderHeading(6, body?.elements, (body as any)?.style, ctx);
		}

		case FEISHU_BLOCK_TYPE.BULLET:
			return `<ul>${renderListItem(block, ctx)}</ul>`;
		case FEISHU_BLOCK_TYPE.ORDERED:
			return `<ol>${renderListItem(block, ctx)}</ol>`;

		case FEISHU_BLOCK_TYPE.CODE: {
			const inner = renderTextElements(block.code?.elements, ctx);
			return `<pre><code>${inner}</code></pre>`;
		}

		case FEISHU_BLOCK_TYPE.QUOTE: {
			const inner = renderTextElements(block.quote?.elements, ctx);
			return `<blockquote><p>${inner}</p></blockquote>`;
		}

		case FEISHU_BLOCK_TYPE.QUOTE_CONTAINER: {
			const children = renderBlockChildren(block, ctx);
			return `<blockquote>${children}</blockquote>`;
		}

		case FEISHU_BLOCK_TYPE.TODO: {
			const done = (block.todo as any)?.style?.done === true;
			const inner = renderTextElements(block.todo?.elements, ctx);
			const checkbox = done ? '[x] ' : '[ ] ';
			return `<ul class="feishu-todo"><li>${escapeHtml(checkbox)}${inner}</li></ul>`;
		}

		case FEISHU_BLOCK_TYPE.CALLOUT: {
			// Two emoji_id shapes seen:
			//   scys docx:       block.callout.emoji_id
			//   feishu standard: block.callout.style.emoji_id
			// Emit Obsidian-native callout syntax (`[!type] title`) so reading
			// view shows a colored box matching feishu's tinted callout, and
			// keep the original emoji inline in the title so visual parity is
			// preserved when Obsidian's default icon for that type differs.
			const callout = block.callout as any;
			const emojiId = callout?.emoji_id || callout?.style?.emoji_id || '';
			const emoji = emojiId ? feishuEmojiToUnicode(emojiId) : '';
			const calloutType = FEISHU_EMOJI_TO_CALLOUT_TYPE[emojiId] || 'note';

			let titleText = renderTextElements(block.callout?.elements, ctx);
			const allChildIds = block.children || [];
			let bodyChildIds = allChildIds;
			// scys docx callouts have callout.elements=null and put the visual
			// title as a leading heading child. Promote that into the title
			// line so Obsidian shows it on the callout's coloured header bar.
			if (!titleText && allChildIds.length > 0) {
				const firstChild = ctx.blockMap.get(allChildIds[0]);
				const headingKey = firstChild ? ({
					[FEISHU_BLOCK_TYPE.HEADING1]: 'heading1',
					[FEISHU_BLOCK_TYPE.HEADING2]: 'heading2',
					[FEISHU_BLOCK_TYPE.HEADING3]: 'heading3',
					[FEISHU_BLOCK_TYPE.HEADING4]: 'heading4',
					[FEISHU_BLOCK_TYPE.HEADING5]: 'heading5',
					[FEISHU_BLOCK_TYPE.HEADING6]: 'heading6',
					[FEISHU_BLOCK_TYPE.HEADING7]: 'heading7',
					[FEISHU_BLOCK_TYPE.HEADING8]: 'heading8',
					[FEISHU_BLOCK_TYPE.HEADING9]: 'heading9',
				} as Record<number, string | undefined>)[firstChild.block_type as number] : undefined;
				if (firstChild && headingKey) {
					titleText = renderTextElements((firstChild as any)[headingKey]?.elements, ctx);
					bodyChildIds = allChildIds.slice(1);
				}
			}
			const childrenHtml = renderChildren(bodyChildIds, ctx);
			const title = [emoji, titleText].filter(Boolean).join(' ');
			const titleLine = `[!${calloutType}]${title ? ' ' + title : ''}`;
			return `<blockquote class="feishu-callout"><p>${titleLine}</p>${childrenHtml}</blockquote>`;
		}

		case FEISHU_BLOCK_TYPE.DIVIDER:
			return '<hr>';

		case FEISHU_BLOCK_TYPE.IMAGE: {
			const img = block.image;
			if (!img?.token) return '';
			const captionHtml = img.caption?.content
				? `<figcaption>${escapeHtml(img.caption.content)}</figcaption>`
				: '';
			return `<figure><img src="feishu-image://${img.token}" alt="" width="${img.width || ''}" height="${img.height || ''}">${captionHtml}</figure>`;
		}

		case FEISHU_BLOCK_TYPE.FILE: {
			const file = block.file;
			if (!file?.name || !block.block_id) {
				return file?.name ? `<p>📎 ${escapeHtml(file.name)}</p>` : '';
			}
			// Use block_id (not file_token): Feishu doesn't expose attachments
			// as standalone /file/{token} URLs — they live inside their parent
			// doc. Anchor with #{block_id} makes the doc scroll to the
			// attachment when opened.
			return `<a href="feishu-file-block://${block.block_id}" data-filename="${escapeHtml(file.name)}">${escapeHtml(file.name)}</a>`;
		}

		case FEISHU_BLOCK_TYPE.TABLE: {
			return renderTable(block, ctx);
		}

		case FEISHU_BLOCK_TYPE.GRID: {
			return renderBlockChildren(block, ctx);
		}

		case FEISHU_BLOCK_TYPE.GRID_COLUMN: {
			return renderBlockChildren(block, ctx);
		}

		// VIEW (33) and SOURCE_SYNCED (49) are transparent containers — render
		// children, drop self elements. VIEW wraps embedded attachments /
		// referenced documents (actual FILE child sits one level down, must
		// recurse to render it instead of dropping the whole subtree).
		case FEISHU_BLOCK_TYPE.VIEW:
		case FEISHU_BLOCK_TYPE.SOURCE_SYNCED: {
			return renderBlockChildren(block, ctx);
		}

		case FEISHU_BLOCK_TYPE.SHEET: {
			// Embedded spreadsheet: token format is {spreadsheet_token}_{sheet_id}.
			// Emit a placeholder; resolveFeishuSheets() fetches data + replaces it
			// with a real HTML table.
			const token = (block as any).sheet?.token;
			if (!token) return `<p>📊 [Sheet 无 token]</p>`;
			return `<table data-feishu-sheet="${token}"></table>`;
		}

		case FEISHU_BLOCK_TYPE.IFRAME: {
			const rawUrl = block.iframe?.component?.url;
			if (!rawUrl) return `<p>[Embedded content: type 26]</p>`;
			const decoded = safeDecode(rawUrl);
			const label = extractDomainLabel(decoded) || decoded;
			return `<p>🌐 <a href="${escapeAttr(decoded)}">${escapeHtml(label)}</a></p>`;
		}

		case FEISHU_BLOCK_TYPE.WIDGET:
		case FEISHU_BLOCK_TYPE.MINDNOTE:
		case FEISHU_BLOCK_TYPE.DIAGRAM:
		case FEISHU_BLOCK_TYPE.CHAT_CARD:
			return `<p>[Embedded content: type ${block.block_type}]</p>`;

		default:
			return '';
	}
}

function renderTable(block: FeishuBlock, ctx: RenderCtx): string {
	const table = block.table;
	if (!table?.property) return '';

	const rowSize = table.property.row_size || 0;
	const colSize = table.property.column_size || 0;
	const cellIds = block.children || [];

	if (!rowSize || !colSize || !cellIds.length) return '';

	const rows: string[] = [];
	for (let r = 0; r < rowSize; r++) {
		const cells: string[] = [];
		for (let c = 0; c < colSize; c++) {
			const idx = r * colSize + c;
			const cellId = cellIds[idx];
			const cellBlock = cellId ? ctx.blockMap.get(cellId) : undefined;
			const tag = r === 0 ? 'th' : 'td';
			if (cellBlock?.children?.length) {
				const content = renderChildren(cellBlock.children, ctx);
				cells.push(`<${tag}>${content}</${tag}>`);
			} else {
				cells.push(`<${tag}></${tag}>`);
			}
		}
		rows.push(`<tr>${cells.join('')}</tr>`);
	}

	return `<table>${rows.join('')}</table>`;
}

export async function extractFeishuStructuredContent(doc: Document): Promise<FeishuStructuredContent | null> {
	if (!isFeishuDocUrl(doc.URL)) return null;

	const parsedUrl = parseFeishuUrl(doc.URL);
	if (!parsedUrl.token || !parsedUrl.type) {
		logger.warn('Failed to parse URL', { url: doc.URL });
		return null;
	}

	const resolved = await resolveDocumentId(parsedUrl);
	if (!resolved) {
		logger.warn('Failed to resolve document ID', { token: parsedUrl.token, type: parsedUrl.type });
		return null;
	}

	logger.debug('Resolved document', { documentId: resolved.documentId, objType: resolved.objType });

	const [blocks, docMeta] = await Promise.all([
		fetchAllBlocks(resolved.documentId),
		fetchFeishuDocMeta(resolved.documentId, resolved.objType as 'docx' | 'doc'),
	]);

	if (!blocks.length) {
		logger.warn('No blocks returned', { documentId: resolved.documentId });
		return null;
	}

	logger.info('Extraction complete', { documentId: resolved.documentId, blockCount: blocks.length });

	const rawContent = convertBlocksToHtml(blocks, { autoNumberHeadings: true });
	const imagesResolved = await resolveFeishuImages(rawContent);
	const sheetsResolved = await resolveFeishuSheets(imagesResolved);
	const content = resolveFeishuFiles(sheetsResolved, doc.URL);

	let commentsMarkdown = '';
	try {
		commentsMarkdown = await extractFeishuComments(resolved.documentId);
	} catch (e) {
		logger.warn(`Comments extraction threw: ${String(e)}`);
	}

	// Author resolution priority:
	//   1. DOM scrape — feishu web renders the doc owner's display name in
	//      `.docs-info-avatar-name-text` (first match = primary owner).
	//      Works without OpenAPI permissions because the page already loaded
	//      contact info for current user's view.
	//   2. Contact API — fallback for clipping flows without page DOM
	//      (e.g., headless test). Returns null on 41050 (cross-tenant user).
	//   3. Empty string — open_id is a useless feishu internal ID for users;
	//      we don't surface it. frontmatter `author:` stays empty.
	const ownerOpenId = docMeta?.ownerOpenId || '';
	const domAuthor = (() => {
		try {
			const el = doc.querySelector?.('.docs-info-avatar-name-text');
			return el?.textContent?.trim() || '';
		} catch { return ''; }
	})();
	const apiName = !domAuthor && ownerOpenId ? await resolveFeishuUserName(ownerOpenId) : null;
	const authorTag = domAuthor || apiName || '';
	const publishedDate = docMeta?.latestModifyTime
		? convertDate(new Date(docMeta.latestModifyTime * 1000))
		: '';

	const textContent = blocks
		.map(b => {
			const body = getTextBody(b);
			if (!body?.elements) return '';
			return body.elements
				.map(el => el.text_run?.content || '')
				.join('');
		})
		.join('\n')
		.trim();

	const wordCount = textContent.split(/\s+/).filter(Boolean).length || textContent.length;

	return {
		title: docMeta?.title || doc.title || '',
		author: authorTag,
		content,
		commentsMarkdown: commentsMarkdown || undefined,
		published: publishedDate || undefined,
		wordCount,
	};
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function escapeAttr(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function safeDecode(s: string): string {
	try { return decodeURIComponent(s); } catch { return s; }
}

function extractDomainLabel(url: string): string {
	try {
		const u = new URL(url);
		const hostname = u.hostname.replace(/^www\./, '');
		const path = u.pathname && u.pathname !== '/' ? u.pathname : '';
		const search = !path && u.search ? u.search : '';
		return hostname + path + search;
	} catch {
		return '';
	}
}
