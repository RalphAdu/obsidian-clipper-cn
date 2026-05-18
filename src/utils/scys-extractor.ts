import browser from 'webextension-polyfill';
import { createLogger } from './logger';
import { convertBlocksToHtml, autolinkBareUrls } from './feishu-extractor';
import type { FeishuBlock } from './feishu-extractor';
import { convertDate } from './date-utils';

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
	// scys docx encrypted JSON nests container children in a `node` field
	// (block_type=19 callout). The container also carries `children: string[]`
	// of the same ids (Feishu native format). Course path uses children_blocks
	// instead; both shapes coexist across scys data sources.
	node?: ScysBlock[];
	// scys serves the signed OSS URL as a top-level block field
	// (sibling to `image`, not nested inside it). image.token still
	// carries the feishu-style identifier.
	file_url?: string;
	// scys comment content uses block_type=5001 with server-rendered HTML
	// in sc_html.content (instead of feishu's structured text.elements)
	sc_html?: { content?: string };
}

// Heading promotion: scys course/docx serves H4/5/6 (6/7/8) as section titles
// that should map to Obsidian H2/H3/H4 in markdown (so the standard outline
// pane shows the real document structure). DEFAULT mapping used by course/docx.
const HEADING_REWRITE_DEFAULT: Record<number, { newType: number; newField: string }> = {
	6: { newType: 4, newField: 'heading2' },
	7: { newType: 5, newField: 'heading3' },
	8: { newType: 6, newField: 'heading4' },
};

// Article (xq_topic) mapping: scys article uses one heading level higher than
// course/docx. The browser renders block_type=5 (HEADING3) as 18px/600
// (chapter level), block_type=6 as 16px/600 (subsection), etc. — so demote
// each level by one in markdown to match Obsidian's visual hierarchy.
const HEADING_REWRITE_ARTICLE: Record<number, { newType: number; newField: string }> = {
	5: { newType: 4, newField: 'heading2' },
	6: { newType: 5, newField: 'heading3' },
	7: { newType: 6, newField: 'heading4' },
	8: { newType: 7, newField: 'heading5' },
};

// Map of feishu HEADING block types to their body field name.
const HEADING_FIELDS: Record<number, string> = {
	3: 'heading1', 4: 'heading2', 5: 'heading3',
	6: 'heading4', 7: 'heading5', 8: 'heading6',
	9: 'heading7', 10: 'heading8', 11: 'heading9',
};

// scys article authors abuse the "heading" button as a bold-paragraph styler.
// Per-type cutoffs balance "keep real chapter titles as headings" against
// "demote prose paragraphs masquerading as headings". DEFAULT (course/docx):
//   HEADING4 (block_type=6) — top-level article section.
//   HEADING5/6/7 (block_type=7/8/9) — frequently abused; cutoff 30 demotes.
const HEADING_PARAGRAPH_LEN_THRESHOLD_DEFAULT: Record<number, number> = {
	6: 50,
	7: 30,
	8: 30,
	9: 30,
	10: 30,
	11: 30,
};

// Article: browser renders doc-heading-7 (block_type=9) at 12px/400 — i.e.
// visually a plain paragraph regardless of length. Cutoff 0 → always demote.
// block_type 10/11 (HEADING8/9) follow the same browser pattern in article.
const HEADING_PARAGRAPH_LEN_THRESHOLD_ARTICLE: Record<number, number> = {
	6: 50,
	7: 30,
	8: 30,
	9: 0,
	10: 0,
	11: 0,
};

export interface FlattenOptions {
	headingRewrite?: Record<number, { newType: number; newField: string }>;
	headingParagraphCutoff?: Record<number, number>;
	// When a heading block is demoted to TEXT (because content exceeds the
	// cutoff for that type), force every text_run inside to bold=true. This
	// mirrors how scys article CSS makes the whole heading container bold
	// (font-weight: 600 on .block5/.block6) — without this override the
	// demoted prose loses its visual weight in markdown.
	forceBoldOnDemote?: boolean;
}

function headingContentLength(block: any, field: string): number {
	const body = block[field];
	if (!body || !Array.isArray(body.elements)) return 0;
	let n = 0;
	for (const el of body.elements) {
		// Count both plain text and mention_doc titles — feishu blocks split
		// "prefix text + linked doc title" across multiple elements; missing the
		// mention_doc length would under-count and skip demotion. equation.content
		// (rendered inline as <code>) also contributes to visible length.
		n += ((el.text_run && el.text_run.content) || '').length;
		n += ((el.mention_doc && el.mention_doc.title) || '').length;
		n += ((el.equation && el.equation.content) || '').length;
	}
	return n;
}

