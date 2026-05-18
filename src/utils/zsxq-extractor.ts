import browser from 'webextension-polyfill';
import { createLogger } from './logger';
import { convertDate } from './date-utils';

const logger = createLogger('zsxq-extractor');

// ─── URL detection ────────────────────────────────────────────────────────────
// zsxq topic page:   https://wx.zsxq.com/group/{groupId}/topic/{topicId}
// zsxq article page: https://wx.zsxq.com/group/{groupId}/article/{articleId}
// groupId is always numeric; topicId is numeric (15-ish digits);
// articleId is a short alphanumeric token (e.g. "0rpvzt86eie6").

export function isZsxqTopicUrl(url: string): boolean {
	try {
		const u = new URL(url);
		if (u.hostname !== 'wx.zsxq.com') return false;
		return /^\/group\/\d+\/topic\/\d+\/?$/.test(u.pathname);
	} catch {
		return false;
	}
}

export function isZsxqArticleUrl(url: string): boolean {
	try {
		const u = new URL(url);
		if (u.hostname !== 'wx.zsxq.com') return false;
		return /^\/group\/\d+\/article\/[A-Za-z0-9]+\/?$/.test(u.pathname);
	} catch {
		return false;
	}
}

// Standalone article page on articles.zsxq.com — full SSR HTML, no API call
// needed. Reachable independently from a wx.zsxq.com topic (which links to it
// via talk.article.article_url) or pasted directly by the user.
export function isZsxqArticlesHtmlUrl(url: string): boolean {
	try {
		const u = new URL(url);
		if (u.hostname !== 'articles.zsxq.com') return false;
		return /^\/id_[A-Za-z0-9]+\.html\/?$/.test(u.pathname);
	} catch {
		return false;
	}
}

export type ZsxqUrlInfo =
	| { kind: 'topic'; groupId: string; topicId: string }
	| { kind: 'article'; groupId: string; articleId: string }
	| { kind: 'articles-html'; articleId: string };

// ─── Inline text parsing ──────────────────────────────────────────────────────
// zsxq text fields embed self-closing <e> tags for hashtags, mentions, emoji
// and inline web links, plus the usual <br> and HTML entities. Convert all of
// that into plain markdown text without DOM dependencies (vitest runs in pure
// node — no jsdom). The <e> tag attributes are always URL-encoded.

function safeDecode(s: string): string {
	try { return decodeURIComponent(s); } catch { return s; }
}

function decodeBasicEntities(s: string): string {
	return s
		.replace(/&nbsp;/g, ' ')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, '\'')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}

export function parseZsxqInlineText(text: string): string {
	if (!text) return '';
	let out = text;

	// 1. <e type="..." ... /> tags (self-closing, no nesting).
	out = out.replace(/<e\s+([^>]*?)\/?>/g, (_m, attrsRaw: string) => {
		// Parse attributes loosely: key="value" pairs.
		const attrs: Record<string, string> = {};
		const attrRe = /(\w+)="([^"]*)"/g;
		let m: RegExpExecArray | null;
		while ((m = attrRe.exec(attrsRaw)) !== null) {
			attrs[m[1]] = m[2];
		}
		const type = attrs.type ?? '';
		const title = attrs.title ? safeDecode(attrs.title) : '';
		const href = attrs.href ? safeDecode(attrs.href) : '';
		switch (type) {
			case 'hashtag':
				// title usually already wraps the term in #…#
				return title || '';
			case 'mention':
				// title usually already starts with @
				return title || '';
			case 'emoji':
				return title || '[表情]';
			case 'web':
				// Emit a sentinel-wrapped link; renderTextAsParagraphs converts
				// to a real <a> tag AFTER escapeHtml. Returning markdown like
				// `[t](u)` would otherwise be escaped to `\[t\](u)` by turndown.
				if (href) {
					return `LINK${href}${title || href}`;
				}
				return title;
			case 'text_bold':
				// zsxq stores bold section headings as <e type="text_bold" title="..."/>.
				// The title attribute holds the actual bold text; dropping the tag
				// loses these headings entirely. Render as **markdown bold**.
				return title ? `**${title}**` : '';
			case 'text_italic':
				return title ? `*${title}*` : '';
			default:
				return '';
		}
	});

	// 2. <br> / <br/> → newline.
	out = out.replace(/<br\s*\/?>/gi, '\n');

	// 3. HTML entities.
	out = decodeBasicEntities(out);

	return out;
}

