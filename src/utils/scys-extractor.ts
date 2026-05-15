import browser from 'webextension-polyfill';
import { createLogger } from './logger';
import { convertBlocksToHtml } from './feishu-extractor';
import type { FeishuBlock } from './feishu-extractor';

const logger = createLogger('scys-extractor');

export function isScysCourseUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		if (parsed.hostname !== 'scys.com') return false;
		if (!/^\/course\/detail\/\d+/.test(parsed.pathname)) return false;
		return /^\d+$/.test(parsed.searchParams.get('chapterId') ?? '');
	} catch {
		return false;
	}
}

export function parseScysUrl(url: string): { courseId: number; chapterId: number } | null {
	try {
		const parsed = new URL(url);
		const pathMatch = parsed.pathname.match(/^\/course\/detail\/(\d+)/);
		const chapterIdStr = parsed.searchParams.get('chapterId');
		if (!pathMatch || !chapterIdStr || !/^\d+$/.test(chapterIdStr)) return null;
		return { courseId: parseInt(pathMatch[1], 10), chapterId: parseInt(chapterIdStr, 10) };
	} catch {
		return null;
	}
}

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

export interface ScysBlock extends Omit<FeishuBlock, 'children'> {
	children_blocks?: ScysBlock[];
	// scys serves the signed OSS URL as a top-level block field
	// (sibling to `image`, not nested inside it). image.token still
	// carries the feishu-style identifier.
	file_url?: string;
	// scys comment content uses block_type=5001 with server-rendered HTML
	// in sc_html.content (instead of feishu's structured text.elements)
	sc_html?: { content?: string };
}

const HEADING_REWRITE: Record<number, { newType: number; oldField: keyof ScysBlock; newField: string }> = {
	6: { newType: 4, oldField: 'heading4', newField: 'heading2' },
	7: { newType: 5, oldField: 'heading5', newField: 'heading3' },
	8: { newType: 6, oldField: 'heading6', newField: 'heading4' },
};

export function flattenScysBlocks(blocks: ScysBlock[]): FeishuBlock[] {
	const out: FeishuBlock[] = [];

	function walk(block: ScysBlock, parentId?: string): void {
		const childBlocks = block.children_blocks ?? [];
		const childIds = childBlocks.map(c => c.block_id);

		// Shallow copy without children_blocks
		const { children_blocks: _drop, ...rest } = block;
		const flat: any = { ...rest, parent_id: parentId, children: childIds.length ? childIds : undefined };

		// Heading rewrite (block_type 6/7/8 → 4/5/6, copy body to new field name)
		const rewrite = HEADING_REWRITE[flat.block_type];
		if (rewrite) {
			const body = flat[rewrite.oldField];
			if (body === undefined) {
				logger.warn(`heading rewrite: missing ${rewrite.oldField} on block ${block.block_id}`);
			}
			flat[rewrite.newField] = body;
			delete flat[rewrite.oldField];
			flat.block_type = rewrite.newType;
		}

		// Image: inject scys: prefixed token from top-level file_url
		// (scys serves the OSS signed URL alongside the image block, not inside image)
		if (flat.block_type === 27 && flat.file_url) {
			flat.image = { ...flat.image, token: `scys:${encodeURIComponent(flat.file_url)}` };
		}

		out.push(flat as FeishuBlock);
		for (const child of childBlocks) walk(child, block.block_id);
	}

	for (const b of blocks) walk(b);
	return out;
}

export function renderScysChapterContent(scysBlocks: ScysBlock[]): string {
	const flat = flattenScysBlocks(scysBlocks);
	// scys API doesn't include a PAGE block, so synthesise one so convertBlocksToHtml
	// uses the renderChildren(pageBlock.children, blockMap) path. Otherwise it falls
	// back to iterating the entire flat array, which re-renders content nested inside
	// callout/table/grid/quote_container containers (double output).
	const rootIds = scysBlocks.map(b => b.block_id);
	const FEISHU_PAGE_TYPE = 1;
	const page: FeishuBlock = {
		block_id: '__scys_page__',
		block_type: FEISHU_PAGE_TYPE,
		children: rootIds,
	};
	return convertBlocksToHtml([page, ...flat]);
}