export function flattenScysBlocks(blocks: ScysBlock[], options: FlattenOptions = {}): FeishuBlock[] {
	const rewriteMap = options.headingRewrite ?? HEADING_REWRITE_DEFAULT;
	const cutoffMap = options.headingParagraphCutoff ?? HEADING_PARAGRAPH_LEN_THRESHOLD_DEFAULT;
	const out: FeishuBlock[] = [];

	function walk(block: ScysBlock, parentId?: string): void {
		// Support two scys data shapes:
		// - course: block.children_blocks = ScysBlock[] (derive children ids from it)
		// - docx:   block.node = ScysBlock[] PLUS block.children = string[] (Feishu native)
		const childBlocks = block.children_blocks ?? block.node ?? [];
		// Prefer existing children:string[] (docx); else derive from childBlocks (course).
		const existingChildren = Array.isArray((block as any).children) &&
			typeof (block as any).children[0] === 'string'
			? (block as any).children as string[]
			: null;
		const childIds = existingChildren ?? childBlocks.map(c => c.block_id);

		// Shallow copy without nest-wrapper fields
		const { children_blocks: _dropCB, node: _dropNode, ...rest } = block;
		const flat: any = { ...rest, parent_id: parentId, children: childIds.length ? childIds : undefined };

		// HEADING handling has two layers:
		//   1. Demotion: if scys content is long enough to be prose abuse of a
		//      heading button (per-type cutoff), convert to a plain TEXT block so
		//      Obsidian doesn't render it as a huge blue heading.
		//   2. Promotion: feishu's H4/H5/H6 are conventionally section/subsection
		//      titles in course/docx — map to markdown H2/H3/H4 so they slot into
		//      Obsidian's outline at sensible levels.
		const oldField = HEADING_FIELDS[flat.block_type];
		const cutoff = cutoffMap[flat.block_type];
		if (oldField && cutoff !== undefined && headingContentLength(flat, oldField) >= cutoff) {
			// Demote → plain TEXT paragraph
			flat.text = flat[oldField];
			delete flat[oldField];
			flat.block_type = 2;
			if (options.forceBoldOnDemote && flat.text && Array.isArray(flat.text.elements)) {
				flat.text = { ...flat.text, elements: flat.text.elements.map((el: any) => {
					if (!el.text_run) return el;
					const style = { ...(el.text_run.text_element_style || {}), bold: true };
					return { ...el, text_run: { ...el.text_run, text_element_style: style } };
				}) };
			}
		} else {
			const rewrite = rewriteMap[flat.block_type];
			if (rewrite && oldField) {
				const body = flat[oldField];
				if (body === undefined) {
					logger.warn(`heading rewrite: missing ${oldField} on block ${block.block_id}`);
				}
				flat[rewrite.newField] = body;
				delete flat[oldField];
				flat.block_type = rewrite.newType;
			}
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

export function renderScysChapterContent(scysBlocks: ScysBlock[], options: FlattenOptions = {}): string {
	const flat = flattenScysBlocks(scysBlocks, options);
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
	const html = convertBlocksToHtml([page, ...flat]);
	// defuddle/markdown.js:653 unconditionally strips the first `# ...\n+` line
	// as a presumed doc title (to avoid duplicate H1 + frontmatter title).
	// scys docx HEADING1 blocks (e.g. "一、怎么用这份文档") would be silently
	// dropped. Prepend a placeholder H1 so defuddle strips the placeholder
	// instead of our real content. Course path also benefits (its content has
	// no H1 today due to heading rewrite, but the placeholder is harmless).
	return SCYS_TITLE_PLACEHOLDER_HTML + html;
}

const SCYS_TITLE_PLACEHOLDER_HTML = '<h1>__cn_scys_title_placeholder__</h1>';

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
	/** Article publish date as YYYY-MM-DD (from topicDTO.gmtCreate unix seconds).
	 *  Empty string for course/docx paths (no publish-time semantics). */
	published: string;
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
		published: '',
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

	return { title, author: '', content: html, wordCount, published: '' };
}

// ─── /articleDetail/{entityType}/{entityId} (zsxq topic mirror) ───────────────
// scys mirrors knowledge-planet (zsxq) topics under /articleDetail/xq_topic/{id}.
// Backed by POST /shengcai-web/client/homePage/topicDetail and pageTopicComment.
// Reuses the existing block→HTML pipeline since topicDTO.docBlocks is the same
// feishu-flavoured block shape as docx/course.

export function isScysArticleUrl(url: string): boolean {
	try {
		const u = new URL(url);
		if (u.hostname !== 'scys.com') return false;
		// /articleDetail/{type}/{id} — type is a slug (e.g. xq_topic), id is numeric.
		return /^\/articleDetail\/[A-Za-z0-9_]+\/\d+\/?$/.test(u.pathname);
	} catch {
		return false;
	}
}

export function parseScysArticleUrl(url: string): { entityType: string; entityId: string } | null {
	try {
		const u = new URL(url);
		const m = u.pathname.match(/^\/articleDetail\/([A-Za-z0-9_]+)\/(\d+)\/?$/);
		return m ? { entityType: m[1], entityId: m[2] } : null;
	} catch {
		return null;
	}
}

export interface ScysArticleComment {
	commentId: string;
	pCommentId?: string;
	gmtCreate: number; // unix seconds
	content: string; // server-rendered HTML (e.g. "<p>…</p>")
	images?: string; // single URL, or comma-separated; empty string when absent
	userName: string;
	userAvatar?: string;
	likeCount: number;
	isAuthor: boolean;
	replyUserName?: string | null;
	repliesCount?: number;
	replies?: ScysArticleComment[] | null;
}

// scys article has TWO body encodings depending on when the post was written:
//   docBlocks   — modern feishu block array (2024+ posts; e.g. 55188248)
//   articleContent — legacy Quill ql-editor HTML string (pre-2024 posts; e.g. 418444442181248)
// Exactly one of the two will be populated. ScysArticleDetail surfaces both;
// extractScysArticleStandalone branches on which side is present.
export interface ScysArticleDetail {
	entityId: string;
	entityType: string;
	showTitle: string;
	docBlocks?: ScysBlock[];     // modern path
	articleHtml?: string;         // legacy Quill ql-editor HTML
	gmtCreate: number;
	commentsCount: number;
	likeCount: number;
	readingCount: number;
	authorName: string;
}

export async function fetchScysArticleDetail(entityId: string, entityType: string): Promise<ScysArticleDetail | null> {
	try {
		const res = await fetch('/shengcai-web/client/homePage/topicDetail', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ entityId, entityType }),
			credentials: 'include',
		});
		if (!res.ok) {
			logger.warn(`[article] HTTP ${res.status}`);
			return null;
		}
		const json = await res.json();
		const d = json?.data;
		const topic = d?.topicDTO;
		if (!topic) {
			logger.warn(`[article] unexpected response shape (entityId=${entityId})`);
			return null;
		}
		const hasBlocks = Array.isArray(topic.docBlocks) && topic.docBlocks.length > 0;
		const hasHtml = typeof topic.articleContent === 'string' && topic.articleContent.length > 0;
		if (!hasBlocks && !hasHtml) {
			logger.warn(`[article] neither docBlocks nor articleContent populated (entityId=${entityId})`);
			return null;
		}
		return {
			entityId: topic.entityId ?? entityId,
			entityType: topic.entityType ?? entityType,
			showTitle: topic.showTitle ?? '',
			docBlocks: hasBlocks ? (topic.docBlocks as ScysBlock[]) : undefined,
			articleHtml: hasHtml ? (topic.articleContent as string) : undefined,
			gmtCreate: topic.gmtCreate ?? 0,
			commentsCount: topic.commentsCount ?? 0,
			likeCount: topic.likeCount ?? 0,
			readingCount: topic.readingCount ?? 0,
			authorName: d?.topicUserDTO?.name ?? '',
		};
	} catch (err) {
		logger.warn(`[article] fetch error: ${String(err)}`);
		return null;
	}
}