// ─── Topic / comment / image / file types (mirror zsxq API shape) ───────────

export interface ZsxqUser {
	user_id: number;
	name: string;
	avatar_url: string;
	alias?: string;
	location?: string;
}

export interface ZsxqImage {
	image_id: number;
	thumbnail?: { url: string };
	large?: { url: string };
	original?: { url: string };
}

export interface ZsxqFile {
	file_id: number;
	name: string;
	download_url?: string;
}

export interface ZsxqArticleRef {
	title: string;
	article_id: string;
	article_url: string;
	inline_article_url?: string;
}

export interface ZsxqTalkBody {
	owner: ZsxqUser;
	text: string;
	images?: ZsxqImage[];
	files?: ZsxqFile[];
	article?: ZsxqArticleRef;
}

export interface ZsxqQABody {
	owner: ZsxqUser;
	text: string;
	images?: ZsxqImage[];
	files?: ZsxqFile[];
}

export type ZsxqTopicType = 'talk' | 'q&a' | 'task' | 'solution' | string;

export interface ZsxqTopic {
	topic_id: number;
	type: ZsxqTopicType;
	create_time: string;
	group?: { group_id: number; name: string };
	title?: string;
	likes_count: number;
	comments_count: number;
	talk?: ZsxqTalkBody;
	question?: ZsxqQABody;
	answer?: ZsxqQABody;
	task?: ZsxqQABody;
	solution?: ZsxqQABody;
}

// ─── Topic body rendering ────────────────────────────────────────────────────

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function pickImageUrl(img: ZsxqImage): string | null {
	// Prefer `large` (800px, quality 75) over `original` (full-resolution,
	// quality 100). A typical zsxq screenshot's `original` is 5-6 MB raw;
	// base64-encoding 3 of them produced a 17 MB markdown file that Obsidian
	// refused to open. `large` is 200-400 KB and visually equivalent for notes.
	return img.large?.url || img.original?.url || img.thumbnail?.url || null;
}

// Emit an <img> with the feishu-image://zsxq:{encoded-url} protocol placeholder
// that resolveZsxqImages replaces with a base64 data URL.
function renderImage(img: ZsxqImage): string {
	const url = pickImageUrl(img);
	if (!url) return '';
	return `<img alt="${img.image_id}" src="feishu-image://zsxq:${encodeURIComponent(url)}"/>`;
}

function renderImages(images?: ZsxqImage[]): string {
	if (!images || images.length === 0) return '';
	return images.map(img => `<p>${renderImage(img)}</p>`).join('');
}

// The article HTML scraped from articles.zsxq.com contains raw <img src> tags
// pointing at images.zsxq.com / article-images.zsxq.com. Rewrite each src to
// the feishu-image://zsxq:{encoded-url} token so resolveZsxqImages handles
// them uniformly (L1 same-origin → L2 background fetch → L3 raw-url fallback).
function rewriteArticleImageSrcsToTokens(html: string): string {
	return html.replace(/<img\b([^>]*?)\bsrc="(https?:\/\/[^"]+)"([^>]*)>/gi, (_m, pre, src, post) => {
		return `<img${pre}src="feishu-image://zsxq:${encodeURIComponent(src)}"${post}>`;
	});
}

function renderFiles(files?: ZsxqFile[]): string {
	if (!files || files.length === 0) return '';
	const items = files.map(f => {
		const safeName = escapeHtml(f.name || `file-${f.file_id}`);
		if (f.download_url) {
			return `<li>📎 <a href="${f.download_url}">${safeName}</a></li>`;
		}
		return `<li>📎 ${safeName}</li>`;
	}).join('');
	return `<ul>${items}</ul>`;
}