async function blobToDataUrl(blob: Blob): Promise<string> {
	// Avoid FileReader so this works in both browser content scripts and the
	// node test runner (vitest is not configured with jsdom). Same pattern as
	// background.ts fetchFeishuImagesViaMainWorld L807-813.
	const buf = await blob.arrayBuffer();
	const bytes = new Uint8Array(buf);
	let bin = '';
	for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
	const base64 = btoa(bin);
	// Default to image/png when blob.type is missing — application/octet-stream
	// would make the browser treat the data URL as a download, not an inline <img>.
	// Matches background.ts:807-813 pattern for feishu images.
	const mime = blob.type || 'image/png';
	return `data:${mime};base64,${base64}`;
}

async function fetchScysImageL1(scysToken: string): Promise<string | null> {
	const fileUrl = decodeURIComponent(scysToken.replace(/^scys:/, ''));
	try {
		const res = await fetch(fileUrl, { credentials: 'include' });
		if (!res.ok) {
			const display = fileUrl.length > 80 ? fileUrl.slice(0, 80) + '...' : fileUrl;
			logger.warn(`[scys-img L1] HTTP ${res.status} for ${display}`);
			return null;
		}
		const blob = await res.blob();
		return await blobToDataUrl(blob);
	} catch (err) {
		logger.warn(`[scys-img L1] fetch error: ${String(err)}`);
		return null;
	}
}