export async function fetchScysArticleComments(
	entityId: string,
	entityType: string,
): Promise<{ items: ScysArticleComment[]; total: number } | null> {
	const items: ScysArticleComment[] = [];
	let total = 0;
	let pageIndex = 1;
	const PAGE_CAP = 50;

	while (true) {
		if (pageIndex > PAGE_CAP) {
			logger.warn(`[article-comments] page cap (${PAGE_CAP}) reached at page ${pageIndex}`);
			break;
		}
		let json: any;
		try {
			const res = await fetch('/shengcai-web/client/homePage/pageTopicComment', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				// sortType=1 = 智能排序 (default); matches what the page sends on initial load.
				body: JSON.stringify({ entityId, entityType, sortType: 1, pageIndex }),
				credentials: 'include',
			});
			if (!res.ok) {
				if (pageIndex === 1) return null;
				break;
			}
			json = await res.json();
		} catch (err) {
			logger.warn(`[article-comments page=${pageIndex}] fetch error: ${String(err)}`);
			if (pageIndex === 1) return null;
			break;
		}
		const data = json?.data;
		if (!data) {
			if (pageIndex === 1) return null;
			break;
		}
		total = data.total ?? total;
		const pageItems: ScysArticleComment[] = Array.isArray(data.items) ? data.items : [];
		items.push(...pageItems);
		if (pageItems.length === 0) break;
		if (items.length >= total) break;
		pageIndex++;
	}
	return { items, total };
}