// Convert a zsxq text field (raw, possibly with <e>/<br>/entities) into a
// sequence of <p>…</p> paragraphs. Escapes HTML in the plain segments so
// user-supplied < > don't break out into markup. Markdown produced by
// parseZsxqInlineText (e.g. [text](url) for web tags) is preserved as-is —
// downstream defuddle createMarkdownContent will treat the output as HTML and
// pass the bracketed text through.
function renderTextAsParagraphs(text: string): string {
	const plain = parseZsxqInlineText(text || '');
	if (!plain.trim()) return '';
	const paragraphs = plain.split(/\n\n+/).map(s => s.trim()).filter(Boolean);
	return paragraphs.map(p => {
		const escaped = escapeHtml(p).replace(/\n/g, '<br/>');
		// Promote markdown emphasis emitted by parseZsxqInlineText to real HTML
		// tags so defuddle's markdown converter renders them as bold/italic
		// instead of leaving literal ** / * characters in the note. Regex is
		// non-greedy and rejects newlines / nested markers.
		return `<p>${promoteEmphasis(escaped)}</p>`;
	}).join('');
}

function promoteEmphasis(html: string): string {
	let out = html.replace(/\*\*([^*\n][^*\n]*?)\*\*/g, '<strong>$1</strong>');
	out = out.replace(/(^|[^*])\*([^*\n][^*\n]*?)\*(?!\*)/g, '$1<em>$2</em>');
	// Restore <e type="web"> sentinels emitted by parseZsxqInlineText:
	// \x01LINK\x02{href}\x02{text}\x03  →  <a href="{href}">{text}</a>
	out = out.replace(/\x01LINK\x02([^\x02]+)\x02([^\x03]+)\x03/g, (_m, href, text) => {
		const safeHref = href.replace(/"/g, '&quot;');
		return `<a href="${safeHref}">${text}</a>`;
	});
	return out;
}

export function renderZsxqTopicBodyHtml(topic: ZsxqTopic, articleBodyHtml: string | null): string {
	const t = topic.type;

	if (t === 'q&a') {
		const q = topic.question;
		const a = topic.answer;
		const parts: string[] = [];
		parts.push('<h2>🙋 提问</h2>');
		if (q) {
			parts.push(renderTextAsParagraphs(q.text));
			parts.push(renderImages(q.images));
			parts.push(renderFiles(q.files));
		}
		parts.push('<h2>💡 回答</h2>');
		if (a) {
			parts.push(renderTextAsParagraphs(a.text));
			parts.push(renderImages(a.images));
			parts.push(renderFiles(a.files));
		}
		return parts.join('');
	}

	// talk / task / solution all share the same "owner + text + media" shape.
	const body =
		(t === 'talk' && topic.talk) ||
		(t === 'task' && topic.task) ||
		(t === 'solution' && topic.solution) ||
		topic.talk ||
		topic.task ||
		topic.solution;

	if (!body) return '';

	const parts: string[] = [];
	const talkBody = body as ZsxqTalkBody;

	// Mirror what the zsxq topic page itself displays: the talk.text teaser
	// (whatever length the API returned — typically a 200-char preview ending
	// in "...") followed by an article-link card (NOT the article body).
	// The full article lives on articles.zsxq.com and is reachable via the
	// link; expanding it here would diverge from what the user sees on the
	// topic page they clipped.
	parts.push(renderTextAsParagraphs(body.text || ''));

	if (talkBody.article) {
		parts.push(renderArticleLinkCard(talkBody.article));
	}

	parts.push(renderImages(body.images));
	parts.push(renderFiles(body.files));

	return parts.join('');
}

function renderArticleLinkCard(article: { title: string; article_url: string }): string {
	const safeTitle = escapeHtml(article.title || '链接');
	return `<p>🔗 <a href="${article.article_url}">${safeTitle}</a></p>`;
}

// ─── Comment types + rendering ──────────────────────────────────────────────
// zsxq comments are nested exactly 2 deep: each top-level comment may carry a
// `replied_comments` array of 1-level replies; replies have no further nesting.
// No tree reconstruction needed — just walk the structure.

export interface ZsxqComment {
	comment_id: number;
	create_time: string;
	text: string;
	owner: ZsxqUser;
	likes_count: number;
	group_owner_liked: boolean;
	topic_owner_liked: boolean;
	rewards_count: number;
	sticky: boolean;
	images?: ZsxqImage[];
	replies_count?: number;
	replied_comments?: ZsxqReply[];
}

export interface ZsxqReply extends Omit<ZsxqComment, 'replied_comments' | 'replies_count'> {
	parent_comment_id: number;
	repliee?: ZsxqUser;
}

function formatZsxqDate(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

function renderCommentHeader(c: ZsxqComment | ZsxqReply, opts?: { repliee?: ZsxqUser }): string {
	const name = escapeHtml(c.owner?.name || `匿名#${c.comment_id}`);
	const likes = (c.likes_count ?? 0) > 0 ? ` · ${c.likes_count} ❤️` : '';
	const date = formatZsxqDate(c.create_time);
	const reply = opts?.repliee?.name ? ` · 回复 @${escapeHtml(opts.repliee.name)}` : '';
	return `<p><strong>${name}</strong>${likes} · ${date}${reply}</p>`;
}

function renderCommentBody(text: string, images?: ZsxqImage[]): string {
	const parts: string[] = [];
	parts.push(renderTextAsParagraphs(text));
	parts.push(renderImages(images));
	return parts.join('');
}

function renderOneReply(r: ZsxqReply): string {
	const header = renderCommentHeader(r, { repliee: r.repliee });
	const body = renderCommentBody(r.text, r.images);
	return `<blockquote>${header}${body}</blockquote>`;
}

function renderOneComment(c: ZsxqComment): string {
	const header = renderCommentHeader(c);
	const body = renderCommentBody(c.text, c.images);
	const replies = (c.replied_comments ?? []).map(renderOneReply).join('');
	return `<blockquote>${header}${body}${replies}</blockquote>`;
}

export function renderZsxqCommentsHtml(comments: ZsxqComment[], totalCount: number): string {
	if (!comments.length) return '';
	const bodies = comments.map(renderOneComment).join('');
	return `<hr/><h2>💬 全部评论（${totalCount} 条）</h2>${bodies}`;
}

// ─── API fetching ───────────────────────────────────────────────────────────
// Topic detail:  GET https://api.zsxq.com/v2/topics/{id}/info
//                Returns { succeeded, resp_data: { type:'topic', topic } }.
// Comments:      GET https://api.zsxq.com/v2/topics/{id}/comments?count=30[&end_time=ISO]
//                Default sort=desc. Paginate using the last comment's
//                create_time as end_time. Stop on short page or PAGE_CAP.
// Article body:  GET https://articles.zsxq.com/id_{article_id}.html
//                Full SSR HTML; extract .ql-editor block. CORS-blocked from
//                wx.zsxq.com when called from content script — fall through to
//                background handler (Task 8) which uses host_permissions.

const ZSXQ_API_BASE = 'https://api.zsxq.com/v2';
const ZSXQ_ARTICLES_BASE = 'https://articles.zsxq.com';
const COMMENTS_PAGE_SIZE = 30;
const COMMENTS_PAGE_CAP = 50;
const COMMENTS_PAGE_DELAY_MS = 200;

async function fetchZsxqTopicOnce(topicId: string): Promise<ZsxqTopic | null> {
	try {
		const res = await fetch(`${ZSXQ_API_BASE}/topics/${topicId}/info`, { credentials: 'include' });
		if (!res.ok) {
			logger.warn(`[topic] HTTP ${res.status}`);
			return null;
		}
		const json = await res.json();
		if (!json?.succeeded) {
			logger.warn(`[topic] succeeded=false (topicId=${topicId})`);
			return null;
		}
		const topic = json?.resp_data?.topic;
		if (!topic) {
			logger.warn(`[topic] unexpected response shape (topicId=${topicId})`);
			return null;
		}
		return topic as ZsxqTopic;
	} catch (err) {
		logger.warn(`[topic] fetch error: ${String(err)}`);
		return null;
	}
}

// Same retry pattern as comments: content-script cross-origin fetch to
// api.zsxq.com sometimes returns succeeded=false (HTTP 200) on the first
// attempt right after navigation, before the SPA's session warmup completes.
// 3× retry with 800ms / 1600ms backoff.
export async function fetchZsxqTopic(topicId: string): Promise<ZsxqTopic | null> {
	for (let attempt = 0; attempt < 3; attempt++) {
		const topic = await fetchZsxqTopicOnce(topicId);
		if (topic) return topic;
		if (attempt < 2) {
			logger.warn(`[topic] empty/failed — retry ${attempt + 1}/3`);
			await sleep(800 * (attempt + 1));
		}
	}
	return null;
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

export async function fetchZsxqAllComments(topicId: string): Promise<ZsxqComment[]> {
	const all: ZsxqComment[] = [];
	let endTime: string | undefined;
	let page = 1;
	while (true) {
		if (page > COMMENTS_PAGE_CAP) {
			logger.warn(`[comments] page cap (${COMMENTS_PAGE_CAP}) reached for topic=${topicId}`);
			break;
		}
		const params = new URLSearchParams({ count: String(COMMENTS_PAGE_SIZE) });
		if (endTime) params.set('end_time', endTime);
		const url = `${ZSXQ_API_BASE}/topics/${topicId}/comments?${params.toString()}`;
		let json: any;
		try {
			const res = await fetch(url, { credentials: 'include' });
			if (!res.ok) {
				logger.warn(`[comments page=${page}] HTTP ${res.status}`);
				break;
			}
			json = await res.json();
		} catch (err) {
			logger.warn(`[comments page=${page}] fetch error: ${String(err)}`);
			break;
		}
		const pageItems: ZsxqComment[] = Array.isArray(json?.resp_data?.comments) ? json.resp_data.comments : [];
		all.push(...pageItems);
		if (pageItems.length < COMMENTS_PAGE_SIZE) break;
		endTime = pageItems[pageItems.length - 1].create_time;
		page++;
		await sleep(COMMENTS_PAGE_DELAY_MS);
	}
	return all;
}

// Extract just the ql-editor block (outerHTML) from a full SSR HTML doc.
// Articles always have exactly one `<div class="content ql-editor">…</div>`
// container holding the entire body; everything else is layout chrome.
function extractQlEditorBlock(fullHtml: string): string | null {
	// Find the opening tag.
	const openRe = /<div\s+class="[^"]*\bql-editor\b[^"]*"[^>]*>/i;
	const openMatch = openRe.exec(fullHtml);
	if (!openMatch) return null;
	const openIdx = openMatch.index;
	// Walk forward counting balanced <div>/</div> tags to find the matching close.
	const tagRe = /<\/?div\b[^>]*>/gi;
	tagRe.lastIndex = openIdx;
	let depth = 0;
	let m: RegExpExecArray | null;
	while ((m = tagRe.exec(fullHtml)) !== null) {
		if (m[0].startsWith('</')) {
			depth--;
			if (depth === 0) {
				const end = m.index + m[0].length;
				return fullHtml.slice(openIdx, end);
			}
		} else {
			depth++;
		}
	}
	return null;
}

export async function fetchZsxqArticleHtml(articleId: string): Promise<string | null> {
	const articleUrl = `${ZSXQ_ARTICLES_BASE}/id_${articleId}.html`;

	// L1: same-origin fetch (works only if the content script happens to be on
	// articles.zsxq.com; from wx.zsxq.com this fails with CORS).
	let fullHtml: string | null = null;
	try {
		const res = await fetch(articleUrl, { credentials: 'include' });
		if (res.ok) {
			fullHtml = await res.text();
		} else {
			logger.warn(`[article-html L1] HTTP ${res.status}`);
		}
	} catch (err) {
		logger.warn(`[article-html L1] fetch error: ${String(err)}`);
	}

	// L2: dispatch to background — uses host_permissions to bypass CORS.
	if (!fullHtml && typeof browser !== 'undefined' && browser?.runtime?.sendMessage) {
		try {
			const resp = await browser.runtime.sendMessage({
				action: 'fetchZsxqArticleHtml',
				articleId,
			}) as { success?: boolean; html?: string };
			if (resp?.success && typeof resp.html === 'string') {
				fullHtml = resp.html;
			}
		} catch (err) {
			logger.warn(`[article-html L2] error: ${String(err)}`);
		}
	}

	if (!fullHtml) return null;
	return extractQlEditorBlock(fullHtml);
}

// ─── Image resolution (L1 same-origin → L2 background → L3 raw URL) ─────────

async function blobToDataUrl(blob: Blob): Promise<string> {
	// Avoid FileReader so this works in both browser content scripts and the
	// node test runner (vitest is not configured with jsdom).
	const buf = await blob.arrayBuffer();
	const bytes = new Uint8Array(buf);
	let bin = '';
	for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
	const base64 = btoa(bin);
	const mime = blob.type || 'image/png';
	return `data:${mime};base64,${base64}`;
}

async function fetchZsxqImageL1(zsxqToken: string): Promise<string | null> {
	const fileUrl = decodeURIComponent(zsxqToken.replace(/^zsxq:/, ''));
	try {
		const res = await fetch(fileUrl, { credentials: 'include' });
		if (!res.ok) {
			const display = fileUrl.length > 80 ? fileUrl.slice(0, 80) + '...' : fileUrl;
			logger.warn(`[zsxq-img L1] HTTP ${res.status} for ${display}`);
			return null;
		}
		const blob = await res.blob();
		return await blobToDataUrl(blob);
	} catch (err) {
		logger.warn(`[zsxq-img L1] fetch error: ${String(err)}`);
		return null;
	}
}

export async function resolveZsxqImages(html: string): Promise<string> {
	const tokenPattern = /feishu-image:\/\/(zsxq:[^"'\s>]+)/g;
	const tokens = new Set<string>();
	let match: RegExpExecArray | null;
	while ((match = tokenPattern.exec(html)) !== null) {
		tokens.add(match[1]);
	}
	if (tokens.size === 0) return html;

	const replacements = new Map<string, string>();

	// L1: same-origin fetch in content-script (works for images.zsxq.com when
	// the content script is on the same eTLD+1 and CORS is permissive).
	await Promise.all(
		Array.from(tokens).map(async (token) => {
			const dataUrl = await fetchZsxqImageL1(token);
			if (dataUrl) replacements.set(token, dataUrl);
		})
	);

	// L2: background main-world dispatch for unresolved tokens.
	const unresolvedAfterL1 = Array.from(tokens).filter(t => !replacements.has(t));
	if (unresolvedAfterL1.length > 0 && typeof browser !== 'undefined' && browser?.runtime?.sendMessage) {
		const urlsToTokens = new Map<string, string>();
		for (const t of unresolvedAfterL1) {
			urlsToTokens.set(decodeURIComponent(t.replace(/^zsxq:/, '')), t);
		}
		const urls = Array.from(urlsToTokens.keys());
		try {
			const resp = await browser.runtime.sendMessage({
				action: 'fetchZsxqImagesAsBase64',
				urls,
			}) as { success?: boolean; results?: Record<string, string> };
			if (resp?.success && resp.results) {
				for (const [url, dataUrl] of Object.entries(resp.results)) {
					const token = urlsToTokens.get(url);
					if (token && dataUrl) replacements.set(token, dataUrl);
				}
			}
		} catch (err) {
			logger.warn(`[zsxq-img L2] error: ${String(err)}`);
		}
	}

	let resolved = html;
	// First substitute all resolved tokens with their data URLs.
	for (const [token, dataUrl] of replacements) {
		resolved = resolved.split(`feishu-image://${token}`).join(dataUrl);
	}
	// L3: any remaining `feishu-image://zsxq:…` tokens degrade to raw URL so
	// the rendered markdown at least shows the image while the user's zsxq
	// session is still valid (CDN URLs are signed with short expiry).
	const stillUnresolved = Array.from(tokens).filter(t => !replacements.has(t));
	for (const token of stillUnresolved) {
		const rawUrl = decodeURIComponent(token.replace(/^zsxq:/, ''));
		resolved = resolved.split(`feishu-image://${token}`).join(rawUrl);
	}
	return resolved;
}

export function parseZsxqUrl(url: string): ZsxqUrlInfo | null {
	try {
		const u = new URL(url);
		if (u.hostname === 'articles.zsxq.com') {
			const m = u.pathname.match(/^\/id_([A-Za-z0-9]+)\.html\/?$/);
			return m ? { kind: 'articles-html', articleId: m[1] } : null;
		}
		if (u.hostname !== 'wx.zsxq.com') return null;
		const topicMatch = u.pathname.match(/^\/group\/(\d+)\/topic\/(\d+)\/?$/);
		if (topicMatch) {
			return { kind: 'topic', groupId: topicMatch[1], topicId: topicMatch[2] };
		}
		const articleMatch = u.pathname.match(/^\/group\/(\d+)\/article\/([A-Za-z0-9]+)\/?$/);
		if (articleMatch) {
			return { kind: 'article', groupId: articleMatch[1], articleId: articleMatch[2] };
		}
		return null;
	} catch {
		return null;
	}
}

// articles.zsxq.com publish-time text format: "2026年05月01日 21:02" — single space
// between date and time; month/day are zero-padded. Return YYYY-MM-DD or '' on
// parse failure.
function parseChineseArticleDate(raw: string): string {
	const m = raw.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
	if (!m) return '';
	const y = m[1];
	const mo = m[2].padStart(2, '0');
	const d = m[3].padStart(2, '0');
	return `${y}-${mo}-${d}`;
}

// ─── Top-level entry ────────────────────────────────────────────────────────

export interface ZsxqStructuredContent {
	title: string;
	author: string;
	content: string;
	wordCount: number;
	/** Topic publish time as YYYY-MM-DD (from topic.create_time ISO8601). */
	published: string;
}

function buildZsxqPublished(topic: ZsxqTopic): string {
	if (!topic.create_time) return '';
	const d = new Date(topic.create_time);
	if (Number.isNaN(d.getTime())) return '';
	return convertDate(d);
}

function buildZsxqTitle(topic: ZsxqTopic): string {
	// Prefer talk.article.title (full article title) over the truncated
	// talk.text teaser.
	const articleTitle = topic.talk?.article?.title;
	if (articleTitle) return articleTitle;
	if (topic.title) return topic.title;
	const body = topic.talk ?? topic.question ?? topic.task ?? topic.solution;
	// If talk.text starts with a bold heading (text_bold <e>), prefer that as
	// title — zsxq users typically put the post's full title in the first
	// text_bold tag. The raw <e type="text_bold" title="..."/> appears
	// literally at the start of text in this case.
	const rawText = body?.text ?? '';
	const firstBoldMatch = rawText.match(/^\s*<e\s+[^>]*type="text_bold"[^>]*title="([^"]+)"[^>]*\/?>/);
	if (firstBoldMatch) {
		try {
			const decoded = decodeURIComponent(firstBoldMatch[1]).trim();
			if (decoded) return decoded.length > 80 ? decoded.slice(0, 80) + '…' : decoded;
		} catch { /* fall through */ }
	}
	const plain = parseZsxqInlineText(rawText)
		.replace(/\*+/g, '') // strip markdown emphasis that parseZsxqInlineText now emits
		.replace(/\n/g, ' ')
		.trim();
	if (!plain) return 'zsxq 帖子';
	return plain.length > 40 ? plain.slice(0, 40) + '…' : plain;
}

function buildZsxqAuthor(topic: ZsxqTopic): string {
	// For q&a topics, the topic "owner" displayed on the page is the answerer
	// (the 星主 being asked), not the questioner. zsxq's web UI shows the
	// answerer's avatar + name at the top of the post; the questioner appears
	// inside the question body. Prefer answer.owner.name when available.
	if (topic.type === 'q&a') {
		return topic.answer?.owner?.name ?? topic.question?.owner?.name ?? '';
	}
	// For solution topics, the solver is the "owner" of the topic (the task
	// itself was posted by someone else); prefer solution.owner.
	if (topic.type === 'solution') {
		return topic.solution?.owner?.name ?? topic.task?.owner?.name ?? '';
	}
	const body = topic.talk ?? topic.task;
	return body?.owner?.name ?? '';
}

function countZsxqWords(topic: ZsxqTopic, comments: ZsxqComment[], articleHtml: string | null): number {
	let total = 0;
	if (articleHtml) total += articleHtml.replace(/<[^>]+>/g, '').length;
	const body = topic.talk ?? topic.question ?? topic.task ?? topic.solution;
	if (body?.text) total += parseZsxqInlineText(body.text).length;
	for (const c of comments) {
		if (c.text) total += parseZsxqInlineText(c.text).length;
		for (const r of c.replied_comments ?? []) {
			if (r.text) total += parseZsxqInlineText(r.text).length;
		}
	}
	return total;
}

// articles.zsxq.com SSR HTML extractor — DOM-driven (no API call). The page
// is plain server-rendered HTML so we read .author-info / .ql-editor directly.
async function extractZsxqArticlesHtml(doc: Document): Promise<ZsxqStructuredContent | null> {
	const ql = doc.querySelector('.ql-editor');
	if (!ql) {
		logger.warn('[articles-html] .ql-editor not found');
		return null;
	}
	// Title: <h1>/<title>/document.title. The page header isn't structured as
	// an <h1> — Obsidian-friendly title comes from doc.title (no "-知识星球"
	// suffix on articles.zsxq.com; the suffix is wx.zsxq.com only).
	const title = (doc.title || '').trim() || 'zsxq 文章';
	const author = doc.querySelector('.nick-name')?.textContent?.trim() ?? '';
	const dateRaw = doc.querySelector('#article-date')?.textContent?.trim() ?? '';
	const published = parseChineseArticleDate(dateRaw);

	const bodyHtml = rewriteArticleImageSrcsToTokens(ql.outerHTML);
	const content = await resolveZsxqImages(bodyHtml);
	const wordCount = ql.textContent?.length ?? 0;

	return { title, author, published, content, wordCount };
}

export async function extractZsxqStructuredContent(doc: Document): Promise<ZsxqStructuredContent | null> {
	const parsed = parseZsxqUrl(doc.URL);
	if (!parsed) return null;
	if (parsed.kind === 'articles-html') return extractZsxqArticlesHtml(doc);
	if (parsed.kind !== 'topic') return null;

	const topic = await fetchZsxqTopic(parsed.topicId);
	if (!topic) return null;

	// Match what the zsxq topic page itself shows: talk.text teaser + article
	// link card + comments. Don't fetch the full article body — that's a
	// separate page (articles.zsxq.com) the user can clip individually.
	//
	// Comments retry: zsxq API intermittently returns an empty array (HTTP 200)
	// when content-script fetch races SPA session warmup. Retry up to 3× with
	// short backoff when the topic claims comments but we got none.
	const expectedCount = topic.comments_count ?? 0;
	const fetchCommentsWithRetry = async (): Promise<ZsxqComment[]> => {
		for (let attempt = 0; attempt < 3; attempt++) {
			const got = await fetchZsxqAllComments(parsed.topicId).catch(() => [] as ZsxqComment[]);
			if (got.length > 0 || expectedCount === 0) return got;
			if (attempt < 2) {
				logger.warn(`[comments] empty but expected ${expectedCount} — retry ${attempt + 1}/3`);
				await sleep(800 * (attempt + 1));
			}
		}
		return [];
	};
	const comments = await fetchCommentsWithRetry();

	const bodyHtml = renderZsxqTopicBodyHtml(topic, null);
	const commentsHtml = renderZsxqCommentsHtml(comments, topic.comments_count ?? comments.length);
	const content = await resolveZsxqImages(bodyHtml + commentsHtml);

	return {
		title: buildZsxqTitle(topic),
		author: buildZsxqAuthor(topic),
		published: buildZsxqPublished(topic),
		content,
		wordCount: countZsxqWords(topic, comments, null),
	};
}