export async function resolveScysImages(html: string): Promise<string> {
	const tokenPattern = /feishu-image:\/\/(scys:[^"'\s>]+)/g;
	const tokens = new Set<string>();
	let match: RegExpExecArray | null;
	while ((match = tokenPattern.exec(html)) !== null) {
		tokens.add(match[1]);
	}
	if (tokens.size === 0) return html;

	const replacements = new Map<string, string>();

	// L1: same-origin fetch in content-script
	await Promise.all(
		Array.from(tokens).map(async (token) => {
			const dataUrl = await fetchScysImageL1(token);
			if (dataUrl) replacements.set(token, dataUrl);
		})
	);

	// L2: for unresolved tokens, dispatch background MAIN-world fetch
	const unresolved = Array.from(tokens).filter(t => !replacements.has(t));
	if (unresolved.length > 0 && typeof browser !== 'undefined') {
		const urlsToTokens = new Map<string, string>();
		for (const t of unresolved) {
			urlsToTokens.set(decodeURIComponent(t.replace(/^scys:/, '')), t);
		}
		const urls = Array.from(urlsToTokens.keys());
		try {
			const resp = await browser.runtime.sendMessage({
				action: 'fetchScysImagesViaMainWorld',
				urls,
			}) as { success?: boolean; results?: Record<string, string> };
			if (resp?.success && resp.results) {
				for (const [url, dataUrl] of Object.entries(resp.results)) {
					const token = urlsToTokens.get(url);
					if (token && dataUrl) replacements.set(token, dataUrl);
				}
			}
		} catch (err) {
			logger.warn(`[scys-img L2] error: ${String(err)}`);
		}
	}

	let resolved = html;
	for (const [token, dataUrl] of replacements) {
		resolved = resolved.split(`feishu-image://${token}`).join(dataUrl);
	}
	return resolved;
}

export interface ScysChapter {
	id: number;
	title: string;
	content: ScysBlock[];
}

export interface ScysComment {
	id: number;
	user_id: number;
	title?: string;
	content: ScysBlock[];
	comments?: ScysComment[] | null;
	like_count: number;
	created_at: number | string;
}

export interface ScysUser {
	id: number;
	name: string;
	avatar?: string;
}

export interface ScysCommentsResult {
	total: number;
	items: ScysComment[];
	users: Map<number, ScysUser>;
}

export async function fetchScysChapter(courseId: number, chapterId: number): Promise<ScysChapter | null> {
	try {
		const res = await fetch(
			`/search/course/getChapterContent?course_id=${courseId}&chapter_id=${chapterId}`,
			{ credentials: 'include' }
		);
		if (!res.ok) {
			logger.warn(`[chapter] HTTP ${res.status}`);
			return null;
		}
		const json = await res.json();
		const chapter = json?.data?.chapter;
		if (!chapter || !Array.isArray(chapter.content)) {
			logger.warn(`[chapter] unexpected response shape (course=${courseId} chapter=${chapterId})`);
			return null;
		}
		return chapter as ScysChapter;
	} catch (err) {
		logger.warn(`[chapter] fetch error: ${String(err)}`);
		return null;
	}
}

export async function fetchScysComments(
	courseId: number,
	chapterId: number,
): Promise<ScysCommentsResult | null> {
	const pageSize = 20;
	const items: ScysComment[] = [];
	const users = new Map<number, ScysUser>();
	let total = 0;
	let page = 1;
	const PAGE_CAP = 50;

	while (true) {
		if (page > PAGE_CAP) {
			logger.warn(`[comments] page cap (${PAGE_CAP}) reached, stopping before page ${page}`);
			break;
		}
		let json: any;
		try {
			const res = await fetch(
				`/search/course/getCourseComments?course_id=${courseId}&chapter_id=${chapterId}&page=${page}&page_size=${pageSize}&sort_by=most_likes`,
				{ credentials: 'include' }
			);
			if (!res.ok) {
				if (page === 1) return null;
				break;
			}
			json = await res.json();
		} catch (err) {
			logger.warn(`[comments page=${page}] fetch error: ${String(err)}`);
			if (page === 1) return null;
			break;
		}

		const data = json?.data;
		if (!data) {
			if (page === 1) return null;
			break;
		}
		total = data.total ?? total;
		const pageItems: ScysComment[] = Array.isArray(data.items) ? data.items : [];
		items.push(...pageItems);
		for (const u of data.extra?.users ?? []) {
			if (u?.id) users.set(u.id, { id: u.id, name: u.name, avatar: u.avatar });
		}
		if (pageItems.length === 0) break;
		if (items.length >= total) break;
		page++;
	}
	return { total, items, users };
}

export async function fetchScysCourse(courseId: number): Promise<{ title?: string; author?: string } | null> {
	try {
		const res = await fetch(`/search/course/getCourseDetail?course_id=${courseId}`, { credentials: 'include' });
		if (!res.ok) return null;
		const json = await res.json();
		const course = json?.data?.course ?? json?.data;
		if (!course) return null;
		return {
			title: course.title || course.name,
			author: course.author || course.teacher_name || course.creator_name,
		};
	} catch {
		return null;
	}
}

function formatScysDate(ts: number | string): string {
	// scys API delivers ISO 8601 strings, but the function also accepts unix
	// seconds for compatibility with synthetic tests.
	const d = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

export function formatScysCommentHeader(comment: ScysComment, users: Map<number, ScysUser>): string {
	const user = users.get(comment.user_id);
	const name = user?.name ?? `匿名#${comment.user_id}`;
	const date = formatScysDate(comment.created_at);
	const likes = comment.like_count > 0 ? ` · ${comment.like_count} ❤️` : '';
	return `**${name}**${likes} · ${date}`;
}

// Comment content is a mix of:
// - block_type=5001 with server-rendered sc_html.content (the actual text)
// - block_type=27 image blocks (handled via the standard scys: token path)
function renderCommentBodyHtml(blocks: ScysBlock[]): string {
	return blocks.map(b => {
		if (b.block_type === 5001) {
			return b.sc_html?.content ?? '';
		}
		// Other block types (esp. image=27) go through the standard chapter pipeline
		// so the scys:-token injection works.
		return convertBlocksToHtml(flattenScysBlocks([b]));
	}).join('');
}

// Convert markdown-style header like "**叁斤** · 9 ❤️ · 2026-05-10" into HTML so downstream
// defuddle doesn't escape the asterisks.
function formatHeaderToHtml(header: string): string {
	// header has the form "**{name}**{optional likes + date}"
	const m = header.match(/^\*\*([^*]+)\*\*(.*)$/);
	if (!m) return `<p>${header}</p>`;
	const [, name, rest] = m;
	return `<p><strong>${name}</strong>${rest}</p>`;
}

// Sync variant retained for unit tests that don't need image resolution.
// Production code uses renderScysCommentsAsync (called from extractScysStructuredContent).
function renderOneCommentHtml(comment: ScysComment, users: Map<number, ScysUser>): string {
	const header = formatScysCommentHeader(comment, users);
	const bodyHtml = renderCommentBodyHtml(comment.content ?? []);
	const replies = Array.isArray(comment.comments) ? comment.comments : [];
	const repliesHtml = replies.map(r => renderOneCommentHtml(r, users)).join('');
	const headerHtml = formatHeaderToHtml(header);
	return `<blockquote>${headerHtml}${bodyHtml}${repliesHtml}</blockquote>`;
}

export function renderScysComments(result: ScysCommentsResult): string {
	if (!result.items.length) return '';
	const bodies = result.items.map(item => renderOneCommentHtml(item, result.users)).join('');
	return `<hr><h2>💬 章节评论（${result.total} 条）</h2>${bodies}`;
}

export interface ScysStructuredContent {
	title: string;
	author: string;
	content: string;
	wordCount: number;
}

function countWordsFromBlocks(blocks: FeishuBlock[]): number {
	let n = 0;
	for (const b of blocks) {
		const body =
			b.text || (b as any).heading1 || (b as any).heading2 || (b as any).heading3 ||
			(b as any).heading4 || (b as any).heading5 || (b as any).heading6 ||
			(b as any).heading7 || (b as any).heading8 || (b as any).heading9 ||
			b.bullet || b.ordered || b.code || b.quote || b.callout || b.todo;
		if (!body?.elements) continue;
		for (const el of body.elements) {
			const c = el.text_run?.content || '';
			n += c.length;
		}
	}
	return n;
}

async function renderOneCommentHtmlAsync(
	comment: ScysComment,
	users: Map<number, ScysUser>,
): Promise<string> {
	const header = formatScysCommentHeader(comment, users);
	let bodyHtml = renderCommentBodyHtml(comment.content ?? []);
	bodyHtml = await resolveScysImages(bodyHtml);
	const replies = Array.isArray(comment.comments) ? comment.comments : [];
	// Render sibling replies concurrently (mirrors renderScysCommentsAsync's
	// top-level concurrency). Order is preserved by Promise.all.
	const repliesHtml = (await Promise.all(replies.map(r => renderOneCommentHtmlAsync(r, users)))).join('');
	const headerHtml = formatHeaderToHtml(header);
	return `<blockquote>${headerHtml}${bodyHtml}${repliesHtml}</blockquote>`;
}

export async function renderScysCommentsAsync(result: ScysCommentsResult): Promise<string> {
	if (!result.items.length) return '';
	const bodies = await Promise.all(result.items.map(item => renderOneCommentHtmlAsync(item, result.users)));
	return `<hr><h2>💬 章节评论（${result.total} 条）</h2>${bodies.join('')}`;
}

async function extractScysCourseChapter(doc: Document): Promise<ScysStructuredContent | null> {
	if (!isScysCourseUrl(doc.URL)) return null;
	const parsed = parseScysUrl(doc.URL);
	if (!parsed) return null;

	const chapter = await fetchScysChapter(parsed.courseId, parsed.chapterId);
	if (!chapter) {
		logger.warn(`Chapter fetch failed for course=${parsed.courseId} chapter=${parsed.chapterId}`);
		return null;
	}

	let html = renderScysChapterContent(chapter.content);
	html = await resolveScysImages(html);

	const [commentsResult, courseMeta] = await Promise.all([
		fetchScysComments(parsed.courseId, parsed.chapterId),
		fetchScysCourse(parsed.courseId),
	]);

	let commentsMd = '';
	if (commentsResult && commentsResult.items.length) {
		commentsMd = await renderScysCommentsAsync(commentsResult);
	}

	const flatBlocks = flattenScysBlocks(chapter.content);
	const wordCount = countWordsFromBlocks(flatBlocks);

	return {
		title: chapter.title,
		author: courseMeta?.author || '',
		content: html + commentsMd,
		wordCount,
	};
}

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

export async function extractScysStructuredContent(doc: Document): Promise<ScysStructuredContent | null> {
	if (isScysCourseUrl(doc.URL)) return extractScysCourseChapter(doc);
	if (isScysDocxUrl(doc.URL)) return extractScysDocxStandalone(doc);
	return null;
}