// Convert images field (single URL or comma-separated) into a placeholder
// <img> using the same feishu-image://scys: protocol resolveScysImages handles.
function renderCommentImages(images: string | undefined): string {
	if (!images || !images.trim()) return '';
	return images.split(',').map(u => u.trim()).filter(Boolean).map(u =>
		`<p><img src="feishu-image://scys:${encodeURIComponent(u)}" alt=""></p>`
	).join('');
}

// Header line for an article comment. Mirrors formatScysCommentHeader visual
// pattern but uses ScysArticleComment fields directly.
export function formatScysArticleCommentHeader(comment: ScysArticleComment): string {
	const name = comment.userName || `匿名#${comment.commentId}`;
	const author = comment.isAuthor ? ' · 作者' : '';
	const likes = (comment.likeCount ?? 0) > 0 ? ` · ${comment.likeCount} ❤️` : '';
	const date = formatScysDate(comment.gmtCreate);
	const reply = comment.replyUserName ? ` · 回复 @${comment.replyUserName}` : '';
	return `<p><strong>${name}</strong>${author}${likes} · ${date}${reply}</p>`;
}

function renderOneArticleCommentHtml(c: ScysArticleComment): string {
	const header = formatScysArticleCommentHeader(c);
	// scys server-renders comment content as HTML but does NOT wrap URLs in
	// <a>; autolink so Obsidian gets clickable [url](url) markdown.
	const body = autolinkBareUrls(c.content ?? '') + renderCommentImages(c.images);
	const replies = Array.isArray(c.replies) ? c.replies : [];
	const repliesHtml = replies.map(renderOneArticleCommentHtml).join('');
	return `<blockquote>${header}${body}${repliesHtml}</blockquote>`;
}

export function renderScysArticleComments(items: ScysArticleComment[], total: number): string {
	if (!items.length) return '';
	const bodies = items.map(renderOneArticleCommentHtml).join('');
	return `<hr><h2>💬 评论（${total} 条）</h2>${bodies}`;
}

// Convert scys "plain-text articleContent" (no <p>/<div>) into proper HTML:
//   1. <e type="web" href="URL-encoded" title="URL-encoded" />  →  <a href="…">…</a>
//   2. Split on blank lines (\n\n+) into paragraphs; inner single \n → <br>.
// Without this defuddle treats the whole blob as one paragraph since there's
// no block-level structure to anchor on.
export function preprocessScysEntityHtml(html: string): string {
	// 1. Decode <e type="web" href="…" title="…" /> into clickable <a>.
	const safeDecode = (s: string) => {
		try { return decodeURIComponent(s); } catch { return s; }
	};
	const out1 = html.replace(
		/<e\s+type="web"\s+href="([^"]*)"\s+title="([^"]*)"\s*\/?>/g,
		(_m, hrefEnc, titleEnc) => {
			const href = safeDecode(hrefEnc);
			const title = safeDecode(titleEnc) || href;
			return `<a href="${href}">${title}</a>`;
		}
	);
	// 2. Paragraph-ize on blank lines; preserve inner single newlines as <br>.
	const paras = out1.split(/\n\n+/).map(s => s.trim()).filter(Boolean);
	return paras.map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('\n');
}

async function extractScysArticleStandalone(doc: Document): Promise<ScysStructuredContent | null> {
	const parsed = parseScysArticleUrl(doc.URL);
	if (!parsed) return null;
	const detail = await fetchScysArticleDetail(parsed.entityId, parsed.entityType);
	if (!detail) {
		logger.warn(`Article fetch failed for ${parsed.entityType}/${parsed.entityId}`);
		return null;
	}

	let html: string;
	let wordCount: number;

	if (detail.docBlocks && detail.docBlocks.length > 0) {
		// Modern path: feishu block tree (2024+ posts).
		// Article-specific HEADING mapping: scys article renders one level deeper
		// than course/docx (browser block5-class is 18px H3, block6 is 16px H4).
		const articleOptions: FlattenOptions = {
			headingRewrite: HEADING_REWRITE_ARTICLE,
			headingParagraphCutoff: HEADING_PARAGRAPH_LEN_THRESHOLD_ARTICLE,
			forceBoldOnDemote: true,
		};
		html = renderScysChapterContent(detail.docBlocks, articleOptions);
		// Resolve FILE block placeholders (videos) → article URL anchor link.
		html = html.replace(
			/<a href="feishu-file-block:\/\/([A-Za-z0-9_-]+)" data-filename="([^"]*)">[^<]*<\/a>/g,
			(_m, blockId, filename) => `<p>📎 <a href="${doc.URL}#${blockId}">${filename}</a></p>`
		);
		wordCount = countWordsFromBlocks(flattenScysBlocks(detail.docBlocks, articleOptions));
	} else {
		// Legacy path: articleContent has two sub-shapes:
		//   (a) Quill ql-editor HTML: outer <div class="content ql-editor"> with
		//       <p>/<ol>/<strong>/<img> children. Pre-2024 posts (e.g. 418444442181248).
		//   (b) Plain text + \n\n paragraph separators + scys custom entity tags
		//       like <e type="web" href="URL-encoded" title="URL-encoded" />. Some
		//       pre-2024 posts (e.g. 2852488814854211) — no block-level HTML at all.
		// detect (b) by absence of <p> / <div / <ol > and presence of plain newlines.
		html = detail.articleHtml || '';
		const looksPlainText = !/<(p|div|ol|ul|h\d)\b/i.test(html);
		if (looksPlainText) {
			// (b) plain-text path: expand <e> entities → <a>, paragraph-ize on \n\n.
			html = preprocessScysEntityHtml(html);
		}
		// (a) ql-editor path is now a no-op fall-through; (b) lands here already paragraphed.
		// Rewrite img src → scys: token (resolveScysImages inlines base64).
		html = html.replace(
			/<img([^>]*?)src="(https?:\/\/[^"]+)"/g,
			(_m, attrs, src) => `<img${attrs}src="feishu-image://scys:${encodeURIComponent(src)}"`
		);
		// Strip the <div class="content ql-editor"> wrapper (ql-editor path only).
		html = html.replace(/^<div class="content ql-editor">/, '').replace(/<\/div>$/, '');
		// Autolink bare URLs in plain text segments.
		html = autolinkBareUrls(html);
		// Word count: rough char-count of stripped text.
		wordCount = html.replace(/<[^>]+>/g, '').length;
	}

	const commentsResult = await fetchScysArticleComments(parsed.entityId, parsed.entityType);
	let commentsHtml = '';
	if (commentsResult && commentsResult.items.length) {
		commentsHtml = renderScysArticleComments(commentsResult.items, detail.commentsCount || commentsResult.total);
	}

	// Resolve scys: image tokens (body + comment images) in one pass.
	html = await resolveScysImages(html + commentsHtml);

	const published = detail.gmtCreate
		? convertDate(new Date(detail.gmtCreate * 1000))
		: '';

	return {
		title: detail.showTitle,
		author: detail.authorName,
		content: html,
		wordCount,
		published,
	};
}

export async function extractScysStructuredContent(doc: Document): Promise<ScysStructuredContent | null> {
	if (isScysCourseUrl(doc.URL)) return extractScysCourseChapter(doc);
	if (isScysDocxUrl(doc.URL)) return extractScysDocxStandalone(doc);
	if (isScysArticleUrl(doc.URL)) return extractScysArticleStandalone(doc);
	return null;
}
